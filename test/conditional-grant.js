const test = require('brittle')
const b4a = require('b4a')
const { create, replicateAndSync, encode } = require('./helpers')

// Evidence for a design rule, in both directions. An application-level grant
// condition ("only an admin may promote") evaluated against LIVE apply state
// makes the verdict a function of where concurrent ops happen to sort; the
// promoted writer's citation feeds that verdict back into sort weight, giving
// two self-consistent (order, verdict) fixed points. Which one a peer settles
// in depends on ARRIVAL order, so two peers holding the identical DAG disagree
// stably - split-brain with no local signal. The same condition scoped to the
// promote op's causal past (cite the grant that made the author an admin,
// verified by point lookup against the system-authored grant log) has one
// fixed point and converges under the identical race.
//
// The apply handlers live in ./helpers: promoteAdmin (live read) and
// promoteAdminPinned (cited grant). Both request weight 5 - above the
// admins' own class - because that is the bistable geometry: the promoted
// citation can pull the promote op above a same-or-lower-class demote in one
// order, while the timestamp tiebreak puts the demote first in the other.
//
// ON THIS BRANCH grants are carrier-gated (a grant clamps to its carrying
// node's resolved weight), so the request clamps to 3 and the bistable
// geometry is UNREACHABLE: nothing a grant confers can out-class the ops
// that decide its own verdict. The live variant therefore converges here -
// see the demotion branch for the ungated split-brain demonstration. That
// does not make live reads safe in general; the prohibition stands.

async function raceScenario(t, variant) {
  const g = await create(t, null, {})
  const a = await create(t, g.key, {})
  const d = await create(t, g.key, {})
  const b = await create(t, g.key, {})

  let conferA = null
  if (variant === 'app') {
    await g.append(encode({ appBootstrapAdmin: true }))
    const boot = { key: b4a.toString(g.local.key, 'hex'), length: g.local.length }
    await g.append(encode({ appPromote: b4a.toString(a.local.key, 'hex'), cite: boot }))
    conferA = { key: b4a.toString(g.local.key, 'hex'), length: g.local.length }
  }

  await g.append(encode({ addWriter: a.local.id, weight: 3 }))
  await g.append(encode({ addWriter: d.local.id, weight: 3 }))
  await g.append(encode({ addWriter: b.local.id, weight: 1 }))
  await replicateAndSync(g, a, d, b)

  await a.append(encode({ msg: 'a-cites' }))
  await d.append(encode({ msg: 'd-cites' }))
  await b.append(encode({ msg: 'b-cites' }))
  await replicateAndSync(g, a, d, b)

  const recA = await a.system.get(a.local.key)
  t.ok(recA.weight >= 3, 'granter resolved admin before the race')

  await d.append(encode({ demoteWriter: a.local.id, weight: 1 }))
  await new Promise((resolve) => setTimeout(resolve, 5))

  if (variant === 'app') {
    await a.append(encode({ appPromote: b4a.toString(b.local.key, 'hex'), cite: conferA }))
  } else if (variant === 'carrier') {
    await a.append(encode({ promoteAdminCarrier: b.local.id }))
  } else if (variant === 'pinned') {
    const grant = await a.system.strongestGrant(a.local.key)
    await a.append(
      encode({
        promoteAdminPinned: b.local.id,
        link: { key: b4a.toString(grant.key, 'hex'), length: grant.length }
      })
    )
  } else {
    await a.append(encode({ promoteAdmin: b.local.id }))
  }

  await replicateAndSync(a, b)
  await b.append(encode({ msg: 'claim' }))
  await replicateAndSync(a, b)

  await replicateAndSync(g, d)
  await replicateAndSync(g, a, d, b)
  await replicateAndSync(g, a, d, b)

  const out = []
  for (const [name, auto] of [
    ['a', a],
    ['b', b],
    ['g', g],
    ['d', d]
  ]) {
    const rec = await auto.system.get(b.local.key)
    const nodes = await auto.replay()
    out.push({
      name,
      max: rec ? rec.maxWeight : null,
      order: nodes
        .map((n) => `${b4a.toString(n.key, 'hex').slice(0, 8)}:${n.length}:w${n.weight}`)
        .join(' ')
    })
  }
  return out
}

test('live-state grant condition can no longer split the brain under carrier-gated grants', async function (t) {
  const [a, b, g, d] = await raceScenario(t, 'live')

  for (const peer of [a, b, g, d]) {
    t.is(
      peer.max,
      1,
      `${peer.name}: verdict uniform - the earlier demote wins the same-class tiebreak everywhere`
    )
    t.is(peer.order, a.order, `${peer.name}: identical replay everywhere`)
  }
})

test('pinned grant condition converges under the identical race', async function (t) {
  const [a, b, g, d] = await raceScenario(t, 'pinned')

  for (const peer of [a, b, g, d]) {
    t.is(peer.max, 3, `${peer.name}: grant held everywhere (clamped to the carrier)`)
    t.is(peer.order, a.order, `${peer.name}: identical replay everywhere`)
  }
})

// The recommended form: condition on the CARRIER node's resolved weight
// (node.weight in apply). resolveWeight is already a pinned function of the
// carrier's causal past, so the verdict is arrival-independent with no extra
// wire format. The racing demotion cannot flip it - the granter has not cited
// its demotion, so its carrier resolves admin on every peer
test('carrier-weight grant condition converges under the identical race', async function (t) {
  const [a, b, g, d] = await raceScenario(t, 'carrier')

  for (const peer of [a, b, g, d]) {
    t.is(peer.max, 3, `${peer.name}: grant held everywhere (clamped to the carrier)`)
    t.is(peer.order, a.order, `${peer.name}: identical replay everywhere`)
  }
})

// ...and revocation binds exactly when the granter's own chain acknowledges
// the demotion: the citing append lowers every later carrier everywhere, so
// the same grant uniformly fails. Voluntary, but never divergent
// The layering keet needs: the APP owns admin semantics, independent of
// weights, and its verdict gates the grant. Safe form: the appender decides
// against its own local view - which is exactly its causal past, since the
// node links its heads - and the op cites the app-level fact it relied on
// (the conferral op that made its author a keet-admin). The app's apply
// handler verifies by point lookup against append-only facts keyed by op
// coordinate in its own view (kconf/<coord> -> conferred key). A cited fact
// sits in the node's causal past, so it is applied before the node in EVERY
// interleaving and the lookup is arrival-independent - the identical race
// (system demotion of the granter, opposite arrival orders) cannot touch it
test('app-owned admin semantics via citation converge under the identical race', async function (t) {
  const [a, b, g, d] = await raceScenario(t, 'app')

  for (const peer of [a, b, g, d]) {
    t.is(peer.max, 3, `${peer.name}: app-gated grant held everywhere (clamped to the carrier)`)
    t.is(peer.order, a.order, `${peer.name}: identical replay everywhere`)
  }
})

test('carrier-weight condition uniformly refuses a granter that cited its demotion', async function (t) {
  const g = await create(t, null, {})
  const a = await create(t, g.key, {})
  const b = await create(t, g.key, {})

  await g.append(encode({ addWriter: a.local.id, weight: 3 }))
  await g.append(encode({ addWriter: b.local.id, weight: 1 }))
  await replicateAndSync(g, a, b)
  await a.append(encode({ msg: 'a-cites' }))
  await replicateAndSync(g, a, b)

  await g.append(encode({ demoteWriter: a.local.id, weight: 1 }))
  await replicateAndSync(g, a, b)

  await a.append(encode({ msg: 'a-cites-demotion' }))
  await replicateAndSync(g, a, b)

  const recA = await a.system.get(a.local.key)
  t.is(recA.weight, 1, 'granter acknowledged its demotion')

  await a.append(encode({ promoteAdminCarrier: b.local.id }))
  await replicateAndSync(g, a, b)

  for (const [name, auto] of [
    ['a', a],
    ['b', b],
    ['g', g]
  ]) {
    const rec = await auto.system.get(b.local.key)
    t.is(rec.maxWeight, 1, `${name}: grant refused everywhere`)
  }
})
