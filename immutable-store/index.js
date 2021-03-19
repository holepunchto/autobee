const sodium = require('sodium-universal')

const { Message } = require('./lib/messages')

const VERSION = 'v1'
const CAP_NAMESPACE = Buffer.from(`immutable store capability ${VERSION}`)
const EXTENSION_NAME = `immutable-store/${VERSION}`
const DEFAULT_TIMEOUT = 2.5 * 1000

class MapDb {
  constructor () {
    this.m = new Map()
  }

  put (key, val) {
    this.m.set(key.toString('hex'), val)
  }

  get (key) {
    return this.m.get(key.toString('hex'))
  }
}

class InvertedPromise {
  constructor (resolve, reject) {
    this.resolve = resolve
    this.reject = reject
  }
}

module.exports = class ImmutableStore {
  constructor (opts = {}) {
    this.db = opts.db || new MapDb()

    this._debug = opts.debug
    this._onerror = opts.onerror

    this._exts = new Map()
    this._pending = new Map()
    this._timeout = opts.timeout || DEFAULT_TIMEOUT
  }

  _verifyCapability (stream, hash, cap) {
    const expected = deriveCapability(hash, stream.remotePublicKey)
    return sodium.sodium_compare(expected, cap) === 0
  }

  _send (ext, msg) {
    const state = { start: 0, end: 0, buffer: null }
    Message.preencode(state, msg)
    state.buffer = Buffer.alloc(state.end)
    Message.encode(state, msg)
    return ext.send(state.buffer)
  }

  _sendRequests (keys, pending) {
    for (const [stream, ext] of this._exts) {
      const request = {
        discoveryKey: keys.discoveryKey,
        capability: deriveCapability(keys.hash, stream.publicKey)
      }
      this._send(ext, { request })
      pending.inflight.add(stream)
    }
    pending.timeout = setTimeout(() => this._flush(keys.id, null), this._timeout)
  }

  _flush (id, value) {
    if (!this._pending.has(id)) return
    const { promises, timeout } = this._pending.get(id)
    clearTimeout(timeout)
    for (const prom of promises) {
      prom.resolve(value)
    }
    this._pending.delete(id)
  }

  // Extension Handlers

  async _onrequest (req, from) {
    const discoveryKey = req.discoveryKey
    const ext = this._exts.get(from)
    if (!discoveryKey || !ext) return

    const rsp = { response: { discoveryKey } }
    const stored = await this.db.get(discoveryKey)
    const verified = stored && this._verifyCapability(from, stored.hash, req.capability)

    if (!stored || !verified) return this._send(ext, rsp)

    rsp.response.hash = stored.hash
    rsp.response.value = stored.value
    this._send(ext, rsp)
  }

  async _onresponse (rsp, from) {
    const pending = this._pending.get(keyString(rsp.discoveryKey))
    if (!pending || !pending.inflight.has(from)) return

    pending.inflight.delete(from)
    if (!rsp.hash) return

    const valueHash = deriveHash(rsp.value)
    const discoveryKey = deriveHash(rsp.hash)

    if (valueHash.equals(rsp.hash) && discoveryKey.equals(rsp.discoveryKey)) {
      await this.db.put(rsp.discoveryKey, { hash: rsp.hash, value: rsp.value })
      this._flush(keyString(discoveryKey), rsp.value)
    }
  }

  async _onmessage (raw, from) {
    try {
      const state = { start: 0, end: raw.length, buffer: raw }
      const msg = Message.decode(state)
      if (this._debug && this._debug.onmessage) this._debug.onmessage(msg, from)
      if (msg.request) await this._onrequest(msg.request, from)
      else if (msg.response) await this._onresponse(msg.response, from)
    } catch (err) {
      if (this._onerror) this._onerror(err)
    }
  }

  // Public API

  async put (value) {
    const hash = deriveHash(value)
    const discoveryKey = deriveHash(hash)
    await this.db.put(discoveryKey, { hash, value })
    return hash
  }

  async get (hash, opts = {}) {
    const discoveryKey = deriveHash(hash)
    const existing = await this.db.get(discoveryKey)
    if (existing || opts.local || !this._exts.size) return existing && existing.value

    const id = keyString(discoveryKey)
    const keys = { hash, discoveryKey, id }

    let pending = this._pending.get(id)
    if (!pending) {
      pending = { inflight: new Set(), promises: [], timeout: null }
      this._pending.set(id, pending)
      this._sendRequests(keys, pending)
    }

    return new Promise((resolve, reject) => {
      pending.promises.push(new InvertedPromise(resolve, reject))
    })
  }

  register (stream) {
    const ext = stream.registerExtension(EXTENSION_NAME, {
      onmessage: (msg) => this._onmessage(msg, stream)
    })
    this._exts.set(stream, ext)
  }

  close () {
    for (const ext of this._exts.values) {
      ext.destroy()
    }
    if (this.db.close) return this.db.close()
  }
}

function keyString (key) {
  return Buffer.isBuffer(key) ? key.toString('hex') : key
}

function deriveCapability (key, noisePublicKey) {
  const out = Buffer.allocUnsafe(32)
  sodium.crypto_generichash_batch(out, [
    CAP_NAMESPACE,
    noisePublicKey
  ], key)
  return out
}

function deriveHash (buf) {
  const digest = Buffer.allocUnsafe(32)
  sodium.crypto_generichash(digest, buf)
  return digest
}
