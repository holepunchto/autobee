const test = require('brittle')
const { create, replicateAndSync, encode, same } = require('./helpers')

test('acking - disabled by default', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

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
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  await auto2.append(encode({ msg: 'hello' }))
  await replicateAndSync(auto1, auto2)

  auto2.setAcking(true, { threshold: 4 })

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
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  await auto2.append(encode({ msg: 'hello' }))
  await replicateAndSync(auto1, auto2)

  auto2.setAcking(true, { threshold: 2 })

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
  const auto2 = await create(t, auto1.key)

  auto2.setAcking(true, { threshold: 1 })

  for (let i = 0; i < 6; i++) {
    await auto1.append(encode({ msg: 'msg' + i }))
    await replicateAndSync(auto1, auto2)
  }

  t.is(auto2.local.length, 0, 'nothing appended')
})
