const b4a = require('b4a')
const encoding = require('./encoding.js')
const topo = require('./topo.js')

exports.resolveWeight = resolveWeight

async function resolveWeight(auto, node) {
  const rec = await auto.system.get(node.key)

  const prev = rec ? rec.weight : 0
  const claim = node.claim
  if (!claim) return prev

  if (!claim.referrer) {
    if (claim.weight <= prev) return prev
    return (await genesisBacked(auto, node, claim)) ? claim.weight : prev
  }

  const flush = await findFlush(auto, claim.referrer)

  let weight = prev
  if (claim.weight > prev && flush) {
    if (isPromoted(flush, node, claim)) weight = claim.weight
  }

  if (weight === 0) return 0

  // weight is capped by the weight of any backing writer
  let limit = 0
  if (flush && !b4a.equals(claim.referrer.key, node.key)) {
    limit = getWeight(flush, claim.referrer.key)
  }

  if (claim.backer && limit < weight) {
    const backed = await backingWeight(auto, node, claim)
    if (backed > limit) limit = backed
  }

  return Math.min(weight, limit)
}

// local reads only - must never block an offline append
exports.availableWeight = async function availableWeight(auto, node, claim) {
  let limit = 0

  if (claim.referrer && !b4a.equals(claim.referrer.key, node.key)) {
    const flush = await findFlush(auto, claim.referrer)
    if (flush) limit = getWeight(flush, claim.referrer.key)
  }

  if (claim.backer && limit < claim.weight) {
    const data = await findFlush(auto, claim.backer)
    if (data) {
      const entry = readWriterEntry(data, node.key)
      if (entry && !entry.isRemoved && predates(entry, node)) {
        const w = getWeight(data, claim.backer.key)
        if (w > limit) limit = w
      }
    }
  }

  return limit
}

// every valid backer has applied the referrer and so sorts after it,
// so just check head-to-referrer window
exports.findBacker = findBacker

const MAX_BACKER_PROBES = 8
const BACKER_PROBE_TIMEOUT = 750

async function findBacker(auto, node, claim) {
  if (!claim.referrer) return null

  const candidates = []
  const ch = auto.system.bee.createChangesStream()

  for await (const data of ch) {
    if (topo.isLegacyFlush(data)) break

    const ref = topo.flushRef(data)
    if (!ref) continue

    if (
      b4a.equals(ref.oplog.key, claim.referrer.key) &&
      ref.oplog.length <= claim.referrer.length
    ) {
      break
    }

    if (b4a.equals(ref.oplog.key, node.key)) continue
    if (ref.oplog.weight === 0) continue

    candidates.push({ key: ref.oplog.key, length: ref.oplog.length, weight: ref.oplog.weight })
  }

  candidates.sort((a, b) => b.weight - a.weight)

  // advice, not verification: probes time out so an offline append can't
  // block on unfetchable data (resolution never times out - availability may
  // delay its answer, never change it)
  for (const cand of candidates.slice(0, MAX_BACKER_PROBES)) {
    const backer = { key: cand.key, length: cand.length }
    const probe = { ...claim, backer }
    if ((await backingWeight(auto, node, probe, BACKER_PROBE_TIMEOUT)) > 0) return backer
  }

  return null
}

function predates(entry, node) {
  return entry.length < node.length
}

function getWeight(flush, key) {
  const entry = readWriterEntry(flush, key)
  if (!entry) return 0
  if (entry.maxWeight > 0 && !entry.referrer) return entry.maxWeight
  return entry.weight
}

async function genesisBacked(auto, node, claim) {
  const ch = auto.system.bee.createChangesStream()

  let deepest = null
  for await (const data of ch) {
    if (topo.isLegacyFlush(data)) break
    const ref = topo.flushRef(data)
    if (ref && b4a.equals(ref.oplog.key, node.key)) deepest = data
  }

  if (!deepest) return false

  const entry = readWriterEntry(deepest, node.key)
  if (!entry || entry.referrer) return false
  if (!predates(entry, node)) return false

  return entry.maxWeight === claim.weight
}

function isPromoted(flush, node, claim) {
  const entry = readWriterEntry(flush, node.key)
  if (!entry || !entry.referrer) return false
  if (!predates(entry, node)) return false

  return (
    entry.maxWeight === claim.weight &&
    entry.referrer.length === claim.referrer.length &&
    b4a.equals(entry.referrer.key, claim.referrer.key)
  )
}

// compute the backing weight provided by the referrer
async function backingWeight(auto, node, claim, timeout = 0) {
  const backerRef = claim.backer
  if (b4a.equals(backerRef.key, node.key)) return 0

  const data = await findFlush(auto, backerRef)
  if (!data) return 0

  const entry = readWriterEntry(data, node.key)
  if (entry) {
    if (entry.isRemoved || !predates(entry, node)) return 0
    return getWeight(data, backerRef.key)
  }

  if (!(await causallyAfter(auto, node, claim, timeout))) return 0

  return getWeight(data, backerRef.key)
}

async function causallyAfter(auto, node, claim, timeout = 0) {
  if (!claim.referrer) return false

  const opts = timeout ? { timeout } : null
  const core = auto.openCore(claim.backer.key)
  let sys = null

  try {
    const block = await core.get(claim.backer.length - 1, opts)
    const views = encoding.decodeOplog(block).views

    // views only ride the tail of each local drain flush
    if (!views || !views.system) return false

    const head = { key: views.system.key, length: views.system.start + views.system.length }
    sys = auto.system.bee.checkout(head)

    const ref = await readCommittedEntry(sys, claim.referrer.key, opts)
    if (!ref || ref.length < claim.referrer.length) return false

    const self = await readCommittedEntry(sys, node.key, opts)
    if (self && self.length >= node.length) return false

    return true
  } catch (err) {
    if (err.code === 'REQUEST_TIMEOUT') return false
    throw err
  } finally {
    await core.close()
    if (sys) await sys.close()
  }
}

async function readCommittedEntry(bee, key, opts) {
  const data = await bee.get(encodeWriterKey(key), opts)
  return data ? encoding.decodeSystemWriter(data.key, data.value) : null
}

// same layout as lib/system.js's writer keys
function encodeWriterKey(key) {
  const buf = b4a.allocUnsafe(34)
  buf[0] = 1
  buf[1] = 0
  buf.set(key, 2)
  return buf
}

async function findFlush(auto, target) {
  const ch = auto.system.bee.createChangesStream()

  for await (const data of ch) {
    if (topo.isLegacyFlush(data)) return null

    const ref = topo.flushRef(data)
    if (!ref) continue

    if (b4a.equals(ref.oplog.key, target.key)) {
      if (ref.oplog.length === target.length) return data
      if (ref.oplog.length < target.length) return null
    }
  }

  return null
}

function readWriterEntry(data, key) {
  for (const { keys } of data.batch) {
    for (const k of keys) {
      if (k.key[0] !== 1) continue
      if (!b4a.equals(k.key.subarray(2), key)) continue
      return encoding.decodeSystemWriter(k.key, k.value)
    }
  }
  return null
}
