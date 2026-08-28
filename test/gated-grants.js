const test = require('brittle')
const b4a = require('b4a')
const { create, replicateAndSync, encode } = require('./helpers')

// Scheme: a grant is capped at its carrying node's resolved weight, so
// weight classes are self-governing - only a peer standing at w (or above)
// can confer w. The "ack" of a two-phase promotion is simply a grant
// re-issued by a qualified peer: same log, same coordinates, same witness
// citation as any grant, so no new index surface and no new verification
// path. The carrier weight is pinned (lib/witness.js), so every verdict here
// is arrival-independent by construction. Pending/proposal state is UX only
// and must never be read by validity - a "most recent proposal" check is a
// register read and reintroduces split-brain.

async function weightOf(auto, key) {
  const rec = await auto.system.get(key)
  return rec ? { max: rec.maxWeight, w: rec.weight } : null
}

test('gated grants - a grant clamps to the granter carrier weight', async function (t) {
  const g = await create(t)
  const m = await create(t, g.key)
  const b = await create(t, g.key)

  await g.append(encode({ addWriter: m.local.id, weight: 2 }))
  await replicateAndSync(g, m, b)
  await m.append(encode({ msg: 'm-cites' }))
  await replicateAndSync(g, m, b)

  await m.append(encode({ addWriter: b.local.id, weight: 3 }))
  await replicateAndSync(g, m, b)
  await b.append(encode({ msg: 'b-cites' }))
  await replicateAndSync(g, m, b)

  for (const [name, auto] of [
    ['g', g],
    ['m', m],
    ['b', b]
  ]) {
    const rec = await weightOf(auto, b.local.key)
    t.is(rec.max, 2, `${name}: capability clamped to the granter standing`)
    t.is(rec.w, 2, `${name}: citation resolves the clamped weight`)
  }
})

test('gated grants - a qualified ack elevates a clamped promotion', async function (t) {
  const g = await create(t)
  const m = await create(t, g.key)
  const b = await create(t, g.key)

  await g.append(encode({ addWriter: m.local.id, weight: 2 }))
  await replicateAndSync(g, m, b)
  await m.append(encode({ addWriter: b.local.id, weight: 3 }))
  await replicateAndSync(g, m, b)

  await g.append(encode({ addWriter: b.local.id, weight: 3 }))
  await replicateAndSync(g, m, b)
  await b.append(encode({ msg: 'b-cites-the-ack' }))
  await replicateAndSync(g, m, b)

  for (const [name, auto] of [
    ['g', g],
    ['m', m],
    ['b', b]
  ]) {
    const rec = await weightOf(auto, b.local.key)
    t.is(rec.max, 3, `${name}: the qualified ack conferred the full weight`)
    t.is(rec.w, 3, `${name}: citation resolves the acked weight`)
  }
})

test('gated grants - an ack racing a demotion of the acker converges', async function (t) {
  const g = await create(t)
  const a = await create(t, g.key)
  const d = await create(t, g.key)
  const b = await create(t, g.key)

  await g.append(encode({ addWriter: a.local.id, weight: 3 }))
  await g.append(encode({ addWriter: d.local.id, weight: 3 }))
  await g.append(encode({ addWriter: b.local.id, weight: 1 }))
  await replicateAndSync(g, a, d, b)
  await a.append(encode({ msg: 'a-cites' }))
  await d.append(encode({ msg: 'd-cites' }))
  await replicateAndSync(g, a, d, b)

  await d.append(encode({ demoteWriter: a.local.id, weight: 1 }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  await a.append(encode({ addWriter: b.local.id, weight: 3 }))

  await replicateAndSync(a, b)
  await b.append(encode({ msg: 'claim' }))
  await replicateAndSync(a, b)

  await replicateAndSync(g, d)
  await replicateAndSync(g, a, d, b)
  await replicateAndSync(g, a, d, b)

  const orders = new Set()
  for (const [name, auto] of [
    ['a', a],
    ['b', b],
    ['g', g],
    ['d', d]
  ]) {
    const rec = await weightOf(auto, b.local.key)
    t.is(rec.max, 3, `${name}: the ack held - the acker never acknowledged its demotion`)
    const nodes = await auto.replay()
    orders.add(
      nodes
        .map((n) => `${b4a.toString(n.key, 'hex').slice(0, 8)}:${n.length}:w${n.weight}`)
        .join(' ')
    )
  }
  t.is(orders.size, 1, 'identical replay on all four peers')
})

test('gated grants - weight above the genesis root cannot be minted', async function (t) {
  const g = await create(t)
  const x = await create(t, g.key)
  const y = await create(t, g.key)

  await g.append(encode({ addWriter: x.local.id, weight: 3 }))
  await replicateAndSync(g, x, y)
  await x.append(encode({ msg: 'x-cites' }))
  await replicateAndSync(g, x, y)

  await x.append(encode({ addWriter: y.local.id, weight: 5 }))
  await replicateAndSync(g, x, y)
  await y.append(encode({ msg: 'y-cites' }))
  await replicateAndSync(g, x, y)

  for (const [name, auto] of [
    ['g', g],
    ['x', x],
    ['y', y]
  ]) {
    const rec = await weightOf(auto, y.local.key)
    t.is(rec.max, 3, `${name}: ceiling is the root standing, no minting above it`)
    t.is(rec.w, 3, `${name}: resolution respects the ceiling`)
  }
})
