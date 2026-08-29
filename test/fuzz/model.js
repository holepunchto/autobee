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
    const genesis = await create(harness, {
      storage: nextStorage(),
      bootstrapWeight: config.maxWeight,
      ...writerClock(config, rng)
    })
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

const BYZ = process.env.FUZZ_NO_BYZ ? 0 : 1
const COND = process.env.FUZZ_COND_GRANT ? 4 : 0

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
  // fault injection: a single faulty CLAIMANT, three ways. there is no
  // buggy-backer action any more - the grant log is system-authored, so a
  // third party has nothing to forge. all three must floor deterministically
  { name: 'buggyClaimInflate', weight: BYZ, run: buggyClaimInflate },
  { name: 'buggyClaimNakedLink', weight: BYZ, run: buggyClaimNakedLink },
  { name: 'buggyClaimForeignGrant', weight: BYZ, run: buggyClaimForeignGrant },
  // EXPERIMENT (FUZZ_COND_GRANT=live|pinned|carrier): an application-level
  // rule - "only an admin may promote to admin" - whose verdict is evaluated
  // inside apply, three ways (live register read / cited grant / carrier
  // weight). Under gated grants all three must converge - see
  // test/conditional-grant.js, and the demotion branch for the ungated
  // split-brain demonstration
  { name: 'condPromoteRace', weight: COND, run: condPromoteRace }
]

exports.actions = actions

// ---- actions ------------------------------------------------------------

async function spawnCandidate(state) {
  if (state.pool.length >= state.config.maxWriters) return false

  const clock = writerClock(state.config, state.rng)
  const auto = await create(state.harness, state.genesisKey, {
    storage: state.nextStorage(),
    bootstrapWeight: state.config.maxWeight,
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
  state.weights.set(hex, Math.max(currentWeight(state, hex), weight))
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
  state.weights.set(hex, Math.max(currentWeight(state, hex), weight))
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
  // gated grants: a self-add's carrier resolves 0, so it confers no weight -
  // the writer joins writable at 0 and waits for a qualified grant
  state.weights.set(hex, Math.max(currentWeight(state, hex), 0))
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
  state.weights.set(hex, Math.max(currentWeight(state, hex), weight1, weight2))
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

  // only once the pool can no longer grow: a writer spawned AFTER a removal
  // can never obtain the removed writer's oplog blocks, so it can never apply
  // the nodes that writer contributed before it went - it parks forever and no
  // sync round converges. that is the known removed-writer/late-joiner hazard,
  // not something the ordering scheme can fix
  if (!process.env.FUZZ_ALLOW_UNSAFE_REMOVE && state.pool.length < state.config.maxWriters) {
    return false
  }

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

async function condPromoteRace(state) {
  const pinned = process.env.FUZZ_COND_GRANT === 'pinned'
  const writable = writableEntries(state)
  if (writable.length < 3) return false

  const admins = []
  for (const e of writable) {
    const rec = await e.auto.system.get(e.auto.local.key)
    if (rec && rec.maxWeight >= 3) admins.push(e)
  }
  if (admins.length < 2) return false

  const granter = state.rng.pick(admins)
  const targets = writable.filter((e) => e !== granter)
  if (!targets.length) return false
  const target = state.rng.pick(targets)

  if (process.env.FUZZ_COND_GRANT === 'carrier') {
    await granter.auto.append(encode({ promoteAdminCarrier: target.auto.local.id }))
  } else if (pinned) {
    const grant = await granter.auto.system.strongestGrant(granter.auto.local.key)
    if (!grant || grant.weight < 3) return false
    await granter.auto.append(
      encode({
        promoteAdminPinned: target.auto.local.id,
        link: { key: keyHexOf(grant.key), length: grant.length }
      })
    )
  } else {
    await granter.auto.append(encode({ promoteAdmin: target.auto.local.id }))
  }

  await state.transport.pairSync(granter.auto, target.auto, {
    timeoutMs: state.config.syncTimeoutMs
  })
  state.seq++
  await target.auto.append(encode({ msg: `m${state.seq}`, from: target.name }))

  state.granted.add(keyHex(target.auto))
  state.weights.set(keyHex(target.auto), Math.min(5, granterStanding(state, granter)))
  state.dirty.add(keyHex(granter.auto))
  state.dirty.add(keyHex(target.auto))
  state.log(`${granter.name} conditionally promotes ${target.name} (${pinned ? 'pinned' : 'live'})`)
  return true
}

// ---- byzantine actions ----------------------------------------------------
//
// Under the grant-link scheme there is nothing a THIRD party can forge: the
// grant log is system-authored, so no writer (and no coalition) can make a
// grant appear that the contract did not apply. That collapses the whole
// byzantine surface onto the claimant, which is what these actions cover -
// every one of them must floor, and floor identically on every peer.

// force-embed a witness that append() would never construct. the citation is
// always a position already applied in the claimant's own view: citing an
// unapplied position just parks its own chain at the ingest gate (a
// self-inflicted liveness stall, not an ordering surface, and it would wedge
// the sync rounds this harness depends on)
async function embedWitness(state, claimant, witness, how) {
  const auto = claimant.auto

  // the citation becomes a hard causal dep, so it must point at data that
  // stays fetchable: a removed or retired writer's core may be gc'd and no
  // longer replicated, which wedges the drain forever. that is the fixture
  // asking for the impossible, not a property of the scheme
  const linkHex = keyHexOf(witness.link.key)
  if (state.retired.has(linkHex)) return false

  const linkRec = await auto.system.get(witness.link.key)
  if (!linkRec || linkRec.isRemoved) return false
  if (!(await auto.system.has(witness.link))) return false

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

// claim more than the cited grant actually conferred - the strict grant gate
// in resolveWeight must reject it
async function buggyClaimInflate(state) {
  const writable = writableEntries(state)
  if (!writable.length) return false

  const claimant = state.rng.pick(writable)
  const grant = await claimant.auto.system.strongestGrant(claimant.auto.local.key)
  if (!grant) return false

  const weight = unbackableWeight(state)
  return embedWitness(
    state,
    claimant,
    { weight, link: { key: grant.key, length: grant.length } },
    `inflated claim ${weight} over a grant of ${grant.weight}`
  )
}

// cite a node that is not a grant to us at all
async function buggyClaimNakedLink(state) {
  const writable = writableEntries(state)
  if (!writable.length) return false

  const claimant = state.rng.pick(writable)
  const auto = claimant.auto

  const heads = auto.system.getLinks(auto.local.key)
  if (!heads.length) return false

  for (const head of heads) {
    const link = { key: head.key, length: head.length }
    // make sure the fixture really is a non-grant, otherwise it is testing
    // nothing (a head can happen to be the op that granted us)
    if ((await auto.system.grantedWeight(auto.local.key, link)) !== 0) continue

    const weight = state.rng.int(1, state.config.maxWeight)
    return embedWitness(state, claimant, { weight, link }, `naked link, claim=${weight}`)
  }

  return false
}

// cite a grant that was made to somebody else - the log is keyed by grantee,
// so a foreign grant is simply not found for us
async function buggyClaimForeignGrant(state) {
  const writable = writableEntries(state)
  if (writable.length < 2) return false

  const claimant = state.rng.pick(writable)
  const auto = claimant.auto

  const others = state.pool.filter((e) => e !== claimant)
  while (others.length) {
    const other = others.splice(state.rng.int(0, others.length - 1), 1)[0]
    const grant = await auto.system.strongestGrant(other.auto.local.key)
    if (!grant) continue

    return embedWitness(
      state,
      claimant,
      { weight: grant.weight, link: { key: grant.key, length: grant.length } },
      `foreign grant of ${other.name}, claim=${grant.weight}`
    )
  }

  return false
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

  try {
    await state.transport.pairSync(a.auto, b.auto, { timeoutMs: state.config.syncTimeoutMs })
  } catch (err) {
    if (process.env.FUZZ_DIAG) await diagnose(state, [a, b], err)
    throw err
  }

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

function granterStanding(state, entry) {
  const hex = keyHex(entry.auto)
  if (hex === state.genesisHex) return state.config.maxWeight
  return currentWeight(state, hex)
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

async function diagnose(state, pair, err) {
  console.error('\n===== DIAG: ' + err.message + ' =====')
  console.error('pair: ' + pair.map((e) => e.name.slice(0, 3)).join(' <-> '))

  for (const { auto, name } of state.pool) {
    console.error(
      '-- ' +
        name.slice(0, 3) +
        ' localLen=' +
        auto.local.length +
        ' active=' +
        auto.writers.active.size
    )
    for (const w of auto.writers.active.values()) {
      let contig = '?'
      try {
        contig = w.core.contiguousLength
      } catch {}
      console.error(
        '     ' +
          w.id.slice(0, 8) +
          ' added=' +
          (w.isAdded ? 1 : 0) +
          ' removed=' +
          (w.isRemoved ? 1 : 0) +
          ' frozen=' +
          (w.isFrozen ? 1 : 0) +
          ' coreLen=' +
          w.core.length +
          ' contig=' +
          contig +
          ' pending=' +
          (w.isPending ? 1 : 0) +
          ' waiting=' +
          (w.waiting ? 'Y' : 'n')
      )
    }
    const recs = []
    for (const other of state.pool) {
      const rec = await auto.system.get(other.auto.local.key)
      recs.push(
        keyHex(other.auto).slice(0, 8) +
          '=' +
          (rec ? 'len' + rec.length + (rec.isRemoved ? ',RM' : '') : 'null')
      )
    }
    console.error('     sys: ' + recs.join(' '))
  }
  console.error('===== END DIAG =====\n')
}
