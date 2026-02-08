const test = require('brittle')
const b4a = require('b4a')
const { create, replicateAndSync, same, encode } = require('./helpers')

test('basic', async function (t) {
  const auto = await create(t)

  const val = encode({ hello: 'world' })
  await auto.append(val)

  const node = await auto.view.get(b4a.from('latest'))

  t.alike(node.value, val)
})

test('basic replication', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  const val = encode({ hello: 'world' })
  await auto1.append(val)

  await replicateAndSync(auto1, auto2)

  t.ok(await same(auto1, auto2))
})

test('basic replication (batch)', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  const val1 = encode({ hello: 'world' })
  const val2 = encode({ hej: 'verden' })
  await auto1.append([val1, val2])

  await replicateAndSync(auto1, auto2)

  t.ok(await same(auto1, auto2))
})

test('basic fork and replication', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ hello: 'world' }))
  await auto1.append(encode({ addWriter: auto2.local.id }))

  await replicateAndSync(auto1, auto2)

  await auto1.append(encode({ fork: 1 }))
  await auto2.append(encode({ fork: 2 }))

  await replicateAndSync(auto1, auto2)

  t.ok(await same(auto1, auto2))
})
