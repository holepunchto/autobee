const test = require('brittle')
const { create, replicateAndSync, encode, same, decode } = require('./helpers')
const b4a = require('b4a')

test('wakeup - replication', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)
  const auto3 = await create(t, auto1.key)

  await auto1.append(encode({ hello: 'world' }))
  await auto1.append(encode({ addWriter: auto2.local.id }))

  await replicateAndSync(auto1, auto2, auto3)

  await auto2.append(encode({ hello: 'from auto2' }))

  t.comment('sync 2<>3')
  await replicateAndSync(auto2, auto3)

  t.is(auto1._wakeup._coupler.coupled.size, 2)
  t.is(auto2._wakeup._coupler.coupled.size, 2)

  t.ok(await same(auto2, auto3))
})

test('wakeup - onwakeup', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key, { onwakeup: createOnWakeup('auto2') })
  const auto3 = await create(t, auto1.key, { onwakeup: createOnWakeup('auto3') })

  await auto1.append(encode({ hello: 'world' }))
  await auto1.append(encode({ addWriter: auto2.local.id }))

  await replicateAndSync(auto1, auto2, auto3)

  await auto2.append(encode({ hello: 'from auto2' }))

  t.comment('sync 2<>3')
  await replicateAndSync(auto2, auto3)

  t.is(auto1._wakeup._coupler.coupled.size, 2)
  t.is(auto2._wakeup._coupler.coupled.size, 2)

  t.ok(await same(auto2, auto3))

  function createOnWakeup(name) {
    return async function (view) {
      const entry = await view.get(b4a.from('latest'))
      const data = decode(entry.value)

      t.is(name, 'auto3')
      t.is(data.addWriter, auto2.local.id)
    }
  }
})
