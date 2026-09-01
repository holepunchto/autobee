const test = require('brittle')
const b4a = require('b4a')
const { create, replicateAndSync, encode } = require('./helpers')

async function forceWitness(auto, value, witness) {
  const links = auto.system.getLinks(auto.local.key)
  const ts = Math.max(auto._now(), auto.system.timestamp)
  const ref = { pointer: 0, data: witness }
  auto.writers.appendLocal(encode(value), ts, { start: 0, end: 0 }, links, false, ref)
  await auto._bump()
}

function nodesOf(replay, key) {
  return replay.filter((n) => b4a.equals(n.key, key))
}

test('witness - grant-linked elevation works end to end', async function (t) {
  const a = await create(t)
  const b = await create(t, a.key)
  const c = await create(t, a.key)

  await a.append(encode({ addWriter: b.local.id, weight: 2 }))
  await replicateAndSync(a, b, c)
  t.ok(b.writable, 'b writable')

  await b.append(encode({ msg: 'from b' }))
  await replicateAndSync(a, b, c)

  for (const [name, auto] of [
    ['a', a],
    ['b', b],
    ['c', c]
  ]) {
    const mine = nodesOf(await auto.replay(), b.local.key)
    t.is(mine.length, 1, `${name}: b has one node`)
    t.is(mine[0].weight, 2, `${name}: elevated to 2`)
    t.ok(mine[0].witness, `${name}: carries a witness`)
  }
})

test('witness - elevation survives removal of the granter', async function (t) {
  const a = await create(t)
  const b = await create(t, a.key)
  const c = await create(t, a.key)

  await a.append(encode({ addWriter: c.local.id, weight: 2 }))
  await a.append(encode({ addWriter: b.local.id, weight: 2 }))
  await replicateAndSync(a, b, c)

  await b.append(encode({ msg: 'from b' }))
  await replicateAndSync(a, b, c)

  await c.append(encode({ removeWriter: a.local.id }))
  await replicateAndSync(b, c)

  await b.append(encode({ msg: 'from b again' }))
  await replicateAndSync(b, c)

  for (const [name, auto] of [
    ['b', b],
    ['c', c]
  ]) {
    const mine = nodesOf(await auto.replay(), b.local.key)
    t.is(mine.length, 2, `${name}: b has two nodes`)
    t.is(mine[0].weight, 2, `${name}: first node still 2`)
    t.is(mine[1].weight, 2, `${name}: post-removal node still 2`)
  }
})

test('witness - either of two concurrent equal grants justifies a claim', async function (t) {
  const a = await create(t)
  const b = await create(t, a.key)
  const c = await create(t, a.key)

  await a.append(encode({ addWriter: c.local.id, weight: 2 }))
  await replicateAndSync(a, b, c)

  await a.append(encode({ addWriter: b.local.id, weight: 2 }))
  await c.append(encode({ addWriter: b.local.id, weight: 2 }))
  await replicateAndSync(a, b, c)

  await replicateAndSync(a, b, c)

  await b.append(encode({ msg: 'from b' }))
  await replicateAndSync(a, b, c)

  for (const [name, auto] of [
    ['a', a],
    ['b', b],
    ['c', c]
  ]) {
    const hint = await auto.system.grantHint(b.local.key)
    t.is(hint.weight, 2, `${name}: an anchor covers the concurrent grants`)
    const mine = nodesOf(await auto.replay(), b.local.key)
    t.is(mine[mine.length - 1].weight, 2, `${name}: elevated to 2`)
  }
})

test('witness - claim above the cited grant floors on every peer', async function (t) {
  const a = await create(t)
  const b = await create(t, a.key)
  const c = await create(t, a.key)

  await a.append(encode({ addWriter: b.local.id, weight: 1 }))
  await a.append(encode({ addWriter: c.local.id, weight: 2 }))
  await replicateAndSync(a, b, c)

  const grant = await b.system.grantHint(b.local.key)
  t.is(grant.weight, 1, 'b was granted 1')

  await forceWitness(
    b,
    { msg: 'inflated' },
    {
      weight: 3,
      link: { key: grant.key, length: grant.length }
    }
  )
  await replicateAndSync(a, b, c)

  await b.append(encode({ msg: 'honest' }))
  await replicateAndSync(a, b, c)

  for (const [name, auto] of [
    ['a', a],
    ['b', b],
    ['c', c]
  ]) {
    const mine = nodesOf(await auto.replay(), b.local.key)
    t.is(mine.length, 2, `${name}: b has two nodes`)
    t.is(mine[0].weight, 0, `${name}: inflated claim floored at prev standing, not 3`)
    t.is(mine[1].weight, 1, `${name}: honest claim still elevates to the real grant`)
  }
})

test('witness - naked link (not a grant) floors on every peer', async function (t) {
  const a = await create(t)
  const b = await create(t, a.key)
  const c = await create(t, a.key)

  await a.append(encode({ addWriter: b.local.id, weight: 1 }))
  await a.append(encode({ addWriter: c.local.id, weight: 2 }))
  await replicateAndSync(a, b, c)

  await c.append(encode({ msg: 'just a message' }))
  await replicateAndSync(a, b, c)

  const cInfo = await b.system.get(c.local.key)
  const link = { key: c.local.key, length: cInfo.length }

  await forceWitness(b, { msg: 'naked' }, { weight: 2, link })
  await replicateAndSync(a, b, c)

  await b.append(encode({ msg: 'honest' }))
  await replicateAndSync(a, b, c)

  for (const [name, auto] of [
    ['a', a],
    ['b', b],
    ['c', c]
  ]) {
    const mine = nodesOf(await auto.replay(), b.local.key)
    t.is(mine[0].weight, 0, `${name}: floored, no elevation from a non-grant`)
    t.is(mine[1].weight, 1, `${name}: honest claim still elevates`)
  }
})

test('witness - a grant to another writer does not justify our claim', async function (t) {
  const a = await create(t)
  const b = await create(t, a.key)
  const c = await create(t, a.key)

  await a.append(encode({ addWriter: b.local.id, weight: 1 }))
  await a.append(encode({ addWriter: c.local.id, weight: 3 }))
  await replicateAndSync(a, b, c)

  const cGrant = await b.system.grantHint(c.local.key)
  t.is(cGrant.weight, 3, 'c was granted 3')

  await forceWitness(
    b,
    { msg: 'stolen' },
    {
      weight: 3,
      link: { key: cGrant.key, length: cGrant.length }
    }
  )
  await replicateAndSync(a, b, c)

  await b.append(encode({ msg: 'honest' }))
  await replicateAndSync(a, b, c)

  for (const [name, auto] of [
    ['a', a],
    ['b', b],
    ['c', c]
  ]) {
    const mine = nodesOf(await auto.replay(), b.local.key)
    t.is(mine[0].weight, 0, `${name}: floored at b's own grant`)
    t.is(mine[1].weight, 1, `${name}: honest claim still elevates`)
  }
})
