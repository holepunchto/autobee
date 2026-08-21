const b4a = require('b4a')
const encoding = require('./encoding.js')
const { createNode } = require('./writers.js')
const asserts = require('./asserts.js')

const EMPTY_HEAD = { length: 0, key: null }
const INFO_LEGACY_KEY = b4a.concat([b4a.from([0, 0]), b4a.from('info')])

const DEFAULT_OP_TIMEOUT = 5000

exports.sort = sort
exports.rollback = rollback
exports.replay = replay
exports.getMostRecentHead = getMostRecentHead

exports.isLinking = isLinking
exports.isLinkingAll = isLinkingAll
exports.isLegacyNode = isLegacyNode

class Clock {
  constructor() {
    this.map = new Map()
  }

  add(link) {
    const hex = b4a.toString(link.key, 'hex')
    const p = this.map.get(hex)
    if (!p || p < link.length) this.map.set(hex, link.length)
  }

  has(link) {
    const hex = b4a.toString(link.key, 'hex')
    const p = this.map.get(hex)
    return p >= link.length
  }
}

async function getMostRecentHead(auto, system) {
  const ch = system.createChangesStream()
  for await (const data of ch) {
    const refs = getOplogCompat(data)
    if (!refs.length) continue

    const { oplog } = refs[0]
    return { key: oplog.key, length: oplog.length }
  }

  return null
}

async function rollback(auto, system, verified) {
  if (!(await isApplied(system, verified.op))) return null

  const tip = []
  const ch = system.createChangesStream()

  let found = false

  for await (const data of ch) {
    const { ref, info } = getOplog(data)

    if (sameNode(ref.oplog, verified.op)) {
      // stale views.flushes - the verified head describes a prefix this system
      // does not share, so nothing above it is ours to reapply
      if (info.flushes === verified.flushes) found = true
      break
    }

    // walking back, a writer's lengths only decrease - once this writer is
    // behind the verified head the marker cannot be further down
    if (b4a.equals(ref.oplog.key, verified.op.key) && ref.oplog.length < verified.op.length) {
      break
    }

    tip.push(ref)
  }

  if (!found) return null

  const inflated = await inflate(auto, tip.reverse())

  // @todo: verify sort

  return {
    undo: null,
    view: null,
    tip: inflated.map(getBatch)
  }
}

// nodes we cannot resolve are returned as null rather than dropped, so callers
// can tell an incomplete replay from a short one
async function replay(auto) {
  const replay = []

  for await (const entry of oplogIterator(auto.system.bee)) {
    // the walk was cut short, nothing below this point is reachable
    if (entry === null) {
      replay.push(null)
      break
    }

    for (const ref of entry.refs) replay.push(ref)
  }

  // same reasoning as the iterator - never block on what we do not have
  const inflated = await inflate(auto, replay.reverse(), { wait: false })
  return inflated.flatMap((b) => (b === null ? [null] : b.batch))
}

async function isApplied(system, node) {
  const entry = await system.get(encoding.encodeSystemWriterKey(node.key))
  if (entry === null) return false

  const info = encoding.decodeSystemWriter(entry.key, entry.value)
  return info.length >= node.length
}

async function sort(auto, batch) {
  const node = batch[0]
  const ch = auto.system.bee.createChangesStream()
  const reorder = []

  for await (const data of ch) {
    if (isLegacyNode(data)) break

    const { ref, info } = getOplog(data)
    const link = {
      key: ref.oplog.key,
      length: ref.oplog.length,
      // pinned resolved weight from this entry's own flush
      weight: ref.oplog.weight,
      timestamp: ref.oplog.timestamp
    }

    if (!isOrderedBefore(node, link)) break

    reorder.push(ref)
  }

  const inflated = await inflate(auto, reorder.reverse())

  // addSorted mutates inflated in place - capture original occupants first
  const undos = inflated.map((e) => e.undo)

  const { shared } = addSorted(inflated, { undo: null, batch, index: -1 })

  const tip = inflated.slice(shared).map((b) => b.batch)

  // rewind to the original occupant of the first changed position
  const undo = shared < undos.length ? undos[shared] : null

  return {
    undo,
    view: null,
    tip
  }
}

function addSorted(list, entry) {
  const node = entry.batch[0]
  const clock = new Clock()

  clock.add(node)
  for (const link of node.links) {
    clock.add(link)
  }

  // backer MUST precede node
  if (node.witness) clock.add(node.witness.backer)

  const tip = []
  const linked = []

  while (list.length) {
    // reached a stable sorting point
    if (cmp(node, list[list.length - 1].batch[0]) > 0) {
      break
    }

    const b = list.pop()
    const target = b.batch[0]

    // move past this node
    if (!clock.has(target)) {
      tip.push(b)
      continue
    }

    // keep entry identity (index/undo) for the shared-prefix scan below
    linked.push(b)

    // update the clock to catch linked nodes
    for (const link of target.links) {
      clock.add(link)
    }
  }

  while (linked.length) addSorted(list, linked.pop())
  list.push(entry)
  while (tip.length) list.push(tip.pop())

  let shared = 0
  while (shared < list.length) {
    if (list[shared].index === shared) {
      shared++
      continue
    }

    break
  }

  return { shared }
}

function isOrderedBefore(node, oplog) {
  return cmp(node, oplog) < 0
}

function cmp(a, b) {
  const w = a.weight - b.weight
  if (w) return w > 0 ? -1 : 1

  const t = a.timestamp - b.timestamp
  if (t) return t < 0 ? -1 : 1

  const c = b4a.compare(a.key, b.key)
  if (c) return c

  return a.length < b.length ? -1 : 1
}

async function inflate(auto, reorder, opts = null) {
  const readOpts = opts === null ? { timeout: DEFAULT_OP_TIMEOUT } : opts

  const promises = []
  const sessions = new Map()

  for (let i = 0; i < reorder.length; i++) {
    const ref = reorder[i]

    // marker for a node we could not resolve, pass it through
    if (ref === null) {
      promises.push(null)
      continue
    }

    const id = b4a.toString(ref.oplog.key, 'hex')
    // only seeds the node - reapplication re-resolves from the witness
    const weight = ref.oplog.weight

    const local = auto.writers.localWriter
    if (local && local.id === id) {
      promises.push(getLocalBatch(ref.undo, local, ref.oplog.length, weight, i))
      continue
    }

    let core = sessions.get(id)
    if (!core) {
      core = auto.openCore(ref.oplog.key)
      sessions.set(id, core)
    }

    promises.push(getOplogBatch(ref.undo, core, ref.oplog.length, weight, i, readOpts))
  }

  try {
    return await Promise.all(promises)
  } finally {
    for (const core of sessions.values()) await core.close()
  }
}

async function getOplogBatch(undo, core, length, weight, index, opts = null) {
  const seq = length - 1
  const block = await core.get(seq, opts)
  if (block === null) return null
  const oplog = encoding.decodeOplog(block)
  const head = createNode(core, length, weight, oplog)

  const batch = []
  const result = { undo, batch, index }

  const remaining = []
  const start = seq - head.batch.start
  const end = seq + head.batch.end // skip head, we have it

  for (let i = start; i < end; i++) {
    remaining.push(core.get(i, opts))
  }

  if (remaining.length) {
    const blocks = await Promise.all(remaining)
    for (let i = 0; i < blocks.length; i++) {
      // keep the hole so the gap in the batch stays visible
      if (blocks[i] === null) {
        batch.push(null)
        continue
      }

      const oplog = encoding.decodeOplog(blocks[i])
      batch.push(createNode(core, i + start + 1, weight, oplog))
    }
  }

  batch.push(head)
  return result
}

function getLocalBatch(undo, writer, length, weight, index) {
  if (writer.core.closed) throw new Error('Writer core is closed')

  if (length > writer.core.length) {
    if (!writer.pending) {
      throw new Error(
        `No local nodes: looking for ${length}, found ${writer.core.length}@${writer.core.id}`
      )
    }

    let i = 0
    while (i < writer.pending.length) {
      if (writer.pending[i].length === length) break
      i++
    }

    const head = writer.pending[i]
    const headBatch = head.batch || { start: 0, end: 0 }

    const start = i - headBatch.start
    const end = i + headBatch.end + 1 // include head

    const batch = writer.pending.slice(start, end)
    return { undo, batch, index }
  }

  return getOplogBatch(undo, writer.core, length, weight, index)
}

// tolerates legacy nodes instead of asserting
async function* oplogIterator(bee) {
  try {
    for await (const node of bee.createChangesStream({ wait: false })) {
      const legacy = isLegacyNode(node)
      const refs = getOplogCompat(node)
      if (refs.length) yield { node, refs, legacy }
    }
  } catch {
    yield null // signal data not available
  }
}

function getOplog(data) {
  const result = { ref: null, info: null }
  for (const { keys } of data.batch) {
    for (const k of keys) {
      const prefix = k.key[0]

      if (prefix === 0) {
        result.info = encoding.decodeSystemInfo(k.value)
        if (result.ref) return result
      }

      if (prefix === 1) {
        // expect inlined for now
        const value = encoding.decodeSystemWriter(k.key, k.value)
        if (!value.isOplog) continue

        result.ref = { undo: data.tail || EMPTY_HEAD, oplog: value }
        if (result.info) return result
      }
    }
  }

  asserts.bail('Bad system node')
}

// legacy nodes carry no isOplog flag so we cannot tell which writer update is
// the oplog to fetch - yield every candidate until we have a better signal
function getOplogCompat(data) {
  const undo = data.tail || EMPTY_HEAD
  const oplogs = []
  const candidates = []

  for (const { keys } of data.batch) {
    for (const k of keys) {
      if (k.key[0] !== 1) continue

      let value = null
      try {
        value = encoding.decodeSystemWriter(k.key, k.value)
      } catch {
        continue
      }

      // writer was just added, nothing to fetch
      if (!value.length) continue

      if (value.isOplog) oplogs.push({ undo, oplog: value })
      else candidates.push({ undo, oplog: value })
    }
  }

  return oplogs.length ? oplogs : candidates
}

function isLinking(node, link) {
  if (node.length >= link.length && b4a.equals(node.key, link.key)) {
    return true
  }

  for (const l of node.links) {
    if (l.length >= link.length && b4a.equals(l.key, link.key)) {
      return true
    }
  }

  return false
}

function isLinkingAll(node, heads) {
  for (const h of heads) {
    if (!isLinking(node, h)) return false
  }

  return true
}

function isLegacyNode(data) {
  for (const { keys } of data.batch) {
    for (const k of keys) {
      if (b4a.equals(k.key, INFO_LEGACY_KEY)) return true
    }
  }
  return false
}

function sameNode(a, b) {
  return b4a.equals(a.key, b.key) && a.length === b.length
}

function getBatch(b) {
  return b.batch
}
