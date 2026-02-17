const test = require('brittle')
const b4a = require('b4a')
const { create, replicate, sync, encode } = require('./helpers')

test('optimistic - basic flow', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ hello: 'world' }))
  await auto2.append(encode({ test: 42 }), { optimistic: true })

  const done = replicate(auto1, auto2)
  await auto1.wakeup({ key: auto2.local.key, length: auto2.local.length })
  await sync(auto1, auto2)

  const writerInfo = await auto1.system.get(auto2.local.key)
  
  done()
  
  t.ok(writerInfo && writerInfo.length >= auto2.local.length, 
    'optimistic batch processed')
})

test('optimistic - stability test (multiple iterations)', async function (t) {
  t.timeout(60000)
  
  const iterations = 20
  
  for (let i = 0; i < iterations; i++) {
    const auto1 = await create(t)
    const auto2 = await create(t, auto1.key)

    await auto1.append(encode({ hello: 'world' }))
    await auto2.append(encode({ test: i }), { optimistic: true })

    const done = replicate(auto1, auto2)
    await auto1.wakeup({ key: auto2.local.key, length: auto2.local.length })
    await sync(auto1, auto2)

    const writerInfo = await auto1.system.get(auto2.local.key)
    
    t.ok(writerInfo && writerInfo.length >= auto2.local.length, 
      `iteration ${i}: batch processed`)

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
    auto2.append(encode({ test: 2 }), { optimistic: true }),
    auto3.append(encode({ test: 3 }), { optimistic: true })
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
    await auto2.append(encode({ batch: i }), { optimistic: true })
  }

  const done = replicate(auto1, auto2)
  await auto1.wakeup({ key: auto2.local.key, length: auto2.local.length })
  await sync(auto1, auto2)

  const writerInfo = await auto1.system.get(auto2.local.key)

  done()
  
  t.is(writerInfo.length, 10, 'all 10 batches processed')
})
