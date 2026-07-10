const test = require('brittle')
const b4a = require('b4a')

const { create, replicate, sync, encode } = require('./helpers')

// Note: there is intentionally no "remove writer" action here. A writer that
// keeps appending after being concurrently removed forks permanently - the
// remover's view can never fully index that writer's later entries again
// (see test/writer-management.js "concurrent remove and write from removed
// writer", which works around it with manual flush/timeout polling instead
// of sync()). Plugging that into a generic random fuzz loop would make
// syncRound() hang forever whenever the fuzzer happens to hit that
// interleaving, so removal is left out for now.

// A minimized, always-on regression test for the bug this fuzzer originally
// found lives in test/generated.js - see .repro-scratch/ (untracked)
// for the seed-search + delta-debugging tooling that produced it, if a
// future failure here needs the same treatment.
//
// The check below compares auto.replay() (the full topologically-sorted
// oplog order) across every peer, not just system.get() weight - a given
// causal history has exactly one correct system state, so any two peers that
// applied the same nodes must produce byte-identical replay() output.
// Comparing weight alone misses this: two peers can already disagree on
// ordering well before that disagreement happens to surface as a visible
// weight mismatch, and weight itself isn't immutable oplog data - it's
// re-derived from each peer's own converging system state, so a divergence
// there is a downstream symptom, not the earliest signal. See
// checkReplayAgreement()/compareReplay() below for how a failure here is
// classified: same-history-different-weight (a determinism bug in system
// state computation) vs same-history-different-order (a non-deterministic
// tiebreak) are distinguished by checking whether the common replay prefix's
// weights agree before the two peers' orders actually part ways.

// autobee's internal drain loop can throw asynchronously outside the awaited
// promise chain (observed while reducing the failing case above) - without
// this, that surfaces as an opaque top-level crash instead of a normal,
// attributable test failure.
let asyncError = null
process.on('uncaughtException', (err) => { asyncError = err })
process.on('unhandledRejection', (err) => { asyncError = err })

function throwIfAsyncError() {
  if (!asyncError) return
  const err = asyncError
  asyncError = null
  throw err
}

// sync() polls forever with no internal timeout - a fuzz interleaving that
// strands a writer in permanent optimistic limbo (granted by no one, never
// removed) makes it spin indefinitely instead of failing loudly.
function withTimeout(promise, ms, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// Tunables - override via env when running this file directly, eg:
//   FUZZ_SEED=42 FUZZ_STEPS=2000 FUZZ_MAX_WRITERS=10 node test/fuzz.js
const SEED = envInt('FUZZ_SEED', (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0)
const STEPS = envInt('FUZZ_STEPS', 150)
const MAX_WRITERS = envInt('FUZZ_MAX_WRITERS', 6)
const SYNC_EVERY = envInt('FUZZ_SYNC_EVERY', 5)
const MAX_WEIGHT = envInt('FUZZ_MAX_WEIGHT', 3)
const SYNC_TIMEOUT = envInt('FUZZ_SYNC_TIMEOUT_MS', 20000)
const VERBOSE = !!process.env.FUZZ_VERBOSE

test('fuzz - random writer weights, optimistic self-adds, eventual consistency', async function (t) {
  // full-mesh replicate+sync rounds get slower as the writer pool grows, and
  // this is meant to be scaled way up via env vars - give it room accordingly
  t.timeout(Math.max(30000, STEPS * 500))
  t.comment(`seed=${SEED} steps=${STEPS} maxWriters=${MAX_WRITERS} syncEvery=${SYNC_EVERY} maxWeight=${MAX_WEIGHT}`)

  const rng = makeRng(SEED)

  const genesis = await create(t)
  await genesis.append(encode({ msg: 'genesis' }))

  const state = {
    t,
    rng,
    pool: [{ auto: genesis, name: genesis.name }],
    genesisKey: genesis.key,
    granted: new Set([keyHex(genesis)]),
    pendingOptimistic: new Set(),
    // writers can never be downgraded - system.js has no defined behaviour for
    // a writer's ordering weight decreasing after the fact (see the
    // write-up in .repro-scratch/ for why: fixing the update()/addNode
    // asymmetry that silently drops self-downgrades makes them apply, but
    // then the node's own topo weight oscillates across reorg passes and
    // never converges). tracks the floor any future grant to a key must
    // respect - genesis is seeded with its real bootstrap weight (1, the
    // default passed to system.addWriter() with no explicit weight).
    weights: new Map([[keyHex(genesis), 1]]),
    seq: 0,
    log(msg) {
      if (VERBOSE) t.comment(msg)
    }
  }

  const actions = [
    { name: 'spawn', weight: 3, run: spawnCandidate },
    { name: 'appendNormal', weight: 6, run: appendNormal },
    { name: 'addWriterByPeer', weight: 3, run: addWriterByPeer },
    { name: 'changeWeight', weight: 3, run: changeWeight },
    { name: 'optimisticSelfAdd', weight: 3, run: optimisticSelfAdd },
    // deliberately hunts for the generated.js pattern: two distinct
    // granters concurrently grant a common target conflicting weights,
    // rather than waiting for addWriterByPeer/changeWeight to land on it by
    // chance (seed search over the plain random mix only found it ~18% of
    // the time within 60 steps)
    { name: 'concurrentConflictingGrant', weight: 2, run: concurrentConflictingGrant }
  ]

  for (let i = 0; i < STEPS; i++) {
    const action = weightedPick(rng, actions)

    try {
      await action.run(state)
      throwIfAsyncError()
    } catch (err) {
      t.fail(`step ${i} (${action.name}) threw: ${err.stack}`)
    }

    if ((i + 1) % SYNC_EVERY === 0) {
      await syncRound(state)
      await checkReplayAgreement(t, state.pool)
    }
  }

  // final settle - everyone should be able to fully converge once no more
  // writes are in flight
  await syncRound(state)
  await checkReplayAgreement(t, state.pool)

  t.pass(`fuzz completed ${STEPS} steps across ${state.pool.length} writers (seed=${SEED})`)
})

// ---- actions --------------------------------------------------------

async function spawnCandidate(state) {
  if (state.pool.length >= MAX_WRITERS) return false

  const auto = await create(state.t, state.genesisKey)
  state.pool.push({ auto, name: auto.name })
  state.log(`spawn ${auto.name}`)
  return true
}

async function appendNormal(state) {
  const writable = writableEntries(state.pool)
  if (!writable.length) return false

  const from = state.rng.pick(writable)
  state.seq++
  await from.auto.append(encode({ msg: `m${state.seq}`, from: from.name }))
  state.log(`${from.name} appends normal message #${state.seq}`)
  return true
}

async function addWriterByPeer(state) {
  const writable = writableEntries(state.pool)
  const candidates = state.pool.filter((e) => !e.auto.writable)
  if (!writable.length || !candidates.length) return false

  const granter = state.rng.pick(writable)
  const target = state.rng.pick(candidates)
  const hex = keyHex(target.auto)
  const weight = randWeightAtLeast(state, currentWeight(state, hex))

  await granter.auto.append(encode({ addWriter: target.auto.local.id, weight }))
  state.granted.add(hex)
  state.weights.set(hex, weight)
  state.log(`${granter.name} adds ${target.name} as writer, weight=${weight}`)
  return true
}

async function changeWeight(state) {
  const writable = writableEntries(state.pool)
  const target = pickGrantedTarget(state)
  if (!writable.length || !target) return false

  const granter = state.rng.pick(writable)
  const hex = keyHex(target.auto)
  const weight = randWeightAtLeast(state, currentWeight(state, hex))

  await granter.auto.append(encode({ addWriter: target.auto.local.id, weight }))
  state.weights.set(hex, weight)
  state.log(`${granter.name} changes ${target.name} weight -> ${weight}`)
  return true
}

async function optimisticSelfAdd(state) {
  const pending = state.pool.filter((e) => !e.auto.writable)
  if (!pending.length) return false

  const self = state.rng.pick(pending)
  const hex = keyHex(self.auto)
  const weight = randWeightAtLeast(state, Math.max(1, currentWeight(state, hex)))

  await self.auto.append(encode({ addWriter: self.auto.local.id, weight }), { optimistic: true })
  state.granted.add(hex)
  state.weights.set(hex, weight)
  state.pendingOptimistic.add(hex)
  state.log(`${self.name} optimistically adds itself, weight=${weight}`)
  return true
}

// Two distinct granters concurrently grant a common target conflicting
// weights, back to back, before either syncs with the other. This is the
// exact shape test/generated.js isolates: system.js's
// _updateWriter() re-stamps a writer's weight from each peer's own current
// system.bee state whenever that writer's length advances, so which grant
// "wins" depends on the peers' own arrival order and they can permanently
// disagree. Left as a fuzz action (rather than only the fixed regression
// test) so random surrounding traffic can still turn up variants of it.
async function concurrentConflictingGrant(state) {
  const writable = writableEntries(state.pool)
  if (writable.length < 2) return false

  const granter1 = state.rng.pick(writable)
  const rest = writable.filter((e) => e !== granter1)
  const granter2 = state.rng.pick(rest.length ? rest : writable)
  if (granter2 === granter1) return false

  const target = state.rng.pick(state.pool)
  const hex = keyHex(target.auto)
  const floor = currentWeight(state, hex)
  const weight1 = randWeightAtLeast(state, floor)
  const weight2 = randWeightAtLeast(state, floor)

  await granter1.auto.append(encode({ addWriter: target.auto.local.id, weight: weight1 }))
  await granter2.auto.append(encode({ addWriter: target.auto.local.id, weight: weight2 }))

  state.granted.add(hex)
  // whichever grant "wins" in the replicated system, it'll be at least this -
  // future grants must not undercut whichever of the two takes effect
  state.weights.set(hex, Math.max(weight1, weight2))
  state.log(
    `${granter1.name} grants ${target.name} weight=${weight1}, concurrently ${granter2.name} grants weight=${weight2}`
  )
  return true
}

// ---- sync + consistency checks --------------------------------------

async function syncRound(state) {
  const entries = state.pool
  if (entries.length < 2) return

  const autos = entries.map((e) => e.auto)
  const done = replicate(...autos)

  // nudge writable peers to pull in any outstanding optimistic batches,
  // mirroring the pattern used in test/optimistic-race.js
  const writable = writableEntries(entries)
  for (const hex of state.pendingOptimistic) {
    const entry = entries.find((e) => keyHex(e.auto) === hex)
    if (!entry) continue

    await Promise.all(
      writable.map((w) =>
        w.auto.wakeup({ key: entry.auto.local.key, length: entry.auto.local.length }).catch(() => {})
      )
    )
  }

  await withTimeout(
    sync(...autos),
    SYNC_TIMEOUT,
    `sync() did not converge within ${SYNC_TIMEOUT}ms - a writer is likely stranded (granted by no one, never removed)`
  )
  await done()

  state.pendingOptimistic.clear()
}

// Compares the full topologically-sorted oplog order (auto.replay()) across every peer -
// a much stronger, more direct signal than comparing system.get() weights. A given causal
// history has exactly one correct system state (weights included), so any two peers that
// have applied the same set of nodes MUST produce byte-identical replay() output. Checking
// replay() directly catches ordering divergence at its source, rather than waiting for it
// to eventually surface as a weight disagreement (which it may not always do, and even
// when it does, only well after the actual point where the two peers' understanding of
// the DAG first split).
async function checkReplayAgreement(t, pool) {
  const replays = []
  for (const { auto, name } of pool) {
    replays.push({ name, nodes: await auto.replay() })
  }

  for (let i = 0; i < replays.length - 1; i++) {
    for (let j = i + 1; j < replays.length; j++) {
      compareReplay(t, replays[i], replays[j])
    }
  }
}

// Finds the first index where two peers' replay() orders diverge, then classifies the
// divergence:
//
//   - if every node in the common prefix [0, k) has the SAME weight on both sides, but the
//     peers still chose a DIFFERENT next node, that's the clean, fixable signal: identical
//     causal history must yield identical system state, so this can only mean the ordering
//     decision itself (not the history feeding it) is non-deterministic
//   - if some node WITHIN the common prefix already has a different weight recorded by the
//     two peers, that's an even earlier problem - a genuine determinism bug in how the
//     system state gets computed, since it means "same order applied" didn't produce "same
//     result" at all, well before the two peers' chosen orders even part ways
function compareReplay(t, a, b) {
  const refsA = a.nodes.map(nodeRef)
  const refsB = b.nodes.map(nodeRef)

  let k = 0
  while (k < refsA.length && k < refsB.length && refsA[k] === refsB[k]) k++

  if (k === refsA.length && k === refsB.length) {
    t.pass(`${a.name} and ${b.name} agree on replay order (${k} nodes)`)
    return
  }

  let prefixWeightMismatch = null
  for (let i = 0; i < k; i++) {
    if (a.nodes[i].weight !== b.nodes[i].weight) {
      prefixWeightMismatch = i
      break
    }
  }

  const lines = [`${a.name} and ${b.name} diverge in replay() order at index ${k} (of ${refsA.length}/${refsB.length})`]
  lines.push(`  common prefix [0, ${k}) identical in order: yes`)

  if (prefixWeightMismatch !== null) {
    const i = prefixWeightMismatch
    lines.push(
      `  common prefix weight MISMATCH at index ${i}: ${nodeRef(a.nodes[i])} ` +
        `${a.name}.weight=${a.nodes[i].weight} vs ${b.name}.weight=${b.nodes[i].weight}`
    )
    lines.push('  -> same history, different weight: determinism bug in system state computation')
  } else {
    lines.push('  common prefix weight agreement: yes')
    lines.push(
      `  -> ${a.name} next: ${nodeRef(a.nodes[k])} weight=${a.nodes[k] && a.nodes[k].weight} | ` +
        `${b.name} next: ${nodeRef(b.nodes[k])} weight=${b.nodes[k] && b.nodes[k].weight}`
    )
    lines.push('  -> identical history, different ordering decision: non-deterministic tiebreak')
  }

  t.fail(lines.join('\n'))
}

function nodeRef(n) {
  if (!n) return '<missing>'
  return `${keyHexOf(n.key).slice(0, 8)}:${n.length}`
}

// ---- helpers ----------------------------------------------------------

function writableEntries(pool) {
  return pool.filter((e) => e.auto.writable)
}

function pickGrantedTarget(state) {
  if (!state.granted.size) return null
  const hex = state.rng.pick([...state.granted])
  return state.pool.find((e) => keyHex(e.auto) === hex) || null
}

function currentWeight(state, hex) {
  return state.weights.get(hex) || 0
}

// weights can only ever go up (or stay the same) - never down, see the note
// on state.weights above
function randWeightAtLeast(state, floor) {
  return state.rng.int(Math.min(floor, MAX_WEIGHT), MAX_WEIGHT)
}

function keyHex(auto) {
  return keyHexOf(auto.local.key)
}

function keyHexOf(key) {
  return b4a.toString(key, 'hex')
}

function envInt(name, fallback) {
  const v = process.env[name]
  return v ? Number(v) : fallback
}

// ---- seeded PRNG (mulberry32) ------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeRng(seed) {
  const next = mulberry32(seed)
  return {
    float: () => next(),
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1))
    },
    pick(arr) {
      return arr[this.int(0, arr.length - 1)]
    },
    bool(p = 0.5) {
      return next() < p
    }
  }
}

function weightedPick(rng, options) {
  const total = options.reduce((sum, o) => sum + o.weight, 0)
  let r = rng.float() * total
  for (const o of options) {
    r -= o.weight
    if (r <= 0) return o
  }
  return options[options.length - 1]
}
