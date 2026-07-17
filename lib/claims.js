const b4a = require('b4a')
const encoding = require('./encoding.js')
const topo = require('./topo.js')

const MAX_BACKER_PROBES = 8
const MAX_BACKER_SCAN = 64
const BACKER_PROBE_TIMEOUT = 750

exports.PROBE_TIMEOUT = BACKER_PROBE_TIMEOUT

exports.currentWeight = currentWeight
exports.resolveWeight = resolveWeight
exports.verifyClaim = verifyClaim
exports.witnessedWeight = witnessedWeight
exports.findBacker = findBacker
exports.isLiveBacker = isLiveBacker

// advisory: a claim through a dead backer is useless
async function isLiveBacker(auto, ref) {
  const rec = await auto.system.get(ref.key)
  return rec !== null && !rec.isRemoved && rec.length >= ref.length
}

// resolved current weight of a writer
function currentWeight(rec) {
  if (!rec) return 0
  if (rec.maxWeight > 0 && rec.isGenesis) return rec.maxWeight
  return rec.weight
}

// resolve claim weight to sort weight according to current system
async function resolveWeight(auto, node) {
  const rec = await auto.system.get(node.key)
  const prev = currentWeight(rec)

  const claim = node.claim
  if (!claim || claim.weight <= prev) return prev

  // check the weight was applied in our view
  const limit = rec ? rec.maxWeight : 0
  if (limit <= prev) return prev

  // a node never influences its own sort key
  if (b4a.equals(claim.backer.key, node.key)) return prev

  const backer = await auto.system.get(claim.backer.key)
  if (!backer || backer.isRemoved || backer.length < claim.backer.length) {
    return prev
  }

  // floor is previous weight, cap is between system, backer and claim
  return Math.max(prev, Math.min(claim.weight, currentWeight(backer), limit))
}

// pure function of the node, so every peer agrees
async function verifyClaim(auto, node, activeRequests) {
  const claim = node.claim
  if (!claim || !claim.backer || claim.weight === 0) return false
  if (b4a.equals(claim.backer.key, node.key)) return false

  const witnessed = await witnessedWeight(auto, node, claim.backer, { activeRequests })
  return witnessed === claim.weight
}

// open the backer's block, checkout the system it references, read the
// claimant's entry. advisory probes bound with { timeout }
async function witnessedWeight(auto, node, backerRef, opts = null) {
  const core = auto.openCore(backerRef.key)
  let sys = null

  try {
    const block = await core.get(backerRef.length - 1, opts)
    const views = encoding.decodeOplog(block).views

    // views only ride the tail of each local drain flush
    if (!views || !views.system) return 0

    const head = { key: views.system.key, length: views.system.start + views.system.length }
    sys = auto.system.bee.checkout(head)

    const entry = await readCommittedEntry(sys, node.key, opts)
    if (!entry || entry.isRemoved) return 0
    if (!predates(entry, node)) return 0

    return entry.maxWeight
  } catch (err) {
    if (err.code === 'REQUEST_TIMEOUT') return 0
    throw err
  } finally {
    await core.close()
    if (sys) await sys.close()
  }
}

// advisory hunt at append time: walk our own flush history newest to oldest,
// probe candidate committers for a snapshot witnessing our weight. probes run
// in parallel and time out, so an offline append pays at most one timeout
// window and never blocks on unfetchable data
async function findBacker(auto, node, max) {
  const candidates = []
  const seen = new Set()
  const ch = auto.system.bee.createChangesStream()

  let scanned = 0
  for await (const data of ch) {
    if (topo.isLegacyFlush(data)) break

    const ref = topo.flushRef(data)
    if (!ref) continue

    // one probe per writer: their newest flush is the likeliest witness
    const hex = b4a.toString(ref.oplog.key, 'hex')
    if (!b4a.equals(ref.oplog.key, node.key) && ref.oplog.weight > 0 && !seen.has(hex)) {
      seen.add(hex)
      const cand = { key: ref.oplog.key, length: ref.oplog.length, weight: ref.oplog.weight }
      if (await isLiveBacker(auto, cand)) candidates.push(cand)
    }

    // walked past the flush that carried our promotion
    const self = readWriterEntry(data, node.key)
    if (self && self.maxWeight < max) break

    if (candidates.length >= MAX_BACKER_PROBES) break
    if (++scanned >= MAX_BACKER_SCAN) break
  }

  candidates.sort((a, b) => b.weight - a.weight)

  const probes = candidates.map(async (cand) => {
    const backer = { key: cand.key, length: cand.length }
    const weight = await witnessedWeight(auto, node, backer, { timeout: BACKER_PROBE_TIMEOUT })
    return weight > 0 ? { backer, weight } : null
  })

  // prefer the highest witnessed value, ties to the heaviest committer
  let best = null
  for (const result of await Promise.all(probes)) {
    if (result && (best === null || result.weight > best.weight)) best = result
  }

  return best
}

function predates(entry, node) {
  return entry.length < node.length
}

async function readCommittedEntry(bee, key, opts) {
  const data = await bee.get(encoding.encodeSystemWriterKey(key), opts)
  return data ? encoding.decodeSystemWriter(data.key, data.value) : null
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
