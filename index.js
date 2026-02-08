const ReadyResource = require('ready-resource')
const b4a = require('b4a')
const ScopeLock = require('scope-lock')
const Hyperbee = require('hyperbee2')
const ID = require('hypercore-id-encoding')
const System = require('./lib/system.js')
const ApplyCalls = require('./lib/apply-calls.js')
const { Writer } = require('./lib/writers.js')

module.exports = class Autobee extends ReadyResource {
  constructor(store, key = null, handlers = {}) {
    super()

    if (isObject(key)) {
      handlers = key
      key = null
    }

    const { name = null } = handlers

    const bee = new Hyperbee(store.namespace('view'))

    this.store = store
    this.key = key ? ID.decode(key) : null
    this.discoveryKey = null
    this.id = null

    this.system = new System(store.namespace('system'), name)
    this.bee = bee.snapshot()
    this.view = handlers.open ? handlers.open(this.bee) : this.bee

    this.name = name // for debugging

    this.local = store.get({ name: 'local', exclusive: true })
    this.writers = new Map()
    this.localWriter = null
    this.lock = new ScopeLock()
    this.bumping = 0

    this._workingBee = bee
    this._workingView = handlers.open ? handlers.open(this._workingBee) : this._workingBee
    this._writersBooting = null
    this._systemBooting = null

    this._handlers = handlers
    this._hasApply = !!handlers.apply
    this._needsUpdate = false
    this._host = new ApplyCalls(this)
  }

  async _open() {
    await this.local.ready()
    await this.bee.ready()

    this.localWriter = new Writer(this.local)
    this.writers.set(this.localWriter.id, this.localWriter)

    if (!this.key) {
      this.key = this.local.key
      this.discoveryKey = this.local.discoveryKey
      this.id = this.local.id
    }

    if (!b4a.equals(this.local.key, this.key)) {
      const bootstrap = await this._addWriter(this.key)
      this.key = bootstrap.core.key
      this.discoveryKey = bootstrap.core.discoveryKey
      this.id = bootstrap.core.id
    }

    this._systemBooting = this.system.boot(this.bee)
    this._writersBooting = this._boot() // bg
  }

  async _close() {
    if (this._handlers.open) await this._handlers.close(this.view)

    await this.local.close()
    await this.system.close()
    await this._workingBee.close()
    await this.bee.close()
    await this.store.close()
  }

  replicate(...args) {
    return this.store.replicate(...args)
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
          this._needsUpdate = updated = true
        }
      }

      if (this.bumping === 1) this.bumping = 0
      else this.bumping = 1
    }

    if (this._needsUpdate) await this._update()
  }

  _update() {
    this._needsUpdate = false
    this.bee.update(this._workingBee.root)
  }

  async _addWriter(key) {
    const id = b4a.toString(key, 'hex')
    let w = this.writers.get(id)
    if (w) return w
    const core = this.store.get(key)
    await core.ready()
    core.on('append', () => this._bump())
    w = new Writer(core)
    this.writers.set(id, w)
    return w
  }

  async _processBatch(batch) {
    await this.lock.lock()

    try {
      const t = await this.system.prepare(batch)

      if (t.view) {
        this._workingBee.move(t.view)
      }

      for (const batch of t.tip) {
        if (this._hasApply) await this._handlers.apply(batch, this._workingView, this._host)

        const changed = await this.system.flush(batch, this._workingBee)

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
    this._needsUpdate = true

    await this.localWriter.flush()
    await this._bump()
  }
}

function isObject(o) {
  return typeof o === 'object' && o && !b4a.isBuffer(o)
}
