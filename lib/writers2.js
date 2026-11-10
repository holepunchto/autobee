const b4a = require('b4a')
const encoding = require('./encoding.js')
const Triggers = require('./triggers.js')
const { LEGACY_OPLOG_VERSION } = require('./constants.js')
const { WriterEncryption } = require('./encryption.js')

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
    this.triggers = new Triggers()
    this.pending = []
    this.writable = false
    this.localWriter = null

    this._setLocal(auto.local)
  }

  get size() {
    return this.map.size
  }

  [Symbol.iterator]() {
    return this.map.values()
  }

  drain() {}

  resolved(key, length) {
    this.triggers.trigger(b4a.toHex(key), length)
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

  updateLocalState() {
    return this.localWriter._updateSystem()
  }

  // the caller has already swapped auto.local and waited for appends to settle
  async rotateLocalWriter(core) {
    await this.localWriter.close()

    // a peer may already have announced the new key, in which case a remote
    // writer tracks it - drop it so only one writer owns the key
    const existing = this.get(core.key)
    if (existing !== null) await existing.close()

    this._setLocal(core)
    await this.updateLocalState()
  }

  // the local core is tracked like any other writer, it is just the one we append to
  _setLocal(core) {
    const w = this.add(core.key)
    w.core = core
    this.localWriter = w
  }

  getLatestLocalOplog() {
    return this.localWriter.getLatest()
  }

  appendLocal(value, timestamp, batch, links, optimistic, witness, approvals, hash, drift) {
    return this.localWriter.append(
      value,
      timestamp,
      batch,
      links,
      optimistic,
      witness,
      approvals,
      hash,
      drift
    )
  }

  async flushLocal(views) {
    const w = this.localWriter

    // only pay for the trusted lookup when a flush will actually write
    if (w.applied() === 0) return false

    const trusted = await this.auto.trusted.mostRecentTrusted(this.auto._workingView.view, null)

    await w.flush(views, trusted)
    return true
  }

  _updateWritable() {
    const w = this.localWriter
    const writable = w.isAdded && !w.isRemoved

    if (writable === this.writable) return

    this.writable = writable
    this.auto.emit(writable ? 'writable' : 'unwritable')
    this.auto.emit('update')
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

    // local nodes appended but not yet flushed, they sit past the end of the core
    this.queue = []

    this.isAdded = false
    this.isRemoved = false
    this.isPending = false
    this.isLinked = false
    this.isFrozen = false
    this.isClosed = false
  }

  get appending() {
    return this.queue.length > 0
  }

  isIdle() {
    // a loaded tail, or queued local nodes, is work we have not applied yet
    if (this.tail !== null || this.queue.length > 0) return false
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

  async update() {
    await this._updateSystem()
    if (this.tail === null) await this._updateTail()
    if (!this.isLinked && this.tail !== null) await this._updateLinked()
    if (this.length < this.hintedLength) await this._updateHint()

    return this.tail !== null && this.isLinked
  }

  // hand over the ready batch, the drain applies it straight away
  take() {
    const batch = this.tail

    this.tail = null
    this.isLinked = false
    this.length = batch[batch.length - 1].length

    return batch
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
      group,
      userData: { referrer: auto.key }
    })

    await core.ready()

    // another open, or a close, may have raced us
    if (this.core !== null || this.isClosed) {
      await core.close()
      return
    }

    this.core = core

    const bump = this.bump.bind(this)

    core.on('download', bump)
    core.on('append', bump)
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

  // a drain failed to apply what we took, reload from the system on the next pass
  reset() {
    this.systemHead = null
  }

  async _updateSystem() {
    const sys = this.writers.auto.system
    const head = sys.bee.head()

    if (sameHead(head, this.systemHead)) return

    const info = await sys.get(this.key)

    // the bootstrap writer is added implicitly until the system records it
    this.isAdded = info ? true : b4a.equals(this.key, this.writers.auto.key)
    this.isRemoved = info ? info.isRemoved : false

    this.systemHead = head

    if (this === this.writers.localWriter) this.writers._updateWritable()

    const length = info ? info.length : 0

    if (length === this.length) return

    this.tail = null
    this.isLinked = false
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
    // a removed writer only loads what someone linking it asked for
    if (this.isRemoved && this.length >= this.hintedLength) return

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
      const queued = seq >= this.core.length
      const node = queued ? this._getQueuedNode(seq) : await this._readNode(seq)
      if (node === null) return

      // a plain node queued by a writer that cannot write is a caller error, not a wait
      if (queued && !(optimistic || node.optimistic) && !this.writers.writable) {
        this.queue = []
        throw new Error('Not writable')
      }

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

  async _readNode(seq) {
    const block = await this.core.get(seq, { wait: false })
    return block === null ? null : this._createNode(block, seq)
  }

  _getQueuedNode(seq) {
    const i = seq - this.core.length
    return i < this.queue.length ? this.queue[i] : null
  }

  _createNode(block, seq) {
    try {
      return new Node(this.core, this.id, seq + 1, encoding.decodeOplog(block))
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

  async getLatest() {
    if (this.core === null) await this._openCore()
    if (this.core.length === 0) return null

    const block = await this.core.get(this.core.length - 1)
    return encoding.decodeOplog(block)
  }

  append(value, timestamp, batch, links, optimistic, witness, approvals, hash, drift) {
    const oplog = {
      version: encoding.OPLOG_VERSION,
      timestamp,
      links,
      batch,
      views: null,
      trusted: null,
      witness: witness || null,
      approvals,
      optimistic: optimistic && !this.writers.writable,
      value,
      hash,
      weightHint: 0,
      drift
    }

    const node = new Node(this.core, this.id, this.core.length + this.queue.length + 1, oplog)

    this.queue.push(node)
    this.bump()

    return node
  }

  // queued nodes the drain has applied, these are what a flush persists
  applied() {
    const n = this.length - this.core.length
    return n <= 0 ? 0 : Math.min(n, this.queue.length)
  }

  async flush(views, trusted) {
    const count = this.applied()
    if (count === 0) return

    const nodes = this.queue.splice(0, count)
    const head = nodes[count - 1]

    head.views = views
    head.trusted = trusted ? [{ key: trusted.key, length: trusted.length }] : null

    this.writers.auto.emit('appending', nodes)

    const buffers = new Array(count)
    for (let i = 0; i < count; i++) {
      const node = nodes[i]
      node.weightHint = node.weight > 0 ? node.weight : 0
      buffers[i] = encoding.encodeOplog(node)
    }

    await this.core.append(buffers)
  }

  removeWaiting() {
    if (this.waiting === null) return
    this.writers.triggers.remove(this.waiting)
    this.waiting = null
  }
}

class Node {
  constructor(core, id, length, oplog) {
    this.core = core
    this.from = core // compat
    this.key = core.key
    this.id = id
    this.length = length
    this.weight = -1
    this.version = oplog.version
    this.timestamp = oplog.timestamp
    this.links = oplog.links
    this.batch = oplog.batch
    this.views = oplog.views
    this.trusted = oplog.trusted || []
    this.witness = oplog.witness || null
    this.approvals = oplog.approvals || null
    this.optimistic = oplog.optimistic
    this.value = oplog.value
    this.hash = oplog.hash || null
    this.weightHint = oplog.weightHint || 0
    this.drift = oplog.drift || 0
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

exports.ActiveWriters = ActiveWriters
exports.Writer = Writer
exports.Node = Node
exports.finalizeNodeBatch = finalizeNodeBatch
