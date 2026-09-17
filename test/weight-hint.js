const test = require('brittle')
const { create, replicateAndSync, encode } = require('./helpers')
const encoding = require('../lib/encoding.js')

async function hints(auto, from = 0) {
  const out = []
  for (let seq = from; seq < auto.local.length; seq++) {
    out.push(encoding.decodeOplog(await auto.local.get(seq)).weightHint)
  }
  return out
}

test('weight hint - genesis stamps its bootstrap weight', async function (t) {
  const a = await create(t)

  await a.append(encode({ m: 'one' }))
  await a.updated()

  t.alike(await hints(a), [3], 'bootstrap weight is stamped')
})

test('weight hint - stamped on every node of a batch', async function (t) {
  const a = await create(t)

  await a.append(encode({ m: 'seed' }))
  await a.updated()

  const before = a.local.length
  await a.append([encode({ m: 'b0' }), encode({ m: 'b1' }), encode({ m: 'b2' })])
  await a.updated()

  t.alike(await hints(a, before), [3, 3, 3], 'readable from any block')
})

test('weight hint - matches the weight the node resolved to', async function (t) {
  const a = await create(t)
  const b = await create(t, a.key)

  await a.append(encode({ addWriter: b.local.id, weight: 1 }))
  await a.append(encode({ m: 'approve' }))
  await replicateAndSync(a, b)

  await b.append(encode({ m: 'b0' }))
  await replicateAndSync(a, b)

  const rec = await a.system.get(b.local.key)
  t.is(rec.weight, 1, 'the citation resolved the grant')
  t.alike(await hints(b), [1], 'the hint matches the resolved weight')
})

test('weight hint - monotone across a promotion', async function (t) {
  const a = await create(t)
  const b = await create(t, a.key)

  await a.append(encode({ addWriter: b.local.id, weight: 1 }))
  await a.append(encode({ m: 'approve-1' }))
  await replicateAndSync(a, b)

  await b.append(encode({ m: 'b0' }))
  await replicateAndSync(a, b)

  await a.append(encode({ addWriter: b.local.id, weight: 3 }))
  await a.append(encode({ m: 'approve-3' }))
  await replicateAndSync(a, b)

  await b.append(encode({ m: 'b1' }))
  await replicateAndSync(a, b)

  const seen = await hints(b)

  t.alike(seen, [1, 3], 'the hint rises with the grant')

  let prev = 0
  for (const w of seen) {
    t.ok(w >= prev, 'never drops')
    prev = w
  }
})

test('weight hint - absent on nodes that predate the field', async function (t) {
  const a = await create(t)

  await a.append(encode({ m: 'one' }))
  await a.updated()

  const oplog = encoding.decodeOplog(await a.local.get(0))
  delete oplog.weightHint

  t.is(encoding.decodeOplog(encoding.encodeOplog(oplog)).weightHint, 0, 'decodes as zero')
})
