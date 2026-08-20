const b4a = require('b4a')
const encoding = require('./encoding.js')
const Triggers = require('./triggers.js')
const { LEGACY_OPLOG_VERSION } = require('./constants.js')
const { resolveWeight } = require('./witness.js')
const { WriterEncryption } = require('autobee-encryption')

const WRITER_PREFETCH = 10

const BATCH_WRITER_SANITY = 1024
const BATCH_OPTIMISTIC_SANITY = 32

const MAX_FORWARD_TIME_DRIFT = 2 * 3600 * 1000

class ActiveWriters {
  constructor(auto) {
    const local = auto.local

    this.auto = auto
    this.active = new Map()
    this._adding = new Map()
    this.triggers = new Triggers()
    this.localWriter = new Writer(this, auto.system, true, local, b4a.toString(local.key, 'hex'))
    this.writable = false
    this.pending = []

    this._pendingBuffer = new Map()

    this.localWriter.attach()

    this._bootstrap()
  }

  [Symbol.iterator]() {
    return this.active.values()
  }

  async close() {
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
    let w = this.active.get(id)

    if (w === this.localWriter) return

    let added = false
    if (!w) {
      w = await this.add(key)
      if (!w) return
      added = true
    }

    const advanced = length > w.hintedLength

    // remember the announced length so gc doesn't drop a writer we haven't caught up on
    w.hint(length)

    // prefetch the oplog head for the fast-forward that runs right after us
    if (w && length > 0) w.core.get(length - 1).catch(noop)

    if (added || advanced) this.bump()
  }

  getLatestLocalOplog() {
    return this.localWriter.getLatest()
  }

  appendLocal(value, timestamp, batch, links, optimistic, witness, approvals = null) {
    return this.localWriter.append(value, timestamp, batch, links, optimistic, witness, approvals)
  }

  async rotateLocalWriter(core) {
    this.clearLocal()
    await this.localWriter.detachAndClose()

    this.localWriter = new Writer(this, this.auto.system, true, core, b4a.toString(core.key, 'hex'))
    this.localWriter.addPending()
    this.auto.emit('writer', this.localWriter)

    await this.updateLocalState()
  }

  clearLocal() {
    return this.localWriter.clear()
  }

  async flushLocal(views) {
    const w = this.localWriter

    // only consume the queue when a flush will actually write
    if (w.pending === null || w.processed === 0) return

    const trusted = await this.auto.trusted.mostRecentTrusted(this.auto._workingView.view, null)

    return w.flush(views, trusted)
  }

  async refresh() {
    // peeked batches were read against the pre-reboot system, drop them
    this._pendingBuffer.clear()

    if (this.localWriter && !this.localWriter.isClosed) {
      await this.updateLocalState()
    }

    for (const writer of this.active.values()) {
      if (writer.isFrozen && writer !== this.localWriter) await writer.detachAndClose()
      else await writer.reset()
    }
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

  add(key) {
    const id = b4a.toString(key, 'hex')

    let adding = this._adding.get(id)
    if (adding) return adding

    adding = this._add(key, id)
    this._adding.set(id, adding)

    return adding.finally(() => {
      this._adding.delete(id)
    })
  }

  // TODO: correct fix is writer as ReadyResource
  async _add(key, id) {
    const local = b4a.equals(key, this.auto.local.key)
    if (local) await this.updateLocalState()

    let w = this.active.get(id)
    if (w) {
      w.couple() // couple if we weren't ready first time
      return w
    }

    // no new sessions once teardown started
    if (this.auto._interrupting) return null

    const encryption = this.auto.encryptionKey ? new WriterEncryption(this.auto) : null

    const core = this.auto.store.get({
      key,
      encryption,
      group: local || !this.auto.wakeupCapability ? null : this.auto.wakeupCapability.discoveryKey
    })

    await core.ready()
    await core.setUserData('referrer', this.auto.key)

    // we want this writer's blocks, tell the replicator to go get them
    core.setActive(true)

    // teardown may have started underneath us
    if (this.auto._interrupting) {
      await core.close()
      return null
    }

    w = new Writer(this, this.auto.system, false, core, id)
    w.attach()
    w.couple()

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

  _bootstrap() {
    const bootstrap = this.auto.bootstrap

    bootstrap.setEncryption(this.auto._getEncryptionProvider())
    bootstrap.setActive(true)

    const id = b4a.toString(bootstrap.key, 'hex')
    let w = this.active.get(id)
    if (w) {
      w.isBootstrap = true
      w.couple() // couple if we weren't ready first time
      return
    }

    const session = bootstrap.session()
    session.setEncryption(this.auto._getEncryptionProvider())

    w = new Writer(this, this.auto.system, false, session, id)
    w.isBootstrap = true // the root of the autobase, never gc'd
    w.attach()
    w.couple()
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

    this.isPending = false
    this.isClosed = false
    this.isAttached = false
    this.isAdded = false
    this.isRemoved = false
    this.isCoupled = false
    this.isFrozen = false
    this.isBootstrap = false

    this._onchangeBound = this._onchange.bind(this)

    if (!local) this.core.on('append', this._onchangeBound)
    if (!local) this.core.on('download', this._onchangeBound)

    this.couple()
  }

  get isIndexer() {
    return this.weight >= 2
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
    if (length > this.hintedLength) this.hintedLength = length
  }

  _onchange() {
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

    if (this.waiting) {
      this.writers.triggers.remove(this.waiting)
      this.waiting = null
    }

    const length = await this.update()

    // don't drop any local nodes left in buffer, or work a peer told us about
    if (length < this.core.length || length < this.hintedLength || this.appending) {
      this.addPending()
    } else if (this !== this.writers.localWriter && !this.isIndexer && !this.isBootstrap) {
      await this.detachAndClose()
    }
  }

  close() {
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
    // drop replicator interest before tearing the session down
    this.core.setActive(false)
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

    // an anchor core is prologue-only, so once its single node has applied
    // nothing more can ever come - retire the writer
    if (info && info.length > 0 && isAnchor(this.core)) {
      await this.detachAndClose()
      return info.length
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

    return info ? info.length : 0
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

      if (!this.isAdded && !node.optimistic && !genesis) {
        return null
      }

      // an optimistic writer cannot be genesis
      if (node.optimistic && genesis) {
        return null
      }

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

    for (let i = 0; i < links.length; i++) {
      if (has[i]) continue
      const link = links[i]
      const id = b4a.toString(link.key, 'hex')

      this.waiting = this.writers.triggers.add(id, link.length, this)

      // check it didn't arrive underneath us
      if (await this.system.has(link)) {
        this.writers.triggers.remove(this.waiting)
        this.waiting = null
        continue
      }

      this.writers.wakeup(link.key, link.length).catch(noop)
      return false
    }

    return true
  }

  get appending() {
    return this.pending !== null
  }

  append(value, timestamp, batch, links, optimistic, witness, approvals = null) {
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
      value
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

    const buffers = []
    for (let i = 0; i < this.processed; i++) {
      buffers.push(encoding.encodeOplog(this.pending[i]))
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
    value: oplog.value
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

function isAnchor(core) {
  return !!(core.manifest && core.manifest.signers.length === 0 && core.length === 1)
}
