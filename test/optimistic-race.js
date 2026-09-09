const test = require('brittle')
const b4a = require('b4a')
const { create, replicate, sync, encode, decode } = require('./helpers')

test('optimistic - basic flow', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ hello: 'world' }))
  await auto2.append(encode({ test: 42, addWriter: auto2.local.id }), { optimistic: true })

  const done = replicate(auto1, auto2)
  await auto1.wakeup({ key: auto2.local.key, length: auto2.local.length })
  await sync(auto1, auto2)

  const writerInfo = await auto1.system.get(auto2.local.key)

  done()

  t.ok(writerInfo && writerInfo.length >= auto2.local.length, 'optimistic batch processed')
})

test('optimistic - declined when apply neither adds nor acks the writer', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ hello: 'world' }))
  await auto2.append(encode({ test: 42 }), { optimistic: true })

  const done = replicate(auto1, auto2)
  await auto1.wakeup({ key: auto2.local.key, length: auto2.local.length })

  // sync() cannot converge on a declined writer - drain a few rounds instead
  for (let i = 0; i < 10; i++) {
    await auto1.update()
    await auto1.updated()
    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  done()

  const writerInfo = await auto1.system.get(auto2.local.key)
  const latest = await auto1.bee.get(b4a.from('latest'))

  t.absent(writerInfo, 'declined writer has no system record')
  t.alike(decode(latest.value), { hello: 'world' }, 'declined op was rolled back from the view')
  t.is(auto1.system.heads.length, 1, 'declined op is not a head')
})

test('optimistic - acked but never added writer is recorded as removed', async function (t) {
  async function apply(nodes, view, host) {
    for (const node of nodes) {
      const data = decode(node.value)
      if (data.ack) host.ackWriter(node.key)
      const w = view.write()
      w.tryPut(b4a.from('latest'), node.value)
      await w.flush()
    }
  }

  const auto1 = await create(t, null, { apply })
  const auto2 = await create(t, auto1.key, { apply })

  await auto1.append(encode({ hello: 'world' }))
  await auto2.append(encode({ msg: 'acked', ack: true }), { optimistic: true })

  const done = replicate(auto1, auto2)
  await auto1.wakeup({ key: auto2.local.key, length: auto2.local.length })
  await sync(auto1, auto2)

  const info = await auto1.system.get(auto2.local.key)
  t.ok(info, 'acked writer has a record')
  t.is(info.length, 1, 'record covers the acked op')
  t.ok(info.isRemoved, 'acked writer is recorded as removed')
  t.is(info.maxWeight, 0, 'acked writer was never granted')
  t.alike(decode((await auto1.bee.get(b4a.from('latest'))).value), { msg: 'acked', ack: true })
  t.absent(auto2.writable, 'acked writer is not writable')

  // a later op that is not acked is not applied
  await auto2.append(encode({ msg: 'unacked' }), { optimistic: true })
  await auto1.wakeup({ key: auto2.local.key, length: auto2.local.length })
  for (let i = 0; i < 10; i++) {
    await auto1.update()
    await auto1.updated()
    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  done()

  t.alike(decode((await auto1.bee.get(b4a.from('latest'))).value), { msg: 'acked', ack: true })
})

test('optimistic - stability test (multiple iterations)', async function (t) {
  t.timeout(60000)

  const iterations = 20

  for (let i = 0; i < iterations; i++) {
    const auto1 = await create(t)
    const auto2 = await create(t, auto1.key)

    await auto1.append(encode({ hello: 'world' }))
    await auto2.append(encode({ test: i, addWriter: auto2.local.id }), { optimistic: true })

    const done = replicate(auto1, auto2)
    await auto1.wakeup({ key: auto2.local.key, length: auto2.local.length })
    await sync(auto1, auto2)

    const writerInfo = await auto1.system.get(auto2.local.key)

    t.ok(writerInfo && writerInfo.length >= auto2.local.length, `iteration ${i}: batch processed`)

    done()
    await auto1.close()
    await auto2.close()
  }
})

test('optimistic - concurrent writers', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)
  const auto3 = await create(t, auto1.key)

  await auto1.append(encode({ hello: 'world' }))

  await Promise.all([
    auto2.append(encode({ test: 2, addWriter: auto2.local.id }), { optimistic: true }),
    auto3.append(encode({ test: 3, addWriter: auto3.local.id }), { optimistic: true })
  ])

  const done1 = replicate(auto1, auto2)
  const done2 = replicate(auto1, auto3)

  await Promise.all([
    auto1.wakeup({ key: auto2.local.key, length: auto2.local.length }),
    auto1.wakeup({ key: auto3.local.key, length: auto3.local.length })
  ])

  await sync(auto1, auto2)
  await sync(auto1, auto3)

  const writer2 = await auto1.system.get(auto2.local.key)
  const writer3 = await auto1.system.get(auto3.local.key)

  done1()
  done2()

  t.ok(writer2 && writer2.length >= auto2.local.length, 'writer2 processed')
  t.ok(writer3 && writer3.length >= auto3.local.length, 'writer3 processed')
})

test('optimistic - multiple batches from one writer', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ hello: 'world' }))

  // Multiple optimistic appends
  for (let i = 0; i < 10; i++) {
    await auto2.append(encode({ batch: i, addWriter: auto2.local.id }), { optimistic: true })
  }

  const done = replicate(auto1, auto2)
  await auto1.wakeup({ key: auto2.local.key, length: auto2.local.length })
  await sync(auto1, auto2)

  const writerInfo = await auto1.system.get(auto2.local.key)

  done()

  t.is(writerInfo.length, 10, 'all 10 batches processed')
})

test('optimistic - a joiner announces its own claim, unaided', async function (t) {
  const host = await create(t)
  await host.append(encode({ hello: 'world' }))

  const joiner = await create(t, host.key)

  const done = replicate(host, joiner)

  await sync(host, joiner)

  await joiner.append(encode({ addWriter: joiner.local.id }), { optimistic: true })
  await sync(host, joiner)

  const info = await host.system.get(joiner.local.key)

  done()

  t.ok(
    info && info.length >= joiner.local.length,
    'the host admitted a joiner it was never told about'
  )
})

test('optimistic - join, then shutdown, then activity from idle', async function (t) {
  const a = await t.tmp()
  const b = await t.tmp()

  let host = await create(t, null, { storage: a })
  await host.append(encode({ hello: 'world' }))

  let joiner = await create(t, host.key, { storage: b })

  let done = replicate(host, joiner)

  await sync(host, joiner)

  await joiner.append(encode({ addWriter: joiner.local.id }), { optimistic: true })
  await sync(host, joiner)

  const info = await host.system.get(joiner.local.key)

  await done()

  await joiner.append(encode({ hello: 'world' }))
  await joiner.append(encode({ hello: 'world' }))
  await joiner.append(encode({ hello: 'world' }))

  await joiner.close()
  await host.close()

  host = await create(t, null, { storage: a })
  joiner = await create(t, host.key, { storage: b })

  done = replicate(host, joiner)

  await sync(host, joiner)

  for await (const info of host.system.list()) {
    const other = await joiner.system.get(info.key)
    t.alike(info, other)
  }

  for await (const info of joiner.system.list()) {
    const other = await host.system.get(info.key)
    t.alike(info, other)
  }
})
