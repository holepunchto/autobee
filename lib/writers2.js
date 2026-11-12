const b4a = require('b4a')
const Signal = require('signal-promise')
const encoding = require('./encoding.js')
const Hypercore = require('hypercore')
const safetyCatch = require('safety-catch')
const Triggers = require('./triggers.js')
const System = require('./system.js')
const { Node, finalizeNodeBatch } = require('./node.js')
const { LEGACY_AUTOBASE_VERSION, MAPPED_AUTOBEE_VERSION } = require('./constants.js')
const { WriterEncryption } = require('./encryption.js')

// a batch longer than this is malformed, stop loading rather than spin on it
const BATCH_WRITER_SANITY = 1024

// an optimistic writer we have not added gets a much shorter leash
const BATCH_OPTIMISTIC_SANITY = 32

// a node stamped further into the future than this is not applied yet
const MAX_FORWARD_TIME_DRIFT = 2 * 3600 * 1000

// blocks to read ahead past the tail
const WRITER_PREFETCH = 10

// a fast-forward has to move us at least this many flushes to be worth it
const MIN_FF_GAP = 16

class ActiveWriters {
  constructor(auto) {
    this.auto = auto
    this.map = new Map()
    this.triggers = new Triggers()
    this.pending = []
    this.writable = false
    this.localWriter = null

    // blocks we know of but have not applied, summed over all writers
    this.backlog = 0

    // the heads writers vouch for, by key, and the one with the most flushes
    this.fastForwards = new Map()
    this.fastForward = null

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

    // a new writer gets a pass on the next drain, to pick up its system record
    w.addPending()

    return w
  }

  async close() {
    const closing = []

    // each close drops itself from the map, which iteration copes with
    for (const w of this.map.values()) closing.push(w.close())
    for (const ff of this.fastForwards.values()) closing.push(ff.close())

    await Promise.allSettled(closing)
  }

  _refFastForward(key) {
    const id = b4a.toHex(key)
    let ff = this.fastForwards.get(id)

    if (!ff) {
      ff = new WriterFastForward(this, key, id)
      this.fastForwards.set(id, ff)
    }

    ff.refs++
    return ff
  }

  _unrefFastForward(ff) {
    if (--ff.refs > 0) return

    this.fastForwards.delete(ff.id)
    ff.close().catch(noop)

    if (this.fastForward === ff) this._rankFastForward()
  }

  // the best two heads get inflated, so a stalled one does not hold the
  // landing up, the drain lands on whichever is ready first
  _rankFastForward() {
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

    // only the two race, a run that dropped out of them is stopped
    for (const ff of this.fastForwards.values()) {
      if (ff !== best && ff !== next && ff.inflating !== null) ff.cancel()
    }

    if (best !== null) best.inflate().catch(noop)
    if (next !== null) next.inflate().catch(noop)
  }

  // the inflated head with the most flushes, what the drain lands on
  landing() {
    const flushes = this.auto.system.flushes
    let best = null

    for (const ff of this.fastForwards.values()) {
      if (ff.inflated === null || ff.inflated.flushes <= flushes) continue
      if (best === null || ff.inflated.flushes > best.inflated.flushes) best = ff
    }

    return best
  }

  wakeup(key, length) {
    const added = this.get(key) === null
    const w = this.add(key)

    // peers do not get to drive our own writer
    if (w === this.localWriter) return

    if (length > w.hintedLength) w.hint(length)
    else if (added) w.bump()
  }

  get(key) {
    return this.map.get(b4a.toHex(key)) || null
  }

  // the cores to announce to a peer: loaded, and not mid-update
  *cores() {
    for (const w of this.map.values()) {
      if (w.core !== null && !w.isPending) yield w.core
    }
  }

  // the system recorded the removal, the writer re-reads its record on the
  // next pass and finishes what it was already behind on
  remove(key) {
    const w = this.get(key)
    if (w !== null) w.bump()
  }

  // after a round, drop the writers nothing needs anymore
  async refresh() {
    const closing = []

    for (const w of this.map.values()) {
      if (w === this.localWriter) continue
      if (w.isFrozen || (!w.isHead && w.isIdle())) closing.push(w.close())
    }

    await Promise.all(closing)
  }

  // we landed somewhere else, everything computed against the old system goes
  async moved() {
    for (const w of this.map.values()) w.reset()

    // a head the landing passed is no landing anymore, done or in flight
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
    this.backlog = 0

    // local nodes appended but not yet flushed, they sit past the end of the core
    this.queue = []

    // the newest oplog we hold, decoded, fetched as soon as we learn of it
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

    // the head we vouch for, shared with every writer vouching for the same key
    this.fastForward = null
  }

  get appending() {
    return this.queue.length > 0
  }

  isIdle() {
    // a loaded tail, or queued local nodes, is work we have not applied yet
    return this.tail === null && this.queue.length === 0 && this.backlog === 0
  }

  // what we know of past what we applied, kept as a running sum on the writers
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

  hint(length) {
    if (length > this.hintedLength) {
      this.hintedLength = length
      this.bump()
    }
  }

  bump() {
    // track the head and keep replicating even while parked on a missing link
    this._updateLatest()
    this._updateActivity()

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

    this._updateActivity()

    return this.tail !== null && this.isLinked
  }

  // replicate while we are behind or are a system head, and announce heads
  // through the wakeup coupler so peers learn about them
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

  // a removed writer only loads what another writer linked, so having more
  // than we applied means someone depends on it
  hasReferrals() {
    return this.hintedLength > this.length
  }

  // hand over the ready batch, the drain applies it straight away
  take() {
    const batch = this.tail

    this.tail = null
    this.isLinked = false
    this.length = batch[batch.length - 1].length
    this._updateBacklog()

    return batch
  }

  async close() {
    if (this.writers.map.get(this.id) !== this) return
    this.writers.map.delete(this.id)
    this.isClosed = true
    this.removePending()
    this.removeWaiting()
    this._updateBacklog()
    this.latestSignal.notify()

    if (this.core !== null && this !== this.writers.localWriter) {
      this.writers.auto.stats.writersClosed++
    }

    if (this.fastForward !== null) {
      this.writers._unrefFastForward(this.fastForward)
      this.fastForward = null
    }

    if (this.isCoupled) {
      this.writers.auto._wakeup.removeCore(this.core)
      this.isCoupled = false
    }

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
    this._fetchLatest(target).catch(noop)
  }

  async _fetchLatest(target) {
    let block = null

    try {
      // waits, so a hinted head is pulled from the peer that announced it
      block = await this.core.get(target - 1)
    } catch {
      // closed underneath us
    }

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

    if (this.latest !== null && !this.isFrozen) await this._updateFastForward()
  }

  // we vouch for the head our latest stamps, or our own head when it stamps
  // nothing, and only once that key is trusted
  async _updateFastForward() {
    if (this === this.writers.localWriter) return

    const auto = this.writers.auto
    const head = firstStamp(this.latest) || { key: this.key, length: this.latestLength }

    const trusted = await auto.trusted.isTrusted(head.key, auto._workingView.view)
    if (!trusted || this.isClosed) return

    if (this.fastForward !== null && !b4a.equals(this.fastForward.key, head.key)) {
      this.writers._unrefFastForward(this.fastForward)
      this.fastForward = null
    }

    if (this.fastForward === null) this.fastForward = this.writers._refFastForward(head.key)

    this.fastForward.hint(head.length)
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

  // what we hold was read against a system that moved, start over from its
  // record on the next pass
  reset() {
    this.systemHead = null
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

    // activity depends on the length, so settle it last
    this._updateActivity()
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

      // a plain node queued by a writer that cannot write is a caller error, not
      // a wait, what the system already applied stays to be flushed
      if (queued && !(optimistic || node.optimistic) && !this.writers.writable) {
        this.queue.splice(this.applied())
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
      return new Node(this.core, seq + 1, encoding.decodeOplog(block), -1)
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

    this._updateLatest()

    // the target can move while we wait, then wait for the newer head too
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

    const node = new Node(this.core, this.core.length + this.queue.length + 1, oplog, -1)

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

    // we just wrote the head, no need to read it back
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

// a head writers vouch for, read through its own session of the writer's core
// so it outlives the writers pointing at it, and the fast-forward onto it
class WriterFastForward {
  constructor(writers, key, id) {
    this.writers = writers
    this.key = key
    this.id = id
    this.refs = 0
    this.core = null
    this.hinted = 0
    this.fetched = 0
    this.length = 0
    this.head = null
    this.isClosed = false

    // the system we boot at the head, moved along as the head does, and the
    // reads in flight, the array is destroyed and replaced to fail a run
    this.system = null
    this.activeRequests = []
    this.view = null
    this.warmupView = null

    // the dance in flight, the flushes of the head it is for, and what the
    // drain lands on once it is done
    this.inflating = null
    this.inflatingFlushes = 0
    this.inflated = null
  }

  static MIN_GAP = MIN_FF_GAP

  hint(length) {
    if (length <= this.hinted) return
    this.hinted = length
    this._fetch().catch(noop)
  }

  // boot the system at the head, warm the view up and hold the result, the
  // drain lands on it with the flushes and version the landing checks need,
  // reads wait for a peer as long as it takes, a newer head or close ends them
  inflate({ force = false, skipGap = false } = {}) {
    if (this.head === null || this.isClosed) return Promise.resolve(null)

    const auto = this.writers.auto
    const head = this.head
    const flushes = head.op.views.flushes
    const system = auto.system.flushes

    // a head within the gap of what we hold is served by what we hold
    if (this.inflated !== null && flushes - this.inflated.flushes < MIN_FF_GAP) {
      return Promise.resolve(this.inflated)
    }

    if (this.inflating !== null) {
      // within the gap of the run in flight, join it
      if (flushes - this.inflatingFlushes < MIN_FF_GAP) return this.inflating

      // a run that already moves us a good way finishes first, it ranks again
      // when done and the newer head follows
      if (this.inflatingFlushes - system >= MIN_FF_GAP) return this.inflating
    }

    // never move backwards, with some slack while a legacy system is landing
    if (flushes < system - landingSlack(auto)) return Promise.resolve(null)

    // not worth the dance unless it moves us a good way forward
    if (!force && !skipGap && flushes - system < MIN_FF_GAP) return Promise.resolve(null)

    // the run in flight is not worth finishing, it is failed and waited out
    if (this.inflating !== null) this.cancel()

    this.inflatingFlushes = flushes
    this.inflating = this._inflate(head, force)

    return this.inflating
  }

  async _inflate(head, force) {
    // still the previous run at this point, we are assigned once we return
    const prev = this.inflating
    if (prev !== null) await prev

    let result = null

    try {
      result = await this._run(head, force)
    } catch (err) {
      safetyCatch(err)
    } finally {
      await this._closeWarmupView()
    }

    // superseded by a newer head
    if (this.inflatingFlushes !== head.op.views.flushes) return null
    this.inflating = null

    if (result === null || this.isClosed) return null

    this.inflated = result

    // the head may have moved a good way while we ran
    this.writers._rankFastForward()

    return result
  }

  async _run(head, force) {
    const auto = this.writers.auto
    const sys = head.op.views.system
    const target = { key: sys.key, length: sys.start + sys.length }

    if (this.system === null) {
      // 'reboot' is a storage namespace: renaming it would derive a different
      // scratch core on disk, so it stays as is
      this.system = new System(auto, auto.store.namespace('reboot'), {
        getEncryptionProvider: auto.getSystemEncryption
      })
    }

    // every read of this run goes on the array as it is now, a cancel swaps it
    const system = this.system
    const activeRequests = this.activeRequests

    await system.boot(target, { activeRequests })
    if (this.inflatingFlushes !== head.op.views.flushes) return null

    // a legacy autobase system boots through the explicit boot path only
    if (system.version <= LEGACY_AUTOBASE_VERSION) return null

    // an unmapped system is only landed on when forced, the remap will carry us
    if (
      system.version < MAPPED_AUTOBEE_VERSION &&
      !force &&
      !auto._remapFailed &&
      !auto.system.isGenesis()
    ) {
      return null
    }

    const promises = []

    // the hook gets its own view, closed under it if the run is abandoned
    if (auto._warmup && system.view.length) {
      this.warmupView = auto.openView(system.view)
      promises.push(auto._warmup(this.warmupView.view))
    }

    // ensure local key is locally available always
    promises.push(system.get(auto.local.key, { activeRequests }))

    // a legacy system without the designated view migrates onto an empty view
    const view = system.view.length ? this._openView(system.view.key) : null

    if (view !== null) {
      promises.push(view.get(system.view.length - 1, { activeRequests }))
    }

    for (const h of system.heads) {
      promises.push(system.get(h.key, { activeRequests }))
    }

    await Promise.all(promises)
    if (this.inflatingFlushes !== head.op.views.flushes) return null

    // conservative: the lengths we land on must be held whole, either by us or
    // by a connected peer, so the view does not stall on a block nobody has
    if (!force && auto._conservativeFF) {
      if (!isContiguous(system.bee.core, target.length)) return null
      if (view !== null && !isContiguous(view, system.view.length)) return null
    }

    return {
      head: target,
      length: head.length,
      flushes: system.flushes,
      version: system.version
    }
  }

  // the view core is kept across runs, the head rarely moves to another view
  _openView(key) {
    if (this.view !== null && !b4a.equals(this.view.key, key)) {
      this.view.close().catch(noop)
      this.view = null
    }

    if (this.view === null) this.view = this.writers.auto.store.get({ key, active: true })

    return this.view
  }

  // fail every read in flight and any the run still makes, the run returns
  // null and a later inflate starts over
  cancel() {
    Hypercore.destroyRequests(this.activeRequests)
    this.activeRequests = []
    this._closeWarmupView().catch(noop)
  }

  // fails the reads a warmup hook still has going
  async _closeWarmupView() {
    if (this.warmupView === null) return
    const view = this.warmupView
    this.warmupView = null
    await view.close()
  }

  // the hint is a floor, our core may know a newer head, and syncing a block
  // from the peer may teach us about one newer still
  async _fetch() {
    if (this.core === null) await this._openCore()
    if (this.core === null) return

    while (!this.isClosed) {
      const length = Math.max(this.hinted, this.core.length)
      if (length <= this.fetched) return
      this.fetched = length

      const block = await this.core.get(length - 1)
      if (this.isClosed || length <= this.length) continue

      const op = encoding.decodeOplog(block)
      if (op.views === null) continue

      this.length = length
      this.head = { key: this.key, length, op }

      this.writers._rankFastForward()
    }
  }

  async _openCore() {
    // the key is trusted, so tracking it as a writer is wanted anyway
    const w = this.writers.add(this.key)
    if (w.core === null) await w._openCore()

    // the writer may have closed under us
    if (w.core === null || this.core !== null || this.isClosed) return

    // active, we want this head whether or not the writer is behind
    this.core = w.core.session({ active: true })
  }

  async close() {
    this.isClosed = true
    this.head = null
    this.inflated = null

    if (this.inflating !== null) {
      const inflating = this.inflating
      this.inflating = null
      this.cancel()
      await inflating
    }

    if (this.system !== null) await this.system.close()
    if (this.view !== null) await this.view.close()
    if (this.core !== null) await this.core.close()
  }
}

// landing off a legacy system is allowed to fall a little behind
function landingSlack(auto) {
  if (auto.system.isGenesis() || auto.system.version >= MAPPED_AUTOBEE_VERSION) return 0
  return MIN_FF_GAP
}

function isContiguous(core, length) {
  return core.contiguousLength >= length || core.remoteContiguousLength >= length
}

function firstStamp(oplog) {
  const stamps = oplog.trusted
  return stamps && stamps.length > 0 ? stamps[0] : null
}

function sameHead(a, b) {
  return a && b && a.length === b.length && b4a.equals(a.key, b.key)
}

function noop() {}

exports.ActiveWriters = ActiveWriters
exports.Writer = Writer
exports.WriterFastForward = WriterFastForward
