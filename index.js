const ReadyResource = require('ready-resource')
const b4a = require('b4a')
const ScopeLock = require('scope-lock')
const Hyperbee = require('hyperbee2')
const System = require('./lib/system.js')
const encoding = require('./lib/encoding.js')
const { Writer } = require('./lib/writers.js')

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
    this.bumping++

    while (this.bumping === 1) {
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

      if (this.bumping === 1) this.bumping = 0
      else this.bumping = 1
    }
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

  async append(values) {
    if (!Array.isArray(values)) values = [values]

    if (!this.opened) await this.ready()

    await this._systemBooting
    await this.local.ready()

    const links = this.system.getLinks(this.local.key)
    const batch = []
    const t = Date.now()

    for (let i = 0; i < values.length; i++) {
      const value = values[i]
      const buffer = typeof value === 'string' ? b4a.from(value) : value
      const lnk = i === 0 ? links : []
      const b = { start: i, end: values.length - 1 - i }

      const node = this.localWriter.append(buffer, t, b, lnk)
      batch.push(node)
    }

    await this._processBatch(batch)

    await this.localWriter.flush()
    await this._bump()
  }
}

function noop() {}

function isObject(o) {
  return typeof o === 'object' && o && !b4a.isBuffer(o)
}
