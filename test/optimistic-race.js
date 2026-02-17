const test = require('brittle')
const b4a = require('b4a')
const { create, replicate, sync, encode } = require('./helpers')

test('optimistic - race condition exposure (run multiple times)', async function (t) {
  t.plan(1)
  t.timeout(120000) // 2 minutes for more iterations
  
  let failures = 0
  let successes = 0
  const iterations = 100

  for (let i = 0; i < iterations; i++) {
    const auto1 = await create(t)
    const auto2 = await create(t, auto1.key)

    await auto1.append(encode({ hello: 'world' }))
    
    // Optimistic append before replication
    await auto2.append(encode({ test: 42, iteration: i }), { optimistic: true })

    const done = replicate(auto1, auto2)

    // Add small delay to widen race window
    await new Promise(resolve => setTimeout(resolve, Math.random() * 10))

    // Wakeup and sync
    await auto1.wakeup({ key: auto2.local.key, length: auto2.local.length })
    
    // Add another small delay before sync
    await new Promise(resolve => setTimeout(resolve, Math.random() * 5))
    
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

test('optimistic - stress test with concurrent operations', async function (t) {
  t.timeout(60000)
  
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)
  const auto3 = await create(t, auto1.key)

  await auto1.append(encode({ hello: 'world' }))

  // Multiple optimistic appends
  await Promise.all([
    auto2.append(encode({ test: 2 }), { optimistic: true }),
    auto3.append(encode({ test: 3 }), { optimistic: true })
  ])

  const done1 = replicate(auto1, auto2)
  const done2 = replicate(auto1, auto3)

  // Wakeup both
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

  t.ok(writer2 && writer2.length >= auto2.local.length, 'auto2 batch processed')
  t.ok(writer3 && writer3.length >= auto3.local.length, 'auto3 batch processed')
})

test('optimistic - check immediately after wakeup (no sync)', async function (t) {
  t.timeout(60000)
  
  let failures = 0
  const iterations = 50

  for (let i = 0; i < iterations; i++) {
    const auto1 = await create(t)
    const auto2 = await create(t, auto1.key)

    await auto1.append(encode({ hello: 'world' }))
    await auto2.append(encode({ test: 42, iteration: i }), { optimistic: true })

    const done = replicate(auto1, auto2)

    await auto1.wakeup({ key: auto2.local.key, length: auto2.local.length })
    
    // Check immediately without sync - this should expose the race
    const writerInfo = await auto1.system.get(auto2.local.key)
    
    if (!writerInfo || writerInfo.length < auto2.local.length) {
      failures++
      if (failures <= 5) {
        console.log(`[${i}] RACE DETECTED: wakeup returned but batch not processed yet`)
      }
    }

    // Now sync and verify it eventually works
    await sync(auto1, auto2)
    await auto1._bump() // Force bump
    
    const writerInfoAfter = await auto1.system.get(auto2.local.key)
    t.ok(writerInfoAfter && writerInfoAfter.length >= auto2.local.length, 
      `iteration ${i}: batch eventually processed`)

    done()
    await auto1.close()
    await auto2.close()
  }

  console.log(`\nRace condition detected ${failures}/${iterations} times`)
  t.comment(`This shows wakeup() doesn't wait for _bump() to complete`)
})

test('optimistic - extreme stress with no wakeup', async function (t) {
  t.timeout(120000)
  
  let raceDetected = 0
  const iterations = 100

  for (let i = 0; i < iterations; i++) {
    const auto1 = await create(t)
    const auto2 = await create(t, auto1.key)

    await auto1.append(encode({ hello: 'world' }))
    await auto2.append(encode({ test: i }), { optimistic: true })

    const done = replicate(auto1, auto2)

    // Don't use wakeup at all - let replication discover naturally
    // This creates maximum race window
    
    // Wait just a tiny bit for replication to start
    await new Promise(resolve => setImmediate(resolve))
    
    // Check immediately - before any sync
    const writerInfo = await auto1.system.get(auto2.local.key)
    
    if (!writerInfo || writerInfo.length < auto2.local.length) {
      raceDetected++
      if (raceDetected <= 3) {
        console.log(`[${i}] RACE: batch not yet processed (writerInfo: ${writerInfo ? writerInfo.length : 'null'})`)
      }
    }

    done()
    await auto1.close()
    await auto2.close()
  }

  console.log(`\nRace detected ${raceDetected}/${iterations} times without wakeup()`)
  t.comment(`Without wakeup(), replication must discover and process naturally`)
})

test('optimistic - interrupt during bump', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ hello: 'world' }))
  await auto2.append(encode({ test: 42 }), { optimistic: true })

  const done = replicate(auto1, auto2)

  // Start wakeup but don't await it
  const wakeupPromise = auto1.wakeup({ key: auto2.local.key, length: auto2.local.length })
  
  // Immediately check before wakeup completes
  const writerInfoDuring = await auto1.system.get(auto2.local.key)
  console.log('During wakeup (not awaited):', writerInfoDuring)
  
  await wakeupPromise
  
  const writerInfoAfter = await auto1.system.get(auto2.local.key)
  console.log('After wakeup completes:', writerInfoAfter)
  
  done()
  
  t.comment('Check if wakeup() actually waits for processing')
})

test('optimistic - multiple rapid optimistic appends', async function (t) {
  t.timeout(60000)
  
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ hello: 'world' }))

  // Rapid fire optimistic appends
  for (let i = 0; i < 10; i++) {
    await auto2.append(encode({ rapid: i }), { optimistic: true })
  }

  console.log('auto2.local.length after rapid appends:', auto2.local.length)

  const done = replicate(auto1, auto2)

  await auto1.wakeup({ key: auto2.local.key, length: auto2.local.length })
  
  // Check immediately
  const writerInfo1 = await auto1.system.get(auto2.local.key)
  console.log('Immediately after wakeup:', writerInfo1)
  
  // Wait a bit
  await new Promise(resolve => setTimeout(resolve, 100))
  
  const writerInfo2 = await auto1.system.get(auto2.local.key)
  console.log('After 100ms:', writerInfo2)
  
  // Force bump
  await auto1._bump()
  
  const writerInfo3 = await auto1.system.get(auto2.local.key)
  console.log('After explicit bump:', writerInfo3)

  done()
  
  t.ok(writerInfo3 && writerInfo3.length >= auto2.local.length, 
    'Eventually all batches processed')
})

test('optimistic - check bumping counter during operations', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ hello: 'world' }))
  await auto2.append(encode({ test: 42 }), { optimistic: true })

  console.log('auto1.bumping before replication:', auto1.bumping)

  const done = replicate(auto1, auto2)

  console.log('auto1.bumping after replication started:', auto1.bumping)

  const wakeupPromise = auto1.wakeup({ key: auto2.local.key, length: auto2.local.length })
  
  console.log('auto1.bumping during wakeup (not awaited):', auto1.bumping)
  
  await wakeupPromise
  
  console.log('auto1.bumping after wakeup:', auto1.bumping)
  
  // The bumping counter should tell us if _bump() is running
  await new Promise(resolve => setTimeout(resolve, 50))
  
  console.log('auto1.bumping after 50ms:', auto1.bumping)

  done()
  
  t.pass('Observed bumping counter behavior')
})

test('optimistic - replicate before optimistic append', async function (t) {
  t.timeout(60000)
  
  let raceDetected = 0
  const iterations = 50

  for (let i = 0; i < iterations; i++) {
    const auto1 = await create(t)
    const auto2 = await create(t, auto1.key)

    await auto1.append(encode({ hello: 'world' }))
    
    // Start replication FIRST
    const done = replicate(auto1, auto2)
    
    // Then do optimistic append while replication is active
    await auto2.append(encode({ test: i }), { optimistic: true })

    // Minimal delay
    await new Promise(resolve => setImmediate(resolve))
    
    const writerInfo = await auto1.system.get(auto2.local.key)
    
    if (!writerInfo || writerInfo.length < auto2.local.length) {
      raceDetected++
      if (raceDetected <= 3) {
        console.log(`[${i}] RACE: optimistic append during active replication not yet processed`)
      }
    }

    // Call wakeup to trigger discovery and processing
    await auto1.wakeup({ key: auto2.local.key, length: auto2.local.length })
    
    // Wait for sync before closing to avoid REQUEST_CANCELLED errors
    await sync(auto1, auto2)
    
    done()
    await auto1.close()
    await auto2.close()
  }

  console.log(`\nRace detected ${raceDetected}/${iterations} times with replication-first`)
  t.comment(`Optimistic append during active replication`)
})
