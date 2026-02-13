const b4a = require('b4a')
const encoding = require('./encoding.js')

const BATCH_WRITER_SANITY = 1024
const BATCH_OPTIMISTIC_SANITY = 32

const MAX_FORWARD_TIME_DRIFT = 2 * 3600 * 1000

class ActiveWriters {
  constructor(auto) {
    const local = auto.local

    this.auto = auto
    this.active = new Map()
    this.localWriter = new Writer(local, b4a.toString(local.key, 'hex'))
    this.writable = false

    this._bumpBound = this.auto._bump.bind(this.auto)

    this.localWriter.attach(this)
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
        w = new Writer(core, id)
      }
    }

    const len = await w.update(this.auto.system)
    if (len >= length) return

    if (w.isRemoved) {
      await w.detachAndClose(this)
      return
    }

    if (w.isAdded) {
      this.auto._bumpSoon()
      return
    }

    await w.linked(this.auto.system)

    const batch = await w.next(this.auto.system)
    const applied = await this.auto._optimisticBatch(batch)

    if (applied) {
      w.attach(this)
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
    return this.localWriter.flush(this.auto.system, head)
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

    w = new Writer(core, id)
    w.attach(this)

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
  constructor(core, id) {
    this.core = core
    this.pending = null
    this.id = id

    this.isClosed = false
    this.isAttached = false
    this.isIndexer = false
    this.isAdded = false
    this.isRemoved = false
  }

  async linked(system) {
    while (true) {
      const b = await this.next(system)
      if (b) return true
      await new Promise((resolve) => this.core.once('append', resolve))
    }
  }

  attach(writers) {
    if (this.isAttached) return
    this.isAttached = true
    writers.active.set(this.id, this)
    if (this !== writers.localWriter) this.core.on('append', writers._bumpBound)
  }

  detach(writers) {
    if (!this.isAttached) return
    this.isAttached = false
    writers.active.delete(this.id)
    this.core.off('append', writers._bumpBound)
  }

  close() {
    this.isClosed = true
    return this.core.close()
  }

  detachAndClose(writers) {
    this.detach(writers)
    return this.close()
  }

  async getLatest() {
    if (this.core.length === 0) return null
    const block = await this.core.get(this.core.length - 1)
    const oplog = encoding.decodeOplog(block)
    return oplog
  }

  async update(system) {
    const info = await system.get(this.core.key)

    if (!info) {
      this.isAdded = false
    } else {
      this.isAdded = true
      this.isRemoved = info.isRemoved
      this.isIndexer = info.isIndexer
    }

    return info ? info.length : 0
  }

  async next(system) {
    const batch = []
    const genesis = system.isGenesis()

    let length = await this.update(system)
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

      for (const link of node.links) {
        if (!(await system.has(link))) return null
      }

      batch.push(node)
      if (b.end === 0) return batch

      // TODO: mark as dead
      if (batch.length >= BATCH_WRITER_SANITY) return null
    }

    return null
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

  flush(system, view) {
    if (this.pending === null) return Promise.resolve()
    const buffers = []
    const s = system.bee.head()
    const flushes = system.flushes
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
