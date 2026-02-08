const b4a = require('b4a')
const encoding = require('./encoding.js')

const VERSION = 4 // check with auto
const BATCH_SANITY = 1024

class Writer {
  constructor(core) {
    this.core = core
    this.pending = []
    this.id = b4a.toString(core.key, 'hex')
  }

  async next(system, bootstrapping) {
    const info = await system.get(this.core.key)
    const batch = []

    if (!info && !bootstrapping) return null

    let length = info ? info.length : 0

    while (length < this.core.length) {
      const block = await this.core.get(length++)
      const oplog = encoding.decodeOplog(block)
      const node = createNode(this.core, length, oplog)

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
    const oplog = {
      version: VERSION,
      timestamp,
      batch,
      links,
      optimistic: false,
      value
    }

    const node = createNode(this.core, this.core.length + this.pending.length + 1, oplog)

    this.pending.push(node)

    return node
  }

  flush() {
    const buffers = []
    for (const node of this.pending) buffers.push(encoding.encodeOplog(node))
    this.pending = []
    return this.core.append(buffers)
  }
}

exports.Writer = Writer
exports.createNode = createNode

function createNode(core, length, oplog) {
  return {
    core,
    key: core.key,
    length,
    version: oplog.version,
    timestamp: oplog.timestamp,
    batch: oplog.batch,
    links: oplog.links,
    value: oplog.value
  }
}
