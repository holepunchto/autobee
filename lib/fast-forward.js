const safetyCatch = require('safety-catch')
const b4a = require('b4a')
const Hypercore = require('hypercore')

const System = require('./system.js')
const migrations = require('./migrations.js')
const { LEGACY_AUTOBASE_VERSION, LEGACY_OPLOG_VERSION } = require('./constants.js')

const DEFAULT_OP_TIMEOUT = 5_000
const MIN_FF_GAP = 32

class FastForward {
  constructor(auto, head, { timeout = DEFAULT_OP_TIMEOUT } = {}) {
    this.auto = auto

    this.activeRequests = []

    // 'reboot' is a storage namespace: renaming it would derive a different
    // scratch core on disk, so it stays as is
    this.system = new System(auto, auto.store.namespace('reboot'), {
      getEncryptionProvider: this.auto.getSystemEncryption,
      encrypted: this.encrypted,
      activeRequests: this.activeRequests
    })

    // length -1 marks an uninitialised head: we know the key but not the length
    this.head = { key: head.key, length: head.length ?? 0 }
    this.timeout = timeout
    this.destroyed = false
    this.running = null
    this.failed = false
    this.cores = []
    this.warmup = null
    this.warmupView = null
  }

  static DEFAULT_TIMEOUT = DEFAULT_OP_TIMEOUT

  static async fromHead(auto, head, trusted, { force = false, timeout = 0 } = {}) {
    const conservative = !force && auto._conservativeFF
    const timeoutOpts = timeout ? { timeout } : null

    const oplog = await FastForward.flushHead(auto, head, {
      conservative,
      ...timeoutOpts
    })
    if (!oplog) return null

    const verified = trusted ? await FastForward.flushHead(auto, trusted, timeoutOpts) : oplog
    if (!verified) return null

    // legacy nodes from non-indexers have no system info to fast-forward from
    if (!oplog.op.views || !verified.op.views) return null

    if (!force && verified.op.views.flushes - auto.system.flushes < MIN_FF_GAP) {
      return null
    }

    return new FastForward(auto, batchToHead(verified.op.views.system))
  }

  static async fromHeads(auto, heads, { force = false, timeout = 0 } = {}) {
    const reference = auto._workingView.view

    const promises = []

    for (const head of heads) {
      if (head.length === 0) continue
      promises.push(FastForward.flushHead(auto, head, timeout ? { timeout } : null))
    }

    const ops = await Promise.all(promises)
    if (auto.fastForwarding || auto.fastForwardTo) return null

    const trust = await Promise.all(
      ops.map((res) => {
        return res === null ? false : auto.trusted.isTrusted(res.key, reference)
      })
    )
    if (auto.fastForwarding || auto.fastForwardTo) return null

    const candidates = []

    let bestTrusted = null
    let bestTrustedFlushes = -1

    for (let i = 0; i < ops.length; i++) {
      const res = ops[i]
      if (res === null || !res.op.views) continue
      if (!force && res.op.views.flushes - auto.system.flushes < MIN_FF_GAP) continue

      if (!trust[i]) {
        candidates.push(res)
        continue
      }

      if (res.op.views.flushes > bestTrustedFlushes) {
        bestTrustedFlushes = res.op.views.flushes
        bestTrusted = res
      }
    }

    if (bestTrusted !== null) {
      return FastForward.fromHead(auto, bestTrusted, null, { force, timeout })
    }

    candidates.sort((a, b) => b.op.views.flushes - a.op.views.flushes)

    for (const res of candidates) {
      const trusted = await FastForward.mostRecentTrusted(auto, res, reference)
      if (trusted === null) continue
      if (auto.fastForwarding || auto.fastForwardTo) return null

      const ff = await FastForward.fromHead(auto, res, trusted, { force, timeout })
      if (ff !== null) return ff
    }

    return null
  }

  static async flushHead(auto, head, opts) {
    const core = auto.openCore(head.key)

    try {
      const oplog = await auto.readOplog(core, head.length, opts)
      if (oplog === null) return null
      return oplog.op.views ? oplog : null
    } finally {
      await core.close()
    }
  }

  static async mostRecentTrusted(auto, head, reference) {
    const opened = auto.openViewAt(head)
    if (opened === null) return null

    try {
      return (await auto.trusted.mostRecentTrusted(opened.view, reference)) || null
    } finally {
      await opened.close()
    }
  }

  async run() {
    try {
      if (!this.running) this.running = this._run()

      return await this.running
    } catch (err) {
      safetyCatch(err)
      this.failed = true
      return null
    } finally {
      await this.close()
    }
  }

  async _run() {
    // an uninitialised head has an unknown length: wait for the core to catch up
    if (!this.head.length) {
      this.head.length = await this._resolveLength()
    }

    // zero-length boot is unsupported
    if (!this.head.length) return null

    await this.system.boot(this.head, { timeout: this.timeout })

    if (this.system.version <= LEGACY_AUTOBASE_VERSION) {
      if (!(await this._runLegacy())) return null
    }

    const promises = []

    if (this._startWarmup()) promises.push(this.warmup)

    // ensure local key is locally available always
    promises.push(this.system.get(this.auto.local.key, { timeout: this.timeout }))

    // a legacy system without the designated view migrates onto an empty view
    if (this.system.view.length) {
      const view = this.auto.store.get({ key: this.system.view.key, active: true })
      this.cores.push(view)

      promises.push(
        view.get(this.system.view.length - 1, {
          timeout: this.timeout,
          activeRequests: this.activeRequests
        })
      )
    }

    for (const head of this.system.heads) {
      promises.push(this.system.get(head.key, { timeout: this.timeout }))
    }

    await Promise.all(promises)
    if (this.destroyed) return null

    return {
      head: this.head,
      migrate: null
    }
  }

  _startWarmup() {
    if (!this.auto._warmup || !this.system.view.length) return false

    this.warmupView = this.auto.openView(this.system.view)
    this.warmup = Promise.resolve(this.auto._warmup(this.warmupView.view))

    return true
  }

  async _resolveLength() {
    const core = this.auto.store.get({ key: this.head.key })
    this.cores.push(core)

    await core.ready()

    return migrations.coreLength(core, this.timeout)
  }

  async _runLegacy() {
    const resolved = await this._resolveLegacy()
    if (resolved === null) return false

    const { head, autobee } = resolved

    if (autobee !== null) {
      try {
        this.head = batchToHead(autobee.op.views.system)
        await this.system.boot(this.head, { timeout: this.timeout })
        if (this.system.version > LEGACY_AUTOBASE_VERSION) return true
      } catch (err) {
        safetyCatch(err)
      }
    }

    this.head = head
    await this.system.boot(this.head, { timeout: this.timeout })

    return true
  }

  async _resolveLegacy() {
    let head = { key: this.head.key, length: this.head.length }
    const seen = new Set()

    // bound at 5 hops for safety
    let hops = 5
    while (true) {
      seen.add(b4a.toString(head.key, 'hex'))

      const core = this.auto.store.get({ key: head.key, encryption: null })
      this.cores.push(core)
      await core.ready()

      await core.setEncryption(this.auto.getSystemEncryption())

      // successors are resolved by key only - wait for the replicated length
      if (!head.length) head.length = await migrations.coreLength(core, this.timeout)
      if (!head.length || this.destroyed) return null

      const info = await migrations.readLegacySystemInfo(core, head.length, {
        timeout: this.timeout,
        activeRequests: this.activeRequests
      })

      const { legacy, autobee } = await findNewestSystem(this, info)
      if (this.destroyed) return null

      // an autobee candidate ends the crawl: it may be behind, but once we are
      // on autobee the ordinary fast-forward carries us to the newest view
      if (autobee !== null) return { head, autobee }

      if (hops-- > 0 && legacy !== null && !seen.has(b4a.toString(legacy, 'hex'))) {
        head = { key: legacy, length: 0 }
        continue
      }

      return { head, autobee: null }
    }
  }

  // cancels every read in flight and fails any that come after
  clearRequests(err = null) {
    Hypercore.destroyRequests(this.activeRequests, err)
  }

  async close() {
    this.destroyed = true
    this.clearRequests()

    // close view to cancel inflight reads
    if (this.warmupView) {
      const view = this.warmupView
      this.warmupView = null
      await view.close()
    }

    if (this.warmup) await this.warmup.catch(safetyCatch)

    if (this.system) await this.system.close()
    for (const core of this.cores) await core.close()
  }
}

module.exports = FastForward

async function findNewestSystem(ff, info) {
  let autobee = null
  let legacy = null
  let flushes = -1

  for (const idx of info.indexers) {
    const core = ff.auto.openCore(idx.key)
    ff.cores.push(core)
    await core.ready()

    const length = await migrations.coreLength(core, ff.timeout)
    if (!length || length <= idx.length || ff.destroyed) continue

    const oplog = await FastForward.flushHead(
      ff.auto,
      { key: idx.key, length },
      { timeout: ff.timeout }
    )
    if (oplog === null || !oplog.op.views) continue

    // this indexer has already moved to autobee: follow it rather than
    // digging a legacy stamp out of its history
    if (oplog.op.version > LEGACY_OPLOG_VERSION) {
      if (autobee === null || oplog.op.views.flushes > autobee.op.views.flushes) {
        autobee = oplog
      }
      continue
    }

    const sys = oplog.op.views.system
    if (!sys || !sys.key) continue

    // follow whichever indexer has checkpointed furthest
    if (oplog.op.views.flushes > flushes) {
      flushes = oplog.op.views.flushes
      legacy = sys.key
    }
  }

  return { legacy, autobee }
}

function batchToHead(b) {
  return {
    key: b.key,
    length: b.start + b.length
  }
}
