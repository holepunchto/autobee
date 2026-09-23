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

class DAGBatch {
  constructor() {
    this.writers = new Map() // writer id -> writer with something queued
    this.nodes = new Map() // head node id -> batch, links land on batch heads
    this.batches = []
  }

  // is this node queued, a writer in here has a fresh length that covers what it queued
  has(key, length) {
    const w = this.writers.get(b4a.toHex(key))
    return w !== undefined && w.length >= length
  }

  // writers queue in dependency order (linked means every link is in the system or already queued),
  // so every link a batch has is resolvable when it is queued
  queue(writer, batch) {
    if (batch.length === 0) return

    const tail = batch[0]
    const head = batch[batch.length - 1]
    const links = tail.witness ? tail.links.concat(tail.witness.link) : tail.links

    // a dropped batch comes back through unqueue
    head.dependencies = []
    head.dropped = false

    for (const l of links) {
      const dep = this.nodes.get(nodeId(l.key, l.length))
      if (dep) head.dependencies.push(dep) // otherwise in the system
    }

    this.writers.set(writer.id, writer)
    this.nodes.set(headId(batch), batch)
    this.batches.push(batch)
  }

  // drop what removed writers queued unless something not removed depends on it, transitively
  rebalance() {
    const stack = []

    for (const batch of this.batches) {
      if (this._isRemoved(batch)) continue
      headOf(batch).marked = true
      stack.push(batch)
    }

    if (stack.length === this.batches.length) return false

    while (stack.length > 0) {
      for (const dep of headOf(stack.pop()).dependencies) {
        const head = headOf(dep)
        if (head.marked) continue
        head.marked = true
        stack.push(dep)
      }
    }

    let dropped = 0

    // sweep in reverse so a writer with several batches queued is unqueued head first,
    // clearing marks as we go so the next pass starts clean
    for (let i = this.batches.length - 1; i >= 0; i--) {
      const batch = this.batches[i]
      const head = headOf(batch)

      if (head.marked) {
        head.marked = false
        continue
      }

      this._drop(batch)
      dropped++
    }

    if (dropped === 0) return false

    this.batches = this.batches.filter(notDropped)
    return true
  }

  _isRemoved(batch) {
    return this.writers.get(batch[0].id).isRemoved
  }

  _drop(batch) {
    const head = headOf(batch)

    head.dropped = true
    this.nodes.delete(headId(batch))

    // ends on the first tail since we sweep head first
    this.writers.get(head.id).unqueue(batch)
  }
}

class ActiveWriters {
  constructor(auto) {
    this.auto = auto
    this.map = new Map()
    this.triggers = new Triggers()
    this.pending = []
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

  async update(batch) {
    await this._updateSystem()
    if (this.tail === null) await this._updateTail()
    if (!this.isLinked && this.tail !== null) await this._updateLinked(batch)
    if (this.length < this.hintedLength) await this._updateHint()

    if (this.tail === null || !this.isLinked) return false

    batch.queue(this, this.tail)
    this.isLinked = false
    this.length = this.tail[this.tail.length - 1].length
    this.tail = null

    return true
  }

  // rebalance dropped what we queued, put it back as our tail and retry next pass
  // in case whoever hinted us links then
  unqueue(nodes) {
    this.tail = nodes
    this.isLinked = false
    this.length = nodes[0].length - 1
    this.addPending()
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

  // a drain failed to apply what we queued, reload from the system on the next pass
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
      return new Node(this.core, this.id, seq + 1, encoding.decodeOplog(block))
    } catch {
      this.isFrozen = true
      return null
    }
  }

  async _updateLinked(b) {
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
      promises[i] = self || b.has(link.key, link.length) ? Promise.resolve(true) : sys.has(link)
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

    // batch dag state, only used on the head of a queued batch
    this.dependencies = null
    this.marked = false
    this.dropped = false
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

function headOf(batch) {
  return batch[batch.length - 1]
}

function headId(batch) {
  const head = headOf(batch)
  return head.id + '@' + head.length
}

function notDropped(batch) {
  return !headOf(batch).dropped
}

function nodeId(key, length) {
  return b4a.toHex(key) + '@' + length
}
