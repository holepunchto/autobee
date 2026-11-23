const b4a = require('b4a')
const Signal = require('signal-promise')
const safetyCatch = require('safety-catch')
const encoding = require('./encoding.js')
const Triggers = require('./triggers.js')
const topo = require('./topo.js')
const WriterFastForward = require('./fast-forward.js')
const { MAPPED_AUTOBEE_VERSION } = require('./constants.js')
const { Node, finalizeNodeBatch } = require('./node.js')
const { WriterEncryption } = require('./encryption.js')

const BATCH_WRITER_SANITY = 1024

const BATCH_OPTIMISTIC_SANITY = 32

const MAX_FORWARD_TIME_DRIFT = 2 * 3600 * 1000

const WRITER_PREFETCH = 10

const MAX_BUFFERED_NODES = 10_000

class ActiveWriters {
  constructor(auto) {
    this.auto = auto
    this.active = new Map()
    this.triggers = new Triggers()
    this.pending = []
    this.writable = false

    this.buffer = []
    this.buffered = 0
    this.localWriter = null

    this.backlog = 0

    this.fastForwards = new Map()
    this.fastForward = null

    this.moving = null

    this._setLocal(auto.local)
  }

  get size() {
    return this.active.size
  }

  [Symbol.iterator]() {
    return this.active.values()
  }

  // buffer batches until one reaches a head a peer told us about, then apply the lot
  // TODO: needs a timeout, a head nobody serves holds the buffer until the cap
  // TODO: hold the buffer while a fast-forward worth taking is inflating
  async drain({ local = false } = {}) {
    let explicit = false
    let stuck = false

    while (this.buffered < MAX_BUFFERED_NODES) {
      // shifting only appends to pending, removing swaps, so that goes last
      const writers = local ? [this.localWriter] : this.pending
      const n = writers.length

      const updates = new Array(n)
      for (let i = 0; i < n; i++) updates[i] = writers[i].update()
      await Promise.all(updates)

      const idle = []
      let shifted = false
      stuck = false

      for (let i = 0; i < n; i++) {
        const w = writers[i]

        if (w.tail !== null && w.isLinked) {
          if (this._shift(w)) explicit = true
          shifted = true
        } else if (w.isGated) {
          // gated by a record the buffer would change, holding would deadlock
          if (this.triggers.has(w.id) || w.bufferedLength > w.length) stuck = true
        } else if (w.tail === null && w.isIdle()) {
          idle.push(w)
        }
      }

      for (const w of idle) w.removePending()

      // flush before going on, what comes next may depend on it applying
      if (!shifted || explicit) break
    }

    if (this.buffer.length === 0) return []
    if (!explicit && !stuck && this.buffered < MAX_BUFFERED_NODES) return []

    const entries = this.buffer

    this.buffer = []
    this.buffered = 0

    return topo.linearize(entries).map(tailOf)
  }

  // a head: the tip of an announced writer that nobody links into
  _shift(w) {
    const batch = w.shift()

    this.buffer.push({ tail: batch, writer: w })
    this.buffered += batch.length

    this.triggers.trigger(w.id, w.bufferedLength)

    if (w === this.localWriter) return true
    if (w.linkedLength >= batch[0].length) return false

    // the proven length, an announced one may not be served
    return w.announcedLength > 0 && w.bufferedLength >= w.core.length
  }

  _isBuffered(link) {
    const w = this.active.get(b4a.toHex(link.key))
    return w !== undefined && w.bufferedLength >= link.length
  }

  reset() {
    this.buffer = []
    this.buffered = 0

    for (const w of this.active.values()) w.reset()
  }

  resolved(key, length) {
    this.triggers.trigger(b4a.toHex(key), length)

    const w = this.get(key)
    if (w === null) return

    if (length > w.length) w.length = length
    w.bump()
  }

  // TODO: bound how many writers an untrusted peer tracks
  add(key) {
    const id = b4a.toHex(key)
    let w = this.active.get(id)
    if (w) return w

    w = new Writer(this, key, id)
    this.active.set(id, w)

    w.addPending()

    return w
  }

  async close() {
    const closing = []

    for (const w of this.active.values()) closing.push(w.close())
    for (const ff of this.fastForwards.values()) closing.push(ff.close())

    await Promise.allSettled(closing)
  }

  refFastForward(key) {
    const id = b4a.toHex(key)
    let ff = this.fastForwards.get(id)

    if (!ff) {
      ff = new WriterFastForward(this, key, id)
      this.fastForwards.set(id, ff)
    }

    ff.refs++
    return ff
  }

  unrefFastForward(ff) {
    if (--ff.refs > 0) return

    this.fastForwards.delete(ff.id)
    ff.close()

    if (this.fastForward === ff) this.rankFastForwards()
  }

  // race the best two so a stalled one does not hold the landing up
  rankFastForwards() {
    let best = null
    let next = null

    for (const ff of this.fastForwards.values()) {
      if (ff.head === null) continue

      if (best === null || ff.head.op.views.flushes > best.head.op.views.flushes) {
        next = best
        best = ff
      } else if (next === null || ff.head.op.views.flushes > next.head.op.views.flushes) {
        next = ff
      }
    }

    this.fastForward = best

    const moving = this.moving

    for (const ff of this.fastForwards.values()) {
      if (ff !== best && ff !== next && ff !== moving && ff.inflating !== null) ff.cancel()
    }

    if (moving !== null && moving.length >= moving.hinted) {
      moving.inflateBackground({ force: true, rewind: true })
    }

    if (!this.auto._ffEnabled) return

    if (best !== null && best !== moving) best.inflateBackground()
    if (next !== null && next !== moving) next.inflateBackground()
  }

  moveTo(head) {
    const prev = this.moving

    this.moving = this.refFastForward(head.key)
    if (prev !== null) this.unrefFastForward(prev)

    this.moving.inflated = null
    this.moving.hint(head.length)
    this.rankFastForwards()
  }

  nextFastForward() {
    const moving = this.moving

    if (moving !== null && moving.inflated !== null) return moving

    const sys = this.auto.system
    let best = null

    for (const ff of this.fastForwards.values()) {
      if (ff.inflated === null) continue

      // landing on a remapped system may be a little behind us
      const landing =
        sys.version < MAPPED_AUTOBEE_VERSION && ff.inflated.version >= MAPPED_AUTOBEE_VERSION

      if (landing) {
        if (ff.inflated.flushes < sys.flushes - WriterFastForward.MIN_GAP) continue
      } else if (ff.inflated.flushes <= sys.flushes) {
        continue
      }

      if (best === null || ff.inflated.flushes > best.inflated.flushes) best = ff
    }

    return best
  }

  async fastForwarded(ff) {
    if (ff === this.moving) {
      this.moving = null
      this.unrefFastForward(ff)
    }

    await this.moved()
  }

  wakeup(key, length) {
    const added = this.get(key) === null
    const w = this.add(key)

    // peers do not get to drive our own writer
    if (w === this.localWriter) return

    if (!w.announce(length) && added) w.bump()
  }

  get(key) {
    return this.active.get(b4a.toHex(key)) || null
  }

  has(key) {
    return this.active.has(typeof key === 'string' ? key : b4a.toHex(key))
  }

  // what we announce, a peer takes an announce as a head
  *heads() {
    for (const w of this.active.values()) {
      if (w.core === null || w.systemHead === null) continue

      if (w.isHead) {
        yield w.core
        continue
      }

      if (w.core.length <= w.length) continue

      const tip = w.announcedLength > 0 && w.linkedLength < w.core.length
      if (tip || w === this.localWriter) yield w.core
    }
  }

  changed(key) {
    this.add(key).bump()
  }

  remove(key) {
    this.changed(key)
  }

  async refresh() {
    await this.updateLocalState()

    const closing = []

    for (const w of this.active.values()) {
      w.isHead = w._isSystemHead()

      // peers fetch heads from us, so a head always has its core loaded
      if (w.isHead && w.core === null) closing.push(w._openCore())
      else w._updateActivity()

      if (w === this.localWriter || w.opening > 0) continue

      if (w.isFrozen || (!w.isHead && w.isIdle())) closing.push(w.close())
    }

    await Promise.all(closing)
  }

  async moved() {
    this.reset()

    const flushes = this.auto.system.flushes

    for (const ff of this.fastForwards.values()) {
      if (ff.inflated !== null && ff.inflated.flushes <= flushes) ff.inflated = null
      if (ff.inflating !== null && ff.head.op.views.flushes <= flushes) ff.cancel()
    }

    await this.updateLocalState()
  }

  updateLocalState() {
    return this.localWriter._updateSystem()
  }

  // the caller has already swapped auto.local and waited for appends to settle
  async rotateLocalWriter(core) {
    await this.localWriter.close()

    // a remote writer may already track the new key, only one may own it
    const existing = this.get(core.key)
    if (existing !== null) await existing.close()

    this._setLocal(core)

    const ff = this.fastForwards.get(b4a.toHex(core.key))
    if (ff !== undefined && ff.core === null) ff.refresh()

    await this.updateLocalState()
  }

  _setLocal(core) {
    const w = this.add(core.key)
    w.core = core
    this.localWriter = w
    this.auto.emit('writer', w)
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
    this.preloadLength = 0
    this.preload = null
    this.tail = null
    this.waiting = null
    this.backlog = 0

    this.bufferedLength = 0

    // told by a peer, making its tip a head, or by a link, making it a dependency
    this.announcedLength = 0
    this.linkedLength = 0

    this.isGated = false

    this.queue = []

    this.latest = null
    this.latestLength = 0
    this.latestRequested = 0
    this.latestSignal = new Signal()

    this.isAdded = false
    this.isRemoved = false
    this.isPending = false
    this.isLinked = false
    this.isFrozen = false
    this.isClosed = false
    this.isHead = false
    this.isCoupled = false
    this.opening = 0

    this.fastForward = null
  }

  get appending() {
    return this.queue.length > 0
  }

  cursor() {
    return Math.max(this.length, this.bufferedLength)
  }

  isIdle() {
    return this.tail === null && this.queue.length === 0 && this.backlog === 0
  }

  _updateBacklog() {
    const coreLength = this.core === null ? 0 : this.core.length
    const known = Math.max(coreLength, this.hintedLength)
    const backlog = this.isClosed ? 0 : Math.max(known - this.length, 0)

    this.writers.backlog += backlog - this.backlog
    this.backlog = backlog
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

  get hintedLength() {
    return Math.max(this.announcedLength, this.linkedLength)
  }

  announce(length) {
    // by getting any length we usually get the best one
    if (length < 1) length = 1
    if (length <= this.announcedLength) return false

    this.announcedLength = length
    this.bump()

    return true
  }

  link(length) {
    if (length <= this.linkedLength) return

    this.linkedLength = length
    this.bump()
  }

  bump() {
    // keep tracking the head even while parked on a missing link
    this._updateLatest()
    this._updateActivity()

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

    this._updateActivity()

    return this.tail !== null && this.isLinked
  }

  _updateActivity() {
    this._updateBacklog()

    if (this.core === null) return

    const wakeup = this.writers.auto._wakeup

    if (this.isHead && !this.isCoupled) {
      this.isCoupled = wakeup.addCore(this.core)
    } else if (!this.isHead && this.isCoupled) {
      this.isCoupled = !wakeup.removeCore(this.core)
    }

    const behind = this.length < this.core.length || this.length < this.hintedLength

    this.core.setActive(this.isHead || behind)
  }

  _isSystemHead() {
    const auto = this.writers.auto

    // at genesis the bootstrap writer is the head, once it has something
    if (auto.system.heads.length === 0) {
      return b4a.equals(this.key, auto.key) && this.core !== null && this.core.length > 0
    }

    return auto.system.isHead(this.key)
  }

  // a removed writer is only ever hinted by a link
  hasReferrals() {
    return this.hintedLength > this.length
  }

  shift() {
    const batch = this.tail

    this.tail = null
    this.isLinked = false
    this.bufferedLength = batch[batch.length - 1].length

    return batch
  }

  async close() {
    if (this.writers.active.get(this.id) !== this) return
    this.writers.active.delete(this.id)
    this.isClosed = true
    this.removePending()
    this.removeWaiting()
    this._updateBacklog()
    this.latestSignal.notify()

    if (this.core !== null && this !== this.writers.localWriter) {
      this.writers.auto.stats.writersClosed++
    }

    if (this.fastForward !== null) {
      this.writers.unrefFastForward(this.fastForward)
      this.fastForward = null
    }

    if (this.isCoupled) {
      this.writers.auto._wakeup.removeCore(this.core)
      this.isCoupled = false
    }

    if (this.core) await this.core.close()
  }

  // the gc leaves us be until the session is handed out
  async session(opts) {
    this.opening++

    try {
      if (this.core === null) await this._openCore()
      return this.isClosed || this.core === null ? null : this.core.session(opts)
    } finally {
      this.opening--
    }
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

    auto.stats.writersOpened++
    auto.emit('writer', this)

    this._updateLatest()
    this._updateActivity()
  }

  _latestTarget() {
    return Math.max(this.core.length, this.hintedLength)
  }

  _updateLatest() {
    if (this.core === null) return

    const target = this._latestTarget()
    if (target <= this.latestRequested) return

    this.latestRequested = target
    this._fetchLatestBackground(target)
  }

  async _fetchLatestBackground(target) {
    let block = null

    try {
      block = await this.core.get(target - 1)
    } catch {}

    // fetches can land out of order, never go backwards
    if (block !== null && !this.isClosed && target > this.latestLength) {
      try {
        this.latest = encoding.decodeOplog(block)
        this.latestLength = target
      } catch {
        this.isFrozen = true
      }
    }

    this.latestSignal.notify()

    if (this.latest === null || this.isFrozen) return

    try {
      await this._updateFastForward()
    } catch (err) {
      safetyCatch(err)
    }
  }

  async _updateFastForward() {
    if (this === this.writers.localWriter) return

    const auto = this.writers.auto
    const reference = auto._workingView.view

    let head = firstStamp(this.latest) || { key: this.key, length: this.latestLength }

    // a stamped head counts if its key is trusted, or its author is
    let trusted =
      (await auto.trusted.isTrusted(head.key, reference)) ||
      (await auto.trusted.isTrusted(this.key, reference))

    // the hook may still vouch for a head, its word is final
    if (!trusted && !this.isClosed && this.latest.views !== null) {
      head = await this._signalledHead(reference)
      trusted = head !== null
    }

    if (head === null || !trusted || this.isClosed) return

    if (this.fastForward !== null && !b4a.equals(this.fastForward.key, head.key)) {
      this.writers.unrefFastForward(this.fastForward)
      this.fastForward = null
    }

    if (this.fastForward === null) this.fastForward = this.writers.refFastForward(head.key)

    this.fastForward.hint(head.length)
  }

  async _signalledHead(reference) {
    const auto = this.writers.auto
    const opened = auto.openViewAt({ op: this.latest })
    if (opened === null) return null

    try {
      return (await auto.trusted.mostRecentTrusted(opened.view, reference)) || null
    } finally {
      await opened.close()
    }
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

  reset() {
    this.systemHead = null
    this.bufferedLength = 0
    this.tail = null
    this.isLinked = false
    this.removeWaiting()
    this.addPending()
  }

  async _updateSystem() {
    const sys = this.writers.auto.system
    const head = sys.bee.head()

    if (sameHead(head, this.systemHead)) return

    const info = await sys.get(this.key)

    // the bootstrap writer is added implicitly until the system records it
    this.isAdded = info ? true : b4a.equals(this.key, this.writers.auto.key)
    this.isRemoved = info ? info.isRemoved : false
    this.isHead = this._isSystemHead()

    // peers fetch heads from us, so a head always has its core loaded
    if (this.isHead && this.core === null) await this._openCore()

    this.systemHead = head

    if (this === this.writers.localWriter) this.writers._updateWritable()

    const length = info ? info.length : 0

    if (length !== this.length) {
      this.tail = null
      this.bufferedLength = 0
      this.isLinked = false
      this.removeWaiting()

      if (length < this.length && this.preload !== null) {
        this.preload.destroy()
        this.preload = null
        this.preloadLength = 0
      }

      this.length = length
    }

    // activity depends on the length, so settle it last
    this._updateActivity()
  }

  async _updateTail() {
    // a removed writer only loads what a link asked for, or its own optimistic node
    const cursor = this.cursor()

    this.isGated = false

    if (this.isRemoved && cursor >= this.hintedLength) {
      const next = this._nextQueuedNode()
      if (next === null || !next.optimistic) return
    }

    if (this.core === null) await this._openCore()

    const prefetchLength = cursor + WRITER_PREFETCH
    const maxLength = cursor + BATCH_WRITER_SANITY

    this._updatePreload(prefetchLength)

    const genesis = this.writers.auto.system.isGenesis()

    const batch = []

    let optimistic = false
    let timestamp = 0

    while (true) {
      const seq = cursor + batch.length
      const queued = seq >= this.core.length
      const node = queued ? this._getQueuedNode(seq) : await this._readNode(seq)
      if (node === null) return

      // a caller error, not a wait
      if (queued && !(optimistic || node.optimistic) && !this.writers.writable) {
        this.queue.splice(this.applied())
        throw new Error('Not writable')
      }

      if (batch.length === 0) {
        if (!this.isAdded && node.optimistic && !this.writers.auto.optimistic) return

        if ((!this.isAdded && !node.optimistic) || (node.optimistic && genesis)) {
          this.isGated = true
          return
        }
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

  _nextQueuedNode() {
    if (this.queue.length === 0) return null
    const i = this.cursor() - this.core.length
    return i >= 0 && i < this.queue.length ? this.queue[i] : null
  }

  _getQueuedNode(seq) {
    const i = seq - this.core.length
    return i < this.queue.length ? this.queue[i] : null
  }

  _createNode(block, seq) {
    try {
      const oplog = encoding.decodeOplog(block)
      return new Node(this.core, seq + 1, oplog, oplog.weightHint)
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
    const links = linksOf(node)
    const promises = new Array(links.length)

    for (let i = 0; i < links.length; i++) {
      const link = links[i]
      const self = link.length < node.length && b4a.equals(link.key, this.key)
      promises[i] = self || this.writers._isBuffered(link) ? true : sys.has(link)
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

      const parent = this.writers.add(link.key)

      parent.link(link.length)
    }

    this.isLinked = linked
  }

  async getLatest() {
    if (this.core === null) await this._openCore()

    this._updateLatest()

    while (!this.isClosed && !this.isFrozen && this.latestLength < this._latestTarget()) {
      await this.latestSignal.wait()
    }

    return this.latest
  }

  views() {
    const latest = this.latest
    if (latest === null || latest.views === null) return []

    // signedLength for autobase compat
    const system = latest.views.system.start + latest.views.system.length
    const view = latest.views.view.start + latest.views.view.length

    return [
      { key: latest.views.system.key, length: system, signedLength: system },
      { key: latest.views.view.key, length: view, signedLength: view }
    ]
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

    const node = new Node(this.core, this.core.length + this.queue.length + 1, oplog, 0)

    this.queue.push(node)
    this.bump()

    return node
  }

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

    this.latest = head
    this.latestLength = this.core.length
    this.latestRequested = Math.max(this.latestRequested, this.core.length)
    this.latestSignal.notify()
  }

  removeWaiting() {
    if (this.waiting === null) return
    this.writers.triggers.remove(this.waiting)
    this.waiting = null
  }
}

function firstStamp(oplog) {
  const stamps = oplog.trusted
  return stamps && stamps.length > 0 ? stamps[0] : null
}

function sameHead(a, b) {
  return a && b && a.length === b.length && b4a.equals(a.key, b.key)
}

function linksOf(node) {
  return node.witness ? node.links.concat(node.witness.link) : node.links
}

function tailOf(entry) {
  return entry.tail
}

exports.ActiveWriters = ActiveWriters
exports.Writer = Writer
