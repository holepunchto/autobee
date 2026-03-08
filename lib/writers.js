const b4a = require('b4a')
const encoding = require('./encoding.js')
const Triggers = require('./triggers.js')

const BATCH_WRITER_SANITY = 1024
const BATCH_OPTIMISTIC_SANITY = 32

const MAX_FORWARD_TIME_DRIFT = 2 * 3600 * 1000

class ActiveWriters {
  constructor(auto) {
    const local = auto.local

    this.auto = auto
    this.active = new Map()
    this.triggers = new Triggers()
    this.localWriter = new Writer(this, auto.system, local, b4a.toString(local.key, 'hex'))
    this.writable = false
    this.pending = []

    this._bumpBound = this.auto._bump.bind(this.auto)

    this.localWriter.attach()
  }

  *external() {
    for (const w of this.active.values()) {
      if (w !== this.localWriter) yield w
    }
  }

  async wakeup(key, length) {
    const id = b4a.toString(key, 'hex')
    let w = this.active.get(id)

    if (w === this.localWriter) return

    if (!w) {
      const core = this.auto.store.get(key)
      await core.ready()

      w = this.active.get(id)

      if (w) {
        await core.close()
      } else {
        w = new Writer(this, this.auto.system, core, id)
      }
    }

    const len = await w.update()
    if (len >= length) return

    if (w.isRemoved) {
      await w.detachAndClose()
      return
    }

    if (w.isAdded) {
      this.auto._bumpSoon()
      return
    }

    await w.linked()

    const batch = await w.next()
    const applied = await this.auto._optimisticBatch(batch)

    if (applied) {
      w.attach()
      w.notify(batch)
    } else {
      await w.close()
    }
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

    const core = this.auto.store.get(key)
    await core.ready()

    w = new Writer(this, this.auto.system, core, id)
    w.attach()

    return w
  }

  async remove(key) {
    if (b4a.equals(key, this.auto.local.key)) await this.updateLocalState()

    const id = b4a.toString(key, 'hex')
    const w = this.active.get(id)
    if (!w) return

    w.detach(this)
    if (w !== this.localWriter) await w.close()
  }
}

class Writer {
  constructor(writers, system, core, id) {
    this.writers = writers
    this.system = system

    this.core = core
    this.pending = null
    this.id = id
    this.waiting = null
    this.index = 0

    this.isPending = false
    this.isClosed = false
    this.isAttached = false
    this.isIndexer = false
    this.isAdded = false
    this.isRemoved = false
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

  async linked() {
    while (true) {
      const b = await this.next()
      if (b) return true
      await new Promise((resolve) => this.core.once('append', resolve))
    }
  }

  bump() {
    this.waiting = null
    this.addPending()
  }

  attach() {
    if (this.isAttached) return
    this.isAttached = true
    this.writers.active.set(this.id, this)
    if (this !== this.writers.localWriter) {
      this.addPending()
      this.core.on('append', this.writers._bumpBound)
    }
  }

  detach() {
    if (!this.isAttached) return
    this.isAttached = false
    this.writers.active.delete(this.id)
    this.removePending()
    this.core.off('append', this.writers._bumpBound)
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
      this.isAdded = false
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

    while (length < this.core.length) {
      const block = await this.core.get(length++)
      const oplog = encoding.decodeOplog(block)
      const node = createNode(this.core, length, oplog)
      const b = oplog.batch

      if (node.optimistic) {
        optimistic = true
      }

      if (!this.isAdded && !optimistic && !genesis) {
        return null
      }

      // an optimistic writer cannot be genesis
      if (optimistic && genesis) {
        return null
      }

      if (optimistic && !this.isAdded && b.end >= BATCH_OPTIMISTIC_SANITY) {
        return null
      }

      if (node.timestamp - Date.now() > MAX_FORWARD_TIME_DRIFT) {
        return null
      }

      if (!optimistic && b.start === 0 && b.end > 1 && b.end < BATCH_WRITER_SANITY) {
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

    return null
  }

  notify(batch) {
    this.writers.triggers.trigger(this.id, batch[batch.length - 1].length)
  }

  async _isLinked(node) {
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
      return false
    }

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
