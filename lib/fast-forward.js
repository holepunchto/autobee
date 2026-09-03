const safetyCatch = require('safety-catch')
const b4a = require('b4a')
const Hypercore = require('hypercore')

const System = require('./system.js')
const migrations = require('./migrations.js')
const { LEGACY_AUTOBASE_VERSION } = require('./constants.js')
const { trace } = require('./debug-log.js')

const DEFAULT_OP_TIMEOUT = 5_000
const MIN_FF_GAP = 32

module.exports = class FastForward {
  constructor(auto, head, { timeout = DEFAULT_OP_TIMEOUT } = {}) {
    this.auto = auto

    this.activeRequests = []

    // 'reboot' is a storage namespace: renaming it would derive a different
    // scratch core on disk, so it stays as is
    this.system = new System(auto.store.namespace('reboot'), 'reboot', {
      getEncryptionProvider: this.auto.getSystemEncryption,
      encrypted: this.encrypted,
      activeRequests: this.activeRequests
    })

    this.system.auto = auto

    // length -1 marks an uninitialised head: we know the key but not the length
    this.head = { key: head.key, length: head.length ?? 0 }
    this.timeout = timeout
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

    if (!oplog) {
      trace(auto, 'ff: head unreadable', { head, conservative })
      return null
    }

    const verified = trusted ? await FastForward.flushHead(auto, trusted, timeoutOpts) : oplog

    if (!verified) {
      trace(auto, 'ff: trusted head unreadable', { head, trusted })
      return null
    }

    // legacy nodes from non-indexers have no system info to fast-forward from
    if (!oplog.op.views || !verified.op.views) {
      trace(auto, 'ff: head carries no system info (non-indexer)', { head })
      return null
    }

    if (!force && verified.op.views.flushes - auto.system.flushes < MIN_FF_GAP) {
      trace(auto, 'ff: gap too small to bother', {
        head,
        theirFlushes: verified.op.views.flushes,
        ourFlushes: auto.system.flushes,
        minGap: MIN_FF_GAP
      })
      return null
    }

    if (condition !== null && !(await FastForward.accepts(auto, verified, condition, reference))) {
      trace(auto, 'ff: host rejected the head', { head })
      return null
    }

    const target = batchToHead(verified.op.views.system)

    trace(auto, 'ff: head accepted', {
      head,
      system: target,
      theirFlushes: verified.op.views.flushes,
      ourFlushes: auto.system.flushes
    })

    return new FastForward(auto, target)
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

    trace(auto, 'ff: read candidate heads', {
      asked: heads.length,
      readable: ops.filter((o) => o !== null).length
    })

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
      trace(auto, 'ff: best trusted candidate', {
        key: bestTrusted.key,
        length: bestTrusted.length,
        flushes: bestTrustedFlushes
      })

      return FastForward.fromHead(auto, bestTrusted, null, {
        force,
        timeout,
        condition,
        reference
      })
    }

    candidates.sort((a, b) => b.op.views.flushes - a.op.views.flushes)

    trace(auto, 'ff: no trusted candidate, trying untrusted', {
      candidates: candidates.length
    })

    for (const res of candidates) {
      const trusted = await FastForward.mostRecentTrusted(auto, res, reference)

      if (trusted === null) {
        trace(auto, 'ff: candidate has no trust path to us', {
          key: res.key,
          length: res.length
        })
        continue
      }

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
      const oplog = await auto.readOplog(core, head.length, opts)
      if (oplog === null) return null
      return oplog.op.views ? oplog : null
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
    trace(this, 'ff: resolving target head', { head: this.head })

    // an uninitialised head has an unknown length: wait for the core to catch up
    if (!this.head.length) {
      this.head.length = await this._resolveLength()
      trace(this, 'ff: resolved head length over the wire', { head: this.head })
    }

    // zero-length boot is unsupported
    if (!this.head.length) {
      trace(this, 'ff: head length never arrived, aborting', { head: this.head })
      return null
    }

    await this.system.boot(this.head, { timeout: this.timeout })

    trace(this, 'ff: target system booted', {
      head: this.head,
      version: this.system.version,
      flushes: this.system.flushes,
      view: this.system.view,
      heads: this.system.heads
    })

    // a legacy system needs migrating rather than a plain fast-forward
    if (this.system.version <= LEGACY_AUTOBASE_VERSION) {
      trace(this, 'migrate: target head is a legacy system', {
        head: this.head,
        version: this.system.version
      })

      const migrated = this.auto._migratedHead && this.auto._migratedHead.system
      if (
        migrated &&
        b4a.equals(migrated.key, this.head.key) &&
        migrated.length >= this.head.length
      ) {
        trace(this, 'migrate: already migrated this head, nothing to do', { head: this.head })
        return null
      }

      const result = await this._migrate()

      if (result === null) {
        trace(this, 'migrate: could not resolve legacy state', { head: this.head })
        return null
      }

      if (result.autobee === null) {
        trace(this, 'migrate: no indexer moved to autobee yet, migrating locally', {
          head: result.head,
          views: result.migrate
        })
        return result
      }

      // an indexer of the newest legacy generation already moved to autobee -
      // fast-forward straight onto its announced head instead of migrating,
      // falling back to the legacy migration if the head cannot be booted
      trace(this, 'migrate: an indexer already moved to autobee, chasing it', {
        head: result.autobee
      })

      try {
        this.head = result.autobee
        await this.system.boot(this.head, { timeout: this.timeout })
        if (this.system.version <= LEGACY_AUTOBASE_VERSION) {
          throw new Error('Expected an autobee system')
        }
      } catch (err) {
        trace(this, 'migrate: autobee head unusable, falling back to local migration', {
          head: result.head,
          message: err.message
        })
        safetyCatch(err)
        this.head = result.head
        return { head: result.head, migrate: result.migrate }
      }

      trace(this, 'migrate: booted the autobee head instead of migrating', { head: this.head })

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

    trace(this, 'ff: prefetching view and writer heads', {
      view: this.system.view,
      heads: this.system.heads.length
    })

    await Promise.all(promises)
    if (this.destroyed) return null

    if (this.destroyed) return null

    trace(this, 'ff: prefetch complete', { head: this.head })

    return {
      head: this.head,
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

      trace(this, 'migrate: chasing legacy system generation', { hop: hops, head })

      const core = this.auto.store.get({ key: head.key, encryption: null })
      this.cores.push(core)
      await core.ready()

      // setup encryption
      await core.setEncryption(this.auto.getSystemEncryption())

      // successors are resolved by key only - wait for the replicated length
      if (!head.length) head.length = await migrations.coreLength(core, this.timeout)

      if (!head.length || this.destroyed) {
        trace(this, 'migrate: legacy system core length never arrived', { head })
        return null
      }

      const info = await migrations.readLegacySystemInfo(core, head.length, {
        timeout: this.timeout,
        activeRequests: this.activeRequests
      })

      trace(this, 'migrate: read legacy system info', {
        head,
        version: info.version,
        indexers: info.indexers.length,
        views: info.views.length
      })

      const { legacy, autobee } = await migrations.findNewestSystem(this, info)
      if (this.destroyed) return null

      if (legacy !== null && !seen.has(b4a.toString(legacy, 'hex'))) {
        trace(this, 'migrate: indexers point at a newer legacy system', { next: legacy })
        head = { key: legacy, length: 0 }
        continue
      }

      this.head = head

      const views = await migrations.resolveLegacyViews(this, info)

      if (views === null || this.destroyed) {
        trace(this, 'migrate: could not resolve the legacy views', { head })
        return null
      }

      trace(this, 'migrate: newest legacy generation resolved', {
        head,
        views,
        autobee: autobee === null ? null : { key: autobee.key, length: autobee.length }
      })

      return {
        head,
        migrate: views,
        autobee: autobee === null ? null : batchToHead(autobee.op.views.system)
      }
    }

    trace(this, 'migrate: ran out of hops chasing legacy systems', {
      hops: migrations.MAX_MIGRATE_HOPS
    })

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
