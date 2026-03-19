const test = require('brittle')
const { create, replicateAndSync, encode, same } = require('./helpers')

test('basic - replication', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ hello: 'world' }))
  await auto1.append(encode({ addWriter: auto2.local.id }))

  await replicateAndSync(auto1, auto2)

  await auto2.append(encode({ hello: 'world' }))

  await replicateAndSync(auto1, auto2)

  t.ok(auto1._wakeup._coupler)
  t.ok(auto1._wakeup._session)
  t.ok(auto2._wakeup._coupler)
  t.ok(auto2._wakeup._session)

  await replicateAndSync(auto1, auto2)

  t.is(auto1._wakeup._coupler.coupled.size, 2)
  t.is(auto2._wakeup._coupler.coupled.size, 2)

  t.ok(await same(auto1, auto2))
})
