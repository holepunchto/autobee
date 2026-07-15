const b4a = require('b4a')
const encoding = require('./encoding.js')
const Triggers = require('./triggers.js')
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
    this.triggers = new Triggers()
    this.localWriter = new Writer(this, auto.system, true, local, b4a.toString(local.key, 'hex'))
    this.writable = false
    this.pending = []

    this.localWriter.attach()

    this._bootstrap()
  }

  [Symbol.iterator]() {
    return this.active.values()
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
    if (!w) {
      // anchors are local-only and never replicated - nothing to fetch
      const info = await this.auto.system.get(key, { unflushed: true })
      if (info && info.isAnchor) return
      w = await this.add(key)
    }

    // TODO: signal that we've seen length on w for gc

    this.bump()
  }

  getLatestLocalOplog() {
    return this.localWriter.getLatest()
  }

  appendLocal(value, timestamp, batch, links, optimistic, claim) {
    return this.localWriter.append(value, timestamp, batch, links, optimistic, claim)
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

  flushLocal(views) {
    return this.localWriter.flush(views)
  }

  async refresh() {
    if (this.localWriter && !this.localWriter.closed) {
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
    const local = b4a.equals(key, this.auto.local.key)
    if (local) await this.updateLocalState()

    const id = b4a.toString(key, 'hex')
    let w = this.active.get(id)
    if (w) {
      w.couple() // couple if we weren't ready first time
      return w
    }

    const encryption = this.auto.encryptionKey ? new WriterEncryption(this.auto) : null

    const core = this.auto.store.get({
      key,
      encryption,
      group: local || !this.auto.wakeupCapability ? null : this.auto.wakeupCapability.discoveryKey
    })

    await core.ready()
    await core.setUserData('referrer', this.auto.key)

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
      w.couple() // couple if we weren't ready first time
      return
    }

    w = new Writer(this, this.auto.system, false, bootstrap, id)
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

    this.isPending = false
    this.isClosed = false
    this.isAttached = false
    this.isAdded = false
    this.isRemoved = false
    this.isCoupled = false
    this.isFrozen = false

    this._onchangeBound = this._onchange.bind(this)

    if (!local) this.core.on('append', this._onchangeBound)
    if (!local) this.core.on('download', this._onchangeBound)

    this.couple()
  }

  get isIndexer() {
    return this.weight === 2
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

    const head = this.writers.pending.pop()
    if (head !== this) {
      this.writers.pending[this.index] = head
      head.index = this.index
    }
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
    if (length < this.core.length) {
      this.addPending()
    } else if (this !== this.writers.localWriter && !this.isIndexer) {
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

  // claims ride the first node of a batch, so resolve the batch start
  async latestClaim() {
    if (this.pending) {
      for (let i = this.pending.length - 1; i >= 0; i--) {
        if (this.pending[i].claim) return this.pending[i].claim
      }
    }

    if (this.core.length === 0) return null

    const seq = this.core.length - 1
    const head = encoding.decodeOplog(await this.core.get(seq))
    if (head.claim) return head.claim

    const start = head.batch ? seq - head.batch.start : seq
    if (start === seq) return null

    const first = encoding.decodeOplog(await this.core.get(start))
    return first.claim || null
  }

  async update() {
    const info = await this.system.get(this.core.key)

    if (info && info.isAnchor && this !== this.writers.localWriter) {
      await this.detachAndClose()
      return info.length
    }

    if (!info) {
      this.isAdded = this.system.isGenesis() && b4a.equals(this.core.key, this.writers.auto.key)
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

      const node = createNode(this.core, length, this.weight, oplog)

      if (this.writers.writable) node.optimsitic = false

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
      if (b.end === 0) return batch

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

        node.batch = { start: i, end: this.pending.length - 1 - i }

        // an optimistic writer cannot be genesis
        if (node.optimistic && genesis) break
        if (node.optimistic && !this.isAdded && this.pending.length >= BATCH_OPTIMISTIC_SANITY) {
          break
        }
        if (node.timestamp - Date.now() > MAX_FORWARD_TIME_DRIFT) break

        if (!(await this._isLinked(node))) break

        this.processed = i + 1
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
    // referrer/backer gate like links: present-or-wait
    let links = node.links
    if (node.claim) {
      links = links.slice()
      if (node.claim.referrer) links.push(node.claim.referrer)
      if (node.claim.backer) links.push(node.claim.backer)
    }

    const promises = new Array(links.length)

    for (let i = 0; i < links.length; i++) {
      promises[i] = this.system.has(links[i])
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

  append(value, timestamp, batch, links, optimistic, claim) {
    if (this.pending === null) this.pending = []

    const oplog = {
      version: encoding.OPLOG_VERSION,
      timestamp,
      links,
      claim: claim || null,
      batch,
      views: null,
      optimistic: optimistic && !this.writers.writable,
      value
    }

    const node = createNode(this.core, this.appendLength++, this.weight, oplog)

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

  flush(views) {
    if (this.pending === null) return Promise.resolve()
    const buffers = []
    this.pending[this.pending.length - 1].views = views
    for (let i = 0; i < this.processed; i++) {
      const node = this.pending[i]
      node.batch = { start: i, end: this.pending.length - 1 - i }
      buffers.push(encoding.encodeOplog(node))
    }
    this.clear()
    return this.core.append(buffers)
  }
}

exports.ActiveWriters = ActiveWriters
exports.Writer = Writer
exports.createNode = createNode

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
    claim: oplog.claim || null,
    batch: oplog.batch,
    views: oplog.views,
    optimistic: oplog.optimistic,
    value: oplog.value
  }
}

function noop() {}
