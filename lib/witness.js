const b4a = require('b4a')
const encoding = require('./encoding.js')

exports.currentWeight = currentWeight
exports.resolveWeight = resolveWeight
exports.verifyClaim = verifyClaim

function currentWeight(rec) {
  if (!rec) return 0
  if (rec.maxWeight > 0 && rec.isGenesis) return rec.maxWeight
  return rec.weight
}

function seedWeight(auto, node) {
  if (node.length === 1 && b4a.equals(node.key, auto.key)) return auto.bootstrapWeight
  return 0
}

async function resolveWeight(auto, node) {
  const rec = await auto.system.get(node.key)
  const prev = rec ? currentWeight(rec) : seedWeight(auto, node)

  const witness = node.witness
  if (!witness) return prev

  const { weight, link } = witness
  if (weight <= prev) return prev
  if (!(await verifyClaim(auto, node.key, weight, link))) return prev

  return weight
}

async function verifyClaim(auto, key, weight, link) {
  if (!link || !link.length) return false

  const anchor = await readOplogNode(auto, link.key, link.length)
  const entry = anchor.approvals ? anchor.approvals.find((a) => b4a.equals(a.key, key)) : null
  if (!entry || entry.weight < weight) return false

  return approverQualified(auto, link.key, entry.weight)
}

// the approval sits in the causal past of any citation of it, so the approver's
// record is lower-bounded by the standing it held when it approved - no need to
// walk its own witness chain back to genesis
async function approverQualified(auto, key, weight) {
  if (b4a.equals(key, auto.key)) return auto.bootstrapWeight >= weight

  const rec = await auto.system.get(key)
  return currentWeight(rec) >= weight
}

async function readOplogNode(auto, key, length) {
  const core = auto.openCore(key)

  try {
    await core.ready()
    const block = await core.get(length - 1)
    return encoding.decodeOplog(block)
  } finally {
    await core.close()
  }
}
