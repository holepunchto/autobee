const { LEGACY_OPLOG_VERSION } = require('./constants.js')

class Node {
  constructor(core, length, oplog, weight) {
    this.core = core
    this.from = core // compat
    this.key = core.key
    this.length = length
    this.weight = weight
    this.version = oplog.version
    this.timestamp = oplog.timestamp
    this.links = oplog.links
    this.batch = oplog.batch
    this.views = oplog.views
    this.trusted = oplog.trusted || []
    this.witness = oplog.witness || null
    this.approvals = oplog.approvals || null
    this.optimistic = oplog.optimistic
    this.value = oplog.value
    this.hash = oplog.hash || null
    this.weightHint = oplog.weightHint || 0
    this.drift = oplog.drift || 0
  }
}

// legacy oplogs did not record their position in the batch, replay batches
// keep unreachable blocks as null holes (topo.getOplogBatch)
function finalizeNodeBatch(batch) {
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

exports.Node = Node
exports.finalizeNodeBatch = finalizeNodeBatch
