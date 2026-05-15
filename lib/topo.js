const b4a = require('b4a')
const encoding = require('./encoding.js')
const { createNode } = require('./writers.js')
const asserts = require('./asserts.js')

const EMPTY_HEAD = { length: 0, key: null }

exports.sort = sort

exports.isLinking = isLinking
exports.isLinkingAll = isLinkingAll

class Clock {
  constructor() {
    this.map = new Map()
  }

  add(link) {
    const hex = b4a.toString(link.key, 'hex')
    const p = this.map.get(hex)
    if (p < link.length) this.map.set(hex, link.length)
  }

  has(link) {
    const hex = b4a.toString(link.key, 'hex')
    const p = this.map.get(hex)
    return p >= link.length
  }
}

async function sort(auto, batch) {
  const node = batch[0]
  const ch = auto.system.bee.createChangesStream()
  const reorder = []

  for await (const data of ch) {
    const { ref, info } = getOplog(data)
    const link = {
      key: ref.oplog.key,
      length: ref.oplog.length,
      weight: ref.oplog.weight,
      timestamp: info.timestamp
    }

    if (isOrderedBefore(node, link)) break
    reorder.push(ref)
  }

  const inflated = await inflate(auto, reorder.reverse())

  const { undo, shared } = addSorted(inflated, batch)

  const tip = inflated.slice(shared).map((b) => b.batch)

  return {
    undo,
    view: null,
    tip
  }
}

function isOrderedBefore(node, oplog, log) {
  const { version, weight, timestamp } = oplog
  if (version === 0) return false
  if (node.weight < weight) return false
  if (isLinking(node, oplog)) return false
  return node.timestamp <= timestamp
}

function addSorted(list, batch) {
  const node = batch[0]
  const clock = new Clock()
  for (const link of node.links) {
    clock.add(link)
  }

  const tip = []
  const linked = []

  let undo = null
  let shared = list.length

  while (list.length) {
    // reached a stable sorting point
    if (cmp(node, list[list.length - 1].batch[0]) > 0) {
      break
    }

    const b = list.pop()
    const target = b.batch[0]

    if (list.length < shared) {
      undo = b.undo
      shared = list.length
    }

    // move past this node
    if (!clock.has(target)) {
      tip.push(b)
      continue
    }

    // remove node
    linked.push(b)

    // update the clock to catch linked nodes
    for (const link of target.links) {
      clock.add(link)
    }
  }

  while (linked.length) addSorted(list, linked.pop())
  list.push({ undo: null, batch })
  while (tip.length) list.push(tip.pop())

  return { undo, shared }
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

async function inflate(auto, reorder) {
  const promises = []
  const sessions = new Map()

  for (const ref of reorder) {
    const id = b4a.toString(ref.oplog.key, 'hex')

    const local = auto.writers.localWriter
    if (local && local.id === id) {
      promises.push(getLocalBatch(ref.undo, local, ref.oplog.length, ref.oplog.weight))
      continue
    }

    let core = sessions.get(id)
    if (!core) {
      core = auto.openCore(ref.oplog.key)
      sessions.set(id, core)
    }

    promises.push(getOplogBatch(ref.undo, core, ref.oplog.length, ref.oplog.weight))
  }

  try {
    return await Promise.all(promises)
  } finally {
    for (const core of sessions.values()) await core.close()
  }
}

async function getOplogBatch(undo, core, length, weight) {
  const seq = length - 1
  const block = await core.get(seq)
  const oplog = encoding.decodeOplog(block)
  const head = createNode(core, length, weight, oplog)

  const batch = []
  const result = { undo, batch }

  const remaining = []
  const start = seq - head.batch.start
  const end = seq + head.batch.end // skip head, we have it

  for (let i = start; i < end; i++) {
    remaining.push(core.get(i))
  }

  if (remaining.length) {
    const blocks = await Promise.all(remaining)
    for (let i = 0; i < blocks.length; i++) {
      const oplog = encoding.decodeOplog(blocks[i])
      batch.push(createNode(core, i + start + 1, weight, oplog))
    }
  }

  batch.push(head)
  return result
}

function getLocalBatch(undo, writer, length, weight) {
  if (length > writer.core.length) {
    if (!writer.pending) throw new Error('No local nodes')

    let i = 0
    while (i < writer.pending.length) {
      if (writer.pending[i].length === length) break
      i++
    }

    const head = writer.pending[i]

    const start = i - head.batch.start
    const end = i + head.batch.end + 1 // include head

    const batch = writer.pending.slice(start, end)
    return { undo, batch }
  }

  return getOplogBatch(undo, writer.core, length, weight)
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
