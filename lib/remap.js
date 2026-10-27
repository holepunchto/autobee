const b4a = require('b4a')
const c = require('compact-encoding')
const Hypercore = require('hypercore')
const crypto = require('hypercore-crypto')

const { ManifestData } = require('./encoding.js')
const { MAPPED_MANIFEST_VERSION } = require('./constants.js')

async function migrateCore(store, key, encryption = null) {
  const src = store.get({ key, encryption, active: true })
  await src.ready()

  const dl = src.download({ start: 0, end: -1 })
  try {
    if (src.length === 0) throw new Error('Cannot migrate an empty core')

    const userData = c.encode(ManifestData, { version: 0, legacyBlocks: 0, namespace: key })
    const ctx = { key, manifest: { version: MAPPED_MANIFEST_VERSION, userData } }
    const padding = encryption === null ? 0 : encryption.padding()

    const blocks = []
    for (let i = 0; i < src.length; i++) {
      const block = await src.get(i, { raw: encryption === null })

      if (encryption === null) {
        blocks.push(block)
        continue
      }

      const out = b4a.alloc(padding + block.byteLength)
      out.set(block, padding)
      await encryption.encrypt(i, out, 0, ctx)
      blocks.push(out)
    }

    // staged in a throwaway core, which staticify turns into the copy
    const tmp = store.get({ keyPair: crypto.keyPair(), active: false })
    await tmp.append(blocks)

    try {
      return await store.staticify(tmp, {
        manifest: { version: MAPPED_MANIFEST_VERSION, userData, linked: null },
        active: false
      })
    } finally {
      await tmp.close()
    }
  } finally {
    await src.close()
    dl.destroy()
  }
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

  async run({ settle } = {}) {
    try {
      this.mappings = await this._run({ settle })
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

  async _run(opts) {
    try {
      await this._gate(opts)
      if (this.destroyed) return null
      await this._walk()
      if (this.destroyed) return null

      await this._download(opts)
      if (this.destroyed) return null
    } finally {
      await this._closeSessions()
    }

    const mappings = { views: [], systems: [] }

    for (const { key, encryption, system } of this.cores) {
      if (this.destroyed) return null
      const copy = await migrateCore(this.store, key, encryption)
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

  // reads as long as it takes, cancelled only by destroy
  async _walk() {
    const { views, systems } = await this.auto._unmappedCores({
      activeRequests: this.activeRequests
    })

    for (const key of views) {
      this.cores.push({ key, encryption: this.auto.getViewEncryption(), system: false })
    }
    for (const key of systems) {
      this.cores.push({ key, encryption: this.auto.getSystemEncryption(), system: true })
    }
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
      await Promise.all(this.ranges.map((range) => range.done()))
    } catch (err) {
      if (!this.destroyed) throw err
    }
  }

  async _prepare(session, opts) {
    await this._recover(session, opts)
    if (this.destroyed) return
    this.ranges.push(session.download({ start: 0, end: session.length }))
  }

  async _recover(session, opts) {
    try {
      await session.recover(opts)
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

module.exports = { migrateCore, Remapper }
