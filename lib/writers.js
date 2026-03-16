const b4a = require('b4a')
const encoding = require('./encoding.js')
const Triggers = require('./triggers.js')
const { WriterEncryption } = require('autobee-encryption')

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
  }

  *external() {
    for (const w of this.active.values()) {
      if (w !== this.localWriter) yield w
    }
  }

  bump() {
    this.auto._bump()
  }

  async wakeup(key, length) {
    const id = b4a.toString(key, 'hex')
    let w = this.active.get(id)

    if (w === this.localWriter) return
    if (!w) w = await this.add(key)

    // TODO: signal that we've seen length on w for gc
  }

  getLatestLocalOplog() {
    return this.localWriter.getLatest()
  }

  appendLocal(value, timestamp, batch, links, optimistic) {
    return this.localWriter.append(value, timestamp, batch, links, optimistic)
  }

  clearLocal() {
    return this.localWriter.clear()
  }

  flushLocal(head) {
    return this.localWriter.flush(head)
  }

  async updateLocalState() {
    const w = this.localWriter
    const bootstrapping = w.core.length === 0 && b4a.equals(this.auto.key, w.core.key)
    const info = await this.auto.system.get(this.auto.local.key)
    const writable = this.writable

    this.writable = info ? !info.isRemoved : bootstrapping

    if (writable === this.writable) return

    this.auto.emit(this.writable ? 'writable' : 'unwritable')
    this.auto.emit('update')
  }

  async add(key) {
    if (b4a.equals(key, this.auto.local.key)) await this.updateLocalState()

    const id = b4a.toString(key, 'hex')
    let w = this.active.get(id)
    if (w) return w

    const encryption = this.auto.encryptionKey ? new WriterEncryption(this.auto) : null

    const core = this.auto.store.get({
      key,
      encryption
    })
    await core.ready()

    w = new Writer(this, this.auto.system, false, core, id)
    w.attach()

    return w
  }

  async remove(key) {
    if (b4a.equals(key, this.auto.local.key)) await this.updateLocalState()

    const id = b4a.toString(key, 'hex')
    const w = this.active.get(id)
    if (!w) return

    w.detach()
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
    this.pending = null
    this.waiting = null

    this.isPending = false
    this.isClosed = false
    this.isAttached = false
    this.isIndexer = false
    this.isAdded = false
    this.isRemoved = false

    this._onappendBound = this._onappend.bind(this)
    if (!local) {
      this.core.on('append', this._onappendBound)
      this.core.on('append', () => console.log('[CORE] append'))
      this.core.on('download', () => console.log('[CORE] download'))
      this.core.on('manifest', () => console.log('[CORE] manifest'))
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

  _onappend() {
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
    if (this !== this.writers.localWriter) this.addPending()
  }

  detach() {
    if (!this.isAttached) return
    this.isAttached = false
    this.writers.active.delete(this.id)
    this.removePending()
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

  async getLatest() {
    if (this.core.length === 0) return null
    const block = await this.core.get(this.core.length - 1)
    const oplog = encoding.decodeOplog(block)
    return oplog
  }

  async update() {
    const info = await this.system.get(this.core.key)

    if (!info) {
      this.isAdded = this.system.isGenesis()
    } else {
      this.isAdded = true
      this.isRemoved = info.isRemoved
      this.isIndexer = info.isIndexer
    }

    return info ? info.length : 0
  }

  async next() {
    if (this.waiting !== null) return null

    const batch = []
    const genesis = this.system.isGenesis()

    let length = await this.update()
    let optimistic = false
    let timestamp = 0

    while (length < this.core.length) {
      const block = await this.core.get(length++)
      const oplog = encoding.decodeOplog(block)
      const node = createNode(this.core, length, oplog)
      const b = oplog.batch

      // auto correct some batch invariants
      node.timestamp = timestamp = Math.max(node.timestamp, timestamp)
      node.optimistic = optimistic = optimistic || node.optimistic

      if (!this.isAdded && !node.optimistic && !genesis) {
        console.log('[NEXT] skipping batch, optimistic:', this.isAdded, node.optimistic)
        return null
      }

      // an optimistic writer cannot be genesis
      if (node.optimistic && genesis) {
        console.log('NEXT] optimistic writer cannot be genesis')
        return null
      }

      if (node.optimistic && !this.isAdded && b.end >= BATCH_OPTIMISTIC_SANITY) {
        console.log('NEXT] BATCH_OPTIMISTIC_SANITY')
        return null
      }

      if (node.timestamp - Date.now() > MAX_FORWARD_TIME_DRIFT) {
        console.log('NEXT] MAX_FORWARD_TIME_DRIFT')
        return null
      }

      if (!node.optimistic && b.start === 0 && b.end > 1 && b.end < BATCH_WRITER_SANITY) {
        this.core.download({ start: length, end: length + oplog.batch.end })
      }

      if (!(await this._isLinked(node))) {
        console.log('NEXT] NOT linked')
        this.removePending()
        return null
      }

      batch.push(node)
      if (b.end === 0) return batch

      // TODO: mark as dead
      if (batch.length >= BATCH_WRITER_SANITY) {
        console.log('NEXT] DEAD')
        return null
      }
    }

    console.log('NEXT] END')
    return null
  }

  notify(batch) {
    this.writers.triggers.trigger(this.id, batch[batch.length - 1].length)
  }

  async _isLinked(node) {
    console.log('_isLinked', node)
    const promises = new Array(node.links.length)

    for (let i = 0; i < node.links.length; i++) {
      promises[i] = this.system.has(node.links[i])
    }

    const has = await Promise.all(promises)

    for (let i = 0; i < node.links.length; i++) {
      if (has[i]) continue
      const link = node.links[i]
      const id = b4a.toString(link.key, 'hex')
      this.waiting = this.writers.triggers.add(id, link.length, this)
      this.writers
        .wakeup(link.key, link.length)
        .catch((e) => {
          console.log('WAKEUP fail', e)
        })
        .then(() => {
          console.log('WAKEUP ok')
        })

      console.log('_isLinked false', id)
      return false
    }

    console.log('_isLinked true', node)
    return true
  }

  append(value, timestamp, batch, links, optimistic) {
    if (this.pending === null) this.pending = []

    const oplog = {
      version: encoding.OPLOG_VERSION,
      timestamp,
      links,
      batch,
      views: null,
      optimistic,
      value
    }

    const node = createNode(this.core, this.core.length + this.pending.length + 1, oplog)

    this.pending.push(node)

    return node
  }

  clear() {
    this.pending = null
  }

  flush(view) {
    if (this.pending === null) return Promise.resolve()
    const buffers = []
    const s = this.system.bee.head()
    const flushes = this.system.flushes
    this.pending[this.pending.length - 1].views = { system: s, flushes, view }
    for (const node of this.pending) buffers.push(encoding.encodeOplog(node))
    this.pending = null
    return this.core.append(buffers)
  }
}

exports.ActiveWriters = ActiveWriters
exports.Writer = Writer
exports.createNode = createNode

function createNode(core, length, oplog) {
  return {
    core,
    key: core.key,
    length,
    version: oplog.version,
    timestamp: oplog.timestamp,
    links: oplog.links,
    batch: oplog.batch,
    views: oplog.views,
    optimistic: oplog.optimistic,
    value: oplog.value
  }
}

function noop() {}
