const b4a = require('b4a')

exports.currentWeight = currentWeight
exports.resolveWeight = resolveWeight

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
  if (!witness || witness.weight <= prev) return prev

  const granted = await auto.system.grantedWeight(node.key, witness.link)
  if (granted < witness.weight) return prev

  return witness.weight
}
