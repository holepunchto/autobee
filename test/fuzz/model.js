// The fuzz model: what a trial's writer pool looks like and what actions
// can happen to it. Ported from the original test/fuzz.js - this module
// owns state + actions only, no I/O policy (storage, oracle checks) and no
// process lifecycle (that's run.js's job).

const { create, encode } = require('../helpers')

exports.createState = createState
exports.writableEntries = writableEntries
exports.keyHex = keyHex
exports.keyHexOf = keyHexOf

const b4a = require('b4a')

// config: { maxWriters, maxWeight, syncTimeoutMs, maxDriftMs, zeroClock }
// harness: { tick, teardown(fn) } - satisfies test/helpers' create() contract
// nextStorage(): () => string - fresh directory path per writer
// transport: { attach(auto), fullSync(autos, {timeoutMs}), pairSync(a, b,
//   {timeoutMs}), destroy() } - see transport-real.js / transport-sim.js.
// model.js only ever talks to state.transport, never to a concrete network
// layer, so either is interchangeable underneath the same action set.
function createState(config, rng, harness, nextStorage, log, transport) {
  return (async () => {
    const genesis = await create(harness, { storage: nextStorage(), ...writerClock(config, rng) })
    await transport.attach(genesis)
    await genesis.append(encode({ msg: 'genesis' }))

    return {
      config,
      rng,
      harness,
      nextStorage,
      log,
      transport,
      pool: [{ auto: genesis, name: genesis.name }],
      genesisKey: genesis.key,
      genesisHex: keyHex(genesis),
      granted: new Set([keyHex(genesis)]),
      pendingOptimistic: new Set(),
      // removed writers: never appended from or granted to again (a writer
      // that keeps appending after being concurrently removed forks
      // permanently - see test/writer-management.js "concurrent remove and
      // write from removed writer"). removeWriterAction is constrained
      // accordingly; their autos stay in the pool for the oracle.
      retired: new Set(),
      // writers with appends not yet through a syncRound - removal targets
      // must be clean or their unsynced entries can never index (sync hangs)
      dirty: new Set(),
      // weights can never be downgraded (system.js has no defined behaviour
      // for a writer's ordering weight decreasing after the fact) - tracks
      // the floor any future grant to a key must respect. genesis is seeded
      // with its real bootstrap weight (1, the default addWriter passes).
      weights: new Map([[keyHex(genesis), 1]]),
      seq: 0
    }
  })()
}

const actions = [
  { name: 'spawn', weight: 3, run: spawnCandidate },
  { name: 'appendNormal', weight: 6, run: appendNormal },
  { name: 'addWriterByPeer', weight: 3, run: addWriterByPeer },
  { name: 'changeWeight', weight: 3, run: changeWeight },
  { name: 'optimisticSelfAdd', weight: 3, run: optimisticSelfAdd },
  // deliberately hunts two distinct granters concurrently granting a
  // common target conflicting weights, rather than waiting for
  // addWriterByPeer/changeWeight to land on it by chance
  { name: 'concurrentConflictingGrant', weight: 2, run: concurrentConflictingGrant },
  // exercises the isRemoved resolution cap racing in-flight self-declared
  // witnesses from the removed writer
  { name: 'removeWriter', weight: 2, run: removeWriterAction },
  // partial pairwise sync: knowledge propagates unevenly, so full sync
  // rounds have to merge much staler branches (deeper reorgs, harder
  // recompute-on-reapply) than a fixed sync cadence alone produces
  { name: 'pairSync', weight: 2, run: pairSync },
  // fault injection - each models ONE faulty writer acting alone (byzantine
  // as bug, not necessarily malice). when a buggy backer's attestation later
  // reaches a buggy claimant they compose into the independent two-fault
  // case organically. planted claim values are always unbackable (above
  // every grantable weight) so flooring is permanent and deterministic - a
  // plausible planted value plus a later matching grant is the documented
  // residual corner (genuine collusion), out of scope until a collusion
  // action lands with oracle support for its expected divergence
  { name: 'buggyBackerAttest', weight: 1, run: buggyBackerAttest },
  { name: 'buggyClaimantEmbed', weight: 1, run: buggyClaimantEmbed }
]

exports.actions = actions

// ---- actions ------------------------------------------------------------

async function spawnCandidate(state) {
  if (state.pool.length >= state.config.maxWriters) return false

  const clock = writerClock(state.config, state.rng)
  const auto = await create(state.harness, state.genesisKey, {
    storage: state.nextStorage(),
    ...clock
  })
  await state.transport.attach(auto)
  state.pool.push({ auto, name: auto.name })
  state.log(`spawn ${auto.name} (drift ${clock.drift}ms)`)
  return true
}

async function appendNormal(state) {
  const writable = writableEntries(state)
  if (!writable.length) return false

  const from = state.rng.pick(writable)

  // ~1 in 4 appends is a multi-node batch: witnesses ride batch heads and
  // the batch bookkeeping (b.start/b.end) is its own surface
  const count = state.rng.bool(0.25) ? state.rng.int(2, 4) : 1
  const values = []
  for (let n = 0; n < count; n++) {
    state.seq++
    values.push(encode({ msg: `m${state.seq}`, from: from.name }))
  }

  await from.auto.append(count === 1 ? values[0] : values)
  state.dirty.add(keyHex(from.auto))
  state.log(`${from.name} appends ${count} message(s) up to #${state.seq}`)
  return true
}

async function addWriterByPeer(state) {
  const writable = writableEntries(state)
  const candidates = state.pool.filter(
    (e) => !e.auto.writable && !state.retired.has(keyHex(e.auto))
  )
  if (!writable.length || !candidates.length) return false

  const granter = state.rng.pick(writable)
  const target = state.rng.pick(candidates)
  const hex = keyHex(target.auto)
  const weight = randWeightAtLeast(state, currentWeight(state, hex))

  await granter.auto.append(encode({ addWriter: target.auto.local.id, weight }))
  state.granted.add(hex)
  state.weights.set(hex, weight)
  state.dirty.add(keyHex(granter.auto))
  state.log(`${granter.name} adds ${target.name} as writer, weight=${weight}`)
  return true
}

async function changeWeight(state) {
  const writable = writableEntries(state)
  const target = pickGrantedTarget(state)
  if (!writable.length || !target) return false

  const granter = state.rng.pick(writable)
  const hex = keyHex(target.auto)
  const weight = randWeightAtLeast(state, currentWeight(state, hex))

  await granter.auto.append(encode({ addWriter: target.auto.local.id, weight }))
  state.weights.set(hex, weight)
  state.dirty.add(keyHex(granter.auto))
  state.log(`${granter.name} changes ${target.name} weight -> ${weight}`)
  return true
}

async function optimisticSelfAdd(state) {
  const pending = state.pool.filter((e) => !e.auto.writable && !state.retired.has(keyHex(e.auto)))
  if (!pending.length) return false

  const self = state.rng.pick(pending)
  const hex = keyHex(self.auto)
  const weight = randWeightAtLeast(state, Math.max(1, currentWeight(state, hex)))

  await self.auto.append(encode({ addWriter: self.auto.local.id, weight }), { optimistic: true })
  state.granted.add(hex)
  state.weights.set(hex, weight)
  state.pendingOptimistic.add(hex)
  state.dirty.add(hex)
  state.log(`${self.name} optimistically adds itself, weight=${weight}`)
  return true
}

// Two distinct granters concurrently grant a common target conflicting
// weights, back to back, before either syncs with the other - the shape
// test/generated.js isolates as a fixed regression. Left as a fuzz action
// too so random surrounding traffic can still turn up variants of it.
async function concurrentConflictingGrant(state) {
  const writable = writableEntries(state)
  if (writable.length < 2) return false

  const granter1 = state.rng.pick(writable)
  const rest = writable.filter((e) => e !== granter1)
  const granter2 = state.rng.pick(rest.length ? rest : writable)
  if (granter2 === granter1) return false

  const targets = state.pool.filter((e) => !state.retired.has(keyHex(e.auto)))
  if (!targets.length) return false
  const target = state.rng.pick(targets)
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
  state.dirty.add(keyHex(granter1.auto))
  state.dirty.add(keyHex(granter2.auto))
  state.log(
    `${granter1.name} grants ${target.name} weight=${weight1}, concurrently ${granter2.name} grants weight=${weight2}`
  )
  return true
}

// Removal, constrained for oracle soundness: the target must be granted,
// clean since the last sync, not genesis, not mid optimistic self-add, and
// at least two usable writers must remain. The removal op itself still
// merges against everything in flight elsewhere.
async function removeWriterAction(state) {
  const writable = writableEntries(state)
  if (writable.length < 3) return false

  const removable = writable.filter((e) => {
    const hex = keyHex(e.auto)
    return (
      hex !== state.genesisHex &&
      state.granted.has(hex) &&
      !state.dirty.has(hex) &&
      !state.pendingOptimistic.has(hex)
    )
  })
  if (!removable.length) return false

  const target = state.rng.pick(removable)
  const hex = keyHex(target.auto)

  const removers = writable.filter((e) => e !== target)
  if (removers.length < 2) return false
  const remover = state.rng.pick(removers)

  await remover.auto.append(encode({ removeWriter: target.auto.local.id }))
  state.retired.add(hex)
  state.granted.delete(hex)
  state.dirty.add(keyHex(remover.auto))
  state.log(`${remover.name} removes ${target.name}`)
  return true
}

// ---- byzantine actions ----------------------------------------------------

// a backer whose attest computation is broken: queues an attestation for a
// value no grant can ever support, signed for real at its next flush and
// shipped on an ordinary carrier append. an honest victim harvests it but
// must skip it at selection (claim above its own applied grant) - one buggy
// backer acting alone must not affect anything
async function buggyBackerAttest(state) {
  const writable = writableEntries(state)
  if (!writable.length || state.pool.length < 2) return false

  const backer = state.rng.pick(writable)
  const victims = state.pool.filter((e) => e !== backer && !state.retired.has(keyHex(e.auto)))
  if (!victims.length) return false
  const victim = state.rng.pick(victims)

  const weight = unbackableWeight(state)
  backer.auto.writers.attestations.push({ key: victim.auto.local.key, weight })

  // carrier append so the bogus attestation ships now, not whenever the
  // backer happens to write next
  state.seq++
  await backer.auto.append(encode({ msg: `m${state.seq}`, from: backer.name }))
  state.dirty.add(keyHex(backer.auto))
  state.log(`${backer.name} buggily attests ${victim.name} at unbackable weight=${weight}`)
  return true
}

// a claimant whose witness selection is broken: force-embeds a witness
// append() would never produce, via appendLocal. two flavours:
//  - unfiltered: its best harvested attestation with the claim<=own-grant
//    selection filter disabled. an honest harvested claim stays a valid
//    (pinned) elevation; a buggy backer's unbackable one must floor at the
//    strict grant gate - identically on every peer
//  - forged: a grantable-range claim citing a real applied backer position
//    but carrying a garbage signature - must floor at verification, which
//    is pure bytes, so epoch-independent everywhere
// either way the citation is a position already applied in the claimant's
// own view: citing an unapplied position just parks this writer's chain at
// the ingest gate forever (a self-inflicted liveness stall, not an ordering
// surface, and it would wedge sync rounds)
async function buggyClaimantEmbed(state) {
  const writable = writableEntries(state)
  if (!writable.length) return false

  const claimant = state.rng.pick(writable)
  const auto = claimant.auto

  let witness = null
  let how = null

  if (state.rng.bool(0.5)) {
    const sorted = [...auto.writers.witnesses].sort(
      (x, y) => y.attestation.weight - x.attestation.weight
    )
    for (const { key, length, attestation, manifest } of sorted) {
      const info = await auto.system.get(key)
      if (!info || info.length < length) continue

      witness = {
        weight: attestation.weight,
        backer: { key, length, signature: attestation.signature, manifest }
      }
      how = `unfiltered harvest, weight=${attestation.weight}`
      break
    }
  }

  if (!witness) {
    const others = state.pool.filter((e) => e !== claimant)
    while (others.length) {
      const other = others.splice(state.rng.int(0, others.length - 1), 1)[0]
      const info = await auto.system.get(other.auto.local.key)
      if (!info || info.length === 0) continue

      // mostly a real manifest with a garbage signature (floors at the
      // signature check); sometimes garbage manifest bytes too (floors at
      // the manifest<->key binding). both verdicts are pure functions of
      // the node bytes, so both floor identically everywhere
      const garbageManifest = state.rng.bool(0.3)
      const manifest = garbageManifest
        ? GARBAGE_MANIFEST
        : other.auto.local.getManifest({ raw: true })
      if (!manifest) continue

      const weight = state.rng.int(1, state.config.maxWeight)
      witness = {
        weight,
        backer: {
          key: other.auto.local.key,
          length: info.length,
          signature: GARBAGE_SIGNATURE,
          manifest
        }
      }
      how = `forged ${garbageManifest ? 'manifest' : 'signature'}, weight=${weight}`
      break
    }
  }

  if (!witness) return false

  state.seq++
  const links = auto.system.getLinks(auto.local.key)
  const ts = Math.max(auto._now(), auto.system.timestamp)

  auto.writers.appendLocal(
    encode({ msg: `m${state.seq}`, from: claimant.name }),
    ts,
    { start: 0, end: 0 },
    links,
    false,
    witness
  )
  await auto._bump()

  state.dirty.add(keyHex(auto))
  state.log(`${claimant.name} buggily embeds witness (${how})`)
  return true
}

async function pairSync(state) {
  // below 3 peers the full sync cadence already covers this
  if (state.pool.length < 3) return false

  const a = state.rng.pick(state.pool)
  const rest = state.pool.filter((e) => e !== a)
  const b = state.rng.pick(rest)

  // same optimistic nudge as the full round, scoped to the pair
  for (const hex of state.pendingOptimistic) {
    const entry = state.pool.find((e) => keyHex(e.auto) === hex)
    if (!entry) continue

    for (const w of [a, b]) {
      if (!w.auto.writable || state.retired.has(keyHex(w.auto))) continue
      await w.auto
        .wakeup({ key: entry.auto.local.key, length: entry.auto.local.length })
        .catch(() => {})
    }
  }

  await state.transport.pairSync(a.auto, b.auto, { timeoutMs: state.config.syncTimeoutMs })

  // NOT clearing state.dirty: these writers' appends are still unsynced
  // relative to everyone outside the pair
  state.log(`pair sync ${a.name} <-> ${b.name}`)
  return true
}

// ---- full sync round (shared by run.js) ---------------------------------

exports.syncRound = syncRound

async function syncRound(state) {
  const entries = state.pool
  if (entries.length < 2) return

  const autos = entries.map((e) => e.auto)

  const writable = writableEntries(state)
  for (const hex of state.pendingOptimistic) {
    const entry = entries.find((e) => keyHex(e.auto) === hex)
    if (!entry) continue

    await Promise.all(
      writable.map((w) =>
        w.auto
          .wakeup({ key: entry.auto.local.key, length: entry.auto.local.length })
          .catch(() => {})
      )
    )
  }

  await state.transport.fullSync(autos, { timeoutMs: state.config.syncTimeoutMs })

  state.pendingOptimistic.clear()
  state.dirty.clear()
}

// ---- helpers --------------------------------------------------------------

function writableEntries(state) {
  return state.pool.filter((e) => e.auto.writable && !state.retired.has(keyHex(e.auto)))
}

function pickGrantedTarget(state) {
  const eligible = [...state.granted].filter((hex) => !state.retired.has(hex))
  if (!eligible.length) return null
  const hex = state.rng.pick(eligible)
  return state.pool.find((e) => keyHex(e.auto) === hex) || null
}

function currentWeight(state, hex) {
  return state.weights.get(hex) || 0
}

function randWeightAtLeast(state, floor) {
  return state.rng.int(Math.min(floor, state.config.maxWeight), state.config.maxWeight)
}

// strictly above every weight the trial can ever grant: action grants cap at
// config.maxWeight and the genesis bootstrap grant is always 2, so nothing
// can ever back a claim this size - flooring is permanent and deterministic
function unbackableWeight(state) {
  return Math.max(state.config.maxWeight, 2) + 1 + state.rng.int(0, 2)
}

const GARBAGE_SIGNATURE = b4a.alloc(64, 0xee)
const GARBAGE_MANIFEST = b4a.alloc(70, 0xee)

// ~half the writers keep a true clock, the rest drift by up to +/-maxDriftMs.
// the append clamp (max(now, system.timestamp)) must keep stamps monotone
// along links regardless, so honest drift never trips the sort invariant.
// zeroClock: every stamp is 0, degenerating within-class order to pure
// (weight, key) - the harshest ordering config known, kept as a permanent
// mode (see README "clock modes").
function writerClock(config, rng) {
  const drift = rng.bool(0.5) ? 0 : rng.int(-config.maxDriftMs, config.maxDriftMs)
  if (config.zeroClock) return { drift, now: () => 0 }
  return { drift, now: () => Date.now() + drift }
}

function keyHex(auto) {
  return keyHexOf(auto.local.key)
}

function keyHexOf(key) {
  return b4a.toString(key, 'hex')
}
