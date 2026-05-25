const test = require('brittle')
const { create, replicate, replicateAndSync, encode, same, decode } = require('./helpers')
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
  const auto2 = await create(t, auto1.key)
  const auto3 = await create(t, auto1.key, { onwakeup: createOnWakeup('auto3') })

  await auto1.append(encode({ hello: 'world' }))
  await auto1.append(encode({ addWriter: auto2.local.id, weight: 1 }))

  await replicateAndSync(auto1, auto2, auto3)

  for (let i = 0; i < 100; i++) {
    await auto1.append(encode({ hello: 'world' + i }))
  }
  await auto3.writers.refresh()

  await replicateAndSync(auto1, auto2)

  const expected = auto1.system.bee.head()
  const moved = new Promise((resolve) => {
    auto3.on('move-to', (to) => {
      t.alike(to, expected)
      resolve()
    })
  })

  await auto2.append(encode({ hello: 'from auto2' }))

  t.comment('sync 2<>3')

  await replicateAndSync(auto1, auto2, auto3)
  await moved

  // replicate since auto3 is sparse now
  t.teardown(replicate(auto1, auto3))
  t.ok(await same(auto2, auto3))

  function createOnWakeup(name) {
    return async function (view) {
      const entry = await view.get(b4a.from('latest'))
      const data = decode(entry.value)

      t.is(name, 'auto3')
      t.alike(data, { hello: 'from auto2' })

      return { key: auto1.local.key, length: auto1.local.length }
    }
  }
})

test('wakeup - onwakeup via store', async function (t) {
  const auto1 = await create(t)
  const dir = await t.tmp()
  let auto2 = await create(t, auto1.key, { storage: dir })
  const auto3 = await create(t, auto1.key)
  const a2c3 = auto2.store.get(auto3.local.key)

  await auto1.append(encode({ hello: 'world' }))
  await auto1.append(encode({ addWriter: auto3.local.id, weight: 1 }))

  await replicateAndSync(auto1, auto2, auto3)

  await a2c3.ready()

  t.is(auto3.local.length, a2c3.length, 'auto2 got auto1 writer')
  await a2c3.close()
  t.ok(
    auto2.store.cores.map.has(auto3.local.discoveryKey.toString('hex')),
    'auto3 core loaded in auto2 before reopening'
  )
  await auto2.close()

  t.comment('reopen auto2 to clear corestore cores')
  auto2 = await create(t, auto1.key, { storage: dir })

  t.absent(
    auto2.store.cores.map.has(auto3.local.key.toString('hex')),
    'auto3 core not loaded in auto2 store after reopen'
  )

  // Only replicate stores so no wakeup protomux messages
  t.teardown(replicate(auto1.store, auto2.store))

  await auto2.writers.refresh()

  t.absent(
    auto2.store.cores.map.has(auto3.local.key.toString('hex')),
    'auto3 core not loaded in auto2 store after reopen'
  )
  t.absent(
    auto2.writers.has(auto3.local.key.toString('hex')),
    'auto3 core not loaded as active writer in auto2 after reopen'
  )

  await auto3.append(encode({ foo: 'bar' }))
  await replicateAndSync(auto1, auto3)

  t.ok(await same(auto2, auto3), 'autobees match')
  {
    const entry = await auto2.view.get(b4a.from('latest'))
    const data = decode(entry.value)
    t.alike(data, { foo: 'bar' }, 'auto2 has updates from auto3')
  }
})
