const b4a = require('b4a')
const encoding = require('./encoding.js')
const Triggers = require('./triggers.js')
const { LEGACY_OPLOG_VERSION } = require('./constants.js')
const { WriterEncryption } = require('autobee-encryption')

// a batch longer than this is malformed, stop loading rather than spin on it
const BATCH_WRITER_SANITY = 1024

// an optimistic writer we have not added gets a much shorter leash
const BATCH_OPTIMISTIC_SANITY = 32

// a node stamped further into the future than this is not applied yet
const MAX_FORWARD_TIME_DRIFT = 2 * 3600 * 1000

// blocks to read ahead past the tail
const WRITER_PREFETCH = 10

class ActiveWriters {
  constructor(auto) {
    this.auto = auto
    this.map = new Map()
    this.waitings = new Triggers()
    this.pending = []
  }

  get size() {
    return this.map.size
  }

  [Symbol.iterator]() {
    return this.map.values()
  }

  add(key) {
    const id = b4a.toHex(key)
    let w = this.map.get(id)
    if (w) return w

    w = new Writer(this, key, id)
    this.map.set(id, w)

    return w
  }

  get(key) {
    return this.map.get(b4a.toHex(key)) || null
  }
}

class Writer {
  constructor(writers, key, id) {
    this.writers = writers
    this.pending = 0
    this.core = null
    this.key = key
    this.id = id
    this.length = 0
    this.systemHead = null
    this.hintedLength = 0
    this.preloadLength = 0
    this.preload = null
    this.tail = null
    this.waiting = null

    this.isAdded = false
    this.isRemoved = false
    this.isPending = false
    this.isLinked = false
    this.isFrozen = false
    this.isClosed = false

    this._bumpBound = this.bump.bind(this)
  }

  isIdle() {
    // a loaded tail is work we have not applied yet
    if (this.tail !== null) return false
    const coreLength = this.core === null ? 0 : this.core.length
    return this.length >= this.hintedLength && this.length >= coreLength
  }

  addPending() {
    if (this.isPending) return
    this.isPending = true
    this.writers.pending.push(this)
    this.pending = this.writers.pending.length - 1
  }

  removePending() {
    if (!this.isPending) return
    this.isPending = false
    const head = this.writers.pending.pop()
    if (head === this) return
    this.writers.pending[this.pending] = head
    head.pending = this.pending
  }

  hint(length) {
    if (length > this.hintedLength) {
      this.hintedLength = length
      this.bump()
    }
  }

  bump() {
    // if still waiting, no use
    if (this.waiting && this.writers.triggers.active(this.waiting)) return
    if (this.isFrozen) return

    this.addPending()
    this.writers.auto.bumpSoon()
  }

  async _update() {
    await this._updateSystem()
    if (this.tail === null) await this._updateTail()
    if (!this.isLinked && this.tail !== null) await this._updateLinked()
    if (this.length < this.hintedLength) await this._updateHint()
  }

  async close() {
    if (this.writers.map.get(this.id) !== this) return
    this.writers.map.delete(this.id)
    this.isClosed = true
    this.removePending()
    this.removeWaiting()

    if (this.core) await this.core.close()
  }

  async _openCore() {
    if (this.core !== null) return

    const auto = this.writers.auto
    const local = b4a.equals(this.key, auto.local.key)
    const encryption = auto.encryptionKey ? new WriterEncryption(auto) : null
    const group = local || !auto.wakeupCapability ? null : auto.wakeupCapability.discoveryKey

    const core = auto.store.get({
      active: false,
      key: this.key,
      encryption,
      group
    })

    await core.ready()
    // TODO: pass as userData in store.get once corestore forwards that option
    await core.setUserData('referrer', auto.key)

    // another open, or a close, may have raced us
    if (this.core !== null || this.isClosed) {
      await core.close()
      return
    }

    this.core = core

    core.on('download', this._bumpBound)
    core.on('append', this._bumpBound)
  }

  _updatePreload(length) {
    if (this.core === null || length <= this.preloadLength || length <= this.length) return

    const preload = this.core.download({ start: this.length, end: length })
    const prev = this.preload

    this.preloadLength = length
    this.preload = preload

    if (prev) prev.destroy()
  }

  async _updateHint() {
    if (this.core === null) await this._openCore()
    this._updatePreload(this.length + WRITER_PREFETCH)
  }

  async _updateSystem() {
    const sys = this.writers.auto.system
    const head = sys.bee.head()
    if (sameHead(head, this.systemHead)) return

    const info = await sys.get(this.key)
    const length = info ? info.length : 0

    // the bootstrap writer is added implicitly until the system records it
    this.isAdded = info ? true : b4a.equals(this.key, this.writers.auto.key)
    this.isRemoved = info ? info.isRemoved : false

    this.systemHead = head
    this.isLinked = false

    if (length === this.length) return

    // the tail was loaded relative to the old length, so it is stale either way
    this.tail = null
    this.removeWaiting()

    // going backwards (undo or fast forward) invalidates the read-ahead too
    if (length < this.length && this.preload !== null) {
      this.preload.destroy()
      this.preload = null
      this.preloadLength = 0
    }

    this.length = length
  }

  async _updateTail() {
    if (this.core === null) await this._openCore()

    const prefetchLength = this.length + WRITER_PREFETCH
    const maxLength = this.length + BATCH_WRITER_SANITY

    this._updatePreload(prefetchLength)

    const genesis = this.writers.auto.system.isGenesis()

    const batch = []

    let optimistic = false
    let timestamp = 0

    while (true) {
      const seq = this.length + batch.length
      if (seq >= this.core.length) return

      const block = await this.core.get(seq, { wait: false })
      if (!block) return

      const node = this._createNode(block, seq)
      if (node === null) return

      if (batch.length === 0) {
        if (!this.isAdded && !node.optimistic && !genesis) return
        if (node.optimistic && genesis) return
      }

      // auto correct the batch invariants
      node.timestamp = timestamp = Math.max(node.timestamp, timestamp)
      node.optimistic = optimistic = optimistic || node.optimistic

      if (node.optimistic && !this.isAdded && node.batch.end >= BATCH_OPTIMISTIC_SANITY) return
      if (node.timestamp - Date.now() > MAX_FORWARD_TIME_DRIFT) return

      batch.push(node)

      const batchEnd = Math.min(seq + 1 + node.batch.end, maxLength)
      this._updatePreload(Math.max(batchEnd, prefetchLength))

      if (node.batch.end === 0) break
      if (batch.length >= BATCH_WRITER_SANITY) return
    }

    this.tail = finalizeNodeBatch(batch)
  }

  _createNode(block, seq) {
    try {
      return createNode(this.core, seq + 1, encoding.decodeOplog(block))
    } catch {
      this.isFrozen = true
      return null
    }
  }

  async _updateLinked() {
    if (this.isLinked) return
    if (this.tail === null || this.tail.length === 0) return
    if (this.waiting && this.writers.triggers.active(this.waiting)) return

    this.removeWaiting()

    const sys = this.writers.auto.system
    const node = this.tail[0]
    const links = node.witness ? node.links.concat(node.witness.link) : node.links
    const promises = new Array(links.length)

    for (let i = 0; i < links.length; i++) {
      const link = links[i]
      const self = link.length < node.length && b4a.equals(link.key, this.key)
      promises[i] = self ? Promise.resolve(true) : sys.has(link)
    }

    const has = await Promise.all(promises)

    let linked = true

    for (let i = 0; i < links.length; i++) {
      if (has[i]) continue

      const link = links[i]

      if (linked) {
        this.waiting = this.writers.triggers.add(b4a.toHex(link.key), link.length, this)
        linked = false
      }

      this.writers.add(link.key).hint(link.length)
    }

    if (linked) this.isLinked = true
  }

  removeWaiting() {
    if (this.waiting === null) return
    this.writers.triggers.remove(this.waiting)
    this.waiting = null
  }
}

function createNode(core, length, oplog) {
  return {
    core,
    from: core, // compat
    key: core.key,
    length,
    weight: -1,
    version: oplog.version,
    timestamp: oplog.timestamp,
    links: oplog.links,
    batch: oplog.batch,
    views: oplog.views,
    trusted: oplog.trusted || [],
    witness: oplog.witness || null,
    approvals: oplog.approvals || null,
    optimistic: oplog.optimistic,
    value: oplog.value,
    hash: oplog.hash || null,
    weightHint: oplog.weightHint || 0,
    drift: oplog.drift || 0
  }
}

// legacy oplogs did not record their position in the batch
function finalizeNodeBatch(batch) {
  if (batch[0].version > LEGACY_OPLOG_VERSION) return batch

  for (let i = 0; i < batch.length; i++) batch[i].batch.start = i

  return batch
}

function sameHead(a, b) {
  return a && b && a.length === b.length && b4a.equals(a.key, b.key)
}
