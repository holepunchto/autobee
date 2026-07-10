const test = require('brittle')
const b4a = require('b4a')
const { create, replicate, sync, encode } = require('./helpers')

// Regression tests and mined minimal repros, all originally found via test/fuzz.js's
// random action sequences - see .repro-scratch/ (untracked) for the seed search,
// delta-debugging, and mining tooling that produced them. Each test is a standalone,
// already-minimal (or, for the raw captures, deliberately unminimized) repro; re-run the
// mining tooling after a fix attempt to check whether it closes these and/or finds fresh
// ones.

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
//
// Each pool entry may be a bare auto (uses auto.name) or { name, auto } - the latter lets
// callers use aliases that mirror a mined trace's original spawn indices.
async function checkReplayAgreement(t, pool, label) {
  const replays = []
  for (const entry of pool) {
    const auto = entry.auto || entry
    const name = entry.name || auto.name
    replays.push({ name, nodes: await auto.replay() })
  }

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
        if (a.nodes[x].weight !== b.nodes[x].weight) {
          mismatchIndex = x
          break
        }
      }

      const lines = [`${label}: ${a.name} and ${b.name} diverge in replay() order at index ${k}`]
      if (mismatchIndex !== null) {
        lines.push(
          `  common prefix weight MISMATCH at index ${mismatchIndex}: ${nodeRef(a.nodes[mismatchIndex])} ${a.name}.weight=${a.nodes[mismatchIndex].weight} vs ${b.name}.weight=${b.nodes[mismatchIndex].weight}`
        )
      } else {
        lines.push(
          `  ${a.name} next: ${nodeRef(a.nodes[k])} weight=${a.nodes[k] && a.nodes[k].weight} | ${b.name} next: ${nodeRef(b.nodes[k])} weight=${b.nodes[k] && b.nodes[k].weight}`
        )
      }
      t.fail(lines.join('\n'))
      return
    }
  }

  t.pass(`${label}: all peers agree`)
}

// Minimized from test/fuzz.js's random "concurrent writer weights" scenario via seed
// search + delta-debugging. Two writers concurrently grant a third writer conflicting
// weights, each unaware of the other's grant.
test('regression - concurrent conflicting writer grants disagree on final weight', async function (t) {
  const auto1 = await create(t) // genesis, weight 2
  const auto2 = await create(t, auto1.key)

  // auto1 grants auto2 writer status (weight 1)...
  await auto1.append(encode({ addWriter: auto2.local.id, weight: 1 }))
  // ...but auto2 doesn't know that yet, and optimistically grants ITSELF a higher weight
  await auto2.append(encode({ addWriter: auto2.local.id, weight: 3 }), { optimistic: true })
  // concurrently, auto1 also re-stamps its own weight (unrelated governance op, still in
  // flight when auto2's optimistic batch above was created)
  await auto1.append(encode({ addWriter: auto1.local.id, weight: 1 }))

  {
    const done = replicate(auto1, auto2)
    await auto1.wakeup({ key: auto2.local.key, length: auto2.local.length })
    await sync(auto1, auto2)
    await done()
  }

  await auto1.append(encode({ msg: 'hello' }))

  const auto3 = await create(t, auto1.key)

  // auto2 and auto1 CONCURRENTLY grant auto3 conflicting weights, each unaware of the
  // other's grant
  await auto2.append(encode({ addWriter: auto3.local.id, weight: 3 }))
  await auto1.append(encode({ addWriter: auto3.local.id, weight: 2 }))

  {
    const done = replicate(auto1, auto2, auto3)
    await sync(auto1, auto2, auto3)
    await done()
  }

  await checkReplayAgreement(t, [auto1, auto2, auto3], 'final sync')
})

// Minimized from a fresh test/fuzz.js failure (seed 19, found + delta-debugged after the
// isOrderedBefore/grant-ref fixes were in place) - already minimal, ddmin can't drop any
// of these 6 ops including the auto3 spawn, even though auto3 never touches the disputed
// writer directly.
//
// Shape: auto2 optimistically self-grants (weight 1) before it knows auto1 has
// concurrently granted it a different weight (3) too - so the SAME writer (auto2) is the
// target of two concurrent grants, one of which it issued about itself.
test('regression - optimistic self-grant racing a concurrent grant disagrees on weight', async function (t) {
  const auto1 = await create(t) // genesis, weight 2
  // this bootstrap append (genesis becoming length 1 before anything else happens) is
  // part of the recorded trace this was minimized from - dropping it closes the
  // wall-clock gap the race depends on and it stops reproducing
  await auto1.append(encode({ msg: 'genesis' }))

  const auto2 = await create(t, auto1.key)

  // order matters here too: this append has to land after auto2 exists
  await auto1.append(encode({ msg: 'm1' }))

  // auto2 optimistically grants itself weight=1...
  await auto2.append(encode({ addWriter: auto2.local.id, weight: 1 }), { optimistic: true })
  // ...concurrently, auto1 grants auto2 weight=3, unaware of auto2's self-grant
  await auto1.append(encode({ addWriter: auto2.local.id, weight: 3 }))

  const auto3 = await create(t, auto1.key)

  const done = replicate(auto1, auto2, auto3)
  await auto1.wakeup({ key: auto2.local.key, length: auto2.local.length })
  await sync(auto1, auto2, auto3)
  await done()

  await checkReplayAgreement(t, [auto1, auto2, auto3], 'final sync')
})

// Raw, unminimized capture straight off test/fuzz.js's random action sequence (seed 1,
// fails at its step 29). Transcribed from the pool/index-based replay into named writers
// - auto1 is spawn-index 0 (genesis), auto2 is index 1, and so on - keeping every op's
// exact semantics (which appends are optimistic, which sync rounds include which peers)
// unchanged. Checked after every op instead of only at the end, to catch a transcription
// mistake immediately and pin down exactly where the real disagreement first appears.
test('regression - raw fuzz capture (seed 1, step 29): writer weight disagreement', async function (t) {
  const auto1 = await create(t) // idx 0, genesis
  await auto1.append(encode({ msg: 'genesis' }))

  // op 1: addWriter granter=0 target=0 weight=3
  await auto1.append(encode({ addWriter: auto1.local.id, weight: 3 }))

  // op 2: append from=0 seq=1
  await auto1.append(encode({ msg: 'm1', from: 0 }), { optimistic: true })

  // op 3: addWriter granter=0 target=0 weight=1
  await auto1.append(encode({ addWriter: auto1.local.id, weight: 1 }))

  // op 4: spawn idx=1
  const auto2 = await create(t, auto1.key)

  // op 5: append from=0 seq=2
  await auto1.append(encode({ msg: 'm2', from: 0 }), { optimistic: true })

  // op 6: append from=0 seq=3
  await auto1.append(encode({ msg: 'm3', from: 0 }), { optimistic: true })

  // op 7: spawn idx=2
  const auto3 = await create(t, auto1.key)

  // op 8: append from=0 seq=4
  await auto1.append(encode({ msg: 'm4', from: 0 }), { optimistic: true })

  // op 9: sync (pool so far: auto1, auto2, auto3) - no pending optimistic wakeups yet
  {
    const done = replicate(auto1, auto2, auto3)
    await sync(auto1, auto2, auto3)
    await done()
  }
  await checkReplayAgreement(t, [auto1, auto2, auto3], 'op9 (sync)')

  // op 10: append from=0 seq=5
  await auto1.append(encode({ msg: 'm5', from: 0 }), { optimistic: true })

  // op 11: spawn idx=3
  const auto4 = await create(t, auto1.key)

  // op 12: append from=0 seq=6
  await auto1.append(encode({ msg: 'm6', from: 0 }), { optimistic: true })

  // op 13: optimisticSelfAdd idx=1 weight=1
  await auto2.append(encode({ addWriter: auto2.local.id, weight: 1 }), { optimistic: true })

  // op 14: addWriter granter=1 target=1 weight=0
  await auto2.append(encode({ addWriter: auto2.local.id, weight: 0 }))

  // op 15: sync (pool so far: auto1..auto4) - auto2 has a pending optimistic batch (from
  // op13/14), so nudge the writable peers to pull it in, same pattern as optimistic-race.js
  {
    const done = replicate(auto1, auto2, auto3, auto4)
    const writable = [auto1, auto2, auto3, auto4].filter((a) => a.writable)
    await Promise.all(
      writable.map((w) =>
        w.wakeup({ key: auto2.local.key, length: auto2.local.length }).catch(() => {})
      )
    )
    await sync(auto1, auto2, auto3, auto4)
    await done()
  }
  await checkReplayAgreement(t, [auto1, auto2, auto3, auto4], 'op15 (sync)')

  // op 16: addWriter granter=1 target=0 weight=3
  await auto2.append(encode({ addWriter: auto1.local.id, weight: 3 }))

  // op 17: append from=1 seq=7
  await auto2.append(encode({ msg: 'm7', from: 1 }), { optimistic: true })

  // op 18: append from=0 seq=8
  await auto1.append(encode({ msg: 'm8', from: 0 }), { optimistic: true })

  // op 19: append from=0 seq=9
  await auto1.append(encode({ msg: 'm9', from: 0 }), { optimistic: true })

  // op 20: append from=1 seq=10
  await auto2.append(encode({ msg: 'm10', from: 1 }), { optimistic: true })

  // op 21: sync (pool: auto1..auto4) - no new pending optimistic batches since last sync
  {
    const done = replicate(auto1, auto2, auto3, auto4)
    await sync(auto1, auto2, auto3, auto4)
    await done()
  }
  await checkReplayAgreement(t, [auto1, auto2, auto3, auto4], 'op21 (sync)')

  // op 22: addWriter granter=0 target=2 weight=0
  await auto1.append(encode({ addWriter: auto3.local.id, weight: 0 }))

  // op 23: addWriter granter=0 target=2 weight=3
  await auto1.append(encode({ addWriter: auto3.local.id, weight: 3 }))

  // op 24: addWriter granter=0 target=1 weight=2
  await auto1.append(encode({ addWriter: auto2.local.id, weight: 2 }))

  // op 25: addWriter granter=1 target=3 weight=3
  await auto2.append(encode({ addWriter: auto4.local.id, weight: 3 }))

  // op 26: addWriter granter=0 target=3 weight=3
  await auto1.append(encode({ addWriter: auto4.local.id, weight: 3 }))

  // op 27: spawn idx=4
  const auto5 = await create(t, auto1.key)

  // op 28: sync (pool: auto1..auto5)
  {
    const done = replicate(auto1, auto2, auto3, auto4, auto5)
    await sync(auto1, auto2, auto3, auto4, auto5)
    await done()
  }
  await checkReplayAgreement(t, [auto1, auto2, auto3, auto4, auto5], 'op28 (sync)')

  // op 29: spawn idx=5
  const auto6 = await create(t, auto1.key)

  // op 30: optimisticSelfAdd idx=4 weight=3
  await auto5.append(encode({ addWriter: auto5.local.id, weight: 3 }), { optimistic: true })

  // op 31: addWriter granter=4 target=5 weight=0
  await auto5.append(encode({ addWriter: auto6.local.id, weight: 0 }))

  // op 32: addWriter granter=0 target=5 weight=3
  await auto1.append(encode({ addWriter: auto6.local.id, weight: 3 }))

  // op 33: append from=1 seq=11
  await auto2.append(encode({ msg: 'm11', from: 1 }), { optimistic: true })

  // op 34: sync (pool: auto1..auto6) - this is where test/fuzz.js's fuzzer caught the
  // disagreement
  {
    const done = replicate(auto1, auto2, auto3, auto4, auto5, auto6)
    await sync(auto1, auto2, auto3, auto4, auto5, auto6)
    await done()
  }

  await checkReplayAgreement(t, [auto1, auto2, auto3, auto4, auto5, auto6], 'op34 (sync, final)')
})

// Raw, unminimized capture straight off test/fuzz.js's random action sequence (seed 1,
// fails at its step 29) - a further-reduced transcription of the same original failure as
// the previous test, kept alongside it since it isolates the same disagreement with far
// fewer ops.
test('regression - raw fuzz capture (seed 1, step 29, minimal): writer weight disagreement', async function (t) {
  const auto1 = await create(t) // idx 0, genesis
  await auto1.append(encode({ msg: 'genesis' }))

  const auto2 = await create(t, auto1.key)

  {
    const done = replicate(auto1, auto2)
    await sync(auto1, auto2)
    await done()
  }

  await auto2.append(encode({ addWriter: auto2.local.id, weight: 3 }), { optimistic: true })

  await auto2.append(encode({ msg: 'm5', from: 0 }))
  await auto1.append(encode({ msg: 'm6', from: 0 }))

  // disagreement (checkReplayAgreement failed right after this sync)
  {
    const done = replicate(auto1, auto2)
    await sync(auto1, auto2)
    await done()
  }

  await checkReplayAgreement(t, [auto1, auto2], 'final sync')
})

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
    await Promise.all(
      [auto1, auto2, auto4].map((w) =>
        w.wakeup({ key: auto2.local.key, length: auto2.local.length }).catch(() => {})
      )
    )
    await sync(auto1, auto2, auto4)
    await done()
  }
  await checkReplayAgreement(
    t,
    [
      { name: 'auto1', auto: auto1 },
      { name: 'auto2', auto: auto2 },
      { name: 'auto4', auto: auto4 }
    ],
    'sync 1'
  )
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
    await Promise.all(
      [auto1, auto4].map((w) =>
        w.wakeup({ key: auto4.local.key, length: auto4.local.length }).catch(() => {})
      )
    )
    await sync(auto1, auto4)
    await done()
  }
  await checkReplayAgreement(
    t,
    [
      { name: 'auto1', auto: auto1 },
      { name: 'auto4', auto: auto4 }
    ],
    'sync 1'
  )

  await auto4.append(encode({ addWriter: auto4.local.id, weight: 3 }))
  await auto1.append(encode({ addWriter: auto4.local.id, weight: 1 }))
  {
    const done = replicate(auto1, auto4)
    await sync(auto1, auto4)
    await done()
  }
  await checkReplayAgreement(
    t,
    [
      { name: 'auto1', auto: auto1 },
      { name: 'auto4', auto: auto4 }
    ],
    'sync 2'
  )
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
  await checkReplayAgreement(
    t,
    [
      { name: 'auto1', auto: auto1 },
      { name: 'auto2', auto: auto2 }
    ],
    'sync 1'
  )

  await auto2.append(encode({ addWriter: auto1.local.id, weight: 0 }))
  await auto1.append(encode({ msg: 'm6', from: 0 }), { optimistic: true })
  {
    const done = replicate(auto1, auto2)
    await sync(auto1, auto2)
    await done()
  }
  await checkReplayAgreement(
    t,
    [
      { name: 'auto1', auto: auto1 },
      { name: 'auto2', auto: auto2 }
    ],
    'sync 2'
  )
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
  await checkReplayAgreement(
    t,
    [
      { name: 'auto1', auto: auto1 },
      { name: 'auto2', auto: auto2 }
    ],
    'sync 1'
  )

  await auto1.append(encode({ addWriter: auto1.local.id, weight: 2 }))
  await auto2.append(encode({ addWriter: auto1.local.id, weight: 0 }))
  {
    const done = replicate(auto1, auto2)
    await sync(auto1, auto2)
    await done()
  }
  await checkReplayAgreement(
    t,
    [
      { name: 'auto1', auto: auto1 },
      { name: 'auto2', auto: auto2 }
    ],
    'sync 2'
  )
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
    await Promise.all(
      [auto1, auto2, auto4].map((w) =>
        w.wakeup({ key: auto4.local.key, length: auto4.local.length }).catch(() => {})
      )
    )
    await Promise.all(
      [auto1, auto2, auto4].map((w) =>
        w.wakeup({ key: auto2.local.key, length: auto2.local.length }).catch(() => {})
      )
    )
    await sync(auto1, auto2, auto4)
    await done()
  }
  await checkReplayAgreement(
    t,
    [
      { name: 'auto1', auto: auto1 },
      { name: 'auto2', auto: auto2 },
      { name: 'auto4', auto: auto4 }
    ],
    'sync 1'
  )
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
    await Promise.all(
      [auto1, auto6].map((w) =>
        w.wakeup({ key: auto6.local.key, length: auto6.local.length }).catch(() => {})
      )
    )
    await sync(auto1, auto6)
    await done()
  }
  await checkReplayAgreement(
    t,
    [
      { name: 'auto1', auto: auto1 },
      { name: 'auto6', auto: auto6 }
    ],
    'sync 1'
  )
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
  await checkReplayAgreement(
    t,
    [
      { name: 'auto1', auto: auto1 },
      { name: 'auto4', auto: auto4 }
    ],
    'sync 1'
  )
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
    await Promise.all(
      [auto1, auto2, auto5].map((w) =>
        w.wakeup({ key: auto5.local.key, length: auto5.local.length }).catch(() => {})
      )
    )
    await sync(auto1, auto2, auto5)
    await done()
  }
  await checkReplayAgreement(
    t,
    [
      { name: 'auto1', auto: auto1 },
      { name: 'auto2', auto: auto2 },
      { name: 'auto5', auto: auto5 }
    ],
    'sync 1'
  )
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
    await Promise.all(
      [auto1, auto3].map((w) =>
        w.wakeup({ key: auto3.local.key, length: auto3.local.length }).catch(() => {})
      )
    )
    await sync(auto1, auto3)
    await done()
  }
  await checkReplayAgreement(
    t,
    [
      { name: 'auto1', auto: auto1 },
      { name: 'auto3', auto: auto3 }
    ],
    'sync 1'
  )
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
    await Promise.all(
      [auto1, auto2, auto3].map((w) =>
        w.wakeup({ key: auto3.local.key, length: auto3.local.length }).catch(() => {})
      )
    )
    await sync(auto1, auto2, auto3)
    await done()
  }
  await checkReplayAgreement(
    t,
    [
      { name: 'auto1', auto: auto1 },
      { name: 'auto2', auto: auto2 },
      { name: 'auto3', auto: auto3 }
    ],
    'sync 1'
  )
})

// Mined by .repro-scratch/mine-tiebreak.js (seed 4, 17 ops after ddmin) - a fresh miner
// built after the ackedWeight fix, with the same never-downgrade weight-floor tracking
// test/fuzz.js uses, so it only turns up this bug class and not the already-fixed
// self-referential-grant weight determinism bug or the excluded self-downgrade
// oscillation. auto3 is absent because ddmin pruned it as unreferenced - the remaining
// spawns keep their original indices (auto1, auto2, auto4, auto5, auto6).
//
// Failure class: non-deterministic tiebreak - identical replay prefix and every node in
// it has agreed weight on both peers, but auto1 and auto2 pick a different next node.
// This is a divergence in how the Clock/reorder-window mechanism (lib/topo.js
// addSorted) breaks a tie between two concurrent, equal-weight nodes.
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
  await checkReplayAgreement(
    t,
    [
      { name: 'a', auto: a },
      { name: 'b', auto: b }
    ],
    'sync'
  )

  const c = await create(t, a.key)
  await a.append(encode({ addWriter: c.local.id, weight: 3 }))
  {
    const done = replicate(a, b, c)
    await sync(a, b, c)
    await done()
  }
  await checkReplayAgreement(
    t,
    [
      { name: 'a', auto: a },
      { name: 'b', auto: b },
      { name: 'c', auto: c }
    ],
    'sync'
  )

  const d = await create(t, a.key)
  await c.append(encode({ addWriter: d.local.id, weight: 2 }))
  await b.append(encode({ addWriter: b.local.id, weight: 2 }))
  const e = await create(t, a.key)
  {
    const done = replicate(a, b, c, d, e)
    await sync(a, b, c, d, e)
    await done()
  }
  await checkReplayAgreement(
    t,
    [
      { name: 'a', auto: a },
      { name: 'b', auto: b },
      { name: 'c', auto: c },
      { name: 'd', auto: d },
      { name: 'e', auto: e }
    ],
    'sync'
  )

  await c.append(encode({ addWriter: e.local.id, weight: 1 }))
  await b.append(encode({ addWriter: d.local.id, weight: 3 }))
  {
    const done = replicate(a, b, c, d, e)
    await sync(a, b, c, d, e)
    await done()
  }
  await checkReplayAgreement(
    t,
    [
      { name: 'a', auto: a },
      { name: 'b', auto: b },
      { name: 'c', auto: c },
      { name: 'd', auto: d },
      { name: 'e', auto: e }
    ],
    'sync'
  )

  await a.append(encode({ addWriter: a.local.id, weight: 3 }))
  await e.append(encode({ addWriter: a.local.id, weight: 3 }))

  {
    const done = replicate(a, b, c, d, e)
    await sync(a, b, c, d, e)
    await done()
  }

  await checkReplayAgreement(
    t,
    [
      { name: 'a', auto: a },
      { name: 'b', auto: b },
      { name: 'c', auto: c },
      { name: 'd', auto: d },
      { name: 'e', auto: e }
    ],
    'sync'
  )
})
