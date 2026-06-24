const test = require('brittle')
const Corestore = require('corestore')
const { create, replicate, replicateAndSync, encode, same, decode, apply } = require('./helpers')
const b4a = require('b4a')
const encoding = require('../lib/encoding.js')

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
  t.plan(7)

  const wakeups = []
  const heads = []

  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)
  const auto3 = await create(t, auto1.key, { apply: applyWithStall, onwakeup: createOnWakeup() })

  await auto1.append(encode({ hello: 'world' }))
  await auto1.append(encode({ addWriter: auto2.local.id, weight: 1 }))

  await replicateAndSync(auto1, auto2, auto3)

  const MESSAGES = 100
  for (let i = 0; i < MESSAGES; i++) {
    await auto1.append(encode({ hello: 'world' + i }))
  }
  await auto3.writers.refresh()

  await replicateAndSync(auto1, auto2)

  const expected = auto1.system.bee.head()
  const moved = new Promise((resolve, reject) => {
    const timer = setTimeout(reject, 2_000)
    auto3.once('move-to', (to) => {
      clearTimeout(timer)
      t.alike(to, expected)
      resolve()
    })
  })

  await auto2.append(encode({ hello: 'from auto2' }))

  t.comment('sync 2<>3')

  await replicateAndSync(auto1, auto2, auto3)

  try {
    await moved
    t.pass('moved')
  } catch {
    t.fail('did not move')
    return
  }

  // replicate since auto3 is sparse now
  t.teardown(replicate(auto1, auto3))
  t.ok(await same(auto2, auto3))

  // All up to date
  {
    const view = auto3._workingBee
    const entry = await view.get(b4a.from('latest'))
    const data = decode(entry.value)

    t.alike(data, { hello: 'from auto2' })
  }

  t.ok(wakeups.length > 0, 'wokeup')
  t.alike(wakeups[0], { hello: 'from auto2' })

  t.ok(b4a.isBuffer(heads[0].key) && heads[0].length > 0, 'onwakeup received head { key, length }')

  function createOnWakeup() {
    return async function (head, view) {
      const entry = await view.get(b4a.from('latest'))
      const data = decode(entry.value)

      if (data.hello !== 'from auto2') return

      wakeups.push(data)
      heads.push(head)

      return { key: auto1.local.key, length: auto1.local.length }
    }
  }

  function applyWithStall(nodes, view, base) {
    const node = nodes[0]

    // short circuit normal sync
    if (b4a.equals(node.key, auto1.local.key) && node.length > 2) return

    return apply(nodes, view, base)
  }
})

test('wakeup - onwakeup via store', async function (t) {
  const dir = await t.tmp()

  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)
  let auto3 = await create(t, auto1.key, { storage: dir })

  const a2c3 = auto3.store.get(auto2.local.key)

  await auto1.append(encode({ hello: 'world' }))
  await auto1.append(encode({ addWriter: auto2.local.id, weight: 1 }))

  await replicateAndSync(auto1, auto3, auto2)

  await a2c3.ready()

  t.is(auto2.local.length, a2c3.length, 'auto3 got auto1 writer')
  await a2c3.close()
  t.ok(
    auto3.store.cores.map.has(auto2.local.discoveryKey.toString('hex')),
    'auto2 core loaded in auto3 before reopening'
  )
  await auto3.close()

  t.comment('reopen auto3 to clear corestore cores')
  auto3 = await create(t, auto1.key, { storage: dir })

  t.absent(
    auto3.store.cores.map.has(auto2.local.key.toString('hex')),
    'auto2 core not loaded in auto3 store after reopen'
  )

  // Only replicate stores so no wakeup protomux messages
  t.teardown(replicate(auto1.store, auto3.store))

  await auto3.writers.refresh()

  t.absent(
    auto3.store.cores.map.has(auto2.local.key.toString('hex')),
    'auto2 core not loaded in auto3 store after reopen'
  )
  t.absent(
    auto3.writers.has(auto2.local.key.toString('hex')),
    'auto2 core not loaded as active writer in auto3 after reopen'
  )

  await auto2.append(encode({ foo: 'bar' }))
  await replicateAndSync(auto1, auto2)

  t.ok(await same(auto3, auto2), 'autobees match')
  {
    const entry = await auto3.view.get(b4a.from('latest'))
    const data = decode(entry.value)
    t.alike(data, { foo: 'bar' }, 'auto3 has updates from auto3')
  }
})

test('wakeup - previous drain', async function (t) {
  const dir = await t.tmp()

  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)
  let auto3 = await create(t, auto1.key, { storage: dir })

  await auto1.append(encode({ hello: 'world' }))
  await auto1.append(encode({ addWriter: auto2.local.id, weight: 1 }))

  await replicateAndSync(auto1, auto3, auto2)

  await auto3.writers.refresh()

  t.absent(
    auto3.writers.has(auto2.local.key.toString('hex')),
    'auto2 core not loaded as active writer in auto3 after reopen'
  )

  await auto2.append(encode({ foo: 'bar' }))
  await replicateAndSync(auto1, auto2, auto3)

  const previousDrain = auto3.previousDrain
  const localKey = auto3.local.key

  await auto3.close()

  const store = new Corestore(dir, { manifestVersion: 2 })
  t.teardown(() => store.close())

  const local = store.get({ key: localKey })
  await local.ready()

  const buf = await local.getUserData('autobee/previous-drain')
  t.is(encoding.decodePreviousDrain(buf), previousDrain)
})

test('wakeup - boot catch-up surfaces offline group updates', async function (t) {
  const dir = await t.tmp()

  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)
  let auto3 = await create(t, auto1.key, { storage: dir })

  await auto1.append(encode({ hello: 'world' }))
  await auto1.append(encode({ addWriter: auto2.local.id, weight: 1 }))
  await replicateAndSync(auto1, auto2, auto3)

  await auto3.close()

  // auto2 writes more while auto3 is offline
  await auto2.append(encode({ a: 1 }))
  await auto2.append(encode({ b: 2 }))
  await auto2.append(encode({ foo: 'bar' }))
  await replicateAndSync(auto1, auto2)

  // Pull auto2's new blocks into auto3's storage via a plain store session — no autobee
  // is draining, so this records group updates dated after auto3's previousDrain. These
  // never fire a live 'update' event for auto3, so only the boot catch-up can surface them.
  {
    const store = new Corestore(dir, { manifestVersion: 2 })
    await store.ready()
    const done = replicate(auto1.store, store)
    const core = store.get({ key: auto2.local.key })
    await core.ready()
    await core.download({ start: 0, end: auto2.local.length }).done()
    await core.close()
    await done()
    await store.close()
  }

  // Reopen with NO live peers: convergence can only come from _drainBootHints replaying
  // the offline group updates via _notifyHandler.updates({ since: previousDrain }), which
  // wakes auto2's writer so the new node gets applied on drain.
  auto3 = await create(t, auto1.key, { storage: dir })

  let data = null
  for (let i = 0; i < 40 && (!data || data.foo !== 'bar'); i++) {
    await auto3.update()
    await auto3.updated()
    await new Promise((r) => setTimeout(r, 20))
    const entry = await auto3.view.get(b4a.from('latest'))
    data = entry && decode(entry.value)
  }

  t.alike(data, { foo: 'bar' }, 'auto3 converged via boot catch-up alone')
})
