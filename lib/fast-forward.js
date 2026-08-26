const safetyCatch = require('safety-catch')
const b4a = require('b4a')
const Hypercore = require('hypercore')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')

const { decodeBlock } = require('hyperbee2/lib/encoding.js')

const System = require('./system.js')
const { assert } = require('./asserts.js')
const { LEGACY_AUTOBASE_VERSION } = require('./constants.js')
const { getEncoding } = require('../encoding/spec/autobee')

const SystemInfoV1 = getEncoding('@autobase-compat/info-v1')
const SystemInfoV2 = getEncoding('@autobase-compat/info-v2')

const INDEX_VERSION = 1
const [NS_SIGNER_NAMESPACE] = crypto.namespace('autobase', 1)

const EMPTY = b4a.alloc(0)
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

      return this._migrate()
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

    // heads that are still-unlinked optimistic nodes need an ack from us -
    // whoever applied them live may be long offline
    const optimistic = []
    for (const head of this.system.heads) {
      if (b4a.equals(head.key, this.auto.local.key)) continue
      promises.push(this._pushIfOptimistic(head, optimistic))
    }

    await Promise.all(promises)
    if (this.destroyed) return null

    return {
      head: this.head,
      tip: this.tip,
      migrate: null,
      optimistic
    }
  }

  async _pushIfOptimistic(head, optimistic) {
    try {
      const oplog = await this.auto._getOplog(head.key, head.length, { timeout: this.timeout })
      if (oplog && oplog.op.optimistic) optimistic.push(head)
    } catch {}
  }

  // Upgrade a legacy (pre-AUTOBEE_VERSION) system in place. The system already
  // booted above (coerced to the current struct), but the original v1/v2 struct
  // is needed to recover the indexers/views/entropy, so decode the raw block.
  async _migrate() {
    const core = this.auto.store.get({ key: this.head.key, encryption: null })
    this.cores.push(core)
    await core.ready()

    // setup encryption
    await core.setEncryption(this.auto.getSystemEncryption())

    // Decode hyperbee block using hyperbee2 compat
    const node = decodeBlock(
      await core.get(this.head.length - 1, {
        timeout: this.timeout,
        activeRequests: this.activeRequests
      })
    )
    assert(node.keys.length > 0, 'bad system block')

    // Decode system info from hyperbee block using autobee compat
    const info = decodeLegacySystemInfo(node.keys[0].value)

    const indexerManifests = await Promise.all(
      info.indexers.map((idx) => this.getCoreManifest(idx.key, idx.length))
    )
    const entropy =
      info.version > 1 && info.entropy ? info.entropy : indexerManifests[0].signers[0].namespace

    const views = new Map()
    const viewProms = []

    for (const name of this.auto.legacyViews) {
      viewProms.push(this.findViewByName(views, indexerManifests, info.views, entropy, name))
    }

    await Promise.all(viewProms)
    if (this.destroyed) return null

    return {
      head: this.head,
      tip: null,
      migrate: views
    }
  }

  async _resolveLength() {
    const core = this.auto.store.get({ key: this.head.key })
    this.cores.push(core)

    await core.ready()

    return coreLength(core, this.timeout)
  }

  async getCoreManifest(key, length) {
    const core = this.auto.store.get(key)
    this.cores.push(core)

    await core.ready()

    try {
      if (!core.manifest) {
        await core.get(length - 1, {
          timeout: this.timeout,
          activeRequests: this.activeRequests
        })
      }
    } catch {
      return null
    }

    return core.manifest
  }

  async findViewByName(result, indexerManifests, views, entropy, name) {
    if (indexerManifests.length === 0) return null

    const namespace = deriveNamespace(name, this.auto.key, entropy, this.auto.encryptionKey)

    for (const v of views) {
      const manifest = await this.getCoreManifest(v.key, v.length)
      if (!manifest) continue

      if (manifest.signers.length === 0) continue

      const signer = manifest.signers[0]

      if (b4a.equals(signer.namespace, namespace)) {
        result.set(name, v)
        return
      }
    }
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

function decodeLegacySystemInfo(buffer) {
  const state = { start: 0, end: buffer.length, buffer }
  const version = c.uint.decode(state)

  state.start--

  switch (version) {
    case 1:
      return SystemInfoV1.decode(state)
    case 2:
      return SystemInfoV2.decode(state)
    default:
      return { version }
  }
}

function coreLength(core, timeout) {
  if (core.length) return core.length

  return new Promise((resolve) => {
    core.on('append', () => resolve(core.length))
    setTimeout(resolve, timeout, 0)
  })
}

function deriveNamespace(name, bootstrap, entropy, encryptionKey) {
  const encryptionId = crypto.hash(encryptionKey || EMPTY)
  const version = c.encode(c.uint, INDEX_VERSION)

  return crypto.hash([
    NS_SIGNER_NAMESPACE,
    version,
    bootstrap,
    encryptionId,
    entropy,
    b4a.from(name)
  ])
}
