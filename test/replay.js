const test = require('brittle')
const b4a = require('b4a')
const Autobee = require('../index.js')
const { create, replicateAndSync, encode, decode } = require('./helpers')

function ids(nodes) {
  return nodes
    .map((n) => (n === null ? 'null' : `${b4a.toString(n.key, 'hex').slice(0, 8)}:${n.length}`))
    .join(' ')
}

async function expected(auto, n, opts) {
  const keep = (opts && opts.filter) || (() => true)
  const all = await auto.replay()
  return ids(all.filter((node) => node === null || keep(node)).slice(-n))
}

function positionOf(all, node) {
  return all.findIndex((n) => n !== null && n.length === node.length && b4a.equals(n.key, node.key))
}

function nodesOf(replay, key) {
  return replay.filter((n) => b4a.equals(n.key, key))
}

test('replay-last - matches the tail of replay()', async function (t) {
  const a = await create(t)

  for (let i = 0; i < 10; i++) {
    await a.append(encode({ msg: 'msg' + i }))
  }

  for (const n of [1, 2, 3, 9, 10, 11, 50]) {
    t.is(ids(await a.replayLast(n)), await expected(a, n), 'n=' + n)
  }
})

test('replay-last - returns raw replay nodes', async function (t) {
  const a = await create(t)

  await a.append(encode({ msg: 'one' }))
  await a.append(encode({ msg: 'two' }))

  const [node] = await a.replayLast(1)
  const all = await a.replay()
  const last = all[all.length - 1]

  t.ok(node.core, 'carries its core session')
  t.ok(Array.isArray(node.links), 'carries links')
  t.is(typeof node.weight, 'number', 'carries weight')
  t.is(typeof node.timestamp, 'number', 'carries timestamp')
  t.ok(b4a.isBuffer(node.value), 'value is a buffer')
  t.alike(decode(node.value), { msg: 'two' }, 'newest op last')

  t.alike(node.key, last.key, 'same node as replay() tail')
  t.is(node.length, last.length)
  t.is(node.weight, last.weight)
  t.alike(node.value, last.value)
})

test('replay-last - walks several top-up rounds', async function (t) {
  const a = await create(t)

  for (let i = 0; i < 200; i++) {
    await a.append(encode({ i }))
  }

  const opts = { filter: (node) => decode(node.value).i % 10 === 0 }

  t.is(ids(await a.replayLast(10, opts)), await expected(a, 10, opts), 'sparse filter')
  t.is(ids(await a.replayLast(3, opts)), await expected(a, 3, opts), 'sparse filter, n=3')
})

test('replay-last - keeps acks by default, isUserOp skips them', async function (t) {
  const a = await create(t)
  const b = await create(t, a.key, {
    ackThreshold: 1,
    isTrusted: (key) => !b4a.equals(key, a.local.key)
  })

  await a.append(encode({ addWriter: b.local.id, weight: 3 }))
  await replicateAndSync(a, b)

  await b.append(encode({ msg: 'from b' }))
  await replicateAndSync(a, b)

  t.ok(b._acking, 'b acks')

  for (let i = 0; i < 8; i++) {
    await a.append(encode({ msg: 'm' + i }))
    await replicateAndSync(a, b)
  }

  const all = await a.replay()

  t.ok(
    all.some((node) => node !== null && !Autobee.isUserOp(node)),
    'history contains acks'
  )

  const opts = { filter: Autobee.isUserOp }
  const ops = await a.replayLast(4, opts)
  for (const node of ops) t.ok(node.value && node.value.length, 'no acks with isUserOp')

  t.is(ids(ops), await expected(a, 4, opts), 'isUserOp')
  t.is(ids(await a.replayLast(4)), ids(all.slice(-4)), 'default keeps everything')
  t.is(ids(await a.replayLast(4, { filter: null })), ids(all.slice(-4)), 'null keeps everything')
  t.is(ids(await a.replayLast(all.length)), ids(all), 'whole replay')

  const tail = await a.replayLast(4)
  t.ok(
    tail.some((node) => node !== null && !Autobee.isUserOp(node)),
    'the tail itself contains acks'
  )
  t.ok(positionOf(all, ops[0]) < positionOf(all, tail[0]), 'isUserOp walked past the acks')
})

test('replay-last - a custom filter never sees a null', async function (t) {
  const a = await create(t)
  const b = await create(t, a.key)

  await a.append(encode({ addWriter: b.local.id, weight: 3 }))
  await replicateAndSync(a, b)

  await b.append(encode({ msg: 'from b' }))
  await a.append(encode({ msg: 'from a' }))
  await replicateAndSync(a, b)

  const mine = await a.replayLast(5, { filter: (node) => b4a.equals(node.key, b.local.key) })

  t.is(
    ids(mine),
    ids(
      nodesOf(await a.replay(), b.local.key)
        .filter(Autobee.isUserOp)
        .slice(-5)
    ),
    'narrowed to one writer'
  )

  await t.exception(
    a.replayLast(5, {
      filter: () => {
        throw new Error('boom')
      }
    }),
    /boom/,
    'a throwing filter is not swallowed'
  )
})

test('replay-last - identical on every peer', async function (t) {
  const a = await create(t)
  const b = await create(t, a.key)
  const c = await create(t, a.key)

  await a.append(encode({ addWriter: b.local.id, weight: 3 }))
  await a.append(encode({ addWriter: c.local.id, weight: 3 }))
  await replicateAndSync(a, b, c)

  for (let i = 0; i < 4; i++) {
    await a.append(encode({ a: i }))
    await b.append(encode({ b: i }))
    await c.append(encode({ c: i }))
    await replicateAndSync(a, b, c)
  }

  const orders = new Set()
  for (const auto of [a, b, c]) orders.add(ids(await auto.replayLast(5)))

  t.is(orders.size, 1, 'early stopping introduced no peer-local order')
})

test('replay-last - bounds and empty history', async function (t) {
  const a = await create(t)

  t.alike(await a.replayLast(5), [], 'empty history terminates')
  t.alike(await a.replayLast(0), [], 'n=0')
  t.alike(await a.replayLast(-1), [], 'negative n')
  t.alike(await a.replayLast(), [], 'no n')

  for (let i = 0; i < 3; i++) {
    await a.append(encode({ i }))
  }

  t.is((await a.replayLast(1.5)).length, 1, 'n floors')
  t.is(ids(await a.replayLast(1e6)), await expected(a, 1e6), 'n past the end')
})
