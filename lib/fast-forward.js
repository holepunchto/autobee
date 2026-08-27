const safetyCatch = require('safety-catch')
const b4a = require('b4a')
const Hypercore = require('hypercore')

const System = require('./system.js')
const migrations = require('./migrations.js')
const { LEGACY_AUTOBASE_VERSION } = require('./constants.js')

const DEFAULT_OP_TIMEOUT = 5_000
const MIN_FF_GAP = 32

// views are only stamped on the last node of a flush, so a head may sit above
// the most recent one - how far back we look for it
const MAX_FLUSH_SEARCH = 64

module.exports = class FastForward {
  constructor(auto, head, tip, { timeout = DEFAULT_OP_TIMEOUT } = {}) {
    this.auto = auto

    this.activeRequests = []

    // 'reboot' is a storage namespace: renaming it would derive a different
    // scratch core on disk, so it stays as is
    this.system = new System(auto.store.namespace('reboot'), null, {
      getEncryptionProvider: this.auto.getSystemEncryption,
      encrypted: this.encrypted,
      activeRequests: this.activeRequests
    })

    // length -1 marks an uninitialised head: we know the key but not the length
    this.head = { key: head.key, length: head.length ?? 0 }
    this.timeout = timeout
    this.tip = tip || null
    this.destroyed = false
    this.running = null
    this.failed = false
    this.cores = []
  }

  static DEFAULT_TIMEOUT = DEFAULT_OP_TIMEOUT

  static async fromHead(
    auto,
    head,
    trusted,
    { force = false, timeout = 0, condition = null, reference = null } = {}
  ) {
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

    if (condition !== null && !(await FastForward.accepts(auto, verified, condition, reference))) {
      return null
    }

    const tip = {
      system: batchToHead(oplog.op.views.system),
      verified: {
        op: { key: verified.key, length: verified.length },
        flushes: verified.op.views.flushes
      }
    }

    return new FastForward(auto, batchToHead(verified.op.views.system), tip)
  }

  static async fromHeads(
    auto,
    heads,
    { force = false, timeout = 0, condition = null, reference = null } = {}
  ) {
    if (reference === null) reference = auto._workingView.view

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
      return FastForward.fromHead(auto, bestTrusted, null, {
        force,
        timeout,
        condition,
        reference
      })
    }

    candidates.sort((a, b) => b.op.views.flushes - a.op.views.flushes)

    for (const res of candidates) {
      const trusted = await FastForward.mostRecentTrusted(auto, res, reference)
      if (trusted === null) continue
      if (auto.fastForwarding || auto.fastForwardTo) return null

      const ff = await FastForward.fromHead(auto, res, trusted, {
        force,
        timeout,
        condition,
        reference
      })
      if (ff !== null) return ff
    }

    return null
  }

  static async flushHead(auto, head, opts) {
    const core = auto.openCore(head.key)

    try {
      let length = head.length

      for (let i = 0; i < MAX_FLUSH_SEARCH; i++) {
        const oplog = await auto.readOplog(core, length, opts)
        if (oplog === null) return null
        if (oplog.op.views) return oplog

        length = oplog.length - 1
        if (length <= 0) return null
      }

      return null
    } finally {
      await core.close()
    }
  }

  static async accepts(auto, oplog, condition, reference) {
    const opened = auto.openViewAt(oplog)
    if (opened === null) return false

    try {
      return !!(await condition(opened.view, reference))
    } finally {
      await opened.close()
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

    // a legacy system needs migrating rather than a plain fast-forward
    if (this.system.version <= LEGACY_AUTOBASE_VERSION) {
      const migrated = this.auto._migratedHead && this.auto._migratedHead.system
      if (
        migrated &&
        b4a.equals(migrated.key, this.head.key) &&
        migrated.length >= this.head.length
      ) {
        return null
      }

      const result = await this._migrate()
      if (result === null || result.autobee === null) return result

      // an indexer of the newest legacy generation already moved to autobee -
      // fast-forward straight onto its announced head instead of migrating,
      // falling back to the legacy migration if the head cannot be booted
      try {
        this.head = result.autobee
        await this.system.boot(this.head, { timeout: this.timeout })
        if (this.system.version <= LEGACY_AUTOBASE_VERSION) {
          throw new Error('Expected an autobee system')
        }
      } catch (err) {
        safetyCatch(err)
        this.head = result.head
        return { head: result.head, tip: null, migrate: result.migrate }
      }

      // fall through to the plain fast-forward below
    }

    const promises = []

    // ensure local key is locally available always
    promises.push(this.system.get(this.auto.local.key, { timeout: this.timeout }))

    const view = this.auto.store.get({ key: this.system.view.key, active: true })
    this.cores.push(view)

    promises.push(
      view.get(this.system.view.length - 1, {
        timeout: this.timeout,
        activeRequests: this.activeRequests
      })
    )

    for (const head of this.system.heads) {
      promises.push(this.system.get(head.key, { timeout: this.timeout }))
    }

    await Promise.all(promises)
    if (this.destroyed) return null

    if (this.destroyed) return null

    return {
      head: this.head,
      tip: this.tip,
      migrate: null
    }
  }

  // Upgrade a legacy (pre-AUTOBEE_VERSION) system in place. The system already
  // booted above (coerced to the current struct), but the original v1/v2 struct
  // is needed to recover the indexers/views/entropy, so decode the raw block.
  //
  // A head may be arbitrarily old: an indexer rotation freezes the system core
  // and moves the indexers to a successor. The frozen core cannot reveal its
  // successor (the promotion only lands in its unsigned tail), but the
  // indexers' newest oplog digests stamp the newest system they know - chase
  // those so the migration lands on the newest generation instead of the head
  // we were given.
  async _migrate() {
    let head = { key: this.head.key, length: this.head.length }
    const seen = new Set()

    for (let hops = 0; hops < migrations.MAX_MIGRATE_HOPS; hops++) {
      seen.add(b4a.toString(head.key, 'hex'))

      const core = this.auto.store.get({ key: head.key, encryption: null })
      this.cores.push(core)
      await core.ready()

      // setup encryption
      await core.setEncryption(this.auto.getSystemEncryption())

      // successors are resolved by key only - wait for the replicated length
      if (!head.length) head.length = await migrations.coreLength(core, this.timeout)
      if (!head.length || this.destroyed) return null

      const info = await migrations.readLegacySystemInfo(core, head.length, {
        timeout: this.timeout,
        activeRequests: this.activeRequests
      })

      const { legacy, autobee } = await migrations.findNewestSystem(this, info)
      if (this.destroyed) return null

      if (legacy !== null && !seen.has(b4a.toString(legacy, 'hex'))) {
        head = { key: legacy, length: 0 }
        continue
      }

      this.head = head

      const views = await migrations.resolveLegacyViews(this, info)
      if (views === null || this.destroyed) return null

      return {
        head,
        tip: null,
        migrate: views,
        autobee: autobee === null ? null : batchToHead(autobee.op.views.system)
      }
    }

    return null
  }

  async _resolveLength() {
    const core = this.auto.store.get({ key: this.head.key })
    this.cores.push(core)

    await core.ready()

    return migrations.coreLength(core, this.timeout)
  }

  // cancels every read in flight and fails any that come after
  clearRequests(err = null) {
    Hypercore.destroyRequests(this.activeRequests, err)
  }

  async close() {
    this.destroyed = true
    this.clearRequests()
    if (this.system) await this.system.close()
    for (const core of this.cores) await core.close()
  }
}

function batchToHead(b) {
  return {
    key: b.key,
    length: b.start + b.length
  }
}
