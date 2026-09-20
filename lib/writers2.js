const b4a = require('b4a')
const encoding = require('./encoding.js')
const { LEGACY_OPLOG_VERSION } = require('./constants.js')
const { WriterEncryption } = require('autobee-encryption')

const IS_ADDED = 1
const IS_REMOVED = 2
const IS_PENDING = 4
const IS_LINKED = 8
const IS_CLOSED = 16

const ALL = 2 * IS_CLOSED - 1
const NOT_PENDING = ALL ^ IS_PENDING
const NOT_LINKED = ALL ^ IS_LINKED

// a batch longer than this is malformed, stop loading rather than spin on it
const BATCH_WRITER_SANITY = 1024

// blocks to read ahead past the tail
const WRITER_PREFETCH = 10

class ActiveWriters {
  constructor(auto) {
    this.auto = auto
    this.map = new Map()
    this.pending = []
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
  constructor (writers, key, id) {
    this.writers = writers
    this.status = 0
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

    this._bumpSoonBound = this.bumpSoon.bind(this)
  }

  isIdle() {
    return this.length >= this.hintedLength && this.length >= this.core.length
  }

  addPending() {
    if ((this.status & IS_PENDING) !== 0) return
    this.writers.pending.push(this)
    this.pending = this.writers.pending.length - 1
    this.status |= IS_PENDING
  }

  removePending() {
    if ((this.status & IS_PENDING) === 0) return
    this.status &= NOT_PENDING
    const head = this.writers.pending.pop()
    if (head === this) return
    this.writers.pending[this.pending] = head
    head.pending = this.pending
  }

  hint(length) {
    if (length > this.hintedLength) {
      this.hintedLength = length
      this.bumpSoon()
    }
  }

  bumpSoon() {
    // if waiting to be linked, wait for that
    if ((this.status & IS_LINKED) === 0 && this.tail !== null) return

    this.addPending()
    this.writers.auto.bumpSoon()
  }

  async _update() {
    await this._updateSystem()
    if (this.tail === null) await this._updateTail()
    if ((this.status & IS_LINKED) === 0 && this.tail !== null) await this._updateLinked()
    if (this.length < this.hintedLength) await this._updateHint()
  }

  async close() {
    if (this.writers.map.get(this.id) !== this) return
    this.writers.map.delete(this.id)
    this.status |= IS_CLOSED
    this.removePending()

    if (this.core) await this.core.close()
  }

  async _openCore() {
    if (this.core !== null) return

    const auto = this.writers.auto
    const local = b4a.equals(this.key, auto.local.key)
    const encryption = auto.encryptionKey ? new WriterEncryption(auto) : null
    const group = (local || !auto.wakeupCapability) ? null : auto.wakeupCapability.discoveryKey

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
    if (this.core !== null || (this.status & IS_CLOSED) !== 0) {
      await core.close()
      return
    }

    this.core = core

    core.on('download', this._bumpSoonBound)
    core.on('append', this._bumpSoonBound)
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
    const added = info ? true : b4a.equals(this.key, this.writers.auto.key)
    const removed = info ? info.isRemoved : false

    this.status &= ~(IS_ADDED | IS_REMOVED)
    if (added) this.status |= IS_ADDED
    if (removed) this.status |= IS_REMOVED

    this.systemHead = head
    this.status &= NOT_LINKED

    if (length === this.length) return

    // the tail was loaded relative to the old length, so it is stale either way
    this.tail = null

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

    const batch = []

    while (true) {
      const seq = this.length + batch.length
      if (seq >= this.core.length) return

      const block = await this.core.get(seq, { wait: false })
      if (!block) return

      const oplog = encoding.decodeOplog(block)
      batch.push(createNode(this.core, seq + 1, oplog))

      const batchEnd = Math.min(seq + 1 + oplog.batch.end, maxLength)
      this._updatePreload(Math.max(batchEnd, prefetchLength))

      if (oplog.batch.end === 0) break
      if (batch.length >= BATCH_WRITER_SANITY) return
    }

    this.tail = finalizeNodeBatch(batch)
  }

  async _updateLinked() {
    if ((this.status & IS_LINKED) !== 0) return
    if (this.tail === null || this.tail.length === 0) return

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
      this.writers.add(link.key).hint(link.length)
      linked = false
    }

    if (linked) this.status |= IS_LINKED
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
