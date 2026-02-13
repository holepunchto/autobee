const ReadyResource = require('ready-resource')
const b4a = require('b4a')
const ScopeLock = require('scope-lock')
const Hyperbee = require('hyperbee2')
const ID = require('hypercore-id-encoding')
const asserts = require('./lib/asserts.js')
const encoding = require('./lib/encoding.js')
const System = require('./lib/system.js')
const ApplyCalls = require('./lib/apply-calls.js')
const { ActiveWriters } = require('./lib/writers.js')

const EMPTY_HEAD = { length: 0, key: null }

module.exports = class Autobee extends ReadyResource {
  constructor(store, key = null, handlers = {}) {
    super()

    if (isObject(key)) {
      handlers = key
      key = null
    }

    const { name = null } = handlers

    const bee = new Hyperbee(store.namespace('view'), {
      // defer one tick to ensure consistent state, then return state prom
      preload: async () => {
        await 1
        await this._bootingState
      }
    })

    this.store = store
    this.key = key ? ID.decode(key) : null
    this.discoveryKey = null
    this.id = null

    this.system = new System(store.namespace('system'), name)
    this.bee = bee.snapshot()
    this.view = handlers.open ? handlers.open(this.bee) : this.bee

    this.name = name // for debugging

    this.local = store.get({ name: 'local', exclusive: true })
    this.writers = null
    this.lock = new ScopeLock()
    this.bumping = 0

    this._workingBee = bee
    this._workingView = handlers.open ? handlers.open(this._workingBee) : this._workingBee

    this._bootingState = null
    this._bootingSystem = null
    this._bootingAll = null

    this._handlers = handlers
    this._hasApply = !!handlers.apply
    this._needsUpdate = false
    this._host = new ApplyCalls(this)

    this.ready().catch(noop)
  }

  get writable() {
    return this.writers.writable
  }

  async _open() {
    this._bootingState = this._bootState()
    this._bootingSystem = this._bootSystem()
    this._bootingAll = this._bootAll() // bg

    this._bootingState.catch(noop)
    this._bootingSystem.catch(noop)
    this._bootingAll.catch(noop)

    await this.bee.ready()
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

  async flush() {
    await this._bootingAll
    await this.lock.flush()
  }

  async _bootState() {
    await this.local.ready()

    this.writers = new ActiveWriters(this)

    if (!this.key) {
      this.key = this.local.key
      this.discoveryKey = this.local.discoveryKey
      this.id = this.local.id
    }

    if (!b4a.equals(this.local.key, this.key)) {
      const bootstrap = await this.writers.add(this.key)
      this.key = bootstrap.core.key
      this.discoveryKey = bootstrap.core.discoveryKey
      this.id = bootstrap.core.id
    }
  }

  async _bootSystem() {
    await this._bootingState

    const oplog = await this.writers.getLatestLocalOplog()
    const views = oplog ? oplog.views : null
    const system = views ? views.system : EMPTY_HEAD

    await this.system.boot(system)

    this._workingBee.move(system.view)
    this.bee.move(system.view)

    await this.writers.updateLocalState()
  }

  async _bootAll() {
    await this._bootingSystem

    for await (const node of this.system.list()) {
      await this.writers.add(node.key)
    }
    await this._bump()
  }

  bumpSoon() {
    this._bump().catch(noop)
  }

  async _bump() {
    this.bumping++

    while (this.bumping === 1) {
      await this.lock.lock()

      try {
        let updated = true

        while (updated) {
          updated = false
          for (const w of this.writers.external()) {
            const batch = await w.next(this.system)
            if (batch === null) continue
            await this._processBatch(batch)
            this._needsUpdate = updated = true
          }
        }
      } finally {
        if (this.bumping === 1) this.bumping = 0
        else this.bumping = 1
        this.lock.unlock()
      }
    }

    if (this._needsUpdate) await this._update()
  }

  _update() {
    this._needsUpdate = false
    this.bee.update(this._workingBee.root)
  }

  async _optimisticBatch(batch) {
    await this.lock.lock()

    try {
      const rollbackSystem = this.system.bee.head()
      const rollbackView = this._workingBee.head()

      const t = await this.system.prepare(batch)

      if (t.view) {
        this._workingBee.move(t.view)
      }

      asserts.assert(batch === t.tip[0], 'Batch must be first part of tip')

      let failed = false

      try {
        await this._applyBatch(batch)
      } catch {
        failed = true
      }

      const w = failed ? null : await this.system.get(batch[0].key)
      if (!w || w.length < batch[0].length) {
        this._workingBee.move(rollbackView)
        this.system.bee.move(rollbackSystem)
        await this.system.reset()
        return false
      }

      for (let i = 1; i < t.tip.length; i++) {
        await this._applyBatch(t.tip[i])
      }

      return true
    } finally {
      this.lock.unlock()
    }
  }

  async _processBatch(batch) {
    const t = await this.system.prepare(batch)

    if (t.view) {
      this._workingBee.move(t.view)
    }

    // first writer is always added with full permissions
    if (this.system.isGenesis()) {
      this._host.addWriter(t.tip[0][0].key)
    }

    for (let i = 0; i < t.tip.length; i++) {
      await this._applyBatch(t.tip[i])
    }
  }

  async _applyBatch(batch) {
    this._host.applying = batch
    if (this._hasApply) await this._handlers.apply(batch, this._workingView, this._host)
    this._host.applying = null

    const changed = await this.system.flush(batch, this._workingBee)

    for (const { key, added } of changed) {
      if (added) await this.writers.add(key)
      else await this.writers.remove(key)
    }
  }

  static decodeValue(buf, opts) {
    return encoding.decodeValue(buf, opts)
  }

  static encodeValue(value, opts) {
    return encoding.encodeValue(value, opts)
  }

  async wakeup({ key, length }) {
    await this._bootingSystem
    return this.writers.wakeup(key, length)
  }

  async append(values, { force = false, optimistic = false } = {}) {
    if (!Array.isArray(values)) values = [values]

    if (!this.opened) await this.ready()

    await this._bootingSystem
    await this.local.ready()

    const links = this.system.getLinks(this.local.key)
    const batch = []
    const t = Date.now()

    for (let i = 0; i < values.length; i++) {
      const value = values[i]
      const buffer = typeof value === 'string' ? b4a.from(value) : value
      const lnk = i === 0 ? links : []
      const b = { start: i, end: values.length - 1 - i }

      const node = this.writers.appendLocal(buffer, t, b, lnk, optimistic)
      batch.push(node)
    }

    await this.lock.lock()

    if (!this.writers.writable && !force && !optimistic) {
      this.writers.clearLocal()
      throw new Error('Not writable')
    }

    try {
      if (!(optimistic && this.system.isGenesis())) {
        await this._processBatch(batch)
      }
      this._needsUpdate = true
      // analyze is worth the trade off adding the view here also (technically not needed)
      await this.writers.flushLocal(this._workingBee.head())
    } finally {
      this.lock.unlock()
    }

    await this._bump()
  }
}

function isObject(o) {
  return typeof o === 'object' && o && !b4a.isBuffer(o)
}

function noop() {}
