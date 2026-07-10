const test = require('brittle')
const b4a = require('b4a')
const { create, replicate, sync, encode } = require('./helpers')

// Mined + minimized failure cases for the replay-order/weight-determinism bug family -
// see .repro-scratch/mine.js. Each test is a standalone, already-minimal repro; re-run
// mine.js after a fix attempt to check whether it closes these and/or find fresh ones.

function nodeRef(n) {
  if (!n) return '<missing>'
  return `${b4a.toString(n.key, 'hex').slice(0, 8)}:${n.length}`
}

// Compares auto.replay() pairwise across every given peer. A given causal history has
// exactly one correct system state, so two peers that applied the same nodes must produce
// byte-identical replay() output - this is a stronger, earlier signal than comparing
// system.get() weight. On divergence, also classifies it: if every node in the common
// prefix already agrees on weight, the peers simply chose a different next node (a
// non-deterministic tiebreak); if a node WITHIN the agreed prefix already has a different
// weight recorded by the two peers, that's a determinism bug in system state computation
// itself, since identical history must produce identical weight.
async function checkReplayAgreement(t, pool, label) {
  const replays = []
  for (const { auto, name } of pool) replays.push({ name, nodes: await auto.replay() })

  for (let i = 0; i < replays.length - 1; i++) {
    for (let j = i + 1; j < replays.length; j++) {
      const a = replays[i]
      const b = replays[j]
      const refsA = a.nodes.map(nodeRef)
      const refsB = b.nodes.map(nodeRef)

      let k = 0
      while (k < refsA.length && k < refsB.length && refsA[k] === refsB[k]) k++

      if (k === refsA.length && k === refsB.length) continue

      let mismatchIndex = null
      for (let x = 0; x < k; x++) {
        if (a.nodes[x].weight !== b.nodes[x].weight) { mismatchIndex = x; break }
      }

      const lines = [`${label}: ${a.name} and ${b.name} diverge in replay() order at index ${k}`]
      if (mismatchIndex !== null) {
        lines.push(`  common prefix weight MISMATCH at index ${mismatchIndex}: ${nodeRef(a.nodes[mismatchIndex])} ${a.name}.weight=${a.nodes[mismatchIndex].weight} vs ${b.name}.weight=${b.nodes[mismatchIndex].weight}`)
      } else {
        lines.push(`  ${a.name} next: ${nodeRef(a.nodes[k])} weight=${a.nodes[k] && a.nodes[k].weight} | ${b.name} next: ${nodeRef(b.nodes[k])} weight=${b.nodes[k] && b.nodes[k].weight}`)
      }
      t.fail(lines.join('\n'))
      return
    }
  }

  t.pass(`${label}: all peers agree`)
}

// Mined by .repro-scratch/mine.js (seed 516183319, 6 ops after ddmin).
// Failure class: non-deterministic tiebreak: identical replay prefix + weights up to index 2, but auto1 and auto2 chose a different next node
test('consistency #1: replay order diverges (seed 516183319)', async function (t) {
  const auto1 = await create(t) // idx 0, genesis
  await auto1.append(encode({ msg: 'genesis' }))

  const auto2 = await create(t, auto1.key) // idx 1
  await auto2.append(encode({ addWriter: auto2.local.id, weight: 1 }), { optimistic: true })
  const auto4 = await create(t, auto1.key) // idx 3
  await auto1.append(encode({ addWriter: auto4.local.id, weight: 2 }))
  await auto4.append(encode({ msg: 'm7', from: 3 }), { optimistic: true })
  {
    const done = replicate(auto1, auto2, auto4)
    await Promise.all([auto1, auto2, auto4].map((w) => w.wakeup({ key: auto2.local.key, length: auto2.local.length }).catch(() => {})))
    await sync(auto1, auto2, auto4)
    await done()
  }
  await checkReplayAgreement(t, [{ name: 'auto1', auto: auto1 }, { name: 'auto2', auto: auto2 }, { name: 'auto4', auto: auto4 }], 'sync 1')

})

// Mined by .repro-scratch/mine.js (seed 516183320, 6 ops after ddmin).
// Failure class: non-deterministic tiebreak: identical replay prefix + weights up to index 2, but auto1 and auto4 chose a different next node
test('consistency #2: replay order diverges (seed 516183320)', async function (t) {
  const auto1 = await create(t) // idx 0, genesis
  await auto1.append(encode({ msg: 'genesis' }))

  const auto4 = await create(t, auto1.key) // idx 3
  await auto4.append(encode({ addWriter: auto4.local.id, weight: 2 }), { optimistic: true })
  {
    const done = replicate(auto1, auto4)
    await Promise.all([auto1, auto4].map((w) => w.wakeup({ key: auto4.local.key, length: auto4.local.length }).catch(() => {})))
    await sync(auto1, auto4)
    await done()
  }
  await checkReplayAgreement(t, [{ name: 'auto1', auto: auto1 }, { name: 'auto4', auto: auto4 }], 'sync 1')

  await auto4.append(encode({ addWriter: auto4.local.id, weight: 3 }))
  await auto1.append(encode({ addWriter: auto4.local.id, weight: 1 }))
  {
    const done = replicate(auto1, auto4)
    await sync(auto1, auto4)
    await done()
  }
  await checkReplayAgreement(t, [{ name: 'auto1', auto: auto1 }, { name: 'auto4', auto: auto4 }], 'sync 2')

})

// Mined by .repro-scratch/mine.js (seed 516183321, 6 ops after ddmin).
// Failure class: non-deterministic tiebreak: identical replay prefix + weights up to index 2, but auto1 and auto2 chose a different next node
test('consistency #3: replay order diverges (seed 516183321)', async function (t) {
  const auto1 = await create(t) // idx 0, genesis
  await auto1.append(encode({ msg: 'genesis' }))

  const auto2 = await create(t, auto1.key) // idx 1
  await auto1.append(encode({ addWriter: auto2.local.id, weight: 0 }))
  {
    const done = replicate(auto1, auto2)
    await sync(auto1, auto2)
    await done()
  }
  await checkReplayAgreement(t, [{ name: 'auto1', auto: auto1 }, { name: 'auto2', auto: auto2 }], 'sync 1')

  await auto2.append(encode({ addWriter: auto1.local.id, weight: 0 }))
  await auto1.append(encode({ msg: 'm6', from: 0 }), { optimistic: true })
  {
    const done = replicate(auto1, auto2)
    await sync(auto1, auto2)
    await done()
  }
  await checkReplayAgreement(t, [{ name: 'auto1', auto: auto1 }, { name: 'auto2', auto: auto2 }], 'sync 2')

})

// Mined by .repro-scratch/mine.js (seed 516183322, 6 ops after ddmin).
// Failure class: non-deterministic tiebreak: identical replay prefix + weights up to index 2, but auto1 and auto2 chose a different next node
test('consistency #4: replay order diverges (seed 516183322)', async function (t) {
  const auto1 = await create(t) // idx 0, genesis
  await auto1.append(encode({ msg: 'genesis' }))

  const auto2 = await create(t, auto1.key) // idx 1
  await auto1.append(encode({ addWriter: auto2.local.id, weight: 1 }))
  {
    const done = replicate(auto1, auto2)
    await sync(auto1, auto2)
    await done()
  }
  await checkReplayAgreement(t, [{ name: 'auto1', auto: auto1 }, { name: 'auto2', auto: auto2 }], 'sync 1')

  await auto1.append(encode({ addWriter: auto1.local.id, weight: 2 }))
  await auto2.append(encode({ addWriter: auto1.local.id, weight: 0 }))
  {
    const done = replicate(auto1, auto2)
    await sync(auto1, auto2)
    await done()
  }
  await checkReplayAgreement(t, [{ name: 'auto1', auto: auto1 }, { name: 'auto2', auto: auto2 }], 'sync 2')

})

// Mined by .repro-scratch/mine.js (seed 516183323, 6 ops after ddmin).
// Failure class: non-deterministic tiebreak: identical replay prefix + weights up to index 1, but auto1 and auto4 chose a different next node
test('consistency #5: replay order diverges (seed 516183323)', async function (t) {
  const auto1 = await create(t) // idx 0, genesis
  await auto1.append(encode({ msg: 'genesis' }))

  const auto2 = await create(t, auto1.key) // idx 1
  const auto4 = await create(t, auto1.key) // idx 3
  await auto4.append(encode({ addWriter: auto4.local.id, weight: 1 }), { optimistic: true })
  await auto4.append(encode({ addWriter: auto4.local.id, weight: 1 }), { optimistic: true })
  await auto2.append(encode({ addWriter: auto2.local.id, weight: 1 }), { optimistic: true })
  {
    const done = replicate(auto1, auto2, auto4)
    await Promise.all([auto1, auto2, auto4].map((w) => w.wakeup({ key: auto4.local.key, length: auto4.local.length }).catch(() => {})))
    await Promise.all([auto1, auto2, auto4].map((w) => w.wakeup({ key: auto2.local.key, length: auto2.local.length }).catch(() => {})))
    await sync(auto1, auto2, auto4)
    await done()
  }
  await checkReplayAgreement(t, [{ name: 'auto1', auto: auto1 }, { name: 'auto2', auto: auto2 }, { name: 'auto4', auto: auto4 }], 'sync 1')

})

// Mined by .repro-scratch/mine.js (seed 516183324, 4 ops after ddmin).
// Failure class: non-deterministic tiebreak: identical replay prefix + weights up to index 1, but auto1 and auto6 chose a different next node
test('consistency #6: replay order diverges (seed 516183324)', async function (t) {
  const auto1 = await create(t) // idx 0, genesis
  await auto1.append(encode({ msg: 'genesis' }))

  const auto6 = await create(t, auto1.key) // idx 5
  await auto6.append(encode({ addWriter: auto6.local.id, weight: 2 }), { optimistic: true })
  await auto1.append(encode({ addWriter: auto6.local.id, weight: 3 }))
  {
    const done = replicate(auto1, auto6)
    await Promise.all([auto1, auto6].map((w) => w.wakeup({ key: auto6.local.key, length: auto6.local.length }).catch(() => {})))
    await sync(auto1, auto6)
    await done()
  }
  await checkReplayAgreement(t, [{ name: 'auto1', auto: auto1 }, { name: 'auto6', auto: auto6 }], 'sync 1')

})

// Mined by .repro-scratch/mine.js (seed 516183325, 4 ops after ddmin).
// Failure class: non-deterministic tiebreak: identical replay prefix + weights up to index 1, but auto1 and auto4 chose a different next node
test('consistency #7: replay order diverges (seed 516183325)', async function (t) {
  const auto1 = await create(t) // idx 0, genesis
  await auto1.append(encode({ msg: 'genesis' }))

  const auto4 = await create(t, auto1.key) // idx 3
  await auto1.append(encode({ addWriter: auto4.local.id, weight: 3 }))
  await auto4.append(encode({ msg: 'm12', from: 3 }), { optimistic: true })
  {
    const done = replicate(auto1, auto4)
    await sync(auto1, auto4)
    await done()
  }
  await checkReplayAgreement(t, [{ name: 'auto1', auto: auto1 }, { name: 'auto4', auto: auto4 }], 'sync 1')

})

// Mined by .repro-scratch/mine.js (seed 516183328, 6 ops after ddmin).
// Failure class: non-deterministic tiebreak: identical replay prefix + weights up to index 1, but auto1 and auto5 chose a different next node
test('consistency #8: replay order diverges (seed 516183328)', async function (t) {
  const auto1 = await create(t) // idx 0, genesis
  await auto1.append(encode({ msg: 'genesis' }))

  const auto2 = await create(t, auto1.key) // idx 1
  const auto5 = await create(t, auto1.key) // idx 4
  await auto5.append(encode({ addWriter: auto5.local.id, weight: 3 }), { optimistic: true })
  await auto5.append(encode({ addWriter: auto2.local.id, weight: 2 }))
  await auto2.append(encode({ msg: 'm12', from: 1 }), { optimistic: true })
  {
    const done = replicate(auto1, auto2, auto5)
    await Promise.all([auto1, auto2, auto5].map((w) => w.wakeup({ key: auto5.local.key, length: auto5.local.length }).catch(() => {})))
    await sync(auto1, auto2, auto5)
    await done()
  }
  await checkReplayAgreement(t, [{ name: 'auto1', auto: auto1 }, { name: 'auto2', auto: auto2 }, { name: 'auto5', auto: auto5 }], 'sync 1')

})

// Mined by .repro-scratch/mine.js (seed 516183329, 6 ops after ddmin).
// Failure class: non-deterministic tiebreak: identical replay prefix + weights up to index 2, but auto1 and auto3 chose a different next node
test('consistency #9: replay order diverges (seed 516183329)', async function (t) {
  const auto1 = await create(t) // idx 0, genesis
  await auto1.append(encode({ msg: 'genesis' }))

  const auto3 = await create(t, auto1.key) // idx 2
  await auto3.append(encode({ addWriter: auto3.local.id, weight: 1 }), { optimistic: true })
  await auto3.append(encode({ addWriter: auto1.local.id, weight: 0 }))
  await auto1.append(encode({ addWriter: auto1.local.id, weight: 0 }))
  await auto1.append(encode({ msg: 'm4', from: 0 }), { optimistic: true })
  {
    const done = replicate(auto1, auto3)
    await Promise.all([auto1, auto3].map((w) => w.wakeup({ key: auto3.local.key, length: auto3.local.length }).catch(() => {})))
    await sync(auto1, auto3)
    await done()
  }
  await checkReplayAgreement(t, [{ name: 'auto1', auto: auto1 }, { name: 'auto3', auto: auto3 }], 'sync 1')

})

// Mined by .repro-scratch/mine.js (seed 516183330, 6 ops after ddmin).
// Failure class: non-deterministic tiebreak: identical replay prefix + weights up to index 1, but auto1 and auto3 chose a different next node
test('consistency #10: replay order diverges (seed 516183330)', async function (t) {
  const auto1 = await create(t) // idx 0, genesis
  await auto1.append(encode({ msg: 'genesis' }))

  const auto2 = await create(t, auto1.key) // idx 1
  const auto3 = await create(t, auto1.key) // idx 2
  await auto3.append(encode({ addWriter: auto3.local.id, weight: 3 }), { optimistic: true })
  await auto2.append(encode({ msg: 'm10', from: 1 }), { optimistic: true })
  await auto3.append(encode({ addWriter: auto2.local.id, weight: 3 }))
  {
    const done = replicate(auto1, auto2, auto3)
    await Promise.all([auto1, auto2, auto3].map((w) => w.wakeup({ key: auto3.local.key, length: auto3.local.length }).catch(() => {})))
    await sync(auto1, auto2, auto3)
    await done()
  }
  await checkReplayAgreement(t, [{ name: 'auto1', auto: auto1 }, { name: 'auto2', auto: auto2 }, { name: 'auto3', auto: auto3 }], 'sync 1')

})

// Mined by .repro-scratch/mine-tiebreak.js (seed 4, 17 ops after ddmin) - a fresh miner
// built after the ackedWeight fix, with the same never-downgrade weight-floor tracking
// test/fuzz.js uses, so it only turns up this bug class and not the already-fixed
// self-referential-grant weight determinism bug or the excluded self-downgrade
// oscillation. auto3 is absent because ddmin pruned it as unreferenced - the remaining
// spawns keep their original indices (auto1, auto2, auto4, auto5, auto6).
//
// Failure class: non-deterministic tiebreak - identical replay prefix and every node in
// it has agreed weight on both peers (confirmed via the DETAIL dump in
// .repro-scratch/fuzz-tiebreak.js: the two candidate next-nodes are genuinely tied,
// weight=2 on both sides), but auto1 and auto2 pick a different next node. This is NOT
// the weight-determinism bug ackedWeight fixes - it's a separate divergence in how the
// Clock/reorder-window mechanism (lib/topo.js addSorted) breaks a tie between two
// concurrent, equal-weight nodes. Confirmed non-transient: retrying checkReplayAgreement
// several times with no further actions in between does not resolve it.
test('consistency #11: non-deterministic tiebreak among tied weights (seed 4)', async function (t) {
  const a = await create(t) // idx 0, genesis
  await a.append(encode({ msg: 'genesis' }))

  const b = await create(t, a.key)
  await b.append(encode({ addWriter: b.local.id, weight: 1 }), { optimistic: true })
  {
    const done = replicate(a, b)
    await sync(a, b)
    await done()
  }
  await checkReplayAgreement(t, [{ name: 'a', auto: a }, { name: 'b', auto: b }], 'sync')

  const c = await create(t, a.key)
  await a.append(encode({ addWriter: c.local.id, weight: 3 }))
  {
    const done = replicate(a, b, c)
    await sync(a, b, c)
    await done()
  }
  await checkReplayAgreement(t, [{ name: 'a', auto: a }, { name: 'b', auto: b }, { name: 'c', auto: c }], 'sync')

  const d = await create(t, a.key)
  await c.append(encode({ addWriter: d.local.id, weight: 2 }))
  await b.append(encode({ addWriter: b.local.id, weight: 2 }))
  const e = await create(t, a.key)
  {
    const done = replicate(a, b, c, d, e)
    await sync(a, b, c, d, e)
    await done()
  }
  await checkReplayAgreement(t, [{ name: 'a', auto: a }, { name: 'b', auto: b }, { name: 'c', auto: c }, { name: 'd', auto: d }, { name: 'e', auto: e }], 'sync')

  await c.append(encode({ addWriter: e.local.id, weight: 1 }))
  await b.append(encode({ addWriter: d.local.id, weight: 3 }))
  {
    const done = replicate(a, b, c, d, e)
    await sync(a, b, c, d, e)
    await done()
  }
  await checkReplayAgreement(t, [{ name: 'a', auto: a }, { name: 'b', auto: b }, { name: 'c', auto: c }, { name: 'd', auto: d }, { name: 'e', auto: e }], 'sync')

  await a.append(encode({ addWriter: a.local.id, weight: 3 }))
  await e.append(encode({ addWriter: a.local.id, weight: 3 }))

  {
    const done = replicate(a, b, c, d, e)
    await sync(a, b, c, d, e)
    await done()
  }

  await checkReplayAgreement(t, [{ name: 'a', auto: a }, { name: 'b', auto: b }, { name: 'c', auto: c }, { name: 'd', auto: d }, { name: 'e', auto: e }], 'sync')
})
