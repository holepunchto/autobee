const b4a = require('b4a')
const encoding = require('./encoding.js')
const { createNode } = require('./writers.js')
const asserts = require('./asserts.js')

const EMPTY_HEAD = { length: 0, key: null }

exports.sort = sort

exports.isLinking = isLinking
exports.isLinkingAll = isLinkingAll

async function sort(auto, batch) {
  const node = batch[0]
  const ch = auto.system.bee.createChangesStream()
  const reorder = []

  for await (const data of ch) {
    const result = getOplog(data)
    if (result === null) continue // system-only update (e.g. writer removal), skip

    const { ref, info } = result
    const link = { key: ref.oplog.key, length: ref.oplog.length }

    if (isLinking(node, link) || node.timestamp > info.timestamp) break
    reorder.push(ref)
  }

  const inflated = await inflate(auto, reorder.reverse())

  for (let i = 0; i < inflated.length; i++) {
    const b = inflated[i]
    const op = b.batch[0] // just use first op, they are all the same writer
    const c = cmp(op, node)

    if (c === -1) continue

    const tip = new Array(inflated.length - i + 1)
    tip[0] = batch
    for (let j = i; j < inflated.length; j++) {
      tip[j - i + 1] = inflated[j].batch
    }

    return {
      undo: b.undo,
      view: null,
      tip
    }
  }

  return {
    undo: null,
    view: null,
    tip: [batch]
  }
}

function cmp(a, b) {
  const c = b4a.compare(a.key, b.key)

  if (c === 0) {
    return a.length - b.length
  }

  const t = a.timestamp - b.timestamp

  if (t === 0) return c
  return t < 0 ? -1 : 1
}

async function inflate(auto, reorder) {
  const promises = []
  const sessions = new Map()

  for (const ref of reorder) {
    const id = b4a.toString(ref.oplog.key, 'hex')

    let core = sessions.get(id)
    if (!core) {
      core = auto.openCore(ref.oplog.key)
      sessions.set(id, core)
    }

    promises.push(getOplogBatch(ref.undo, core, ref.oplog.length))
  }

  try {
    return await Promise.all(promises)
  } finally {
    for (const core of sessions.values()) await core.close()
  }
}

async function getOplogBatch(undo, core, length) {
  const seq = length - 1
  const block = await core.get(seq)
  const oplog = encoding.decodeOplog(block)
  const head = createNode(core, length, oplog)

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
      batch.push(createNode(core, i + start + 1, oplog))
    }
  }

  batch.push(head)
  return result
}

function getOplog(data) {
  const result = { ref: null, info: null }
  for (let i = 0; i < data.batch.length; i++) {
    const keys = data.batch[i].keys

    for (let j = 0; j < keys.length; j++) {
      const k = keys[j]
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

  // system-only update (e.g. writer removal) with no oplog reference — skip
  if (result.info && !result.ref) return null

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
