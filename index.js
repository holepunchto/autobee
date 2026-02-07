const ReadyResource = require('ready-resource')
const b4a = require('b4a')
const ScopeLock = require('scope-lock')
const Hyperbee = require('hyperbee2')
const System = require('./lib/system.js')
const encoding = require('./lib/encoding.js')

class Writer {
  constructor(core) {
    this.core = core
    this.pending = []
    this.id = b4a.toString(core.key, 'hex')
  }

  async next(system, bootstrapping) {
    const info = await system.get(this.core.key)
    const batch = []

    if (!info && !bootstrapping) return null

    let length = info ? info.length : 0

    while (length < this.core.length) {
      const data = await this.core.get(length++)
      const oplog = encoding.decodeOplog(data)
      const node = {
        core: this.core,
        key: this.core.key,
        length,
        timestamp: oplog.timestamp,
        links: oplog.links,
        value: oplog.value
      }

      for (const link of node.links) {
        const node = await system.get(link.key)
        if (!node || node.length < link.length) return null
      }

      batch.push(node)
      return batch // todo batching
    }

    return null
  }

  append(value, links) {
    const node = {
      core: this.core,
      key: this.core.key,
      length: this.core.length + this.pending.length + 1,
      timestamp: Date.now(),
      links,
      value
    }

    this.pending.push(node)

    return node
  }

  flush() {
    const buffers = []
    for (const node of this.pending) buffers.push(encoding.encodeOplog(node))
    this.pending = []
    return this.core.append(buffers)
  }
}

module.exports = class Autobee extends ReadyResource {
  constructor(store, key = null, opts = {}) {
    super()

    if (isObject(key)) {
      opts = key
      key = null
    }

    const { apply = noop, name = null } = opts

    this.store = store
    this.key = key

    this.system = new System(store.namespace('system'))
    this.bee = new Hyperbee(store.namespace('view'))
    this.view = null

    this.name = name // for debugging

    this.local = store.get({ name: 'local' })
    this.writers = new Map()
    this.localWriter = null
    this.lock = new ScopeLock()
    this.bumping = 0

    this._writersBooting = null
    this._systemBooting = null

    this._userApply = apply
  }

  async _open() {
    await this.local.ready()
    await this.bee.ready()

    this.localWriter = new Writer(this.local)
    this.writers.set(this.localWriter.id, this.localWriter)

    if (!this.key) this.key = this.local.key

    if (!b4a.equals(this.local.key, this.key)) {
      await this._addWriter(this.key)
    }

    this._systemBooting = this.system.boot(this.bee)
    this._writersBooting = this._boot() // bg
  }

  async _boot() {
    await this._systemBooting

    for await (const node of this.system.list()) {
      const id = b4a.toString(node.key, 'hex')
      await this._addWriter(node.key)
    }
    await this._bump()
  }

  async _bump() {
    if (this.bumping !== 0) return
    this.bumping++

    let updated = true

    while (updated) {
      updated = false
      for (const w of this.writers.values()) {
        if (w === this.localWriter) continue
        const batch = await w.next(this.system, b4a.equals(this.key, w.core.key))
        if (batch === null) continue
        await this._processBatch(batch)
        updated = true
      }
    }

    this.bumping = 0
  }

  async _addWriter(key) {
    const id = b4a.toString(key, 'hex')
    if (this.writers.has(id)) return false
    const core = this.store.get(key)
    await core.ready()
    core.on('append', () => this._bump())
    this.writers.set(id, new Writer(core))
    return true
  }

  async _processBatch(batch) {
    await this.lock.lock()

    try {
      const t = await this.system.prepare(batch, this.name)

      if (t.view) {
        this.bee.move(t.view)
      }

      for (const batch of t.tip) {
        await this._userApply(this, this.bee, batch)

        const changed = await this.system.flush(batch, this.bee, this.name)

        for (const { key, added } of changed) {
          if (added) await this._addWriter(key)
          else await this._removeWriter(key)
        }
      }
    } finally {
      this.lock.unlock()
    }
  }

  async append(value) {
    if (!this.opened) await this.ready()
    if (typeof value === 'string') value = b4a.from(value)

    await this._systemBooting
    await this._writersBooting // TODO: remove

    await this.local.ready()
    const links = this.system.getLinks(this.local.key)
    const node = this.localWriter.append(value, links)
    await this._processBatch([node])
    await this.localWriter.flush()
    await this._bump()
  }
}

function noop() {}

function isObject(o) {
  return typeof o === 'object' && o && !b4a.isBuffer(o)
}
