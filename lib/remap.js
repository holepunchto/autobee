const b4a = require('b4a')
const c = require('compact-encoding')
const Hypercore = require('hypercore')
const crypto = require('hypercore-crypto')

const { ManifestData } = require('./encoding.js')
const { MAPPED_MANIFEST_VERSION } = require('./constants.js')

const [NS_MAPPED] = crypto.namespace('autobee/remap', 1)
const COPY_BATCH_BYTES = 4 * 1024 * 1024

// one copy of a source at a time per process: a remap cancelled by a landing
// may still be appending to the staging core the next remap wants
const copying = new Map()

async function migrateCore(store, key, encryption = null, opts = {}) {
  const src = store.get({ key, encryption, active: true })
  await src.ready()

  const name = 'remap/' + b4a.toString(key, 'hex') + '/' + src.length

  while (copying.has(name)) await copying.get(name).catch(noop)

  const copy = copyCore(store, src, name, encryption, opts)
  copying.set(name, copy)

  try {
    return await copy
  } finally {
    copying.delete(name)
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
    tmp = store.get({ name, active: false })
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
    this.sessions = []
    this.ranges = []
    this.activeRequests = []
    this.mappings = null
    this.finished = false
    this.destroyed = false
  }

  async run({ settle, timeout } = {}) {
    try {
      this.mappings = await this._run({ settle, timeout })
    } finally {
      this.finished = true
    }

    return this.mappings
  }

  destroy() {
    this.destroyed = true
    Hypercore.destroyRequests(this.activeRequests)
    for (const range of this.ranges) range.destroy()
    for (const session of this.sessions) session.close().catch(noop)
  }

  // every stage is bounded: a remap that cannot get its data fails rather than
  // holding the store on the old generation forever
  async _run(opts) {
    try {
      await this._gate(opts)
      if (this.destroyed) return null
      await this._walk(opts)
      if (this.destroyed) return null

      await this._download(opts)
      if (this.destroyed) return null

      this._verify()
    } finally {
      await this._closeSessions()
    }

    const mappings = { views: [], systems: [] }

    for (const { key, encryption, system } of this.cores) {
      if (this.destroyed) return null
      const copy = await migrateCore(this.store, key, encryption, {
        cancelled: () => this.destroyed
      })
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
    const session = this.store.get({ key: this.auto.bootstrap.key })
    this.sessions.push(session)
    await this._recover(session, opts)
  }

  async _walk({ timeout } = {}) {
    const { views, systems } = await this.auto._unmappedCores({
      activeRequests: this.activeRequests,
      timeout
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

    try {
      await this._downloaded(opts)
    } catch (err) {
      if (!this.destroyed) throw err
    }
  }

  // bounded by progress, not duration: a big copy may take long, a stalled one may not
  async _downloaded({ timeout = 0 } = {}) {
    const done = Promise.all(this.ranges.map((range) => range.done()))
    if (!timeout) return done

    let timer = null

    const bump = () => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => this._cancelDownloads(), timeout)
    }

    const sessions = this.sessions.slice(1)
    for (const session of sessions) session.on('download', bump)

    try {
      bump()
      await done
    } finally {
      clearTimeout(timer)
      for (const session of sessions) session.off('download', bump)
    }
  }

  // a destroyed range resolves its done() as unfinished, verification does the rest
  _cancelDownloads() {
    for (const range of this.ranges) range.destroy()
  }

  // all or nothing: a core that did not arrive whole fails the remap before anything is copied
  _verify() {
    for (const session of this.sessions.slice(1)) {
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

  async _prepare(session, opts) {
    await this._recover(session, opts)
    if (this.destroyed) return
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
