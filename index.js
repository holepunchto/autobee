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
const { resolveWeight, currentWeight } = require('./lib/witness.js')
const encoding = require('./lib/encoding.js')
const FastForward = require('./lib/fast-forward.js')
const System = require('./lib/system.js')
const ApplyCalls = require('./lib/apply-calls.js')
const topo = require('./lib/topo.js')
const { ActiveWriters } = require('./lib/writers.js')
const TrustedPeers = require('./lib/trusted.js')
const ApplyView = require('./lib/apply-view.js')
const UpdateChanges = require('./lib/updates.js')
const migrations = require('./lib/migrations.js')

const EMPTY_HEAD = { length: 0, key: null }
const INTERRUPT = new Error('Apply interrupted')

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
        await this._bootReady()
      },
      getEncryptionProvider: this.getViewEncryption
    })

    this.store = store

    this.key = key ? ID.decode(key) : null
    this.discoveryKey = null
    this.id = null
    this.bootstrap = null
    this._handlers = handlers
    this.stats = { undos: 0, fastForwards: 0, drains: 0, applies: 0, appends: 0 }

    this.system = new System(this.store.namespace('system'), this.name, {
      getEncryptionProvider: this.getSystemEncryption,
      encrypted: this.encrypted
    })
    this.system.auto = this

    this.bee = bee.snapshot()
    this.view = ApplyView.open(this.bee, this)
    this.optimistic = handlers.optimistic !== false // TODO: should default to false instead

    this.name = name // for debugging

    this.local = null
    this.encryptionKey = null
    this.keyPair = null
    this.writers = null
    this.bumping = 0

    // fastForward: false disables all fast-forwards - both wakeup and boot
    const fastForward = handlers.fastForward === false ? null : handlers.fastForward || {}

    this._ffEnabled = fastForward !== null

    // oplog head to boot from: migrates or fast-forwards depending on its version
    this.bootFrom = (fastForward && fastForward.boot) || null

    // conservative (default on): only fast-forward onto a head someone can serve whole
    this._conservativeFF = !fastForward || fastForward.conservative !== false

    this.trusted = new TrustedPeers(handlers)

    this.ff = null
    this.fastForwarding = null
    this.fastForwardTo = null

    this._workingBee = bee
    this._workingView = new ApplyView(this._workingBee, this)

    this._localSystemStart = 0
    this._localSystemLength = 0
    this._localFlushes = 0
    this._localViewStart = 0
    this._localViewLength = 0

    this._appending = []
    this._draining = null
    this._bootWait = null

    this.legacyViews = handlers.legacyViews || []

    this._bootGuard = new ReadyGuard()
    this._bootingState = null
    this._bootingAll = null

    this._now = handlers.now || Date.now // overridable for clock-drift tests
    this._preapply = handlers.preapply || null
    this._preApplied = false
    this._hasApply = !!handlers.apply
    this._hasUpdate = !!handlers.update
    this._needsUpdate = false
    this._ackRequired = false
    this._ackedHeads = new Map()
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
    this._migratedHead = null

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

  get flushes() {
    return this.system.flushes
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
    this._localFlushes = this.system.flushes

    this.bumpSoon()
  }

  _requestWakeup() {
    const session = this._wakeup._session
    if (session) session.broadcastLookup()
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
    if (this._bootWait !== null) this._bootWait.resolve()
    if (this._notifyHandler) this._notifyHandler.destroy()
    if (this._draining) {
      // drain may be waiting on replicated blocks
      this._clearRequests()
      await this._draining
    }

    if (this._updating) await this._updating

    // let in-flight writer adds finish
    try {
      await this._bootingAll
    } catch {}

    await ApplyView.close(this.view, this)

    if (this.writers) await this.writers.close()
    await this.local.close()
    await this.system.close()
    await this._wakeup.close()
    if (this.bootstrap && !this.bootstrap.closed) await this.bootstrap.close()
    await this._workingView.close()
    await this.bee.close()
    await this.store.close()
  }

  _clearRequests() {
    const closingError = new Error('Autobee is closing')
    for (const session of this.store.sessions) {
      if (session.opened && !session.closing) {
        session.clearRequests(session.activeRequests, closingError)
      }
    }

    if (this.fastForwarding) this.fastForwarding.clearRequests(closingError)
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

  // the view an oplog head points at, opened and closed through the handlers
  openViewAt(oplog) {
    const v = oplog.op.views.view
    if (!v) return null

    return new ApplyView(this.bee.checkout({ key: v.key, length: v.start + v.length }), this)
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

    if (this.bootFrom) {
      this.bootFrom = getBootOption(await this.bootFrom)
    }
  }

  getMostRecentHead() {
    return topo.getMostRecentHead(this, this.system.bee.snapshot())
  }

  async _bootState() {
    if (!this._bootGuard.enter()) return this._bootGuard.ready()

    try {
      await this._bootStateUnsafe()
    } catch (err) {
      this._bootGuard.destroy(err)
      throw err
    }

    this._bootGuard.exit()

    return this._bootGuard.ready()
  }

  async _bootReady() {
    if (this._bootGuard.opened) return true
    try {
      await this._bootGuard.ready()
      return true
    } catch {
      return false
    }
  }

  async _bootStateUnsafe() {
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
    this.local = result.local

    if (this.encrypted && this.encryptionKey === null) {
      throw new Error('Encryption key is expected')
    }

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
      if (this.bootstrap !== this.local && !this.store.storage.readOnly) {
        await this.bootstrap.setGroup(this.wakeupCapability.discoveryKey)
      }

      this._notifyHandler = this.store.notifyGroup(this.wakeupCapability.discoveryKey)
      this._notifyHandler.on('update', this._onGroupUpdateBound)
      await this._drainBootHints()
    }

    const system = result.system || EMPTY_HEAD

    await this.system.boot(system)

    const migrated = await this.local.getUserData('autobee/migrated-head')
    if (migrated) this._migratedHead = encoding.decodeMigratedHead(migrated)

    let view = this.system.view
    if (!view) view = (this._migratedHead && this._migratedHead.view) || EMPTY_HEAD

    // @todo migration
    if (result.migration) {
      if (this._handlers.migrate) {
        view =
          (await this._handlers.migrate(result.migration.views, result.migration.system)) ||
          EMPTY_HEAD
        this._catchupMigratedNodes = result.migration.catchup

        this._migratedHead = {
          system: result.migration.system,
          view: view.length ? view : (this._migratedHead && this._migratedHead.view) || null
        }

        await this._storeMigratedHead()
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
  }

  async _bootAll() {
    if (!(await this._bootReady())) return

    for (const head of this.system.heads) {
      await this.writers.add(head.key)
    }
    await this._bump()
  }

  bumpSoon() {
    this._bump().catch(safetyCatch)
  }

  async _bump() {
    if (!(await this._bootReady())) return

    if (this._bootWait !== null) this._bootWait.resolve()

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

  // one-shot user gate: nothing applies until the host has resolved whatever
  // state apply depends on (e.g. legacy views recorded by a migration)
  async _runPreApply() {
    if (this._preapply === null || this._preApplied) return

    this._preApplied = true
    await this._preapply(this.view)
  }

  async _drain() {
    if (this._updating) await this._updating

    await this._runPreApply()

    this.stats.drains++

    if (this.bootFrom) {
      const { head = null, legacy = null, bootCondition = null } = this.bootFrom

      this.bootFrom = null

      if (legacy) await this._bootFromSystem(legacy)
      else if (head) await this._bootFromHead(head, bootCondition)
    }

    this._ackRequired = false

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
          await this._flushWakeup()
          if (this._interrupting) break

          if (this.fastForwardTo !== null) {
            await this._applyFastForward()
            break // revaluate conditions...
          }

          if (await this._bumpPendingWriters()) {
            this._needsUpdate = true
            continue
          }

          if (!this._appendAck()) break
          this._needsUpdate = true
        }

        await this._flushLocal()

        if (!this._interrupting) await this.writers.refresh()
      } finally {
        if (this.bumping === 1) this.bumping = 0
        else this.bumping = 1
      }
    }

    this._draining = null
    if (this._interrupting) return

    const updating = rrp()
    this._updating = updating.promise

    try {
      if (this._needsUpdate) await this._update(changes)
      await this._storeBoot()
    } finally {
      this._updating = null
      updating.resolve()
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

  // wakeup hints keep arriving asynchronously
  async _applyWakeupHints() {
    const hints = this._wakeup.flush()
    if (!hints.size) return hints

    this.previousDrain = Date.now()

    for (const [hex, length] of hints) {
      const key = b4a.from(hex, 'hex')
      // wakeup() itself no-ops the add for an already-active writer, but still
      // needs to run so it can hint() the announced length - skipping it here
      // for active writers left gc with no hint to protect them
      await this.writers.wakeup(key, length)
    }

    return hints
  }

  async _flushWakeup() {
    const hints = await this._applyWakeupHints()
    if (!hints.size) return

    if (!this._ffEnabled) return

    // a scheduled fast-forward is applied by the drain before we look again
    if (this.fastForwardTo !== null || this.fastForwarding !== null) return
    if (this._interrupting || this.closing || this.bootFrom) return

    try {
      const heads = await this._readCandidateHeads(hints, FastForward.DEFAULT_TIMEOUT)

      const ff = await FastForward.fromHeads(this, heads, {
        timeout: FastForward.DEFAULT_TIMEOUT
      })

      if (ff !== null) await this._runFastForward(ff)
    } catch (err) {
      safetyCatch(err)
    }
  }

  async _readCandidateHeads(hints, timeout) {
    const promises = []

    for (const [hex, length] of hints) {
      if (length === 0) continue
      const key = b4a.from(hex, 'hex')
      promises.push(this._getOplog(key, length, timeout ? { timeout } : null))
    }

    const ops = await Promise.all(promises)
    const heads = []

    for (const res of ops) {
      if (res === null) continue

      // the head we were woken on is a candidate in its own right
      heads.push({ key: res.key, length: res.length })

      if (!res.op.trusted) continue

      for (const trusted of res.op.trusted) {
        const head = this.trusted.read(trusted)
        if (head !== null) heads.push(head)
      }
    }

    return heads
  }

  async _getOplog(key, length, opts = null) {
    const core = this.openCore(key)

    try {
      return await this.readOplog(core, length, opts)
    } finally {
      await core.close()
    }
  }

  // reads on a core the caller owns, so a walk does not churn a session per step
  async readOplog(core, length, opts = null) {
    await core.ready()

    const target = length >= 0 ? length : core.length
    if (target === 0) return null

    // conservative: only proceed when a connected peer can serve the head whole
    if (opts && opts.conservative && core.remoteContiguousLength < target) return null

    const buf = await core.get(target - 1, opts)
    if (buf === null) return null

    let op = encoding.decodeOplog(buf)

    // legacy nodes always inflate, but only indexers carry views - callers
    // that need system info must check op.views
    if (op.version < 3) {
      op = await migrations.inflateLegacyOplog(buf, core, target - 1, opts)
    }

    return {
      key: core.key,
      length: target,
      op
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

    // done, soft restart
    this.emit('rotate-local-writer')
  }

  async createAnchor(key, length) {
    let node = null
    for (let i = this._host.applying.length - 1; i >= 0; i--) {
      const n = this._host.applying[i]
      if (b4a.equals(n.key, key) && n.length === length) {
        node = n
        break
      }
    }

    if (!node) throw new Error('Anchor node is not in system')

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

    await this.system.addAnchor(core.key)

    const anchor = { key: core.key, length: core.length }

    await core.close()

    return anchor
  }

  async _bumpMigratedWriters() {
    const opened = new Set()

    for (const batch of this._catchupMigratedNodes) {
      await this._processBatch(batch)
      for (const node of batch) {
        if (node.from) opened.add(node.from)
      }
    }

    for (const core of opened) await core.close()
  }

  // append a null value node to ack writer
  _appendAck() {
    if (!this._ackRequired) return false
    if (!this.writers.writable) return false

    if (this.writers.localWriter.pending !== null) return false

    const links = this.system.getLinks(this.local.key)
    const t = Math.max(this._now(), this.system.timestamp)

    let unlinked = false
    for (const { key, length } of links) {
      const hex = b4a.toString(key, 'hex')
      const acked = this._ackedHeads.get(hex) || 0
      if (length > acked) {
        unlinked = true
        break
      }
    }
    if (!unlinked) {
      this._ackRequired = false
      return false
    }

    for (const { key, length } of links) {
      this._ackedHeads.set(b4a.toString(key, 'hex'), length)
    }

    this.writers.appendLocal(null, t, { start: 0, end: 0 }, links, false, null)
    this._ackRequired = false
    return true
  }

  async _bumpPendingWriters() {
    if (this._catchupMigratedNodes !== null) {
      await this._bumpMigratedWriters()
      this._catchupMigratedNodes = null
    }

    // apply the best next node to keep the prefix stable
    const next = await this.writers.nextPendingNode()
    if (next === null) return false

    const { writer: w, batch } = next

    if (w.isAdded || (w.isRemoved && w.hasReferrals())) {
      await this._processBatch(batch)
      w.notify(batch)
      return true
    }

    if (this.optimistic && !w.isRemoved && batch[0].optimistic) {
      if (!(await this._optimisticBatch(batch))) {
        w.removePending()
        return true
      }
      w.notify(batch)
      return true
    }

    return true
  }

  async _optimisticBatch(batch) {
    const rollbackSystem = this.system.bee.head()
    const rollbackView = this._workingBee.head()
    const rollbackAttestations = this.writers.attestations.length

    const t = await this.prepareBatch(batch)
    if (t.view) this._workingBee.move(t.view)

    for (const b of t.tip) {
      let failed = true
      try {
        if (await this.system.canApply(b[0].key, true)) {
          await this._applyBatch(b, true)
          failed = false
        }
      } catch {}

      // only check if batch was successful
      if (b !== batch) continue

      const w = failed ? null : await this.system.get(b[0].key)
      if (!w || w.length < b[0].length) {
        this._workingBee.move(rollbackView)
        this.system.bee.move(rollbackSystem)
        await this.system.reset()
        // don't attest grants that were just undone
        this.writers.attestations.length = rollbackAttestations
        return false
      }
    }

    return true
  }

  async prepareBatch(batch) {
    const node = batch[0]
    // recomputed on every application, converges because prefixes converge
    node.weight = await resolveWeight(this, node)
    for (const n of batch) n.weight = node.weight

    // if (topo.isLinkingAll(node, this.system.heads)) {
    //   return { undo: null, view: null, tip: [batch] }
    // }

    const t = await topo.sort(this, batch)

    if (t.undo) {
      this.stats.undos++
      this.trusted.clear()
      t.view = await this.system.undo(t.undo)
      if (!t.view.length && this._migratedHead && this._migratedHead.view) {
        t.view = this._migratedHead.view
      }
    }

    return t
  }

  async applyBacklog(batches) {
    const queue = batches.slice()

    while (queue.length) {
      const batch = queue.shift()
      const t = await this.prepareBatch(batch)

      if (t.view) {
        this._workingBee.move(t.view)
        queue.unshift(...t.tip)
        continue
      }

      if (b4a.equals(batch[0].key, this.key) && batch[0].length === 1) {
        await this._host.addWriter(batch[0].key)
      }

      await this._applyBatch(batch, batch[0].optimistic)

      this.writers.triggers.trigger(
        b4a.toString(batch[0].key, 'hex'),
        batch[batch.length - 1].length
      )
    }
  }

  async _processBatch(batch) {
    await this.applyBacklog([batch])
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
      this.stats.applies++
      this._host.applying = batch
      await this._workingView.apply(userBatch)
      this._host.applying = null
    }

    const { changed, witnessed } = await this.system.flush(batch, this._workingBee)

    if (local) {
      this._localSystemLength = this.system.bee.context.local.length - this._localSystemStart
      this._localViewLength = this._workingBee.context.local.length - this._localViewStart
      this._localFlushes = this.system.flushes
    }

    this.writers.attest(witnessed)

    for (const { key, added, isAnchor } of changed) {
      if (isAnchor) {
        // no Writer/ActiveWriters tracking, but still wake anything linked to it
        this.writers.triggers.trigger(b4a.toString(key, 'hex'), 1)
        continue
      }
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

  _storeMigratedHead() {
    const value = this._migratedHead ? encoding.encodeMigratedHead(this._migratedHead) : null
    return this.local.setUserData('autobee/migrated-head', value)
  }

  static decodeValue(buf, opts) {
    return encoding.decodeValue(buf, opts)
  }

  static encodeValue(value, opts) {
    return encoding.encodeValue(value, opts)
  }

  async wakeup({ key, length }) {
    if (!(await this._bootReady())) return
    await this.writers.wakeup(key, length)
    await this._bump()
  }

  async append(values, { optimistic = false } = {}) {
    if (this.closing) throw new Error('Autobee closed')

    this.stats.appends++

    if (!Array.isArray(values)) values = [values]

    if (!this.opened) await this.ready()

    if (!optimistic && this.writers.localWriter.isRemoved) {
      throw new Error('Not writable')
    }

    await this.local.ready()

    const links = this.system.getLinks(this.local.key)

    // never stamp before anything we link
    const t = Math.max(this._now(), this.system.timestamp)
    const batch = []

    // witnesses only ride upgrade windows. witness.weight is the value the backer's
    // snapshot witnesses - verifiers recompute the same read and verify
    const rec = await this.system.get(this.local.key)
    let witness = null
    if (rec && rec.maxWeight > currentWeight(rec)) {
      const sorted = this.writers.witnesses.sort(
        (a, b) => b.attestation.weight - a.attestation.weight
      )

      for (const { key, length, attestation, manifest } of sorted) {
        if (attestation.weight > rec.maxWeight) continue

        const backer = await this.system.get(key)
        if (!backer || backer.isRemoved || backer.length < length) continue

        const { weight, signature } = attestation
        witness = { weight, backer: { key, length, signature, manifest } }
        break
      }
    }

    for (let i = 0; i < values.length; i++) {
      const value = values[i]
      const buffer = typeof value === 'string' ? b4a.from(value) : value
      const lnk = i === 0 ? links : []
      const node = this.writers.appendLocal(
        buffer,
        t,
        { start: i, end: values.length - 1 - i },
        lnk,
        optimistic,
        i === 0 ? witness : null
      )
      batch.push(node)
    }

    return this._bump()
  }

  async _flushLocal() {
    await this.writers.flushLocal({
      flushes: this._localFlushes,
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
    this._localFlushes = this.system.flushes
    this._localViewStart = this._workingBee.context.local.length
    this._localViewLength = 0
  }

  async moveTo(head) {
    if (!this.opened) await this.ready()
    if (this.closing) throw new Error('Autobee closed')

    const ff = await FastForward.fromHead(this, head, null, { force: true })
    if (ff === null) return null

    if (!(await this._runFastForward(ff))) return null

    return this.ff.promise
  }

  // legacy: ungated boot straight onto a system head
  async _bootFromSystem(system) {
    try {
      const ff = new FastForward(this, system, null, { timeout: FastForward.DEFAULT_TIMEOUT })
      return await this._runFastForward(ff)
    } catch (err) {
      safetyCatch(err)
      return false
    }
  }

  // the boot head seeds the view every trust decision here is made against,
  // since our own view is still empty
  async _bootFromHead(head, bootCondition) {
    // just a head: one attempt, we do not wait around if it cannot be read
    if (bootCondition === null) {
      try {
        const ff = await FastForward.fromHead(this, head, null, {
          force: true,
          timeout: FastForward.DEFAULT_TIMEOUT
        })

        return ff !== null && (await this._runFastForward(ff))
      } catch (err) {
        safetyCatch(err)
        return false
      }
    }

    // a condition needs the view at head to check against, so park until we
    // can read it and something acceptable turns up
    let opened = null

    try {
      while (!this._interrupting) {
        this._bootWait = rrp()

        try {
          if (opened === null) opened = await this._bootReference(head)

          if (opened !== null && (await this._bootAttempt(head, bootCondition, opened.view))) {
            return true
          }
        } catch (err) {
          safetyCatch(err)
        }

        if (this._interrupting) break

        await this._bootWait.promise
      }
    } finally {
      this._bootWait = null
      if (opened !== null) await opened.close()
    }

    return false
  }

  async _bootAttempt(head, bootCondition, reference) {
    // peek, so the hints are still there for the drain once we have booted
    const candidates = await this._readCandidateHeads(
      this._wakeup.hints,
      FastForward.DEFAULT_TIMEOUT
    )

    const ff = await FastForward.fromHeads(this, [head, ...candidates], {
      force: true,
      timeout: FastForward.DEFAULT_TIMEOUT,
      condition: bootCondition,
      reference
    })

    return ff !== null && (await this._runFastForward(ff))
  }

  async _bootReference(head) {
    const oplog = await FastForward.flushHead(this, head, {
      timeout: FastForward.DEFAULT_TIMEOUT
    })

    return oplog === null ? null : this.openViewAt(oplog)
  }

  async _runFastForward(ff) {
    if (this.fastForwardTo !== null || this.fastForwarding !== null) {
      await ff.close()
      return false
    }

    this.fastForwarding = ff

    const result = await ff.run()
    await ff.close()

    if (this.fastForwarding === ff) this.fastForwarding = null

    if (!result) return false

    this.fastForwardTo = result
    this.ff = rrp()

    this.bumpSoon()

    return true
  }

  async _applyFastForward() {
    const changes = this._hasUpdate ? new UpdateChanges(this) : null
    if (changes) changes.track()

    const { head, tip, migrate } = this.fastForwardTo

    const from = this.system.bee.head()
    const to = head

    this.system.bee.move(head)
    await this.system.reset()

    // migrate is set when fast-forwarding from a legacy head
    if (migrate) {
      const view = (await this._handlers.migrate(migrate, head)) || EMPTY_HEAD

      this._migratedHead = {
        system: head,
        view: view.length ? view : (this._migratedHead && this._migratedHead.view) || null
      }

      await this._storeMigratedHead()
      this.bee.move(view)
      this._workingBee.move(view)
    } else {
      this.bee.move(this.system.view)
      this._workingBee.move(this.system.view)
    }

    this.fastForwardTo = null

    // process any wakeup while fast-forward itself was in flight
    await this._applyWakeupHints()
    await this.writers.refresh()

    // we moved, so ask our peers to tell us their heads again
    this._requestWakeup()

    await this._update(changes)
    await this._storeBoot()

    this.stats.fastForwards++
    this.emit('move-to', to, from)
    this.ff.resolve({ to, from })

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
    if (changes) changes.track()

    const sys = this.system.bee.checkout(system)
    const t = await topo.rollback(this, sys, verified)
    await sys.close()

    if (t !== null) await this.applyBacklog(t.tip)

    return this._update(changes)
  }

  replay() {
    return topo.replay(this)
  }
}

function isObject(o) {
  return typeof o === 'object' && o && !b4a.isBuffer(o)
}

function getBootOption(boot) {
  if (!boot) return null

  // oldest style, supported for now but will go away: a bare key is legacy
  if (boot.key) return { legacy: boot, head: null, bootCondition: null }

  asserts.assert(!(boot.head && boot.legacy), 'Boot from either a head or a legacy pointer')

  return boot
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
