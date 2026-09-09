const test = require('brittle')
const b4a = require('b4a')
const { create, replicate, replicateAndSync, sync, encode, same } = require('./helpers')

test('acking - untrusted writer never acks', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key, { ackThreshold: 1, isTrusted: () => false })

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  await auto2.append(encode({ msg: 'hello' }))
  await replicateAndSync(auto1, auto2)

  const length = auto2.local.length

  for (let i = 0; i < 10; i++) {
    await auto1.append(encode({ msg: 'msg' + i }))
    await replicateAndSync(auto1, auto2)
  }

  t.is(auto2.local.length, length, 'no acks appended')
})

test('acking - appends a null node once we fall behind', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key, { ackThreshold: 4 })

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  await auto2.append(encode({ msg: 'hello' }))
  await replicateAndSync(auto1, auto2)

  t.ok(auto2._acking, 'trusted writers ack without opting in')

  const length = auto2.local.length
  const flushes = auto2.flushes

  for (let i = 0; i < 3; i++) {
    await auto1.append(encode({ msg: 'msg' + i }))
    await replicateAndSync(auto1, auto2)
  }

  t.is(auto2.local.length, length, 'still within the threshold')

  await auto1.append(encode({ msg: 'last' }))
  await replicateAndSync(auto1, auto2)

  t.is(auto2.local.length, length + 1, 'acked once')
  t.ok(auto2.flushes - flushes >= 4, 'system moved past the threshold')

  const oplog = await auto2.writers.getLatestLocalOplog()
  t.is(oplog.value, null, 'ack node is a null node')
  t.is(oplog.views.flushes, auto2.flushes, 'views caught up')

  await replicateAndSync(auto1, auto2)
  t.ok(await same(auto1, auto2), 'peers converge')
})

test('acking - stops acking when toggled off', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key, { ackThreshold: 2 })

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  await auto2.append(encode({ msg: 'hello' }))
  await replicateAndSync(auto1, auto2)

  for (let i = 0; i < 6; i++) {
    await auto1.append(encode({ msg: 'msg' + i }))
    await replicateAndSync(auto1, auto2)
  }

  const acked = auto2.local.length
  t.ok(acked > 1, 'acked while enabled')

  auto2.setAcking(false)

  for (let i = 0; i < 6; i++) {
    await auto1.append(encode({ msg: 'more' + i }))
    await replicateAndSync(auto1, auto2)
  }

  t.is(auto2.local.length, acked, 'no acks after disabling')
})

test('acking - non writer never acks', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key, { ackThreshold: 1 })

  for (let i = 0; i < 6; i++) {
    await auto1.append(encode({ msg: 'msg' + i }))
    await replicateAndSync(auto1, auto2)
  }

  t.is(auto2.local.length, 0, 'nothing appended')
})

test('acking - re-evaluated after a fast-forward', async function (t) {
  const auto1 = await create(t, {
    mostRecentTrusted: () => ({ key: auto1.local.key, length: auto1.local.length })
  })

  for (let i = 0; i < 40; i++) await auto1.append(encode({ value: 'a' + i }))

  let trustSelf = false
  const auto2 = await create(t, auto1.key, {
    ackThreshold: 1,
    isTrusted: (key) => (b4a.equals(key, auto1.local.key) ? true : trustSelf)
  })

  t.absent(auto2._acking, 'not acking while untrusted')

  trustSelf = true

  t.teardown(replicate(auto1, auto2))
  await new Promise((resolve) => auto2.once('move-to', resolve))

  t.ok(auto2._acking, 'acking after the fast-forward')

  await sync(auto1, auto2)
})
