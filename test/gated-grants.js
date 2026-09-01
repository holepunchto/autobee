const test = require('brittle')
const b4a = require('b4a')
const { create, replicate, replicateAndSync, sync, encode } = require('./helpers')

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

test('gated grants - a grant clamps until a qualified peer sees it', async function (t) {
  const g = await create(t)
  const m = await create(t, g.key)
  const b = await create(t, g.key)

  await g.append(encode({ addWriter: m.local.id, weight: 2 }))
  await replicateAndSync(g, m, b)
  await m.append(encode({ msg: 'm-cites' }))
  await replicateAndSync(g, m, b)

  await m.append(encode({ addWriter: b.local.id, weight: 3 }))
  await replicateAndSync(m, b)
  await b.append(encode({ msg: 'b-cites-the-clamp' }))
  await replicateAndSync(m, b)

  for (const [name, auto] of [
    ['m', m],
    ['b', b]
  ]) {
    const rec = await weightOf(auto, b.local.key)
    t.is(rec.max, 2, `${name}: capability clamped to the granter standing`)
    t.is(rec.w, 2, `${name}: citation resolves the clamped weight`)
    t.is(await auto.system.pendingPromotion(b.local.key), 3, `${name}: the surplus is pending`)
  }

  await replicateAndSync(g, m, b)
  await replicateAndSync(g, m, b)
  await b.append(encode({ msg: 'b-cites-the-approval' }))
  await replicateAndSync(g, m, b)

  for (const [name, auto] of [
    ['g', g],
    ['m', m],
    ['b', b]
  ]) {
    const rec = await weightOf(auto, b.local.key)
    t.is(rec.max, 3, `${name}: a qualified peer approved the pending promotion internally`)
    t.is(rec.w, 3, `${name}: citation resolves the approved weight`)
    t.is(await auto.system.pendingPromotion(b.local.key), 0, `${name}: pending cleared`)
  }
})

test('gated grants - the approval op is citable like any grant', async function (t) {
  const g = await create(t)
  const m = await create(t, g.key)
  const b = await create(t, g.key)

  await g.append(encode({ addWriter: m.local.id, weight: 2 }))
  await replicateAndSync(g, m, b)
  await m.append(encode({ addWriter: b.local.id, weight: 3 }))
  await replicateAndSync(g, m, b)
  await replicateAndSync(g, m, b)

  const approved = await b.system.grantHint(b.local.key)
  t.ok(approved && approved.weight === 3, 'the internal approval landed as the grant hint')
  t.ok(b4a.equals(approved.key, g.local.key), 'anchored at the qualified approver op')

  await b.append(encode({ msg: 'claim' }))
  await replicateAndSync(g, m, b)
  for (const [name, auto] of [
    ['g', g],
    ['m', m],
    ['b', b]
  ]) {
    const rec = await weightOf(auto, b.local.key)
    t.is(rec.w, 3, `${name}: witness citing the approval resolves everywhere`)
  }
})

test('gated grants - an ack racing removal of the acker converges', async function (t) {
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

  await d.append(encode({ removeWriter: a.local.id }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  await a.append(encode({ addWriter: b.local.id, weight: 3 }))

  await replicateAndSync(a, b)
  await b.append(encode({ msg: 'claim' }))
  await replicateAndSync(a, b)

  await replicateAndSync(g, d)
  await replicateAndSync(g, a, d, b)
  await replicateAndSync(g, a, d, b)

  const orders = new Set()
  const peers0max = (await weightOf(a, b.local.key)).max
  for (const [name, auto] of [
    ['a', a],
    ['b', b],
    ['g', g],
    ['d', d]
  ]) {
    const rec = await weightOf(auto, b.local.key)
    t.is(rec.max, peers0max, `${name}: same verdict on every peer`)
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

// approvals are collected at APPEND time, never stamped at flush: the local
// apply pass consumes the pending node object before flush encodes it, so a
// flush-time field would be applied by every remote but never by the
// approver itself - this test pins the approver/remote agreement that
// property guarantees, and that the wire field is where the entry says it is
test('gated grants - the approver indexes its own approval like every remote', async function (t) {
  const encoding = require('../lib/encoding.js')
  const g = await create(t)
  const m = await create(t, g.key)
  const b = await create(t, g.key)

  await g.append(encode({ addWriter: m.local.id, weight: 2 }))
  await replicateAndSync(g, m, b)
  await m.append(encode({ addWriter: b.local.id, weight: 3 }))

  const links = g.system.getLinks(g.local.key)
  g.writers.appendLocal(
    encode({ msg: 'carrier' }),
    Date.now(),
    { start: 0, end: 0 },
    links,
    false,
    null
  )

  await replicateAndSync(g, m, b)
  await replicateAndSync(g, m, b)

  const approval = await g.system.grantHint(b.local.key)
  t.ok(approval && approval.weight === 3, 'approval landed')
  t.ok(b4a.equals(approval.key, g.local.key), 'authored by the qualified peer')

  const node = encoding.decodeOplog(await g.local.get(approval.length - 1))
  t.is(node.approvals.length, 1, 'the entry coordinate carries the wire field')
  t.ok(b4a.equals(node.approvals[0].key, b.local.key), 'for the proposed writer')

  for (const [name, auto] of [
    ['g', g],
    ['m', m],
    ['b', b]
  ]) {
    const rec = await auto.system.get(b.local.key)
    t.is(rec.maxWeight, 3, `${name}: approver and remotes agree on the approved state`)
    t.is(await auto.system.pendingPromotion(b.local.key), 0, `${name}: pending cleared everywhere`)
  }
})
test('gated grants - the hint stays one entry per writer across grants', async function (t) {
  const g = await create(t)
  const b = await create(t, g.key)

  await g.append(encode({ addWriter: b.local.id, weight: 2 }))
  await replicateAndSync(g, b)
  await replicateAndSync(g, b)
  const first = await g.system.grantHint(b.local.key)
  t.is(first.weight, 2, 'anchored at 2')

  await g.append(encode({ addWriter: b.local.id, weight: 3 }))
  await replicateAndSync(g, b)
  await replicateAndSync(g, b)

  await b.append(encode({ msg: 'claim' }))
  await replicateAndSync(g, b)

  for (const [name, auto] of [
    ['g', g],
    ['b', b]
  ]) {
    const rec = await weightOf(auto, b.local.key)
    t.is(rec.w, 3, `${name}: resolution followed the strongest anchor`)
    const hint = await auto.system.grantHint(b.local.key)
    t.is(hint.weight, 3, `${name}: single hint entry, strongest wins`)
  }
})

test('gated grants - hint and pending prune on removal', async function (t) {
  const g = await create(t)
  const m = await create(t, g.key)
  const b = await create(t, g.key)

  await g.append(encode({ addWriter: m.local.id, weight: 2 }))
  await replicateAndSync(g, m, b)
  await m.append(encode({ addWriter: b.local.id, weight: 5 }))
  await replicateAndSync(g, m, b)

  t.ok(await g.system.grantHint(b.local.key), 'hint live before removal')
  t.is(await g.system.pendingPromotion(b.local.key), 5, 'pending live before removal')

  await g.append(encode({ removeWriter: b.local.id }))
  await replicateAndSync(g, m, b)

  for (const [name, auto] of [
    ['g', g],
    ['m', m]
  ]) {
    t.is(await auto.system.grantHint(b.local.key), null, `${name}: hint pruned on removal`)
    t.is(await auto.system.pendingPromotion(b.local.key), 0, `${name}: pending pruned on removal`)
  }
})

test('gated grants - an unfulfillable pending promotion persists and is listable', async function (t) {
  const g = await create(t)
  const m = await create(t, g.key)
  const b = await create(t, g.key)

  await g.append(encode({ addWriter: m.local.id, weight: 2 }))
  await replicateAndSync(g, m, b)
  await m.append(encode({ addWriter: b.local.id, weight: 5 }))
  await replicateAndSync(g, m, b)
  await replicateAndSync(g, m, b)

  for (const [name, auto] of [
    ['g', g],
    ['m', m],
    ['b', b]
  ]) {
    t.is(
      await auto.system.pendingPromotion(b.local.key),
      5,
      `${name}: nobody stands at 5, the request outlives every approval pass`
    )
  }

  const listed = []
  for await (const entry of g.system.listPendingPromotions()) listed.push(entry)
  t.is(listed.length, 1, 'one pending promotion listed')
  t.ok(b4a.equals(listed[0].key, b.local.key), 'listed for the proposed writer')
  t.is(listed[0].weight, 5, 'listed at the requested weight')
})

test('gated grants - pending promotions are visible from a fast-forwarded boot snapshot', async function (t) {
  const g = await create(t, {
    mostRecentTrusted: () => ({ key: g.local.key, length: g.local.length })
  })
  const m = await create(t, g.key)
  const b = await create(t, g.key)

  await g.append(encode({ addWriter: m.local.id, weight: 2 }))
  await replicateAndSync(g, m, b)
  await m.append(encode({ addWriter: b.local.id, weight: 5 }))
  await replicateAndSync(g, m, b)

  for (let i = 0; i < 40; i++) await g.append(encode({ value: 'filler' + i }))

  const observer = await create(t, g.key, {
    isTrusted: () => true,
    fastForward: {
      boot: {
        head: { key: g.local.key, length: g.local.length }
      }
    }
  })

  const done = replicate(g, observer)
  await new Promise((resolve) => observer.once('move-to', resolve))
  await sync(g, observer)
  await done()

  t.is(
    await observer.system.pendingPromotion(b.local.key),
    5,
    'pending visible from state alone - no oplog replay needed to know who to approve'
  )
  const listed = []
  for await (const entry of observer.system.listPendingPromotions()) listed.push(entry)
  t.is(listed.length, 1, 'listable for post-fast-forward granting')
})

test('gated grants - a removed approver anchor stays verifiable', async function (t) {
  const g = await create(t)
  const a = await create(t, g.key)
  const b = await create(t, g.key)

  await g.append(encode({ addWriter: a.local.id, weight: 3 }))
  await replicateAndSync(g, a, b)
  await a.append(encode({ msg: 'a-cites' }))
  await replicateAndSync(g, a, b)

  await a.append(encode({ addWriter: b.local.id, weight: 3 }))
  await replicateAndSync(g, a, b)
  await replicateAndSync(g, a, b)

  const hint = await b.system.grantHint(b.local.key)
  t.ok(b4a.equals(hint.key, a.local.key), 'anchored by a')

  await g.append(encode({ removeWriter: a.local.id }))
  await replicateAndSync(g, a, b)

  await b.append(encode({ msg: 'claim' }))
  await replicateAndSync(g, b)

  for (const [name, auto] of [
    ['g', g],
    ['b', b]
  ]) {
    const rec = await auto.system.get(b.local.key)
    t.is(rec.weight, 3, `${name}: citation through the removed approver chain verifies`)
  }
})

// a removal racing the anchor does NOT doom a referenced claim: the citation
// is a hard dep, so the anchor gains referrals and applies past the removal
// length - the hammer stops unreferenced future work, not cited history
test('gated grants - a claim citing an anchor that raced the removal still lands', async function (t) {
  const g = await create(t)
  const a = await create(t, g.key)
  const b = await create(t, g.key)

  await g.append(encode({ addWriter: a.local.id, weight: 3 }))
  await g.append(encode({ addWriter: b.local.id, weight: 1 }))
  await replicateAndSync(g, a, b)
  await a.append(encode({ msg: 'a-cites' }))
  await replicateAndSync(g, a, b)
  await b.append(encode({ msg: 'b-cites' }))
  await replicateAndSync(g, a, b)

  await a.append(encode({ addWriter: b.local.id, weight: 3 }))
  await replicateAndSync(a, b)
  await replicateAndSync(a, b)
  await b.append(encode({ msg: 'doomed claim' }))
  await replicateAndSync(a, b)

  await g.append(encode({ removeWriter: a.local.id }))
  await replicateAndSync(g, a, b)
  await replicateAndSync(g, a, b)

  const orders = new Set()
  for (const [name, auto] of [
    ['g', g],
    ['a', a],
    ['b', b]
  ]) {
    const rec = await auto.system.get(b.local.key)
    t.is(rec.weight, 3, `${name}: the referenced anchor applied past the removal`)
    const nodes = await auto.replay()
    orders.add(nodes.map((n) => `${b4a.toString(n.key, 'hex').slice(0, 8)}:${n.length}`).join(' '))
  }
  t.is(orders.size, 1, 'every peer converges on the same order')
})
