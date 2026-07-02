const test = require('brittle')
const Corestore = require('corestore')
const { create, replicate, replicateAndSync, encode, same, decode, apply } = require('./helpers')
const b4a = require('b4a')
const ProtomuxWakeup = require('protomux-wakeup')

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
  t.plan(6)

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

  const moved = new Promise((resolve, reject) => {
    const timer = setTimeout(reject, 2_000)
    auto3.once('move-to', () => {
      clearTimeout(timer)
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
  const auto3 = await create(t, auto1.key, { storage: dir })

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

test('wakeup - handle malicious wakeup', async function (t) {
  const auto1 = await create(t)
  await auto1.append(encode({ hello: 'world' }))

  // a peer that is not a real writer, wired up over raw protomux-wakeup, announcing
  // a core filled with data that is not a valid oplog encoding
  const attackerStore = new Corestore(await t.tmp(), { manifestVersion: 2 })
  t.teardown(() => attackerStore.close())

  const bogus = attackerStore.get({ name: 'bogus-writer' })
  await bogus.ready()
  await bogus.append([b4a.from('not a valid oplog entry'), b4a.from('still garbage')])

  const s1 = auto1.replicate(false)
  const s2 = attackerStore.replicate(true)

  s1.pipe(s2).pipe(s1)
  t.teardown(() => {
    s1.destroy()
    s2.destroy()
  })

  const attackerWakeup = new ProtomuxWakeup()
  attackerWakeup.addStream(s2)

  attackerWakeup.session(auto1.wakeupCapability.key, {
    discoveryKey: auto1.wakeupCapability.discoveryKey,
    onpeeractive(peer, session) {
      session.announce(peer, [{ key: bogus.key, length: bogus.length }])
    }
  })

  const id = b4a.toString(bogus.key, 'hex')

  const writer = await new Promise((resolve) => {
    auto1.on('writer', function onwriter(w) {
      if (w.id !== id) return
      auto1.off('writer', onwriter)
      resolve(w)
    })
  })

  await waitFor(() => writer.isFrozen)
  t.ok(writer.isFrozen, 'writer is marked frozen after failing to decode bogus data')
  t.absent(auto1.closing, 'autobase did not close itself over the bad writer data')

  // autobase as a whole should still be fully functional afterwards
  await auto1.append(encode({ still: 'alive' }))

  const entry = await auto1.view.get(b4a.from('latest'))
  t.alike(
    decode(entry.value),
    { still: 'alive' },
    'autobase keeps processing writes after a bad writer'
  )
})

async function waitFor(cond, timeout = 5000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
