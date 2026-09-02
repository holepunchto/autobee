const b4a = require('b4a')
const encoding = require('./encoding.js')
const { DEFAULT_OP_TIMEOUT } = require('./constants.js')

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
  if (!witness || !witness.data) return prev

  const { weight, link } = witness.data
  if (weight <= prev) return prev
  if (!(await verifyClaim(auto, node.key, weight, link))) return prev

  return weight
}

async function verifyClaim(auto, key, weight, link) {
  if (!link || !link.length) return false

  const anchor = await readOplogNode(auto, link.key, link.length)
  const entry = anchor.approvals ? anchor.approvals.find((a) => b4a.equals(a.key, key)) : null
  if (!entry || entry.weight < weight) return false

  return approverQualified(auto, link.key, link.length, anchor, entry.weight)
}

async function approverQualified(auto, key, length, node, weight) {
  if (b4a.equals(key, auto.key)) return auto.bootstrapWeight >= weight

  let witness = node.witness
  if (witness && !witness.data && witness.pointer > 0) {
    const at = length - witness.pointer
    if (at <= 0) return false
    const back = await readOplogNode(auto, key, at)
    witness = back.witness
  }

  if (!witness || !witness.data) return false
  if (witness.data.weight < weight) return false

  return verifyClaim(auto, key, witness.data.weight, witness.data.link)
}

async function readOplogNode(auto, key, length) {
  const core = auto.openCore(key)

  try {
    await core.ready()
    const block = await core.get(length - 1, { timeout: DEFAULT_OP_TIMEOUT })
    return encoding.decodeOplog(block)
  } finally {
    await core.close()
  }
}
