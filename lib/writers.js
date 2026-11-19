const b4a = require('b4a')
const encoding = require('./encoding.js')
const Triggers = require('./triggers.js')
const { LEGACY_OPLOG_VERSION } = require('./constants.js')
const { resolveWeight } = require('./witness.js')
const { WriterEncryption } = require('./encryption.js')
const ReadWriteLock = require('read-write-mutexify')

const WRITER_PREFETCH = 10

const BATCH_WRITER_SANITY = 1024
const BATCH_OPTIMISTIC_SANITY = 32
const DEFAULT_MAX_UNTRUSTED_WRITERS = 128
const DEFAULT_MAX_RECLAIMED_WRITERS = 1024

const MAX_FORWARD_TIME_DRIFT = 2 * 3600 * 1000

class ActiveWriters {
  static validateMaxReclaimedWriters(value) {
    if (value === undefined) return DEFAULT_MAX_RECLAIMED_WRITERS

    if (typeof value !== 'number') {
      throw new TypeError('maxReclaimedWriters must be a number')
    }

    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError('maxReclaimedWriters must be a non-negative safe integer')
    }

    return value
  }

  constructor(auto) {
    const local = auto.local

    this.auto = auto
    this.active = new Map()
    this.triggers = new Triggers()
    this.localWriter = null
    this.writable = false
    this.pending = []

    this.maxUntrustedWriters =
      auto._handlers.maxUntrustedWriters === undefined
        ? DEFAULT_MAX_UNTRUSTED_WRITERS
        : auto._handlers.maxUntrustedWriters || Infinity

    this.maxReclaimedWriters = auto._maxReclaimedWriters
    this._reclaimed = new Map()
    this._closed = false

    this._pendingBuffer = new Map()
    this._adding = new Map()
    this._lock = new ReadWriteLock()

    this.localWriter = new Writer(this, auto.system, true, local, b4a.toString(local.key, 'hex'))
    this.localWriter.attach()
  }

  get size() {
    return this.active.size
  }

  [Symbol.iterator]() {
    return this.active.values()
  }

  async close() {
    this._closed = true
    this._reclaimed.clear()

    const closing = [this.localWriter.close()]
    for (const w of this.active.values()) closing.push(w.close())
    this.active.clear()
    this.pending.length = 0
    await Promise.allSettled(closing)
  }

  *external() {
    for (const w of this.active.values()) {
      if (w !== this.localWriter) yield w
    }
  }

  bump() {
    this.auto.bumpSoon()
  }

  async wakeup(key, length) {
    const id = b4a.toString(key, 'hex')

    // direct wakeups can carry work for a reclaimed identity. capture the raw
    // length before any await, including every refusal path below
    this._captureReclaimedHint(id, length)

    let w = this.active.get(id)

    if (w === this.localWriter) {
      this._handoffReclaimed(w)
      return
    }

    let added = false
    if (!w) {
      w = await this.add(key)
      if (!w) return
      added = true
    }

    const handed = this._handoffReclaimed(w)
    const advanced = length > w.hintedLength

    // remember the announced length so gc doesn't drop a writer we haven't caught up on
    w.hint(length)

    // prefetch the oplog head for the fast-forward that runs right after us
    if (w && length > 0) w.core.get(length - 1).catch(noop)

    if (added || advanced || handed) this.bump()
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

  async rotateLocalWriter(core) {
    if (this._closed || this.auto._interrupting) return false

    await this._lock.write.lock()

    try {
      if (this._closed || this.auto._interrupting) return false

      this.clearLocal()
      await this.localWriter.detachAndClose()

      // close() does not take the admission lock, so it can clear the active map
      // and the local writer while the detach above is in flight
      if (this._closed || this.auto._interrupting) return false

      const id = b4a.toString(core.key, 'hex')

      // a peer may already have announced this core (wakeup hint / link), in which
      // case an external writer tracks it - drop it so only one writer owns the key
      const existing = this.active.get(id)
      if (existing) await existing.detachAndClose()

      // never construct or attach a replacement local writer after shutdown
      if (this._closed || this.auto._interrupting) return false

      this.localWriter = new Writer(this, this.auto.system, true, core, id)
      // register in active like the constructor does, so add() finds it
      this.localWriter.attach()

      await this.updateLocalState()
      if (this._closed || this.auto._interrupting) return false

      this._handoffReclaimed(this.localWriter)
      return true
    } finally {
      this._lock.write.unlock()
    }
  }

  clearLocal() {
    return this.localWriter.clear()
  }

  async flushLocal(views) {
    const w = this.localWriter

    // only consume the queue when a flush will actually write
    if (w.pending === null || w.processed === 0) return false

    const trusted = await this.auto.trusted.mostRecentTrusted(this.auto._workingView.view, null)

    await w.flush(views, trusted)
    return true
  }

  async refresh({ reclaim = false } = {}) {
    // peeked batches were read against the pre-reboot system, drop them
    this._pendingBuffer.clear()

    const local = this.localWriter && !this.localWriter.isClosed ? this.localWriter : null

    const info = []
    for (const w of this.active.values()) {
      if (w.isFrozen && w !== this.localWriter) continue
      info.push(w.system.get(w.core.key))
    }

    if (local) info.push(local.system.get(local.core.key))

    await Promise.all(info)

    if (local) await this.updateLocalState()

    // reset() below drops every waiting trigger. keep the one link each admitted
    // writer is blocked on as plain data, bounded by the live waiters rather than
    // by everything a peer ever announced.
    const dependencies = reclaim ? this._dependencyDemands() : null

    for (const writer of this.active.values()) {
      if (writer.isFrozen && writer !== this.localWriter) await writer.detachAndClose()
      else await writer.reset()
    }

    if (dependencies !== null) await this._refreshReclaimed(dependencies)
  }

  _dependencyDemands() {
    const dependencies = new Map()

    for (const entries of this.triggers.waiting.values()) {
      for (const entry of entries) {
        const writer = entry.writer

        // removed triggers keep their slot with a nulled writer, and a writer waits
        // on exactly its first missing link - everything else is stale demand
        if (!writer || writer.isClosed || !writer.isAttached) continue
        if (writer.waiting !== entry) continue
        if (this.active.get(writer.id) !== writer) continue

        const previous = dependencies.get(entry.id)
        if (previous && previous.length >= entry.length) continue

        dependencies.set(entry.id, {
          key: b4a.from(entry.id, 'hex'),
          length: entry.length
        })
      }
    }

    return [...dependencies.values()]
  }

  captureReclaimedHints(hints) {
    if (!hints || this._closed || this.auto._interrupting) return

    for (const [id, length] of hints) {
      this._captureReclaimedHint(id, length)
    }
  }

  captureReclaimedAnnouncements(hints) {
    if (!hints || this._closed || this.auto._interrupting) return
    if (this._reclaimed.size === 0) return

    if (!Array.isArray(hints)) {
      this._captureReclaimedAnnouncement(hints)
      return
    }

    for (const announcement of hints) this._captureReclaimedAnnouncement(announcement)
  }

  _captureReclaimedAnnouncement(announcement) {
    // leave malformed forms to the base class, which owns their errors
    if (!announcement || announcement.key === undefined) return
    this._captureReclaimedHint(b4a.toString(announcement.key, 'hex'), announcement.length)
  }

  _captureReclaimedHint(id, length) {
    if (this._closed || this.auto._interrupting) return
    if (!Number.isSafeInteger(length) || length <= 0) return

    const record = this._reclaimed.get(id)
    if (record && length > record.length) record.length = length
  }

  _mergeQueuedReclaimedHint(id, record) {
    const queued = this.auto._wakeup.hints.get(id)
    if (!Number.isSafeInteger(queued) || queued <= 0) return
    if (queued > record.length) record.length = queued
  }

  _mergeQueuedReclaimedHints() {
    for (const [id, record] of this._reclaimed) {
      this._mergeQueuedReclaimedHint(id, record)
    }
  }

  // a reclaimed identity was admitted again: transfer the latest remembered
  // length before dropping the record. never delete before the writer owns it.
  _handoffReclaimed(writer) {
    if (!writer || this._closed || this.auto._interrupting) return false
    if (this.active.get(writer.id) !== writer) return false
    if (!writer.isAttached || writer.isClosed) return false

    const record = this._reclaimed.get(writer.id)
    if (!record) return false

    this._mergeQueuedReclaimedHint(writer.id, record)

    const advanced = record.length > writer.hintedLength
    if (advanced) {
      writer.hint(record.length)
      if (record.length > 0) writer.core.get(record.length - 1).catch(noop)
      writer.addPending()
    }

    this._reclaimed.delete(writer.id)

    // a direct add() has no wakeup() caller to schedule processing for it
    if (advanced) this.bump()

    return advanced
  }

  _stateToken() {
    const system = this.auto.system
    const bee = system.bee
    const view = system.view
    const head = bee.head()

    // head() allocates a fresh value object on every call, so compare the actual
    // root/context identities and persisted head coordinates instead. Counters can
    // repeat across different histories (a no-op view application is a common case).
    return {
      root: bee.root,
      context: bee.context,
      core: bee.core,
      headKey: head && head.key ? b4a.toString(head.key, 'hex') : 'none',
      headLength: head ? head.length : 0,
      flushes: system.flushes,
      version: system.version,
      heads: system.heads
        .map((entry) => b4a.toString(entry.key, 'hex') + ':' + entry.length)
        .join('|'),
      viewKey: view && view.key ? b4a.toString(view.key, 'hex') : 'none',
      viewLength: view ? view.length : 0,
      fastForwardTo: this.auto.fastForwardTo === null,
      fastForwarding: this.auto.fastForwarding === null
    }
  }

  _stateChanged(state) {
    const current = this._stateToken()

    return (
      current.root !== state.root ||
      current.context !== state.context ||
      current.core !== state.core ||
      current.headKey !== state.headKey ||
      current.headLength !== state.headLength ||
      current.flushes !== state.flushes ||
      current.version !== state.version ||
      current.heads !== state.heads ||
      current.viewKey !== state.viewKey ||
      current.viewLength !== state.viewLength ||
      current.fastForwardTo !== state.fastForwardTo ||
      current.fastForwarding !== state.fastForwarding
    )
  }

  async _refreshReclaimed(dependencies) {
    if (this._closed || this.auto._interrupting) return

    let changed = false
    await this._lock.write.lock()

    try {
      if (this._closed || this.auto._interrupting) return

      if (await this._reconcileReclaimedUnlocked()) changed = true
      if (this._closed || this.auto._interrupting) return

      if (await this._reclaimForDependenciesUnlocked(dependencies)) changed = true
      if (this._closed || this.auto._interrupting) return

      if (await this._retryReclaimedUnlocked()) changed = true
    } finally {
      this._lock.write.unlock()
      if (changed && !this._closed && !this.auto._interrupting) this.bump()
    }
  }

  async _reconcileReclaimedUnlocked() {
    if (this._closed || this.auto._interrupting) return false
    if (this._reclaimed.size === 0) return false

    let changed = false

    // announcements may still be queued between the raw flush capture and here
    this._mergeQueuedReclaimedHints()

    for (const [id, record] of [...this._reclaimed]) {
      if (this._closed || this.auto._interrupting) break
      if (this._reclaimed.get(id) !== record) continue

      const active = this.active.get(id)
      if (active) {
        if (this._handoffReclaimed(active)) changed = true
        continue
      }

      const state = this._stateToken()
      const info = await this.auto.system.get(record.key)

      // the await may have raced close, a handoff or a replacement record
      if (this._closed || this.auto._interrupting) break
      if (this._reclaimed.get(id) !== record) continue

      const admitted = this.active.get(id)
      if (admitted) {
        if (this._handoffReclaimed(admitted)) changed = true
        continue
      }

      this._mergeQueuedReclaimedHint(id, record)

      // undo and fast-forward may move the system or view while we read. retain
      // the record for the next refresh instead of trusting flush counts or a
      // repeated application-view summary.
      if (this._stateChanged(state)) continue

      const applied = info ? info.length : 0
      const queued = this.auto._wakeup.hints.get(id)

      // an unresolved length is an obligation even when the applied length covers
      // the last known one. it must not erase a known positive maximum.
      if (queued === -1) continue

      if (this.auto.system.isHead(record.key)) continue
      if (applied < record.length) continue

      // re-read queued hints immediately before deleting. no await is allowed
      // between these final checks and the delete.
      if (this._closed || this.auto._interrupting) break
      if (this._reclaimed.get(id) !== record) continue
      this._mergeQueuedReclaimedHint(id, record)

      const latest = this.auto._wakeup.hints.get(id)
      if (latest === -1) continue
      if (applied < record.length) continue
      if (this.auto.system.isHead(record.key)) continue

      this._reclaimed.delete(id)
    }

    return changed
  }

  async _reclaimForDependenciesUnlocked(dependencies) {
    if (dependencies.length === 0 || this._closed || this.auto._interrupting) return false

    let changed = false
    const trusted = await this.auto.isLocalTrusted()

    if (this._closed || this.auto._interrupting) return false

    for (const dependency of dependencies) {
      if (this._closed || this.auto._interrupting) break

      const id = b4a.toString(dependency.key, 'hex')

      // the system may have advanced since the trigger was recorded
      const info = await this.auto.system.get(dependency.key)
      if (this._closed || this.auto._interrupting) break
      if (info && info.length >= dependency.length) continue

      let w = this.active.get(id)
      let added = false

      if (!w) {
        if (b4a.equals(dependency.key, this.localWriter.core.key)) {
          // wakeup() treats the local core as attached and never hints it, but a
          // reclaimed record must still be handed to the local owner
          w = this.localWriter
        } else {
          if (!trusted && this.active.size >= this.maxUntrustedWriters) {
            // a zero budget cannot admit even after freeing a slot
            if (this.maxUntrustedWriters <= 0) break

            const victim = await this._reclaimOne(dependencies)
            if (this._closed || this.auto._interrupting) break
            if (victim === null) break
          }

          w = await this._addUnlocked(dependency.key, id)
          if (this._closed || this.auto._interrupting) break
          if (!w) break

          added = true
        }
      }

      // every existing/new/local shortcut takes over the remembered obligation
      if (this._handoffReclaimed(w)) changed = true

      if (w === this.localWriter) continue

      // deliver the saved hint now, before releasing the slot this admission
      // holds - a stalled wakeup must not depend on another announcement
      if (dependency.length > w.hintedLength) {
        w.hint(dependency.length)
        w.core.get(dependency.length - 1).catch(noop)
        changed = true
      } else if (added) {
        changed = true
      }
    }

    return changed
  }

  async _retryReclaimedUnlocked() {
    if (this._closed || this.auto._interrupting) return false
    if (this._reclaimed.size === 0) return false

    let changed = false

    for (const [id, record] of [...this._reclaimed]) {
      if (this._closed || this.auto._interrupting) break
      if (this._reclaimed.get(id) !== record) continue

      const active = this.active.get(id)
      if (active) {
        if (this._handoffReclaimed(active)) changed = true
        continue
      }

      const state = this._stateToken()
      const info = await this.auto.system.get(record.key)

      if (this._closed || this.auto._interrupting) break
      if (this._reclaimed.get(id) !== record) continue

      const admitted = this.active.get(id)
      if (admitted) {
        if (this._handoffReclaimed(admitted)) changed = true
        continue
      }

      this._mergeQueuedReclaimedHint(id, record)

      if (this._stateChanged(state)) continue
      if (info && info.length >= record.length) continue

      // ordinary cap and trust rules apply. this path never evicts and never
      // waits on a queued same-key add().
      const w = await this._addUnlocked(record.key, id)
      if (this._closed || this.auto._interrupting) break
      if (!w) continue

      this._handoffReclaimed(w)
      if (this.active.get(id) === w) changed = true
    }

    return changed
  }

  async _reclaimOne(dependencies) {
    if (this._closed || this.auto._interrupting) return null
    if (this._reclaimed.size >= this.maxReclaimedWriters) return null

    const reserved = new Set()
    for (const dependency of dependencies) reserved.add(b4a.toString(dependency.key, 'hex'))

    for (const w of this.active.values()) {
      if (this._closed || this.auto._interrupting) return null
      if (w === this.localWriter) continue
      if (reserved.has(w.id)) continue
      if (!w.isAttached || w.isClosed || this.active.get(w.id) !== w) continue
      if (w.isFrozen) continue

      // isPending is not proof of idleness: reset() clears it before its update
      // and buffered/fetched work lives beside it. Cheap checks first, then a
      // fresh applied length and the same checks again before anything closes.
      if (!this._isIdleCandidate(w)) continue

      const length = await w.update()

      if (this._closed || this.auto._interrupting) return null
      if (w === this.localWriter) continue
      if (!w.isAttached || w.isClosed || this.active.get(w.id) !== w) continue
      if (!w.isHead || !this._isIdleCandidate(w)) continue

      // caught up against both the live core and the last announcement
      if (length < w.core.length || length < w.hintedLength) continue
      if (this._hasQueuedAnnouncement(w.id, length)) continue

      // re-check synchronously: no await between here and detach()
      if (this._closed || this.auto._interrupting || !w.isAttached || w.isClosed) continue
      if (this.active.get(w.id) !== w || !w.isHead || !this._isIdleCandidate(w)) continue
      if (length < w.core.length || length < w.hintedLength) continue
      if (this._hasQueuedAnnouncement(w.id, length)) continue

      // reserve immediately before the detach. saturation never deletes a record
      // and never detaches a candidate.
      if (this._reclaimed.size >= this.maxReclaimedWriters) return null

      const previous = this._reclaimed.get(w.id)
      const record = {
        key: b4a.from(w.core.key),
        length: previous && previous.length > length ? previous.length : length
      }
      this._reclaimed.set(w.id, record)

      let detached = false
      try {
        w.detach()
        detached = true
        w.decouple()
        await w.close()
      } finally {
        // only a reservation whose detach never happened is rolled back. once
        // the writer detached, the record keeps its announced obligation.
        if (!detached) {
          if (previous) this._reclaimed.set(w.id, previous)
          else this._reclaimed.delete(w.id)
        }
      }

      return w
    }

    return null
  }

  _isIdleCandidate(w) {
    if (w.isPending || w.appending) return false
    if (w.waiting !== null || this._pendingBuffer.has(w)) return false
    if (w.pending !== null) return false
    return true
  }

  // An announcement received after the drain's wakeup flush is not on the
  // writer yet, so hintedLength alone would let us close work we already know
  // about. Read the queue without draining it: this runs under the admission
  // write lock and the normal drain owns the only flush.
  _hasQueuedAnnouncement(id, applied) {
    const pending = this.auto._wakeup.hints.get(id)

    if (pending === undefined) return false
    // -1 means the peer has not resolved a length yet, so protect it
    return pending === -1 || pending > applied
  }

  async updateLocalState() {
    await this.localWriter.update()
  }

  async nextPendingNode({ local = false } = {}) {
    for (const w of this.pending.slice()) {
      if (local && w !== this.localWriter) continue
      if (this._pendingBuffer.has(w) || w.isFrozen) continue

      const batch = await w.next()
      if (batch !== null) this._pendingBuffer.set(w, batch)
    }

    if (this._pendingBuffer.size === 0) return null

    let writer = null
    let best = null

    for (const [w, batch] of this._pendingBuffer) {
      if (local && w !== this.localWriter) continue
      const head = batch[0]
      // -1 marks a node next() has not resolved a sort weight for yet
      if (head.weight < 0) head.weight = await resolveWeight(this.auto, head)
      if (best === null || sortsBefore(head, best[0])) {
        writer = w
        best = batch
      }
    }

    if (writer === null) return null

    this._pendingBuffer.delete(writer)
    return { writer, batch: best }
  }

  _updateLocalState() {
    const w = this.localWriter

    const writable = w.isAdded && !w.isRemoved
    if (writable === this.writable) return

    this.writable = writable
    this.auto.emit(this.writable ? 'writable' : 'unwritable')
    this.auto.emit('update')
  }

  has(id) {
    return !!this.active.get(id)
  }

  async add(key) {
    const id = b4a.toString(key, 'hex')

    let adding = this._adding.get(id)
    if (adding) return adding

    adding = this._add(key, id)
    this._adding.set(id, adding)

    try {
      return await adding
    } finally {
      this._adding.delete(id)
    }
  }

  async _add(key, id) {
    await this._lock.read.lock()

    try {
      return await this._addUnlocked(key, id)
    } finally {
      this._lock.read.unlock()
    }
  }

  // caller owns either the read lock (normal admission) or the write lock
  // (reclaim plus admission), so this must never take one itself
  async _addUnlocked(key, id) {
    if (this._closed || this.auto._interrupting) return null

    // judged against the writer we own, not auto.local - that flips before the
    // rotation takes the write lock. an add that beats the rotation onto its
    // key just makes an external writer, which the rotation then evicts
    if (b4a.equals(key, this.localWriter.core.key)) {
      await this.updateLocalState()
      if (this._closed || this.auto._interrupting) return null
      // never track the local core with a second writer - reattach it if it
      // was detached (i.e. removed earlier and now re-added)
      this.localWriter.attach()
      this._handoffReclaimed(this.localWriter)
      return this.localWriter
    }

    let w = this.active.get(id)
    if (w) {
      this._handoffReclaimed(w)
      return w
    }

    // sanity limit while untrusted, a dropped writer is requested again by the
    // links waiting on it or by peers announcing it once the round has gc'd.
    // close() can run while the trust check is in flight, so revalidate before
    // allocating a session or counting an open writer.
    if (this.active.size >= this.maxUntrustedWriters) {
      const trusted = await this.auto.isLocalTrusted()
      if (this._closed || this.auto._interrupting) return null
      if (!trusted) return null
    }

    this.auto.stats.writersOpened++

    const local = b4a.equals(key, this.auto.local.key)
    const encryption = this.auto.encryptionKey ? new WriterEncryption(this.auto) : null

    const core = this.auto.store.get({
      active: false,
      key,
      encryption,
      group: local || !this.auto.wakeupCapability ? null : this.auto.wakeupCapability.discoveryKey
    })

    await core.ready()
    await core.setUserData('referrer', this.auto.key)

    // teardown may have started underneath us
    if (this._closed || this.auto._interrupting) {
      await core.close()
      return null
    }

    w = new Writer(this, this.auto.system, false, core, id)
    w.attach()

    // every successful admission takes ownership of a remembered obligation
    this._handoffReclaimed(w)

    return w
  }

  async remove(key) {
    if (b4a.equals(key, this.auto.local.key)) await this.updateLocalState()

    const id = b4a.toString(key, 'hex')
    const w = this.active.get(id)
    if (!w) return

    // nodes this writer appended before the removal may still sort before it,
    // and their ordering advances its record everywhere - closing the session
    // while we are behind strands us one node short forever. reset() closes it
    // once we have caught up
    if (w !== this.localWriter) {
      const length = await w.update()
      if (length < w.core.length || length < w.hintedLength) {
        w.addPending()
        return
      }
    }

    w.detach()
    w.decouple()
    if (w !== this.localWriter) await w.close()
  }
}

class Writer {
  constructor(writers, system, local, core, id) {
    this.writers = writers
    this.system = system

    this.core = core
    this.id = id
    this.index = 0
    this.weight = 0
    this.pending = null
    this.processed = 0
    this.appendLength = this.core.length + 1
    this.waiting = null
    this.download = null
    this.hintedLength = 0
    this.systemLength = 0

    this.isPending = false
    this.isClosed = false
    this.isAttached = false
    this.isAdded = false
    this.isRemoved = false
    this.isCoupled = false
    this.isFrozen = false
    this.isHead = false

    this._onchangeBound = this._onchange.bind(this)

    if (!local) this.core.on('append', this._onchangeBound)
    if (!local) this.core.on('download', this._onchangeBound)
  }

  get isIndexer() {
    return this.weight >= 2
  }

  isSystemHead() {
    if (this.core.length === 0) return false

    if (this.system.heads.length === 0) {
      return b4a.equals(this.core.key, this.writers.auto.key)
    }

    return this.system.isHead(this.core.key)
  }

  couple() {
    if (this.isCoupled) return
    // if we don't have coupler yet we can't add
    if (this.writers.auto._wakeup.addCore(this.core)) {
      this.isCoupled = true
    }
  }

  decouple() {
    if (!this.isCoupled) return
    // if we don't have coupler yet we can't remove
    if (this.writers.auto._wakeup.removeCore(this.core)) {
      this.isCoupled = false
    }
  }

  hasReferrals() {
    const entries = this.writers.triggers.get(this.id)
    if (!entries) return false
    // TODO: should implement a system where we KNOW that a future writers IS not removed
    // to avoid accidental spam, for now kept simple as the algo still runs
    return true
  }

  addPending() {
    if (this.isPending) return
    this.isPending = true
    this.index = this.writers.pending.push(this) - 1
  }

  removePending() {
    if (!this.isPending) return
    this.isPending = false

    this.writers._pendingBuffer.delete(this)

    const head = this.writers.pending.pop()
    if (head !== this) {
      this.writers.pending[this.index] = head
      head.index = this.index
    }
  }

  // a peer announced this length for us, so we're not caught up until we've seen it
  hint(length) {
    if (length > this.hintedLength) {
      this.hintedLength = length
      this.core.setActive(true)
    }
  }

  _onchange() {
    this.hint(this.core.length)
    if (this.waiting === null) this.bump()
  }

  bump() {
    this.waiting = null
    if (this.isAttached) this.addPending() // TODO: remove the isAttach guard
    this.writers.bump()
  }

  attach() {
    if (this.isAttached) return
    this.isAttached = true
    this.writers.active.set(this.id, this)
    this.writers.auto.emit('writer', this)
    this.addPending()
  }

  detach() {
    if (!this.isAttached) return
    this.isAttached = false
    if (this.download) this.download.destroy()
    this.download = null
    this.writers.active.delete(this.id)
    this.removePending()
  }

  async reset() {
    this.removePending()
    this.processed = 0

    if (this.waiting) {
      this.writers.triggers.remove(this.waiting)
      this.waiting = null
    }

    const length = await this.update()

    // don't drop any local nodes left in buffer, or work a peer told us about
    if (length < this.core.length || length < this.hintedLength || this.appending) {
      this.addPending()
    } else if (this !== this.writers.localWriter && !this.isHead) {
      await this.detachAndClose()
    }
  }

  close() {
    if (!this.isClosed && this !== this.writers.localWriter) this.writers.auto.stats.writersClosed++
    this.isClosed = true

    if (this.waiting) {
      this.writers.triggers.remove(this.waiting)
      this.waiting = null
    }

    this.removePending()

    return this.core.close()
  }

  detachAndClose() {
    this.detach()
    this.decouple()
    return this.close()
  }

  async views() {
    const latest = await this.getLatest()
    if (!latest || !latest.views) return []

    // signedLength for autobase compat
    const system = latest.views.system.start + latest.views.system.length
    const view = latest.views.view.start + latest.views.view.length

    return [
      { key: latest.views.system.key, length: system, signedLength: system },
      { key: latest.views.view.key, length: view, signedLength: view }
    ]
  }

  async getLatest() {
    if (this.core.length === 0) return null
    const block = await this.core.get(this.core.length - 1)
    const oplog = encoding.decodeOplog(block)
    return oplog
  }

  async update() {
    const info = await this.system.get(this.core.key)
    const length = info ? info.length : 0

    this.systemLength = length

    const isHead = this.isSystemHead()

    if (isHead) {
      this.isHead = true
      this.couple()
    } else {
      this.isHead = false
      this.decouple()
    }

    const active = length < this.core.length || length < this.hintedLength

    if (this.isHead || active) {
      this.core.setActive(true)
    } else {
      this.core.setActive(false)
    }

    if (!info) {
      this.isAdded = b4a.equals(this.core.key, this.writers.auto.key)
    } else {
      this.isAdded = true
      this.isRemoved = info.isRemoved
      // capability (isIndexer etc), NOT the resolved sort weight
      this.weight = info.maxWeight
    }

    if (this === this.writers.localWriter) {
      this.writers._updateLocalState()
    }

    return length
  }

  next() {
    if (this.isFrozen) return null
    return this._next()
  }

  async _next() {
    if (this.waiting !== null) return null

    const batch = []
    const genesis = this.system.isGenesis()

    let length = await this.update()
    let optimistic = false
    let timestamp = 0

    if (this.download) this.download.destroy()
    this.download = this.core.download({ start: length, end: length + WRITER_PREFETCH })

    while (length < this.core.length) {
      // @todo aim to prefetch when writer added, with read-ahead
      // download the block if it's not available locally
      // writer will be added back as pending automatically
      if (!(await this.core.has(length))) {
        this.removePending()
        return null
      }

      let oplog
      try {
        const block = await this.core.get(length++)
        oplog = encoding.decodeOplog(block)
      } catch {
        this.isFrozen = true
        this.removePending()
        return null
      }

      const node = createNode(this.core, length, -1, oplog)

      if (this.writers.writable && this === this.writers.localWriter) {
        node.optimistic = false
      }

      const b = oplog.batch

      // auto correct some batch invariants
      node.timestamp = timestamp = Math.max(node.timestamp, timestamp)
      node.optimistic = optimistic = optimistic || node.optimistic

      if (node.optimistic && !this.isAdded && b.end >= BATCH_OPTIMISTIC_SANITY) {
        return null
      }

      if (node.timestamp - Date.now() > MAX_FORWARD_TIME_DRIFT) {
        return null
      }

      if (!node.optimistic && b.start === 0 && b.end > 1 && b.end < BATCH_WRITER_SANITY) {
        this.core.download({ start: length, end: length + oplog.batch.end })
      }

      if (!(await this._isLinked(node))) {
        this.removePending()
        return null
      }

      // an optimistic writer cannot be genesis
      if (node.optimistic && genesis) {
        return null
      }

      if (!this.isAdded && !node.optimistic && !genesis) {
        return null
      }

      batch.push(node)
      if (b.end === 0) return finalizeNodeBatch(batch)

      // TODO: mark as dead
      if (batch.length >= BATCH_WRITER_SANITY) return null
    }

    // handle local writer
    if (this.core.writable && this.pending !== null) {
      let start = this.processed
      const end = this.pending.length

      while (start < end && this.pending[start].length <= length) {
        this.processed = ++start
      }

      if (start < end && !this.writers.writable) {
        const node = this.pending[start]
        if (!node.optimistic) {
          this.writers.clearLocal()
          throw new Error('Not writable')
        }
      }

      for (let i = start; i < end; i++) {
        const node = this.pending[i]

        // an optimistic writer cannot be genesis
        if (node.optimistic && genesis) break
        if (node.optimistic && !this.isAdded && this.pending.length >= BATCH_OPTIMISTIC_SANITY) {
          break
        }
        if (node.timestamp - Date.now() > MAX_FORWARD_TIME_DRIFT) break

        if (!(await this._isLinked(node))) break

        this.processed = i + 1

        if (node.batch.end === 0) break
      }

      if (this.processed === this.pending.length) {
        this.removePending()
      }

      if (start === this.processed) return null
      return this.pending.slice(start, this.processed)
    }

    return null
  }

  notify(batch) {
    this.writers.triggers.trigger(this.id, batch[batch.length - 1].length)
  }

  async _isLinked(node) {
    let links = node.links
    if (node.witness) {
      links = links.slice()
      links.push({ key: node.witness.link.key, length: node.witness.link.length })
    }

    const promises = new Array(links.length)

    for (let i = 0; i < links.length; i++) {
      const link = links[i]

      // legacy batch nodes link their own previous node, satisfied by oplog order
      if (link.length < node.length && b4a.equals(link.key, this.core.key)) {
        promises[i] = true
        continue
      }

      promises[i] = this.system.has(link)
    }

    const has = await Promise.all(promises)

    let missing = false

    for (let i = 0; i < links.length; i++) {
      if (has[i]) continue
      const link = links[i]

      // one trigger per writer, wait on the first missing link
      if (!missing) {
        const id = b4a.toString(link.key, 'hex')

        this.waiting = this.writers.triggers.add(id, link.length, this)

        // check it didn't arrive underneath us
        if (await this.system.has(link)) {
          this.writers.triggers.remove(this.waiting)
          this.waiting = null
          continue
        }

        missing = true
      }

      // but wake up every missing link so they fetch in parallel
      this.writers.wakeup(link.key, link.length).catch(noop)
    }

    return !missing
  }

  get appending() {
    return this.pending !== null
  }

  append(value, timestamp, batch, links, optimistic, witness, approvals, hash, drift) {
    if (this.pending === null) this.pending = []

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

    const node = createNode(this.core, this.appendLength++, -1, oplog)

    this.pending.push(node)
    this.addPending()

    return node
  }

  clear() {
    if (!this.pending) return

    if (this.processed === this.pending.length) {
      this.pending = null
    } else {
      this.pending = this.pending.slice(this.processed)
    }

    this.processed = 0
  }

  async flush(views, trusted) {
    if (this.pending === null || this.processed === 0) return

    const head = this.pending[this.processed - 1]
    head.views = views

    head.trusted = trusted ? [{ key: trusted.key, length: trusted.length }] : null
    this.writers.auto.emit('appending', this.pending)

    const buffers = []
    for (let i = 0; i < this.processed; i++) {
      const node = this.pending[i]
      node.weightHint = node.weight > 0 ? node.weight : 0
      buffers.push(encoding.encodeOplog(node))
    }

    try {
      await this.core.append(buffers)
    } finally {
      this.clear()
    }
  }
}

// mirrors topo.cmp - kept local because topo.js requires this module
function sortsBefore(a, b) {
  if (a.weight !== b.weight) return a.weight > b.weight
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp

  const c = b4a.compare(a.key, b.key)
  if (c !== 0) return c < 0

  return a.length < b.length
}

exports.ActiveWriters = ActiveWriters
exports.Writer = Writer
exports.createNode = createNode
exports.finalizeNodeBatch = finalizeNodeBatch

function createNode(core, length, weight, oplog) {
  return {
    core,
    from: core, // compat
    key: core.key,
    length,
    weight,
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

function finalizeNodeBatch(batch) {
  // replay batches keep unreachable blocks as null holes (topo.getOplogBatch)
  let first = null
  for (const node of batch) {
    if (node !== null) {
      first = node
      break
    }
  }
  if (first === null || first.version > LEGACY_OPLOG_VERSION) return batch

  for (let i = 0; i < batch.length; i++) {
    if (batch[i] !== null) batch[i].batch.start = i
  }

  return batch
}

function noop() {}
