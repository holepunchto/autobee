const test = require('brittle')
const b4a = require('b4a')
const { create, replicateAndSync, encode } = require('./helpers')

// Evidence file for the conditional-grant design rule. A grant condition
// evaluated against LIVE apply state makes the verdict a function of where
// concurrent ops happen to sort; scoped to the op's causal past (a cited
// grant, the carrier weight, or an app-level citation) it has one fixed
// point. The ungated split-brain demonstration lives on the demotion branch;
// on this branch grants are carrier-gated, which makes the bistable geometry
// structurally unreachable (a grant can never confer above its carrier, so a
// citation can never out-class the ops deciding its own verdict), and every
// variant here must converge.
//
// The apply handlers live in ./helpers: promoteAdmin (live register read),
// promoteAdminPinned (cited grant), promoteAdminCarrier (node.weight), and
// appPromote (app-owned conferral facts). All request weight 5, which the
// gate clamps to the promoting carrier.

async function collect(pool, key) {
  const out = []
  for (const [name, auto] of pool) {
    const rec = await auto.system.get(key)
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

// the monotone analogue of the old demotion race: the op that changes the
// live condition's input is a concurrent ELEVATION of the granter, delivered
// to different peers on opposite sides of the promote
test('live-state grant condition stays uniform under a racing elevation', async function (t) {
  const g = await create(t, null, {})
  const a = await create(t, g.key, {})
  const d = await create(t, g.key, {})
  const b = await create(t, g.key, {})

  await g.append(encode({ addWriter: a.local.id, weight: 1 }))
  await g.append(encode({ addWriter: d.local.id, weight: 1 }))
  await g.append(encode({ addWriter: b.local.id, weight: 1 }))
  await replicateAndSync(g, a, d, b)
  await a.append(encode({ msg: 'a-cites' }))
  await replicateAndSync(g, a, d, b)

  await g.append(encode({ addWriter: a.local.id, weight: 3 }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  await a.append(encode({ promoteAdmin: b.local.id }))

  await replicateAndSync(a, b)
  await b.append(encode({ msg: 'claim' }))
  await replicateAndSync(a, b)

  await replicateAndSync(g, d)
  await replicateAndSync(g, a, d, b)
  await replicateAndSync(g, a, d, b)

  const peers = await collect(
    [
      ['a', a],
      ['b', b],
      ['g', g],
      ['d', d]
    ],
    b.local.key
  )
  for (const peer of peers) {
    t.is(peer.max, peers[0].max, `${peer.name}: verdict uniform on every peer`)
    t.is(peer.order, peers[0].order, `${peer.name}: identical replay everywhere`)
  }
})

async function promoteScenario(t, variant) {
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
  t.ok(recA.weight >= 3, 'granter resolved admin before promoting')

  if (variant === 'app') {
    await a.append(encode({ appPromote: b4a.toString(b.local.key, 'hex'), cite: conferA }))
  } else if (variant === 'carrier') {
    await a.append(encode({ promoteAdminCarrier: b.local.id }))
  } else {
    const grant = await a.system.strongestGrant(a.local.key)
    await a.append(
      encode({
        promoteAdminPinned: b.local.id,
        link: { key: b4a.toString(grant.key, 'hex'), length: grant.length }
      })
    )
  }

  await replicateAndSync(a, b)
  await b.append(encode({ msg: 'claim' }))
  await replicateAndSync(a, b)

  await replicateAndSync(g, a, d, b)
  await replicateAndSync(g, a, d, b)

  return collect(
    [
      ['a', a],
      ['b', b],
      ['g', g],
      ['d', d]
    ],
    b.local.key
  )
}

test('pinned grant condition converges under split arrival', async function (t) {
  const peers = await promoteScenario(t, 'pinned')
  for (const peer of peers) {
    t.is(peer.max, 3, `${peer.name}: grant held everywhere (clamped to the carrier)`)
    t.is(peer.order, peers[0].order, `${peer.name}: identical replay everywhere`)
  }
})

test('carrier-weight grant condition converges under split arrival', async function (t) {
  const peers = await promoteScenario(t, 'carrier')
  for (const peer of peers) {
    t.is(peer.max, 3, `${peer.name}: grant held everywhere (clamped to the carrier)`)
    t.is(peer.order, peers[0].order, `${peer.name}: identical replay everywhere`)
  }
})

test('app-owned admin semantics via citation converge under split arrival', async function (t) {
  const peers = await promoteScenario(t, 'app')
  for (const peer of peers) {
    t.is(peer.max, 3, `${peer.name}: app-gated grant held everywhere (clamped to the carrier)`)
    t.is(peer.order, peers[0].order, `${peer.name}: identical replay everywhere`)
  }
})
