const ReadyResource = require('ready-resource')
const ReadyGuard = require('ready-guard')
const b4a = require('b4a')
const safetyCatch = require('safety-catch')
const Hyperbee = require('hyperbee2')
const ID = require('hypercore-id-encoding')
const rrp = require('resolve-reject-promise')
const { AutobeeEncryption, WriterEncryption, ViewEncryption } = require('autobee-encryption')
const AutobeeWakeup = require('autobee-wakeup')
const Hypercore = require('hypercore')
const crypto = require('hypercore-crypto')
const c = require('compact-encoding')
const asserts = require('./lib/asserts.js')
const boot = require('./lib/boot.js')
const encoding = require('./lib/encoding.js')
const Reboot = require('./lib/reboot.js')
const System = require('./lib/system.js')
const ApplyCalls = require('./lib/apply-calls.js')
const topo = require('./lib/topo.js')
const { ActiveWriters } = require('./lib/writers.js')
const UpdateChanges = require('./lib/updates.js')

const EMPTY_HEAD = { length: 0, key: null }
const INTERRUPT = new Error('Apply interrupted')
const MIN_FF_GAP = 32

module.exports = class Autobee extends ReadyResource {
  constructor(store, key = null, handlers = {}) {
    super()

    if (isObject(key)) {
      handlers = key
      key = null
    }

    const { name = null, encrypted, encryptionKey, viewName = 'view' } = handlers

    this.encrypted = encrypted === true || !!encryptionKey

    this.getSystemEncryption = this._getEncryptionProvider.bind(this, '_system')
    this.getViewEncryption = this._getEncryptionProvider.bind(this, viewName)

    const bee = new Hyperbee(store.namespace('view'), {
      // defer one tick to ensure consistent state, then return state prom
      preload: async () => {
        await 1
        if (!this._bootGuard.opened) await this._bootGuard.ready()
      },
      getEncryptionProvider: this.getViewEncryption
    })

    this.store = store

    this.key = key ? ID.decode(key) : null
    this.discoveryKey = null
    this.id = null
    this.bootstrap = null
    this.handlers = handlers

    this.system = new System(this.store.namespace('system'), this.name, {
      getEncryptionProvider: this.getSystemEncryption,
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

    // system head to boot from: migrates or fast-forwards depending on its version
    this.bootFrom = handlers.bootFrom || null

    this.reboot = null
    this.rebooting = null
    this.rebootTo = null

    this._workingBee = bee
    this._workingView = handlers.open ? handlers.open(this._workingBee, this) : this._workingBee

    this._localSystemStart = 0
    this._localSystemLength = 0
    this._localViewStart = 0
    this._localViewLength = 0

    this._appending = []
    this._draining = null

    this.legacyViews = handlers.legacyViews || []

    this._bootGuard = new ReadyGuard()
    this._bootingState = null
    this._bootingAll = null

    this._handlers = handlers
    this._hasApply = !!handlers.apply
    this._hasUpdate = !!handlers.update
    this._needsUpdate = false
    this._updateLocalCore = null
    this._host = new ApplyCalls(this)
    this._notifyHandler = null

    this.interrupted = null
    this._interrupting = false
    this._onErrorBound = this._onError.bind(this)
    this._bumpSoonBound = this.bumpSoon.bind(this)
    this._onGroupUpdateBound = this._onGroupUpdate.bind(this)

    this.wakeupCapability = null
    this._wakeup = new AutobeeWakeup(this, handlers)
    this.previousDrain = 0

    this._catchupMigratedNodes = null

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

    this._localSystemStart = this.system.bee.context.local.length
    this._localViewStart = this._workingBee.context.local.length

    this.bumpSoon()
  }

  _registerWakeup() {
    if (!this.wakeupCapability) return
    this._wakeup.recouple()
    this._wakeup.setCapability(this.wakeupCapability.key, this.wakeupCapability.discoveryKey)
  }

  getExternalWriters() {
    const keys = []
    for (const w of this.writers.active.values()) {
      if (w === this.writers.localWriter) continue
      keys.push(w.core.key)
    }
    return keys
  }

  getWriterViews(key) {
    const id = b4a.toString(key, 'hex')
    const w = this.writers.active.get(id)
    if (!w) return []
    return w.views()
  }

  static getViewEncryption(bootstrap, encryptionKey, name) {
    return AutobeeEncryption.getViewEncryption(bootstrap, encryptionKey, name)
  }

  views() {
    const sys = this.system.bee.context.local
    const view = this._workingBee.context.local

    // todo: figure out why blind-peer doesn't mirror core
    // without adding it to mirror request here
    const head = this.system.bee.head()

    // signedLength for autobase compat
    return [
      { key: sys.key, length: sys.length, signedLength: sys.length },
      { key: view.key, length: view.length, signedLength: view.length },
      { key: head.key, length: head.length, signedLength: head.length }
    ]
  }

  async _close() {
    this._interrupting = true
    if (this._notifyHandler) this._notifyHandler.destroy()
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

  _getEncryptionProvider(view) {
    if (!this.encrypted) return null
    if (view) return new ViewEncryption(this, view)
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

  getMostRecentHead() {
    return topo.getMostRecentHead(this, this.system.bee.snapshot())
  }

  async _bootState() {
    if (!this._bootGuard.enter()) return this._bootGuard.ready()

    const result = await boot(this.store, this.key, this.legacyViews, {
      encryptionKey: this.encryptionKey,
      keyPair: this.keyPair
    })

    this.key = result.key
    this.bootstrap = result.bootstrap
    this.discoveryKey = result.bootstrap.core.discoveryKey
    this.id = result.bootstrap.core.id
    this.encryptionKey = result.encryptionKey
    this.previousDrain = result.previousDrain

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

    if (this.wakeupCapability) {
      if (this.bootstrap !== this.local) {
        await this.bootstrap.setGroup(this.wakeupCapability.discoveryKey)
      }

      this._notifyHandler = this.store.notifyGroup(this.wakeupCapability.discoveryKey)
      this._notifyHandler.on('update', this._onGroupUpdateBound)
      await this._drainBootHints()
    }

    const system = result.system || EMPTY_HEAD

    await this.system.boot(system)

    // Use the view position from the system info (authoritative, post-processing)
    // rather than from the oplog (stale, captured at append time before _bump)
    let view = this.system.view || EMPTY_HEAD

    // @todo migration
    if (result.migration) {
      if (this.handlers.migrate) {
        view = (await this.handlers.migrate(result.migration.views)) || EMPTY_HEAD
        this._catchupMigratedNodes = result.migration.catchup
      }

      // ff boot invalidated by migration
      this.bootFrom = null

      // clear legacy data
      await this.bootstrap.setUserData('autobase/local', null)
      await this.local.setUserData('autobase/boot', null)
      await this.local.setUserData('autobase/encryption', null)

      for (const batch of result.migration.catchup) {
        const { key, length } = batch[batch.length - 1]
        this.writers.wakeup(key, length)
      }
    }

    this._workingBee.move(view)
    this.bee.move(view)

    await this.writers.updateLocalState()

    this._bootGuard.exit()

    return this._bootGuard.ready()
  }

  async _bootAll() {
    if (!this._bootGuard.opened) await this._bootGuard.ready()

    for await (const node of this.system.list()) {
      await this.writers.add(node.key)
    }
    await this._bump()
  }

  bumpSoon() {
    this._bump().catch(safetyCatch)
  }

  async _bump() {
    if (!this._bootGuard.opened) await this._bootGuard.ready()

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
    if (this.bootFrom) {
      await this._initFromHead(this.bootFrom)
      this.bootFrom = null
    }

    const changes = this._hasUpdate ? new UpdateChanges(this) : null
    if (changes) changes.track()

    // Anything expecting work to be done during bumpSoon should do it here
    while (!this._interrupting && this.bumping > 0) {
      if (this._interrupting) break

      // Ensure we catch updates during the drain (i.e. setLocal will bump)
      if (this._updateLocalCore !== null) {
        await this._rotateLocalWriter(this._updateLocalCore)
      }

      try {
        while (!this._interrupting) {
          if (this.rebootTo !== null) {
            await this._applyReboot()
            break // revaluate conditions...
          }

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
      await this._update(changes)
    }
  }

  _onGroupUpdate({ key, length }) {
    this._wakeup.hint({ key, length })
    this.bumpSoon()
  }

  async _drainBootHints() {
    if (!this._notifyHandler) return

    const keys = []
    for await (const key of this._notifyHandler.updates({ since: this.previousDrain })) {
      keys.push(key)
    }
    if (!keys.length) return

    // read the lengths straight from storage in one batch instead of opening cores
    const discoveryKeys = keys.map((key) => crypto.discoveryKey(key))
    const infos = await this.store.storage.getInfos(discoveryKeys, {
      auth: false,
      head: true,
      hints: false
    })

    for (let i = 0; i < keys.length; i++) {
      const info = infos[i]
      const length = info && info.head ? info.head.length : 0
      this._wakeup.hint({ key: keys[i], length })
    }
  }

  async _flushWakeup() {
    const hints = this._wakeup.flush()

    this.previousDrain = Date.now()
    this.rebootFromHeads(hints).catch(noop)

    for (const [hex, length] of hints) {
      const key = b4a.from(hex, 'hex')
      if (this.writers.has(hex)) continue
      await this.writers.wakeup(key, length)
    }
  }

  async _getOplog(key, length) {
    const core = this.openCore(key)
    await core.ready()

    const target = length >= 0 ? length : core.length
    if (target === 0) return null

    const buf = await core.get(target - 1)
    let op = encoding.decodeOplog(buf)

    if (op.version < 3) {
      op = await this._inflateLegacyOplog(buf, core, target - 1)
    }

    await core.close()

    if (buf === null) return null

    return {
      key,
      length: target,
      op
    }
  }

  async _inflateLegacyOplog(buf, core, seq) {
    const m = encoding.decodeRawOplog(buf)
    const fetches = []

    fetches.push(m.digest.pointer ? core.get(seq - m.digest.pointer) : buf)
    fetches.push(m.checkpoint.pointer ? core.get(seq - m.checkpoint.system.checkpointer) : buf)

    const [digestNode, checkpointNode] = await Promise.all(fetches)

    const { digest } = encoding.decodeRawOplog(digestNode)
    const { checkpoint } = encoding.decodeRawOplog(checkpointNode)

    return {
      version: m.version,
      timestamp: 0,
      links: m.node.heads,
      batch: { start: 0, end: m.node.batch - 1 },
      views: {
        system: {
          key: digest.key,
          length: checkpoint.system.checkpoint.length
        },
        flushes: seq
      },
      optimistic: !!m.optimistic,
      value: m.node.value
    }
  }

  async _update(changes) {
    this._needsUpdate = false
    this.bee.update(this._workingBee.root)

    if (!changes) return

    changes.finalise()
    await this._handlers.update(this.view, changes)
  }

  async setLocal(key, { keyPair } = {}) {
    if (!this.opened) await this.ready()
    if (this.closing) throw new Error('Autobee closed')

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
    this.bumpSoon()
  }

  async _rotateLocalWriter(newLocal) {
    asserts.assert(!this.appending, 'Cannot rotate a newLocal writer if an append is in progress')

    const oldLocal = this.local

    this.local = newLocal
    await this.writers.rotateLocalWriter(this.local)

    this._updateLocalCore = null

    this.local.setUserData('referrer', this.key)
    if (this.encryptionKey) {
      await this.local.setUserData('autobee/encryption', this.encryptionKey)
    }

    await this.bootstrap.setUserData('autobee/local', this.local.key)
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

  async _bumpMigratedWriters() {
    for (const batch of this._catchupMigratedNodes) {
      await this._processBatch(batch)
    }
  }

  async _bumpPendingWriters() {
    if (this._catchupMigratedNodes !== null) {
      await this._bumpMigratedWriters()
      this._catchupMigratedNodes = null
    }

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

    return this._processApplyBatch(t)
  }

  async _processApplyBatch(t) {
    // first writer is always added with full permissions
    if (this.system.isGenesis()) {
      await this._host.addWriter(t.tip[0][0].key)
    }

    for (let i = 0; i < t.tip.length; i++) {
      await this._applyBatch(t.tip[i], t.tip[i][0].optimistic)
    }
  }

  async _applyBatch(batch, optimistic) {
    const local = batch[0].core === this.local

    const userBatch = []
    for (const node of batch) {
      this.system.addNode(node)

      // compat: autobase nodes may be null (legacy null decodes to 0-length buffer)
      if (node.value && node.value.length) userBatch.push(node)
    }

    if (this._hasApply && (await this.system.canApply(batch[0].key, optimistic))) {
      this._host.applying = batch
      await this._handlers.apply(userBatch, this._workingView, this._host)
      this._host.applying = null
    }

    const changed = await this.system.flush(batch, this._workingBee)

    if (local) {
      this._localSystemLength = this.system.bee.context.local.length - this._localSystemStart
      this._localViewLength = this._workingBee.context.local.length - this._localViewStart
    }

    await this._storeBoot()

    for (const { key, added } of changed) {
      if (added) await this.writers.add(key)
      else await this.writers.remove(key)
    }
  }

  _storeBoot() {
    const proms = []
    proms.push(
      this.local.setUserData(
        'autobee/previous-drain',
        encoding.encodePreviousDrain(this.previousDrain)
      )
    )

    const boot = this.system.bootRecord()
    if (boot) {
      proms.push(this.local.setUserData('autobee/head', encoding.encodeBootRecord(boot)))
    }

    return Promise.all(proms)
  }

  static decodeValue(buf, opts) {
    return encoding.decodeValue(buf, opts)
  }

  static encodeValue(value, opts) {
    return encoding.encodeValue(value, opts)
  }

  async wakeup({ key, length }) {
    if (!this._bootGuard.opened) await this._bootGuard.ready()
    await this.writers.wakeup(key, length)
    await this._bump()
  }

  async append(values, { optimistic = false } = {}) {
    if (this.closing) throw new Error('Autobee closed')

    if (!Array.isArray(values)) values = [values]

    if (!this.opened) await this.ready()

    if (!optimistic && this.writers.localWriter.isRemoved) {
      throw new Error('Not writable')
    }

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
    await this.writers.flushLocal({
      flushes: this.system.flushes,
      system: {
        key: this.system.bee.context.local.key,
        start: this._localSystemStart,
        length: this._localSystemLength
      },
      view: {
        key: this._workingBee.context.local.key,
        start: this._localViewStart,
        length: this._localViewLength
      }
    })

    this._localSystemStart = this.system.bee.context.local.length
    this._localSystemLength = 0
    this._localViewStart = this._workingBee.context.local.length
    this._localViewLength = 0
  }

  async rebootFromHeads(hints, { force = false } = {}) {
    if (!this._handlers.onwakeup) return false
    if (!hints.size || this.rebooting || this.rebootTo || this.bootFrom) {
      return false
    }

    const promises = []
    const heads = []
    for (const [hex, length] of hints) {
      if (length === 0) continue
      const key = b4a.from(hex, 'hex')
      heads.push({ key, length })
      promises.push(this._getOplog(key, length))
    }

    const ops = await Promise.all(promises)
    if (this.rebooting || this.rebootTo) return false

    let best = null
    let bestFlushes = -1

    for (let i = 0; i < ops.length; i++) {
      const res = ops[i]
      if (res === null) continue

      if (res.op.views && res.op.views.flushes > bestFlushes) {
        bestFlushes = res.op.views.flushes
        best = res
      }
    }

    if (best && force) {
      return this._rebootFromHead(best, null, { force: true })
    }

    if (best === null || bestFlushes - this.system.flushes < MIN_FF_GAP) return false

    const head = { key: best.key, length: best.length }

    const v = best.op.views.view
    const view = this.bee.checkout({ key: v.key, length: v.start + v.length })

    let trusted = null
    try {
      trusted = await this._handlers.onwakeup(head, view, this)
      if (!trusted || this.rebooting || this.rebootTo) return false
    } finally {
      view.close()
    }

    return this._rebootFromHead(best, trusted)
  }

  async _rebootFromHead(head, trusted, { force = false, wait = true } = {}) {
    const oplog = await this._getOplog(head.key, head.length)
    if (!oplog) return false

    const verified = trusted ? await this._getOplog(trusted.key, trusted.length) : oplog

    if (!verified.op.views) return null

    if (!force && verified.op.views.flushes - this.system.flushes < MIN_FF_GAP) {
      return false
    }

    const moved = await this._moveTo(batchToHead(verified.op.views.system), {
      system: batchToHead(oplog.op.views.system),
      verified: {
        op: trusted || head,
        flushes: verified.op.views.flushes
      }
    })

    if (moved && wait) return this.reboot.promise

    return null
  }

  // same as moveTo except we don't return the final promise
  _initFromHead(head, tip) {
    if (!head.length) {
      // legacy fastForward boot
      return this._runReboot(new Reboot(this, head, tip))
    }

    return this._rebootFromHead(head, null, { force: true, wait: false })
  }

  // head is a system head; reboots onto it, migrating in place if it's a legacy version
  async _moveTo(systemHead, tip) {
    if (this.rebootTo !== null || this.rebooting !== null) return false

    if (await this._runReboot(new Reboot(this, systemHead, tip))) {
      return true
    }

    return false
  }

  async _runReboot(reboot) {
    this.rebooting = reboot

    const result = await reboot.run()
    await reboot.close()

    if (this.rebooting === reboot) this.rebooting = null

    if (!result) return false

    this.rebootTo = result
    this.reboot = rrp()

    this.bumpSoon()

    return true
  }

  async _applyReboot() {
    const changes = this._hasUpdate ? new UpdateChanges(this) : null

    const { head, tip, migrate } = this.rebootTo

    const from = this.system.bee.head()
    const to = head

    this.system.bee.move(head)
    await this.system.reset()

    // migrate is set when fast-forwarding from a legacy head
    if (migrate) {
      const view = (await this.handlers.migrate(migrate)) || EMPTY_HEAD
      this.bee.move(view)
      this._workingBee.move(view)
    } else {
      this.bee.move(this.system.view)
      this._workingBee.move(this.system.view)
    }

    this.rebootTo = null
    await this.writers.refresh()

    await this._update(changes)

    this.emit('move-to', to, from)
    this.reboot.resolve({ to, from })

    // tip is null during boot
    if (!tip) return

    try {
      await this._reapply(tip)
    } catch (err) {
      throw err
    }
  }

  async _reapply({ system, verified }) {
    const changes = this._hasUpdate ? new UpdateChanges(this) : null

    const sys = this.system.bee.checkout(system)
    const t = await topo.rollback(this, sys, verified)
    await sys.close()

    await this._processApplyBatch(t)
    return this._update(changes)
  }

  replay() {
    return topo.replay(this)
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

function batchToHead(b) {
  return {
    key: b.key,
    length: b.start + b.length
  }
}
