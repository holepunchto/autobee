// Diff a dumped divergence (FUZZ_DUMP=<file> on a drifted fuzz run) against
// the reference order. For each peer: adapt its replay to the reference node
// shape (using that peer's own pinned weights), compute order(), and report
// where the peer's actual replay departs from the canonical order. Also
// cross-checks the two peers' node sets and pinned weights.
//
//   FUZZ_DUMP=/tmp/div.json FUZZ_MAX_DRIFT_MS=1800000 FUZZ_SEED=4 node test/fuzz.js
//   node reference/diff.js /tmp/div.json

const fs = require('fs')
const { order, explain, idOf } = require('./order.js')

const file = process.argv[2]
if (!file) {
  console.error('usage: node reference/diff.js <dump.json>')
  process.exit(1)
}

const dump = JSON.parse(fs.readFileSync(file, 'utf8'))

const A = adapt(dump.a)
const B = adapt(dump.b)

console.log(`peer A: ${dump.a.name} (${A.nodes.length} nodes)`)
console.log(`peer B: ${dump.b.name} (${B.nodes.length} nodes)`)

// ---- node set + pinned weight agreement --------------------------------

const idsA = new Set(A.nodes.map(idOf))
const idsB = new Set(B.nodes.map(idOf))
const onlyA = [...idsA].filter((id) => !idsB.has(id))
const onlyB = [...idsB].filter((id) => !idsA.has(id))
if (onlyA.length || onlyB.length) {
  console.log('\nNODE SETS DIFFER:')
  if (onlyA.length) console.log('  only in A:', onlyA.join(' '))
  if (onlyB.length) console.log('  only in B:', onlyB.join(' '))
} else {
  console.log('node sets identical')
}

// system record comparison (grant/bit asymmetries live here)
if (dump.a.records && dump.b.records) {
  const keys = new Set([...Object.keys(dump.a.records), ...Object.keys(dump.b.records)])
  let recDiffs = 0
  for (const k of keys) {
    const ra = JSON.stringify(dump.a.records[k])
    const rb = JSON.stringify(dump.b.records[k])
    if (ra !== rb) {
      recDiffs++
      console.log(`RECORD DIFFERS for ${k}:`)
      console.log(`  A: ${ra}`)
      console.log(`  B: ${rb}`)
    }
  }
  if (!recDiffs) console.log('system records identical')
}

const wA = new Map(A.nodes.map((n) => [idOf(n), n.weight]))
let weightDiffs = 0
for (const n of B.nodes) {
  const id = idOf(n)
  if (wA.has(id) && wA.get(id) !== n.weight) {
    if (++weightDiffs <= 10) {
      console.log(
        `  pinned weight differs: ${short(id)} A=${wA.get(id)} B=${n.weight} (ts=${n.ts})`
      )
    }
  }
}
console.log(
  weightDiffs ? `pinned weights differ on ${weightDiffs} nodes` : 'pinned weights identical'
)

// ---- per-peer diff vs reference ----------------------------------------

for (const peer of [A, B]) {
  console.log(`\n==== ${peer.name}: replay vs reference (own pinned weights) ====`)
  let ref
  try {
    ref = order(peer.nodes)
  } catch (err) {
    console.log('  reference order failed:', err.message)
    continue
  }

  const actual = peer.nodes.map(idOf) // replay order preserved by adapt
  const canonical = ref.map(idOf)

  let k = 0
  while (k < actual.length && actual[k] === canonical[k]) k++

  if (k === actual.length) {
    console.log('  replay MATCHES reference exactly')
    continue
  }

  console.log(`  diverges from reference at index ${k}/${actual.length}`)
  console.log(`    actual   : ${window(actual, peer.byId, k)}`)
  console.log(`    reference: ${window(canonical, peer.byId, k)}`)

  const mis = peer.byId.get(canonical[k])
  console.log(`  reference wants here: ${describe(mis)}`)
  const got = peer.byId.get(actual[k])
  console.log(`  replay has here     : ${describe(got)}`)

  // where did the replay put the node the reference wanted?
  const misAt = actual.indexOf(canonical[k])
  console.log(`  reference's pick sits at replay index ${misAt}`)

  // segment context from the reference tree
  const tree = explain(peer.nodes)
  console.log('  reference segments (top level):')
  printSegments(tree, peer.byId, '    ', 2)
}

// ---- helpers ------------------------------------------------------------

function adapt(dumped) {
  const nodes = dumped.nodes.map((n) => ({
    key: n.key,
    length: n.length,
    links: n.links,
    witness: n.witness ? { link: n.witness.link } : null,
    ts: n.ts,
    weight: n.weight
  }))
  const byId = new Map(nodes.map((n) => [idOf(n), n]))
  return { name: dumped.name, nodes, byId }
}

function short(id) {
  const [key, length] = id.split(':')
  return key.slice(0, 8) + ':' + length
}

function describe(n) {
  if (!n) return '<none>'
  const links = n.links.map((l) => short(idOf(l))).join(',') || '-'
  const wit = n.witness ? ` witness(grant=${short(idOf(n.witness.link))})` : ''
  return `${short(idOf(n))} w=${n.weight} ts=${n.ts} links=[${links}]${wit}`
}

function window(ids, byId, k) {
  const from = Math.max(0, k - 2)
  const to = Math.min(ids.length, k + 3)
  return ids
    .slice(from, to)
    .map((id, i) => {
      const n = byId.get(id)
      const mark = from + i === k ? '>' : ' '
      return `${mark}${short(id)}(w${n.weight},t${n.ts % 100000})`
    })
    .join(' ')
}

function printSegments(tree, byId, indent, depth) {
  if (!tree || depth < 0) return
  console.log(`${indent}stratum w${tree.weight}:`)
  for (const e of tree.entries) {
    const c = e.closure ? flattenCount(e.closure) : 0
    console.log(`${indent}  ${describe(e.node)}  closure=${c} nodes`)
    if (e.closure && depth > 0) printSegments(e.closure, byId, indent + '    ', depth - 1)
  }
  if (tree.tail) {
    console.log(`${indent}  tail:`)
    printSegments(tree.tail, byId, indent + '    ', depth - 1)
  }
}

function flattenCount(tree) {
  if (!tree) return 0
  let n = tree.entries.length
  for (const e of tree.entries) n += flattenCount(e.closure)
  n += flattenCount(tree.tail)
  return n
}
