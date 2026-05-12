const ReadyResource = require('ready-resource')
const b4a = require('b4a')
const safetyCatch = require('safety-catch')
const Hyperbee = require('hyperbee2')
const ID = require('hypercore-id-encoding')
const { AutobeeEncryption, WriterEncryption } = require('autobee-encryption')
const AutobeeWakeup = require('autobee-wakeup')
const Hypercore = require('hypercore')
const crypto = require('hypercore-crypto')
const c = require('compact-encoding')
const asserts = require('./lib/asserts.js')
const boot = require('./lib/boot.js')
const encoding = require('./lib/encoding.js')
const System = require('./lib/system.js')
const ApplyCalls = require('./lib/apply-calls.js')
const topo = require('./lib/topo.js')
const { ActiveWriters } = require('./lib/writers.js')
const UpdateChanges = require('./lib/updates.js')

const EMPTY_HEAD = { length: 0, key: null }
const INTERRUPT = new Error('Apply interrupted')

module.exports = class Autobee extends ReadyResource {
  constructor(store, key = null, handlers = {}) {
    super()

    if (isObject(key)) {
      handlers = key
      key = null
    }

    const { name = null, encrypted, encryptionKey } = handlers

    this.encrypted = encrypted === true || !!encryptionKey

    const bee = new Hyperbee(store.namespace('view'), {
      // defer one tick to ensure consistent state, then return state prom
      preload: async () => {
        await 1
        await this._bootingState
      },
      getEncryptionProvider: () => this._getEncryptionProvider()
    })

    this.store = store

    this.key = key ? ID.decode(key) : null
    this.discoveryKey = null
    this.id = null
    this.bootstrap = null

    this.system = new System(this.store.namespace('system'), this.name, {
      getEncryptionProvider: () => this._getEncryptionProvider(),
      encrypted: this.encrypted
    })

    this.bee = bee.snapshot()
    this.view = handlers.open ? handlers.open(this.bee, this) : this.bee
    this.optimistic = handlers.optimistic !== false // TODO: should default to false instead

    this.name = name // for debugging

    this.local = null
    this.encryptionKey = null
    this.keyPair = null
    this.writers = null
    this.bumping = 0

    this._workingBee = bee
    this._workingView = handlers.open ? handlers.open(this._workingBee, this) : this._workingBee

    this._appending = []
    this._draining = null

    this._bootingState = null
    this._bootingAll = null

    this._handlers = handlers
    this._hasApply = !!handlers.apply
    this._hasUpdate = !!handlers.update
    this._needsUpdate = false
    this._updateLocalCore = null
    this._host = new ApplyCalls(this)

    this.interrupted = null
    this._interrupting = false
    this._onErrorBound = this._onError.bind(this)

    this._wakeup = new AutobeeWakeup(this, handlers)
    this.wakeupCapability = null

    this.ready().catch(noop)
  }

  static GENESIS = EMPTY_HEAD

  static isAutobee(auto) {
    return auto instanceof Autobee
  }

  get isIndexer() {
    return this.writers.localWriter.isIndexer
  }

  get writable() {
    return this.writers.writable
  }

  // autobase compat
  get activeWriters() {
    return this.writers
  }

  async _open() {
    await this._preBoot()

    this._bootingState = this._bootState()
    this._bootingAll = this._bootAll()

    this._bootingState.catch(safetyCatch)
    this._bootingAll.catch(safetyCatch)

    await this.bee.ready()
    await this._bootingState

    this.bumpSoon()
  }

  _registerWakeup() {
    this._wakeup.recouple()
    this._wakeup.setCapability(this.wakeupCapability.key, this.wakeupCapability.discoveryKey)
  }

  views() {
    const sys = this.system.bee.context.local
    const view = this._workingBee.context.local

    // signedLength for autobase compat
    return [
      { key: sys.key, length: sys.length, signedLength: sys.length },
      { key: view.key, length: view.length, signedLength: view.length }
    ]
  }

  async _close() {
    this._interrupting = true
    if (this._draining) await this._draining

    if (this._handlers.close) await this._handlers.close(this.view)

    await this.local.close()
    await this.system.close()
    await this._wakeup.close()
    await this._workingBee.close()
    await this.bee.close()
    await this.store.close()

    try {
      await this._bootingAll
    } catch {}
  }

  replicate(...args) {
    const stream = this.store.replicate(...args)
    this._wakeup.addStream(stream)
    return stream
  }

  async flush() {
    await this._bootingAll
  }

  hintWakeup(wakeup) {
    this._wakeup.hint(wakeup)
  }

  openCore(key) {
    const encryption = this.encryptionKey ? new WriterEncryption(this) : null
    return this.store.get({ key, encryption })
  }

  _getEncryptionProvider() {
    if (!this.encrypted) return null
    return new WriterEncryption(this)
  }

  async _preBoot() {
    if (this._handlers.wait) await this._handlers.wait()

    await this.store.ready()

    if (this._handlers.encryptionKey) {
      this.encryptionKey = await this._handlers.encryptionKey
    }

    if (this._handlers.keyPair) {
      this.keyPair = await this._handlers.keyPair
    }
  }

  async _bootState() {
    const result = await boot(this.store, this.key, {
      encryptionKey: this.encryptionKey,
      keyPair: this.keyPair
    })

    this.key = result.key
    this.bootstrap = result.bootstrap
    this.discoveryKey = result.bootstrap.core.discoveryKey
    this.id = result.bootstrap.core.id
    this.encryptionKey = result.encryptionKey

    if (this.encrypted) {
      asserts.assert(this.encryptionKey !== null, 'Encryption key is expected')
    }

    this.local = result.local
    this.local.setEncryption(this._getEncryptionProvider())
    this.local.setActive(true)

    this.writers = new ActiveWriters(this)

    if (this._handlers.wakeupCapability) {
      this.wakeupCapability = await this._handlers.wakeupCapability
    } else {
      this.wakeupCapability = { key: this.key, discoveryKey: this.discoveryKey }
    }

    this._registerWakeup()

    const system = result.system || EMPTY_HEAD

    await this.system.boot(system)

    // Use the view position from the system info (authoritative, post-processing)
    // rather than from the oplog (stale, captured at append time before _bump)
    const view = this.system.view || EMPTY_HEAD

    this._workingBee.move(view)
    this.bee.move(view)

    await this.writers.updateLocalState()
  }

  async _bootAll() {
    await this._bootingState

    for await (const node of this.system.list()) {
      await this.writers.add(node.key)
    }
    await this._bump()
  }

  bumpSoon() {
    this._bump().catch(safetyCatch)
  }

  async _bump() {
    await this._flushWakeup()
    this.bumping++

    if (!this._draining) {
      this._draining = this._drain().catch(this._onErrorBound)
    }

    return this._draining
  }

  update() {
    return this._bump()
  }

  async updated() {
    if (this.opened === false) await this.ready()
    if (this._draining) return this._draining
    return Promise.resolve()
  }

  interrupt(reason) {
    asserts.assert(!!this._host.applying, 'Interrupt is only allowed in apply')
    this._interrupting = true
    if (reason) this.interrupted = reason
    throw INTERRUPT
  }

  getLastError() {
    return this._lastError
  }

  _onError(err) {
    if (this.closing) return

    this._lastError = err

    if (err === INTERRUPT) {
      this.emit('interrupt', this.interrupted)
      this.emit('update')
      return
    }

    this.close().catch(safetyCatch)

    // if no one is listening we should crash! we cannot rely on the EE here
    // as this is wrapped in a promise so instead of nextTick throw it
    if (ReadyResource.listenerCount(this, 'error') === 0) {
      crashSoon(err)
      return
    }

    this.emit('error', err)
  }

  async _drain() {
    if (this._updateLocalCore !== null) {
      await this._rotateLocalWriter(this._updateLocalCore)
    }

    const changes = this._hasUpdate ? new UpdateChanges(this) : null
    if (changes) changes.track()

    while (!this._interrupting && this.bumping > 0) {
      if (this._interrupting) return

      try {
        while (!this._interrupting) {
          if (!(await this._bumpPendingWriters())) break
          this._needsUpdate = true
        }

        await this._flushLocal()
      } finally {
        if (this.bumping === 1) this.bumping = 0
        else this.bumping = 1
      }
    }

    this._draining = null
    if (this._interrupting) return

    if (this._needsUpdate) {
      this._update(changes)
    }
  }

  async _flushWakeup() {
    const hints = this._wakeup.flush()

    const ff = await this._handleWakeup(hints)

    // @todo fast-forward

    for (const [hex, length] of hints) {
      const key = b4a.from(hex, 'hex')
      if (this.writers.has(hex)) continue
      if (length !== -1) {
        const info = await this.system.get(key)
        if (info && length <= info.length) continue // stale hint
      }
      await this.writers.wakeup(key, length === -1 ? 0 : length)
    }
  }

  async _handleWakeup(hints) {
    let best = null
    let bestFlushes = -1

    for (const [hex, length] of hints) {
      if (length <= 0) continue
      const key = b4a.from(hex, 'hex')
      const core = this.openCore(key)
      await core.ready()
      const buf = await core.get(length - 1)
      await core.close()

      if (buf === null) continue

      const msg = encoding.decodeOplog(buf)
      require('bugbear').log('wakeup', { hex, length, buf, msg }, hex)
      if (msg.views && msg.views.flushes > bestFlushes) {
        bestFlushes = msg.views.flushes
        best = msg.views
      }
    }

    if (best === null || !this._handlers.onwakeup) return

    const view = this.bee.checkout({ length: best.view.length })
    try {
      const ff = await this._handlers.onwakeup(view)
      return ff
    } finally {
      view.close()
    }
  }

  _update(changes) {
    this._needsUpdate = false
    this.bee.update(this._workingBee.root)

    if (!changes) return

    changes.finalise()
    this._handlers.update(this.view, changes)
  }

  async setLocal(key, { keyPair } = {}) {
    if (!this.opened) await this.ready()

    const manifest = keyPair
      ? { version: this.store.manifestVersion, signers: [{ publicKey: keyPair.publicKey }] }
      : null
    if (!key) key = Hypercore.key(manifest)
    // If the keys are the same, no need to rotate
    if (b4a.equals(key, this.local.key)) return

    const encryption = this.encryptionKey ? this._getEncryptionProvider() : null

    const local = this.store.get({
      key,
      manifest,
      active: false,
      exclusive: true,
      encryption
    })
    await local.ready()

    this._updateLocalCore = local

    let runs = 0
    while (!this._interrupting && this.appending && runs++ < 16) await this.update()
    await this.bumpSoon()
  }

  async _rotateLocalWriter(newLocal) {
    asserts.assert(!this.appending, 'Cannot rotate a newLocal writer if an append is in progress')

    const oldLocal = this.local

    this.local = newLocal
    this.writers.rotateLocalWriter(this.local)

    this._updateLocalCore = null

    this.local.setUserData('referrer', this.key)
    if (this.encryptionKey) {
      await this.local.setUserData('autobase/encryption', this.encryptionKey)
    }

    await this.bootstrap.setUserData('autobase/local', this.local.key)
    await oldLocal.close()

    // done, soft reboot
    this.emit('rotate-local-writer')
  }

  async createAnchor() {
    const node = this._host.applying[this._host.applying.length - 1]

    const key = node.key
    const length = node.length
    const legacy = node.version <= 2

    const info = await this.system.get(key, { unflushed: true })
    if (!info || info.length < length) throw new Error('Anchor node is not in system')

    const state = { start: 0, end: 40, buffer: b4a.alloc(40) }
    c.fixed32.encode(state, key)
    c.uint64.encode(state, length)

    const namespace = crypto.hash(state.buffer)
    const manifestData = c.encode(encoding.ManifestData, { version: 0, legacyBlocks: 0, namespace })

    const padding = this.encryptionKey ? AutobeeEncryption.PADDING : 0
    const links = [{ key, length }]

    const block = Autobee.encodeValue(null, {
      legacy,
      timestamp: 0,
      links,
      heads: links, // legacy compat
      padding
    })

    if (this.encryptionKey) {
      AutobeeEncryption.encryptAnchor(block, this.key, this.encryptionKey, namespace)
    }

    const root = { index: 0, size: block.byteLength, hash: crypto.data(block) }
    const hash = crypto.tree([root])
    const prologue = { hash, length: 1 }

    const core = createAnchorCore(this.store, prologue, manifestData)
    await core.ready()

    if (core.length === 0) {
      await core.append(block, { writable: true, maxLength: 1 })
    }

    await this.system.addWriter(core.key, { weight: 1 })

    const anchor = { key: core.key, length: core.length }

    await core.close()

    return anchor
  }

  async _bumpPendingWriters() {
    let updated = false

    const pending = this.writers.pending.slice()

    for (let i = pending.length - 1; i >= 0; i--) {
      const w = pending[i]

      const batch = await w.next()
      if (batch === null) continue

      if (w.isAdded || (w.isRemoved && w.hasReferrals())) {
        await this._processBatch(batch)
        w.notify(batch)
        updated = true
        continue
      }

      if (this.optimistic && !w.isRemoved && batch[0].optimistic) {
        if (!(await this._optimisticBatch(batch))) {
          w.removePending()
          continue
        }
        w.notify(batch)
        updated = true
        continue
      }
    }

    return updated
  }

  async _optimisticBatch(batch) {
    const rollbackSystem = this.system.bee.head()
    const rollbackView = this._workingBee.head()

    const t = await this.prepareBatch(batch)

    if (t.view) {
      this._workingBee.move(t.view)
    }

    let failed = true

    try {
      if (await this.system.canApply(batch[0].key, true)) {
        await this._applyBatch(batch, true)
        failed = false
      }
    } catch {}

    const w = failed ? null : await this.system.get(batch[0].key)
    if (!w || w.length < batch[0].length) {
      this._workingBee.move(rollbackView)
      this.system.bee.move(rollbackSystem)
      await this.system.reset()
      return false
    }

    for (let i = 1; i < t.tip.length; i++) {
      await this._applyBatch(t.tip[i], t.tip[i][0].optimistic)
    }

    return true
  }

  async prepareBatch(batch) {
    const node = batch[0]

    if (topo.isLinkingAll(node, this.system.heads)) {
      return { undo: null, view: null, tip: [batch] }
    }

    const t = await topo.sort(this, batch)

    if (t.undo) {
      t.view = await this.system.undo(t.undo)
    }

    return t
  }

  async _processBatch(batch) {
    const t = await this.prepareBatch(batch)

    if (t.view) {
      this._workingBee.move(t.view)
    }

    // first writer is always added with full permissions
    if (this.system.isGenesis()) {
      await this._host.addWriter(t.tip[0][0].key)
    }

    for (let i = 0; i < t.tip.length; i++) {
      await this._applyBatch(t.tip[i], t.tip[i][0].optimistic)
    }
  }

  async _applyBatch(batch, optimistic) {
    const userBatch = []
    for (const node of batch) {
      this.system.addNode(node)

      // compat: autobase nodes may be null
      if (node.value) userBatch.push(node)
    }

    if (this._hasApply && (await this.system.canApply(batch[0].key, optimistic))) {
      this._host.applying = batch
      await this._handlers.apply(userBatch, this._workingView, this._host)
      this._host.applying = null
    }

    const changed = await this.system.flush(batch, this._workingBee)

    await this._storeBoot()

    for (const { key, added } of changed) {
      if (added) await this.writers.add(key)
      else await this.writers.remove(key)
    }
  }

  _storeBoot() {
    const boot = this.system.bootRecord()
    if (!boot) return
    return this.local.setUserData('autobee/head', encoding.encodeBootRecord(boot))
  }

  static decodeValue(buf, opts) {
    return encoding.decodeValue(buf, opts)
  }

  static encodeValue(value, opts) {
    return encoding.encodeValue(value, opts)
  }

  async wakeup({ key, length }) {
    await this._bootingState
    await this.writers.wakeup(key, length)
    await this._bump()
  }

  async append(values, { optimistic = false } = {}) {
    if (!Array.isArray(values)) values = [values]

    if (!this.opened) await this.ready()

    await this.local.ready()

    const links = this.system.getLinks(this.local.key)
    const t = Date.now()
    const batch = []

    for (let i = 0; i < values.length; i++) {
      const value = values[i]
      const buffer = typeof value === 'string' ? b4a.from(value) : value
      const lnk = i === 0 ? links : []
      const node = this.writers.appendLocal(buffer, t, null, lnk, optimistic)
      batch.push(node)
    }

    return this._bump()
  }

  async _flushLocal() {
    // analyze is worth the trade off adding the view here also (technically not needed)
    await this.writers.flushLocal(this._workingBee.head())
  }
}

function isObject(o) {
  return typeof o === 'object' && o && !b4a.isBuffer(o)
}

function noop() {}

function createAnchorCore(store, prologue, manifestData) {
  const manifest = {
    version: 2,
    hash: 'blake2b',
    prologue,
    allowPatch: false,
    quorum: 0,
    signers: [],
    userData: manifestData,
    linked: null
  }

  const core = store.get({
    manifest,
    active: false
  })

  return core
}

function crashSoon(err) {
  queueMicrotask(() => {
    throw err
  })
  throw err
}
