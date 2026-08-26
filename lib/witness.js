exports.currentWeight = currentWeight
exports.resolveWeight = resolveWeight

function currentWeight(rec) {
  if (!rec) return 0
  if (rec.maxWeight > 0 && rec.isGenesis) return rec.maxWeight
  return rec.weight
}

async function resolveWeight(auto, node) {
  const rec = await auto.system.get(node.key)
  const prev = currentWeight(rec)

  const witness = node.witness
  if (!witness || witness.weight <= prev) return prev

  const granted = await auto.system.grantedWeight(node.key, witness.link)
  if (granted < witness.weight) return prev

  return Math.max(prev, witness.weight)
}
