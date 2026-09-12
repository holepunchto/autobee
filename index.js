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
const DEFAULT_ACK_THRESHOLD = 32
const INTERRUPT = new Error('Apply interrupted')

module.exports = class Autobee extends ReadyResource {
  constructor(store, key = null, handlers = {}) {
    super()

    if (isObject(key)) {
      handlers = key
      key = null
    }

    const {
      name = null,
      encrypted,
      encryptionKey,
      viewName = 'view',
      bootstrapWeight = 2
    } = handlers

    this.encrypted = encrypted === true || !!encryptionKey
    this.bootstrapWeight = bootstrapWeight

    this.getSystemEncryption = this._getEncryptionProvider.bind(this, '_system')
    this.getViewEncryption = this._getEncryptionProvider.bind(this, viewName)

    const beeStore = store.session()
    const bee = new Hyperbee(beeStore, {
      core: beeStore.get({ preload: this._getCorePreload(viewName) }),
      // defer one tick to ensure consistent state, then return state prom
      preload: async () => {
        await 1
        await this._bootGuard.ready()
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

    const systemStore = this.store.session()
    this.system = new System(this, systemStore, {
      core: systemStore.get({ preload: this._getCorePreload('system') }),
      encrypted: this.encrypted,
      getEncryptionProvider: this.getSystemEncryption
    })

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

    // conservative (default on): only fast-forward onto a system and view held whole
    this._conservativeFF = fastForward === null || fastForward.conservative !== false

    this.trusted = new TrustedPeers(this, handlers)

    this.ff = null
    this.fastForwarding = null
    this.fastForwardTo = null

    this._workingBee = bee
    this._workingView = new ApplyView(this._workingBee, this)

    this._localSystemStart = 0
    this._localSystemLength = 0
    this._localFlushes = 0
    this._acking = false
    this._ackThreshold = handlers.ackThreshold || DEFAULT_ACK_THRESHOLD
    this._ackFlushes = -1
    this._localViewStart = 0
    this._localViewLength = 0

    this._appending = []
    this._draining = null
    this._updating = null

    this.legacyViews = handlers.legacyViews || []

    // the guards may be destroyed before anyone waits on them
    this._bootGuard = new ReadyGuard()
    this._bootGuard.ready().catch(safetyCatch)
    this._bootOnlineGuard = new ReadyGuard()
    this._bootOnlineGuard.ready().catch(safetyCatch)

    this._now = handlers.now || Date.now // overridable for clock-drift tests
    this._preapply = handlers.preapply || null
    this._preApplied = false
    this._warmup = handlers.warmup || null
    this._hasApply = !!handlers.apply
    this._hasUpdate = !!handlers.update
    this._needsUpdate = false
    this._approvalCheck = true
    this._approvedPending = new Map()
    this._prefetchingApprovals = false
    this._updateLocalCore = null
    this._host = new ApplyCalls(this)
    this._notifyHandler = null

    this.interrupted = null
    this._interrupting = false
    this._onErrorBound = this._onError.bind(this)
    this._onGroupUpdateBound = this._onGroupUpdate.bind(this)

    this.wakeupCapability = null
    this._wakeup = new AutobeeWakeup(this, handlers)
    this.previousDrain = 0

    this._catchupMigratedNodes = null
    this._migrating = false
    this._prebooting = null

    this.ready().catch(noop)
  }

  static GENESIS = EMPTY_HEAD

  static isAutobee(auto) {
    return auto instanceof Autobee
  }

  get isIndexer() {
    return this.writers ? this.writers.localWriter.isIndexer : false
  }

  get writable() {
    return this.writers ? this.writers.writable : false
  }

  // autobase compat
  get activeWriters() {
    return this.writers
  }

  get flushes() {
    return this.system.flushes
  }

  get busy() {
    return !!(this._draining || this._updating)
  }

  async _getCorePreload(name) {
    await 1
    const result = await this._prebooting
    return {
      name: 'autobee/' + result.local.id + '/' + name,
      encryption: name === 'system' ? this.getSystemEncryption() : this.getViewEncryption(),
      inflightRange: [256, 512]
    }
  }

  setAcking(acking, { threshold = this._ackThreshold } = {}) {
    this._acking = acking !== false && threshold > 0
    this._ackThreshold = threshold

    if (this._acking) this.bumpSoon()
  }

  async _updateAcking() {
    if (this._interrupting) return
    this.setAcking(await this.trusted.isTrusted(this.local.key, this._workingView.view))
  }

  // network free: only a migration needs peers, so ready() awaits the full
  // state boot unless one is pending and defers it to the background if so -
  // anything needing the booted system must wait on the boot guard
  async _open() {
    this._prebooting = this._preBoot()

    let result = null

    try {
      result = await this._prebooting

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
      this.writers = new ActiveWriters(this)
    } catch (err) {
      // unblock the guard awaiters (bee preloads, bumps, wakeups, flushes)
      this._bootGuard.destroy(err)
      this._bootOnlineGuard.destroy(err)
      throw err
    }

    const booting = this._boot()

    // waits on the boot guard internally and destroys its own guard on failure
    this._bootOnline()

    // if migrating, we might need network io, if not lets wait on it - less surprises
    if (result.migration) booting.catch(this._onErrorBound)
    else await booting
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

  // the cores a mirror should pin: our writer core, our views when we are
  // trusted, and (with wait) the most recent trusted head so a mirror that
  // forgets to add one still pins a valid entrypoint
  async cores({ wait = true, local = true, all = false } = {}) {
    if (!this._bootGuard.opened) await this._bootGuard.ready()

    const result = { key: this.key, views: null, writers: [] }
    const views = new Map()

    if (local) {
      result.writers.push(this.local.key)

      if (await this.trusted.isTrusted(this.local.key, this._workingView.view)) {
        const localViews = await this.writers.localWriter.views()
        for (const { key } of localViews) {
          views.set(b4a.toString(key, 'hex'), key)
        }
      }
    }

    if (wait) {
      const head = await this.trusted.mostRecentTrusted(this.view, null)

      if (head && (!local || !b4a.equals(head.key, this.local.key))) {
        const oplog = await this._resolveOplogHint(head.key, head.length)
        if (oplog && oplog.op.views) {
          const skey = oplog.op.views.system.key
          const vkey = oplog.op.views.view.key

          views.set(b4a.toString(skey, 'hex'), skey)
          views.set(b4a.toString(vkey, 'hex'), vkey)
        }

        result.writers.push(head.key)
      }

      // nothing trusted to anchor on: pin the bootstrap so a mirror still
      // has a bootable entrypoint for this room
      if (views.size === 0 && !b4a.equals(this.bootstrap.key, this.local.key)) {
        result.writers.push(this.bootstrap.key)
      }

      if (all) {
        const [viewCores, systemCores] = await Promise.all([
          this.bee.cores({ local: false }),
          this.system.bee.cores({ local: false })
        ])

        for (const key of viewCores) {
          views.set(b4a.toString(key, 'hex'), key)
        }
        for (const key of systemCores) {
          views.set(b4a.toString(key, 'hex'), key)
        }
      }
    }

    result.views = [...views.values()]

    return result
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

    // the local core holds the exclusive lock but the local writer closes it
    // early in the teardown, so hand the lock to a detached session that
    // outlives the teardown and only release it once everything is down
    let lock = null

    if (this.local.exclusive) {
      lock = this.store.session()
      const local = lock.get({ key: this.local.key, active: false })
      await local.ready()

      // transfer exclusiveness, the detached session now unlocks on close
      local.exclusive = true
      this.local.exclusive = false
    }

    try {
      await this._teardown()
    } finally {
      if (lock) await lock.close()
    }
  }

  async _teardown() {
    try {
      await ApplyView.close(this.view, this)
    } catch (err) {
      safetyCatch(err)
    }

    if (this.writers) await this.writers.close()
    await this.system.close()
    await this._wakeup.close()
    if (this.bootstrap) await this.bootstrap.close()

    try {
      await this._workingView.close()
      await this.bee.close()
    } catch (err) {
      safetyCatch(err)
    }

    // don't rely on the store teardown to stop the notify watcher
    if (this._notifyHandler) this._notifyHandler.destroy()

    await this.local.close()

    // rugpull the rest
    await this.store.close()

    if (this._updating) await this._updating
    if (this._draining) await this._draining

    // let in-flight writer adds finish
    try {
      await this._bootOnlineGuard.ready()
    } catch {}
  }

  replicate(...args) {
    const stream = this.store.replicate(...args)
    this._wakeup.addStream(stream)
    return stream
  }

  async flush() {
    await this._bootOnlineGuard.ready()
  }

  hintWakeup(wakeup) {
    this._wakeup.hint(wakeup)
  }

  // the view an oplog head points at, opened and closed through the handlers
  openViewAt(oplog, { timeout } = {}) {
    const v = oplog.op.views.view
    if (!v) return null

    return this.openView({ key: v.key, length: v.start + v.length }, { timeout })
  }

  // timeout bounds every hypercore read done through the view, defaults to the main bee's
  openView(head, { timeout } = {}) {
    const bee = this.bee.checkout({ key: head.key, length: head.length, timeout })
    return new ApplyView(bee, this)
  }

  openCore(key) {
    const encryption = this.encryptionKey ? new WriterEncryption(this) : null
    const group = this.wakeupCapability ? this.wakeupCapability.discoveryKey : null
    return this.store.get({ key, encryption, group })
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

    return boot(this.store, this.key, {
      encryptionKey: this.encryptionKey,
      keyPair: this.keyPair
    })
  }

  async _boot() {
    if (!this._bootGuard.enter()) return this._bootGuard.ready()

    try {
      await this._bootUnsafe()
    } catch (err) {
      this._bootGuard.destroy(err)
      throw err
    }

    this._bootGuard.exit()

    await this._updateAcking()

    this.bumpSoon()

    return this._bootGuard.ready()
  }

  async _bootUnsafe() {
    const result = await this._prebooting

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
    if (this.system.migration) await this._runMigration()

    if (result.migration) {
      this._migrating = true
      this._catchupMigratedNodes = result.migration.catchup

      // ff boot invalidated by migration
      this.bootFrom = null

      for (const batch of result.migration.catchup) {
        const { key, length } = batch[batch.length - 1]
        this.writers.wakeup(key, length)
      }
    }

    // since we are doing this DURING the hyperbee2 boot we need to ready the core
    // be good if we had better plumbing for it
    await this._workingBee.core.ready()
    await this.bee.core.ready()

    const view = this.system.view

    this._workingBee.move(view)
    this.bee.move(view)

    await this.writers.updateLocalState()

    // roots are moved, so these resolve without re-entering the boot guard
    await this.bee.ready()
    await this._workingBee.ready()

    // baseline before the guard opens so an early drain can't flush against stale offsets
    this._localSystemStart = this.system.bee.context.local.length
    this._localViewStart = this._workingBee.context.local.length
    this._localFlushes = this.system.flushes
  }

  async _bootOnline() {
    if (!this._bootOnlineGuard.enter()) return

    try {
      if (!this._bootGuard.opened) await this._bootGuard.ready()

      for (const head of this.system.heads) {
        await this.writers.add(head.key)
      }

      if (!this.system.heads.length) {
        await this.writers.add(this.bootstrap.key)
      }

      await this._bump(true)
    } catch (err) {
      this._bootOnlineGuard.destroy(err)
      return
    }

    this._bootOnlineGuard.exit()
  }

  bumpSoon() {
    this._bump(false).catch(safetyCatch)
  }

  async _bump(force) {
    if (!force && !this._bootGuard.opened) await this._bootGuard.ready()

    if (!force && !this._bootOnlineGuard.opened) await this._bootOnlineGuard.ready()

    this.bumping++

    if (!this._draining) {
      this._draining = this._drain().catch(this._onErrorBound)
    }

    return this._draining
  }

  update() {
    return this._bump(false)
  }

  async updated() {
    if (!this._bootGuard.opened) await this._bootGuard.ready()
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
      const { head = null, legacy = null } = this.bootFrom

      this.bootFrom = null

      if (legacy) {
        await this._bootFromSystem(legacy)
      } else if (head) {
        this._wakeup.hint({ key: head.key, length: head.length || 0 })
        await this._bootFromHead(head)
      }
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
          await this._flushWakeup()
          if (this._interrupting) break

          if (this.fastForwardTo !== null) {
            await this._applyFastForward()
            if (changes) changes.track()
            this._needsUpdate = false
            break // revaluate conditions...
          }

          if (await this._bumpPendingWriters()) continue

          if (!(await this._appendAck())) break
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
      if (this._needsUpdate) await this._update(changes, false)
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
    if (!hints.size) return []

    this.previousDrain = Date.now()
    const results = await this._filterHints(hints)

    for (const { key, length } of results) {
      // wakeup() itself no-ops the add for an already-active writer, but still
      // needs to run so it can hint() the announced length - skipping it here
      // for active writers left gc with no hint to protect them
      await this.writers.wakeup(key, length)
    }

    return results
  }

  async _filterHints(hints) {
    const results = []
    const promises = []
    for (const [hex, length] of hints) {
      const key = b4a.from(hex, 'hex')
      promises.push(this._filterTracked(key, length, results))
    }
    await Promise.all(promises)
    return results
  }

  async _filterTracked(key, length, results) {
    if (length) {
      const info = await this.system.get(key)
      // if we've seen this already, ignore
      if (info && info.length >= length) return
    }
    results.push({ key, length })
  }

  async _flushWakeup() {
    const hints = await this._applyWakeupHints()
    if (!hints.length) return

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

    for (const { key, length } of hints) {
      if (length === 0) continue
      promises.push(this._resolveOplogHint(key, length, { timeout }))
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

  async _resolveOplogHint(key, length, opts) {
    const core = this.openCore(key)

    try {
      await core.ready()
      const max = Math.max(length, core.length)

      const block = await this.readOplog(core, max, opts)
      if (max >= core.length) return block // best one

      return await this.readOplog(core, core.length, opts)
    } finally {
      await core.close()
    }
  }

  async _getOplog(key, length, opts) {
    const core = this.openCore(key)

    try {
      return await this.readOplog(core, length, opts)
    } finally {
      await core.close()
    }
  }

  // reads on a core the caller owns, so a walk does not churn a session per step
  async readOplog(core, length, { timeout = 0 } = {}) {
    await core.ready()

    const target = length >= 0 ? length : core.length
    if (target === 0) return null

    const buf = await core.get(target - 1, { timeout })
    if (buf === null) return null

    let op = encoding.decodeOplog(buf)

    // legacy nodes always inflate, but only indexers carry views - callers
    // that need system info must check op.views
    if (op.version < 3) {
      op = await migrations.inflateLegacyOplog(buf, core, target - 1, timeout)
    }

    return {
      key: core.key,
      length: target,
      op
    }
  }

  async _update(changes, fastForward) {
    this._needsUpdate = false
    this.bee.update(this._workingBee.root)

    if (!changes) return

    changes.finalise(fastForward)
    await this._handlers.update(this.view, changes)
  }

  async setLocal(key, { keyPair } = {}) {
    if (!this._bootGuard.opened) await this._bootGuard.ready()
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
    this._ackFlushes = -1

    this.local.setUserData('referrer', this.key)
    if (this.encryptionKey) {
      await this.local.setUserData('autobee/encryption', this.encryptionKey)
    }

    await this.bootstrap.setUserData('autobee/local', this.local.key)
    await oldLocal.close()

    await this._updateAcking()

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
    let updated = false

    for (const batch of this._catchupMigratedNodes) {
      await this._processBatch(batch)
      updated = true
      for (const node of batch) {
        if (node.from) opened.add(node.from)
      }
    }

    for (const core of opened) await core.close()
    return updated
  }

  async _prefetchApprovals() {
    if (this._prefetchingApprovals) return
    this._prefetchingApprovals = true

    try {
      const prefetch = []
      const standing = await this._standing()
      if (standing <= 0 || !this._pendingWork(standing)) return
      for await (const p of this._servableRequests(standing)) {
        prefetch.push(this.system.get(p.key).catch(safetyCatch))
        prefetch.push(this.system.grantHint(p.key).catch(safetyCatch))
      }
      await Promise.allSettled(prefetch)
    } finally {
      this._prefetchingApprovals = false
    }
  }

  async _standing() {
    const rec = await this.system.get(this.local.key)
    return currentWeight(rec)
  }

  // only our own tiers: a request whose lower tiers are already anchored is
  // somebody stronger's job, and must not keep every peer at this standing
  // rescanning (or offering) while it waits
  _pendingWork(standing) {
    const digest = this.system.promotions.digest
    const end = Math.min(standing, digest.length)
    for (let w = 1; w <= end; w++) {
      if (digest[w - 1]) return true
    }
    return false
  }

  // the requests we could serve and by how much - shared by the prefetch and
  // the collector so the two cannot drift on what counts as ours
  async *_servableRequests(standing) {
    for await (const p of this.system.listPendingPromotions()) {
      const amount = Math.min(standing, p.weight)
      if (amount <= 0) continue
      yield { key: p.key, amount }
    }
  }

  async _collectApprovals() {
    if (!this.system.promotions.changed && !this._approvalCheck) return null
    if (!this.writers.writable) return null

    const standing = await this._standing()
    if (standing <= 0) return null

    this.system.promotions.changed = false
    this._approvalCheck = false

    if (!this._pendingWork(standing)) return null

    const approvals = []
    const approving = []

    for await (const p of this._servableRequests(standing)) {
      approving.push(fetchApproval.call(this, p.key, p.amount, approvals))
      if (approving.length === 32) break
    }

    if (!approving.length) return null

    try {
      await Promise.all(approving)
    } catch (err) {
      if (this._interrupting) return null
      throw err
    }

    if (!approvals.length) return null

    for (const a of approvals) {
      this._approvedPending.set(b4a.toString(a.key, 'hex'), a.weight)
    }

    return approvals

    async function fetchApproval(key, weight, approvals) {
      const hex = b4a.toString(key, 'hex')
      if ((this._approvedPending.get(hex) || 0) >= weight) return
      const [target, hint] = await Promise.all([this.system.get(key), this.system.grantHint(key)])
      if (!target || target.isRemoved) return
      if (hint && hint.weight >= weight) return
      approvals.push({ key, weight })
    }
  }

  async _appendAck() {
    if (!this._acking) return false
    if (!this.writers.writable) return false

    if (this.writers.localWriter.pending !== null) return false

    if ((await this._flushesBehind()) < this._ackThreshold) return false

    const links = this.system.getLinks(this.local.key)
    const t = Math.max(this._now(), this.system.timestamp)

    this.writers.appendLocal(null, t, { start: 0, end: 0 }, links, false, null)
    return true
  }

  async _flushesBehind() {
    if (this._ackFlushes === -1) {
      const latest = await this.writers.getLatestLocalOplog()
      this._ackFlushes = latest && latest.views ? latest.views.flushes : this.system.flushes
    }

    return this.system.flushes - this._ackFlushes
  }

  async _bumpPendingWriters({ local = false } = {}) {
    if (!local && this._catchupMigratedNodes !== null) {
      const updated = await this._bumpMigratedWriters()
      this._catchupMigratedNodes = null
      if (updated) {
        this._needsUpdate = true
        return true
      }
    }

    // apply the best next node to keep the prefix stable
    const next = await this.writers.nextPendingNode({ local })
    if (next === null) return false

    const { writer: w, batch } = next

    const optimistic = this.optimistic && batch[0].optimistic

    if (optimistic || w.isAdded || (w.isRemoved && w.hasReferrals())) {
      await this._processBatch(batch)
    } else {
      w.removePending()
      return true
    }

    w.notify(batch)
    this._needsUpdate = true
    return true
  }

  async prepareBatch(batch) {
    const node = batch[0]
    // recomputed on every application, converges because prefixes converge
    node.weight = await resolveWeight(this, node)
    for (const n of batch) n.weight = node.weight

    if (
      node.hash &&
      this.system.hash &&
      b4a.equals(node.hash, this.system.hash) &&
      topo.isLinkingAll(node, this.system.heads)
    ) {
      return { undo: null, view: null, tip: [batch] }
    }

    const t = await topo.sort(this, batch)

    if (t.undo) {
      this.stats.undos++
      this.trusted.clear()
      t.view = await this.system.undo(t.undo)
    }

    return t
  }

  async _processBatch(batch) {
    // a stack: the tip is pushed in reverse so it pops in order
    const stack = [batch]

    while (stack.length) {
      const batch = stack.pop()
      const t = await this.prepareBatch(batch)

      if (t.view) {
        this._workingBee.move(t.view)
        for (let i = t.tip.length - 1; i >= 0; i--) stack.push(t.tip[i])
        continue
      }

      if (b4a.equals(batch[0].key, this.key) && batch[0].length === 1) {
        await this._host.addWriter(batch[0].key, { weight: this.bootstrapWeight })
      }

      await this._applyBatch(batch, batch[0].optimistic)

      // trigger any upstream writer waiting for this batch early
      const id = b4a.toString(batch[0].key, 'hex')
      const length = batch[batch.length - 1].length

      this.writers.triggers.trigger(id, length)
    }
  }

  async _applyBatch(batch, optimistic) {
    const local = batch[0].core === this.local

    const userBatch = []
    for (const node of batch) {
      this.system.addNode(node)

      if (node.approvals) {
        for (const a of node.approvals) {
          await this.system.addWriter(a.key, {
            weight: a.weight,
            coord: { key: node.key, length: node.length },
            carrier: node.weight,
            anchor: true
          })
        }
      }

      // compat: autobase nodes may be null (legacy null decodes to 0-length buffer)
      if (node.value && node.value.length) userBatch.push(node)
    }

    if (this._hasApply && (await this.system.canApply(batch[0].key, optimistic))) {
      this.stats.applies++
      this._host.applying = batch
      try {
        await this._workingView.apply(userBatch)
      } finally {
        this._host.applying = null
      }
    }

    // an optimistic node is always consumed: record its length and, unless apply
    // granted the writer, record the writer as removed so that only its
    // optimistic nodes reach apply
    if (optimistic) await this.system.ackWriter(batch[0].key)

    const changed = await this.system.flush(batch, this._workingBee)

    if (this.system.promotions.changed) this._prefetchApprovals().catch(safetyCatch)

    if (local) {
      this._localSystemLength = this.system.bee.context.local.length - this._localSystemStart
      this._localViewLength = this._workingBee.context.local.length - this._localViewStart
      this._localFlushes = this.system.flushes
    }

    for (const { key, added } of changed) {
      if (added) await this.writers.add(key)
      else await this.writers.remove(key)
    }
  }

  async _storeBoot() {
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

    await Promise.all(proms)

    if (this._migrating) {
      // clear legacy data
      await this.bootstrap.setUserData('autobase/local', null)
      await this.local.setUserData('autobase/boot', null)
      await this.local.setUserData('autobase/encryption', null)
      this._migrating = false
    }
  }

  static decodeValue(buf, opts) {
    return encoding.decodeValue(buf, opts)
  }

  static encodeValue(value, opts) {
    return encoding.encodeValue(value, opts)
  }

  // gates on the state boot only, so hints can still feed a parked boot-from -
  // the trailing bump waits for bootAll like any other drain
  async wakeup({ key, length }) {
    if (!this._bootGuard.opened) await this._bootGuard.ready()
    await this.writers.wakeup(key, length)
    await this._bump(false)
  }

  async append(values, { optimistic = false } = {}) {
    if (this.closing) throw new Error('Autobee closed')

    this.stats.appends++

    if (!Array.isArray(values)) values = [values]

    if (!this._bootGuard.opened) await this._bootGuard.ready()

    if (!optimistic && this.writers.localWriter.isRemoved) {
      throw new Error('Not writable')
    }

    await this.local.ready()

    const links = this.system.getLinks(this.local.key)
    const hash = this.system.hash

    // never stamp before anything we link
    const t = Math.max(this._now(), this.system.timestamp)
    const batch = []

    const rec = await this.system.get(this.local.key)
    let witness = null
    if (rec) {
      const hint = await this.system.grantHint(this.local.key)
      if (hint && hint.weight > currentWeight(rec)) {
        witness = { weight: hint.weight, link: { key: hint.key, length: hint.length } }
      }
    }

    const approvals = optimistic ? null : await this._collectApprovals()

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
        i === 0 ? witness : null,
        i === 0 ? approvals : null,
        i === 0 ? hash : null
      )
      batch.push(node)
    }

    return this._bump(false)
  }

  async _flushLocal() {
    // pull any available local nodes in before flushing
    while (!this._interrupting && (await this._bumpPendingWriters({ local: true }))) {
      // a bump that applied a batch flags the update itself
    }

    const flushed = await this.writers.flushLocal({
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

    if (flushed) this._ackFlushes = this._localFlushes

    this._localSystemStart = this.system.bee.context.local.length
    this._localSystemLength = 0
    this._localFlushes = this.system.flushes
    this._localViewStart = this._workingBee.context.local.length
    this._localViewLength = 0
  }

  async moveTo(head, { timeout = 0 } = {}) {
    if (!this._bootGuard.opened) await this._bootGuard.ready()
    if (this.closing) throw new Error('Autobee closed')

    const ff = await FastForward.fromHead(this, head, null, { force: true, timeout })
    if (ff === null) return null

    if (!(await this._runFastForward(ff))) return null

    return this.ff.promise
  }

  // legacy: ungated boot straight onto a system head
  async _bootFromSystem(system) {
    try {
      const ff = new FastForward(this, system, { timeout: FastForward.DEFAULT_TIMEOUT })
      return await this._runFastForward(ff)
    } catch (err) {
      safetyCatch(err)
      return false
    }
  }

  async _bootFromHead(head) {
    const timeout = FastForward.DEFAULT_TIMEOUT

    try {
      const oplog = await this._resolveOplogHint(head.key, head.length || 0, { timeout })
      if (oplog === null) return false

      const ff = await FastForward.fromHead(this, oplog, null, { force: true, timeout })

      return ff !== null && (await this._runFastForward(ff))
    } catch (err) {
      safetyCatch(err)
      return false
    }
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

  async _runMigration() {
    if (!this._handlers.migrate) {
      throw new Error('Missing migration handler')
    }

    const migration = this.system.migration
    this.system.migration = null

    await this._handlers.migrate(migration.views, migration.head)
  }

  async _applyFastForward() {
    const changes = this._hasUpdate ? new UpdateChanges(this) : null
    if (changes) changes.track()

    const { head } = this.fastForwardTo

    const from = this.system.bee.head()
    const to = head

    this.system.bee.move(head)
    await this.system.reset()
    if (this.system.migration) await this._runMigration()

    this.bee.move(this.system.view)
    this._workingBee.move(this.system.view)

    this._approvalCheck = true
    this.fastForwardTo = null

    // process any wakeup while fast-forward itself was in flight
    await this._applyWakeupHints()
    await this.writers.refresh()

    // we moved, so ask our peers to tell us their heads again
    this._requestWakeup()

    await this._update(changes, true)
    await this._storeBoot()

    await this._updateAcking()

    this.stats.fastForwards++
    this.emit('move-to', to, from)
    this.ff.resolve({ to, from })
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
  if (boot.key) return { legacy: boot, head: null }

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
