const b4a = require('b4a')
const c = require('compact-encoding')
const Hypercore = require('hypercore')
const crypto = require('hypercore-crypto')
const SignalPromise = require('signal-promise')

const { ManifestData } = require('./encoding.js')
const { MAPPED_MANIFEST_VERSION } = require('./constants.js')

const [NS_MAPPED] = crypto.namespace('autobee/remap', 1)
const COPY_BATCH_BYTES = 4 * 1024 * 1024

async function migrateCore(store, namespace, key, encryption = null, opts = {}) {
  const src = store.get({ key, encryption, active: true })
  await src.ready()

  const name = 'remap/' + namespace + '/' + b4a.toString(key, 'hex') + '/' + src.length

  const copy = copyCore(store, src, name, encryption, opts)

  try {
    return await copy
  } finally {
    await src.close()
  }
}

async function copyCore(
  store,
  src,
  name,
  encryption,
  { cancelled = never, batchBytes = COPY_BATCH_BYTES }
) {
  const key = src.key
  const length = src.length
  let tmp = null
  try {
    if (length === 0) throw new Error('Cannot migrate an empty core')

    const userData = c.encode(ManifestData, {
      version: 0,
      legacyBlocks: 0,
      namespace: deriveNamespace(key, length)
    })
    const ctx = { key, manifest: { version: MAPPED_MANIFEST_VERSION, userData } }
    const padding = encryption === null ? 0 : encryption.padding()

    // one staging core per copy, so an interrupted copy picks up where it left
    tmp = store.get({ name, exclusive: true, active: false })
    await tmp.ready()

    if (tmp.length > length) {
      throw new Error('Staging core ahead of its source: ' + tmp.length + ' > ' + length)
    }

    let blocks = []
    let size = 0

    for (let i = tmp.length; i < length; i++) {
      if (cancelled()) throw new Error('Copy cancelled')

      const block = await src.get(i, { raw: encryption === null })

      let out = block

      if (encryption !== null) {
        out = b4a.alloc(padding + block.byteLength)
        out.set(block, padding)
        await encryption.encrypt(i, out, 0, ctx)
      }

      blocks.push(out)
      size += out.byteLength

      if (size >= batchBytes) {
        await tmp.append(blocks)
        blocks = []
        size = 0
      }
    }

    if (blocks.length > 0) await tmp.append(blocks)

    if (tmp.length !== length) {
      throw new Error('Staging core length mismatch: ' + tmp.length + ' vs ' + length)
    }

    return await store.staticify(tmp, {
      manifest: { version: MAPPED_MANIFEST_VERSION, userData, linked: null },
      active: false
    })
  } finally {
    if (tmp !== null) await tmp.close()
  }
}

function never() {
  return false
}

class Remapper {
  constructor(auto) {
    this.auto = auto
    this.store = auto.store
    this.cores = []
    this.gate = null
    this.sessions = []
    this.ranges = []
    this.activeRequests = []
    this.mappings = null
    this.destroyed = false
    this.cancelled = false
    this.signal = new SignalPromise()

    // state
    this.epoch = 0
    this.recovered = false
    this.walked = false
    this.downloaded = false
    this.committing = false
    this.finished = false
  }

  async run({ settle } = {}) {
    try {
      this.mappings = await this._run({ settle })
    } finally {
      this.finished = true
    }

    return this.mappings
  }

  // phase one, recover -> walk -> download, never blocks a landing: a landing
  // cancels it and it starts over from the new head. phase two, the commit,
  // is the only part a landing waits for
  async _run(opts) {
    while (!this.destroyed) {
      while (this.cancelled && !this.destroyed) await this.signal.wait()
      if (this.destroyed) break

      const epoch = this.epoch
      let ready = false

      try {
        if (!this.recovered) {
          // recovery is on the bootstrap, which no landing changes
          await this._gate(opts)
          if (this.destroyed) break
          this.recovered = true
          if (epoch !== this.epoch) continue
        }

        await this._walk()
        if (epoch !== this.epoch) continue
        this.walked = true

        await this._download(opts)
        if (epoch !== this.epoch) continue
        this.downloaded = true

        this._verify()
        ready = true
      } catch (err) {
        // a cancelled stage fails its reads, which says nothing about the remap
        if (epoch === this.epoch) throw err
      } finally {
        await this._closeSessions()
      }

      if (!ready || epoch !== this.epoch) continue

      this.committing = true
      try {
        return await this._commit()
      } catch (err) {
        this.committing = false
        throw err
      }
    }

    return null
  }

  async _commit() {
    const mappings = { views: [], systems: [] }

    for (const { key, encryption, system } of this.cores) {
      if (this.destroyed) return null
      const copy = await migrateCore(
        this.store,
        b4a.toString(this.auto.key, 'hex'),
        key,
        encryption,
        {
          cancelled: () => this.destroyed
        }
      )
      const mapping = { from: key, to: copy.key }
      if (system) mappings.systems.push(mapping)
      else mappings.views.push(mapping)
      await copy.close()
    }

    return mappings
  }

  // everything the remap reads is served by a recovery peer, so one has to be
  // there before anything is read: on the bootstrap, which every peer carries
  async _gate(opts) {
    this.gate = this.store.get({ key: this.auto.bootstrap.key })

    try {
      await this._recover(this.gate, opts)
    } finally {
      await this.gate.close()
      this.gate = null
    }
  }

  async _walk() {
    this.cores = []

    const { views, systems } = await this.auto._unmappedCores({
      activeRequests: this.activeRequests
    })

    for (const key of views) {
      this.cores.push({ key, encryption: this.auto.getViewEncryption(), system: false })
    }
    for (const key of systems) {
      this.cores.push({ key, encryption: this.auto.getSystemEncryption(), system: true })
    }

    // the host may want its mirrors to hold these before the download waits on them
    this.auto.emit('remap-walk', { views, systems })
  }

  async _download(opts) {
    if (this.cores.length === 0) return

    for (const { key } of this.cores) {
      const session = this.store.get({ key })
      this.sessions.push(session)
    }

    await Promise.all(this.sessions.map((session) => this._prepare(session, opts)))
    if (this.destroyed) return

    await Promise.all(this.ranges.map((range) => range.done()))
  }

  // all or nothing: a core that did not arrive whole fails the remap before anything is copied
  _verify() {
    for (const session of this.sessions) {
      if (session.length === 0 || session.contiguousLength !== session.length) {
        throw new Error(
          'Remap core incomplete: ' +
            b4a.toString(session.key, 'hex') +
            ' ' +
            session.contiguousLength +
            '/' +
            session.length
        )
      }
    }
  }

  destroy() {
    this.destroyed = true
    this.epoch++
    Hypercore.destroyRequests(this.activeRequests)
    for (const range of this.ranges) range.destroy()
    for (const session of this.sessions) session.close().catch(noop)
    if (this.gate !== null) this.gate.close().catch(noop)
    this.signal.notify()
  }

  cancel() {
    if (this.committing) return
    this.cancelled = true
    this.epoch++
    this.walked = false
    this.downloaded = false
    Hypercore.destroyRequests(this.activeRequests)
    for (const range of this.ranges) range.destroy()
    // a core still recovering is not waited for, the gate is left to finish
    for (const session of this.sessions) session.close().catch(noop)
  }

  restart() {
    if (!this.cancelled) return
    this.activeRequests = []
    this.cancelled = false
    this.signal.notify()
  }

  async _prepare(session, opts) {
    await this._recover(session, opts)
    if (this.destroyed || session.closing !== null) return
    this.ranges.push(session.download({ start: 0, end: session.length }))
  }

  // recovery is never bounded: a store with no recovery peer waits for one
  async _recover(session, { settle } = {}) {
    try {
      await session.recover({ settle })
    } catch (err) {
      if (!this.destroyed) throw err
    }
  }

  async _closeSessions() {
    const sessions = this.sessions
    this.sessions = []
    this.ranges = []
    await Promise.all(sessions.map((session) => session.close()))
  }
}

function noop() {}

function deriveNamespace(key, length) {
  return crypto.hash([NS_MAPPED, key, c.encode(c.uint64, length)])
}

module.exports = { migrateCore, Remapper }
