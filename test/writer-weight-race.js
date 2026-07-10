const test = require('brittle')
const b4a = require('b4a')
const { create, replicate, sync, encode } = require('./helpers')

// Minimized from test/fuzz.js's random "concurrent writer weights" scenario via seed
// search + delta-debugging (see .repro-scratch/ for the reduction tooling). Two writers
// concurrently grant a third writer conflicting weights, each unaware of the other's
// grant. After a full sync, the granters never agree on what weight the third writer
// ended up with - `weight` is re-derived from each peer's own current system.bee state
// at the moment a writer's length advances (system.js _updateWriter), rather than being
// immutable oplog data, so which grant "wins" depends on each peer's own arrival order.
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

  const w1 = await auto1.system.get(auto3.local.key)
  const w2 = await auto2.system.get(auto3.local.key)
  const w3 = await auto3.system.get(auto3.local.key)

  t.is(w1.weight, w2.weight, 'auto1 and auto2 agree on auto3 weight')
  t.is(w2.weight, w3.weight, 'auto2 and auto3 agree on auto3 weight')
})

async function replay(auto) {
  const nodes = await auto.replay()
  return nodes.map(n => `${n.key.toString('hex')}:${n.length}`)
}

// Minimized from a fresh test/fuzz.js failure (seed 19, found + delta-debugged after the
// isOrderedBefore/grant-ref fixes were in place - see .repro-scratch/trace19.json and
// fail19-full.log) - already minimal, ddmin can't drop any of these 6 ops including the
// auto3 spawn, even though auto3 never touches the disputed writer directly.
//
// Shape: auto2 optimistically self-grants (weight 1) before it knows auto1 has
// concurrently granted it a different weight (3) too - so the SAME writer (auto2) is the
// target of two concurrent grants, one of which it issued about itself. Diagnostics showed
// auto2's own first oplog entry got weight=0 baked into its topo node (the writer's cached
// weight before its own bootstrap/self-grant applied within the same batch), while the
// system record for that same entry is later corrected - so the node's effective weight
// and the system's stored weight for it can disagree, and that disagreement isn't the same
// on every peer.
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

  const w1 = await auto1.system.get(auto2.local.key)
  const w2 = await auto2.system.get(auto2.local.key)
  const w3 = await auto3.system.get(auto2.local.key)

  t.is(w1.weight, w2.weight, 'auto1 and auto2 agree on auto2 weight')
  t.is(w2.weight, w3.weight, 'auto2 and auto3 agree on auto2 weight')
})

// Checks that every peer in `autos` that has heard of a writer agrees on its weight.
// Called after every single op below (not just after each sync) so a failure pinpoints
// exactly which op first introduced the disagreement - most ops won't have replicated
// anywhere yet and so trivially agree (peers with no record of a writer are skipped, same
// as "hasn't replicated this far yet" in test/fuzz.js's checkWeightAgreement), so this only
// actually catches something the moment a sync exposes a real divergence.
async function checkWeightAgreement(t, autos, label) {
  const keys = new Map()
  for (const auto of autos) {
    for await (const w of auto.system.list()) keys.set(b4a.toString(w.key, 'hex'), w.key)
  }

  for (const hex of keys.keys()) {
    let baseline = null
    for (const auto of autos) {
      const info = JSON.stringify(await replay(auto))
      if (!baseline) { baseline = info; continue }
      if (info !== baseline) {
        return t.fail(`${label}: writer ${hex.slice(0, 8)} weight agrees`)
      }
    }
  }

  t.pass(label)
}

// Raw, unminimized capture straight off test/fuzz.js's random action sequence (seed 1,
// fails at its step 29 - see .repro-scratch/record.js + trace-fresh.json). Transcribed
// from the pool/index-based replay (which is what's actually confirmed to reproduce) into
// named writers - auto1 is spawn-index 0 (genesis), auto2 is index 1, and so on - keeping
// every op's exact semantics (which appends are optimistic, which sync rounds include which
// peers) unchanged. A first transcription attempt on the previous test in this file silently
// dropped a bootstrap append and stopped reproducing, so this one is checked after every op
// instead of only at the end, to catch that class of mistake immediately and pin down
// exactly where the real disagreement first appears.
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
  await checkWeightAgreement(t, [auto1, auto2, auto3], 'op9 (sync)')

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
    await Promise.all(writable.map((w) => w.wakeup({ key: auto2.local.key, length: auto2.local.length }).catch(() => {})))
    await sync(auto1, auto2, auto3, auto4)
    await done()
  }
  await checkWeightAgreement(t, [auto1, auto2, auto3, auto4], 'op15 (sync)')

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
  await checkWeightAgreement(t, [auto1, auto2, auto3, auto4], 'op21 (sync)')

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
  await checkWeightAgreement(t, [auto1, auto2, auto3, auto4, auto5], 'op28 (sync)')

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
  // disagreement (checkWeightAgreement failed right after this sync)
  {
    const done = replicate(auto1, auto2, auto3, auto4, auto5, auto6)
    await sync(auto1, auto2, auto3, auto4, auto5, auto6)
    await done()
  }

  await checkWeightAgreement(t, [auto1, auto2, auto3, auto4, auto5, auto6], 'op34 (sync, final)')
})

// Raw, unminimized capture straight off test/fuzz.js's random action sequence (seed 1,
// fails at its step 29 - see .repro-scratch/record.js + trace-fresh.json). Transcribed
// from the pool/index-based replay (which is what's actually confirmed to reproduce) into
// named writers - auto1 is spawn-index 0 (genesis), auto2 is index 1, and so on - keeping
// every op's exact semantics (which appends are optimistic, which sync rounds include which
// peers) unchanged. A first transcription attempt on the previous test in this file silently
// dropped a bootstrap append and stopped reproducing, so this one is checked after every op
// instead of only at the end, to catch that class of mistake immediately and pin down
// exactly where the real disagreement first appears.
test('regression - raw fuzz capture (seed 1, step 29): writer weight disagreement', async function (t) {
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

  // disagreement (checkWeightAgreement failed right after this sync)
  {
    const done = replicate(auto1, auto2)
    await sync(auto1, auto2)
    await done()
  }

  await checkWeightAgreement(t, [auto1, auto2], 'final sync')
})
