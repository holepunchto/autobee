const test = require('brittle')
const { create, replicateAndSync, encode } = require('./helpers')
const encoding = require('../lib/encoding.js')

test('rolling hash - peers agree after concurrent forks merge', async function (t) {
  const a = await create(t)
  const b = await create(t, a.key)
  const c = await create(t, a.key)

  await a.append(encode({ addWriter: b.local.id }))
  await a.append(encode({ addWriter: c.local.id }))
  await replicateAndSync(a, b, c)

  await a.append(encode({ m: 'a1' }))
  await b.append(encode({ m: 'b1' }))
  await c.append(encode({ m: 'c1' }))
  await replicateAndSync(a, b, c)

  t.ok(a.system.hash, 'hash is set once nodes have applied')
  t.is(a.system.hash.byteLength, 8, 'eight bytes')
  t.alike(a.system.hash, b.system.hash, 'a and b hash the same applied order')
  t.alike(a.system.hash, c.system.hash, 'a and c hash the same applied order')
})

test('rolling hash - the hash advances with the applied order', async function (t) {
  const a = await create(t)

  await a.append(encode({ m: 'one' }))
  await a.updated()
  const first = a.system.hash

  await a.append(encode({ m: 'two' }))
  await a.updated()

  t.ok(first, 'hash set after the first apply')
  t.unlike(a.system.hash, first, 'hash moved on')
})

test('rolling hash - stamped on the batch head only', async function (t) {
  const a = await create(t)

  await a.append(encode({ m: 'seed' }))
  await a.updated()

  const before = a.local.length
  await a.append([encode({ m: 'b0' }), encode({ m: 'b1' }), encode({ m: 'b2' })])
  await a.updated()

  const nodes = []
  for (let seq = before; seq < a.local.length; seq++) {
    nodes.push(encoding.decodeOplog(await a.local.get(seq)))
  }

  t.is(nodes.length, 3, 'three nodes appended')
  t.is(nodes[0].batch.start, 0, 'first is the batch head')
  t.ok(nodes[0].hash, 'the head carries the hash')
  t.is(nodes[0].hash.byteLength, 8, 'eight bytes')
  t.absent(nodes[1].hash, 'tail carries none')
  t.absent(nodes[2].hash, 'tail carries none')
})
