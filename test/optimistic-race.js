const test = require('brittle')
const b4a = require('b4a')
const { create, replicate, sync, encode } = require('./helpers')

test('optimistic - race condition exposure (run multiple times)', async function (t) {
  t.plan(1)
  
  let failures = 0
  let successes = 0
  const iterations = 20

  for (let i = 0; i < iterations; i++) {
    const auto1 = await create(t)
    const auto2 = await create(t, auto1.key)

    await auto1.append(encode({ hello: 'world' }))
    
    // Optimistic append before replication
    await auto2.append(encode({ test: 42, iteration: i }), { optimistic: true })

    const done = replicate(auto1, auto2)

    // Wakeup and sync
    await auto1.wakeup({ key: auto2.local.key, length: auto2.local.length })
    await sync(auto1, auto2)

    // Check if auto1 actually processed auto2's optimistic batch
    const writerInfo = await auto1.system.get(auto2.local.key)
    
    if (!writerInfo || writerInfo.length < auto2.local.length) {
      failures++
      console.log(`[${i}] FAILED: auto1 did not process auto2's batch (writerInfo: ${writerInfo ? writerInfo.length : 'null'}, expected: ${auto2.local.length})`)
    } else {
      successes++
    }

    done()
    await auto1.close()
    await auto2.close()
  }

  console.log(`\nResults: ${successes}/${iterations} succeeded, ${failures}/${iterations} failed`)
  t.ok(failures === 0, `All iterations should succeed, but ${failures} failed`)
})

test('optimistic - detailed race condition test', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ hello: 'world' }))
  
  console.log('Before optimistic append:')
  console.log('  auto2.local.length:', auto2.local.length)
  
  await auto2.append(encode({ test: 42 }), { optimistic: true })
  
  console.log('After optimistic append:')
  console.log('  auto2.local.length:', auto2.local.length)
  
  const done = replicate(auto1, auto2)
  
  console.log('After replication started')
  
  await auto1.wakeup({ key: auto2.local.key, length: auto2.local.length })
  console.log('After wakeup')
  
  await sync(auto1, auto2)
  console.log('After sync')
  
  // Check auto1's state
  const writerInfo = await auto1.system.get(auto2.local.key)
  console.log('Writer info in auto1.system:', writerInfo)
  console.log('auto1.bumping:', auto1.bumping)
  
  // Try to force a bump
  console.log('Calling auto1._bump() explicitly...')
  await auto1._bump()
  
  const writerInfoAfterBump = await auto1.system.get(auto2.local.key)
  console.log('Writer info after explicit bump:', writerInfoAfterBump)
  
  done()
  
  t.ok(writerInfoAfterBump && writerInfoAfterBump.length >= auto2.local.length, 
    'auto1 should have processed auto2 batch after explicit bump')
})

test('optimistic - with explicit flush', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ hello: 'world' }))
  await auto2.append(encode({ test: 42 }), { optimistic: true })

  const done = replicate(auto1, auto2)

  await auto1.wakeup({ key: auto2.local.key, length: auto2.local.length })
  await sync(auto1, auto2)
  
  // Try flushing to see if it helps
  await auto1.flush()
  await auto2.flush()

  const writerInfo = await auto1.system.get(auto2.local.key)
  
  done()
  
  t.ok(writerInfo && writerInfo.length >= auto2.local.length, 
    'auto1 should have processed auto2 batch after flush')
})
