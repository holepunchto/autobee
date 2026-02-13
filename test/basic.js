const test = require('brittle')
const b4a = require('b4a')
const Corestore = require('corestore')
const { create, replicateAndSync, same, encode, apply, replicate, sync } = require('./helpers')
const Autobee = require('../index.js')

test('basic', async function (t) {
  const auto = await create(t)

  const val = encode({ hello: 'world' })
  await auto.append(val)

  const node = await auto.view.get(b4a.from('latest'))

  t.alike(node.value, val)
})

test('basic - replication', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  const val = encode({ hello: 'world' })
  await auto1.append(val)

  await replicateAndSync(auto1, auto2)

  t.ok(await same(auto1, auto2))
})

test('basic - replication (batch)', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  const val1 = encode({ hello: 'world' })
  const val2 = encode({ hej: 'verden' })
  await auto1.append([val1, val2])

  await replicateAndSync(auto1, auto2)

  t.ok(await same(auto1, auto2))
})

test('basic - fork and replication', async function (t) {
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

test('basic - removal', async function (t) {
  const auto = await create(t)

  await auto.append(encode({ hello: 'world' }))

  t.ok(auto.writable)

  await auto.append(encode({ removeWriter: auto.local.id }))

  t.absent(auto.writable)
})

test('basic - restart', async function (t) {
  const storage = await t.tmp()

  {
    const auto = await create(t, { storage })

    await auto.append(encode({ hello: 'world' }))
    await auto.append(encode({ hej: 'verden' }))

    await auto.close()
  }

  {
    const auto = new Autobee(new Corestore(storage), { apply })

    const node = await auto.view.get(b4a.from('latest'))

    t.alike(node.value, encode({ hej: 'verden' }))

    await auto.close()
  }
})

test('basic - encode/decode value', async function (t) {
  const buf = Autobee.encodeValue(b4a.from('hello'))
  const value = Autobee.decodeValue(buf)
  t.alike(value, b4a.from('hello'))
})

test('basic - optimistic', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ hello: 'world' }))
  await auto2.append(encode({ test: 42 }), { optimistic: true })

  const done = replicate(auto1, auto2)

  await auto1.wakeup({ key: auto2.local.key, length: auto2.local.length })
  await sync(auto1, auto2)

  done()

  t.pass('applied')
})
