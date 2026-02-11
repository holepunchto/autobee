const b4a = require('b4a')
const encoding = require('./encoding.js')

const BATCH_SANITY = 1024
const MAX_FORWARD_TIME_DRIFT = 2 * 3600 * 1000

class ActiveWriters {
  constructor(auto) {
    this.auto = auto
    this.active = new Map()
    this.localWriter = new Writer(this.auto.local)
    this.writable = false

    this.active.set(this.localWriter.id, this.localWriter)

    this._bumpBound = this.auto._bump.bind(this.auto)
  }

  *external() {
    for (const w of this.active.values()) {
      if (w !== this.localWriter) yield w
    }
  }

  getLatestLocalOplog() {
    return this.localWriter.getLatest()
  }

  appendLocal(value, timestamp, batch, links) {
    return this.localWriter.append(value, timestamp, batch, links)
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
    core.on('append', this._bumpBound)
    await core.ready()

    w = new Writer(core)
    this.active.set(id, w)
    return w
  }

  async remove(key) {
    if (b4a.equals(key, this.auto.local.key)) await this.updateLocalState()

    const id = b4a.toString(key, 'hex')
    const w = this.active.get(id)
    if (!w) return

    this.active.delete(id)
    if (w !== this.localWriter) await w.close()
  }
}

class Writer {
  constructor(core) {
    this.core = core
    this.pending = null
    this.id = b4a.toString(core.key, 'hex')
    this.closed = false
  }

  async getLatest() {
    if (this.core.length === 0) return null
    const block = await this.core.get(this.core.length - 1)
    const oplog = encoding.decodeOplog(block)
    return oplog
  }

  async next(system) {
    const info = await system.get(this.core.key)
    const batch = []

    if (!info && !system.isGenesis()) return null

    let length = info ? info.length : 0

    while (length < this.core.length) {
      const block = await this.core.get(length++)
      const oplog = encoding.decodeOplog(block)
      const node = createNode(this.core, length, oplog)

      if (node.timestamp - Date.now() > MAX_FORWARD_TIME_DRIFT) {
        return null
      }

      if (oplog.batch.start === 0 && oplog.batch.end > 1 && oplog.batch.end < BATCH_SANITY) {
        this.core.download({ start: length, end: length + oplog.batch.end })
      }

      for (const link of node.links) {
        if (!(await system.has(link))) return null
      }

      batch.push(node)

      if (node.batch.end === 0) return batch

      // TODO: mark as dead
      if (batch.length >= BATCH_SANITY) return null
    }

    return null
  }

  append(value, timestamp, batch, links) {
    if (this.pending === null) this.pending = []

    const oplog = {
      version: encoding.OPLOG_VERSION,
      timestamp,
      links,
      batch,
      views: null,
      optimistic: false,
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

  async close() {
    this.closed = true
    await this.core.close()
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
    optimistic: false,
    value: oplog.value
  }
}
