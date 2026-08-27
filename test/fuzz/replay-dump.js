// Re-run the oracle checks against a frozen failure dump - zero I/O, zero
// timing, instant. This is the regression-test analog of a found failure:
// unlike the live fuzzer, a dump replay is fully deterministic (the node
// sets are frozen data, not live replication), so it's safe to check into
// version control and run in CI once a fix is believed to work.
//
//   node test/fuzz/replay-dump.js test/fuzz/failures/<label>.json

const fs = require('fs')
const { compareToReference, compareReplayPeers } = require('./oracle.js')

const file = process.argv[2]
if (!file) {
  console.error('usage: node test/fuzz/replay-dump.js <dump.json>')
  process.exit(1)
}

const dump = JSON.parse(fs.readFileSync(file, 'utf8'))

console.log(`label: ${dump.label}`)
console.log(`seed: ${dump.seed}  trial: ${dump.trial}`)
console.log(`peers: ${dump.peers.map((p) => `${p.name} (${p.nodes.length} nodes)`).join(', ')}`)
if (dump.storageDir) console.log(`retained storage: ${dump.storageDir}`)
console.log(`original failures recorded: ${dump.failures.length}`)
for (const f of dump.failures) console.log(`  [${f.kind}] ${f.message.split('\n')[0]}`)

// peers whose replay could not be collected when the dump was written
// (crash-path best-effort gather) carry an error instead of nodes - show
// them, but keep them out of the comparisons: an empty node set would only
// produce bogus divergences against every healthy peer
const usable = dump.peers.filter((p) => !p.error)
for (const peer of dump.peers) {
  if (peer.error) {
    console.log(
      `  ${peer.name}: replay was NOT collected at dump time: ${peer.error.split('\n')[0]}`
    )
  }
}

console.log('\nre-checking against reference/order.js...')

let clean = true

for (const peer of usable) {
  const f = compareToReference(peer)
  if (f) {
    clean = false
    console.log(`\n[${f.kind}]\n${f.message}`)
  } else {
    console.log(`  ${peer.name}: matches reference order`)
  }
}

for (let i = 0; i < usable.length - 1; i++) {
  for (let j = i + 1; j < usable.length; j++) {
    const f = compareReplayPeers(usable[i], usable[j])
    if (f) {
      clean = false
      console.log(`\n[${f.kind}]\n${f.message}`)
    } else {
      console.log(`  ${usable[i].name} <-> ${usable[j].name}: agree`)
    }
  }
}

if (clean) {
  console.log(
    '\nno divergence reproduces from this dump (fix may be working, or the bug was elsewhere)'
  )
  process.exit(0)
} else {
  console.log('\nDIVERGENCE REPRODUCES')
  process.exit(1)
}
