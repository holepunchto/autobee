const test = require('brittle')
const { create, replicateAndSync, encode, encryptionKey } = require('./helpers')

test('writer-management - add writer', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  t.ok(auto1.writable, 'auto1 is initially writable')
  t.absent(auto2.writable, 'auto2 is not initially writable')

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  t.ok(auto2.writable, 'auto2 is writable after being added')

  const writerInfo = await auto1.system.get(auto2.local.key)
  t.ok(writerInfo, 'writer info exists in system')
  t.alike(writerInfo.key, auto2.local.key, 'writer key matches')
  t.ok(writerInfo.length >= 0, 'writer has valid length')
})

test('writer-management - add writer that is already a writer', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  t.ok(auto2.writable, 'auto2 is writable')

  // Try to add the same writer again
  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  t.ok(auto2.writable, 'auto2 is still writable')

  const writerInfo = await auto1.system.get(auto2.local.key)
  t.ok(writerInfo, 'writer info still exists')
})

test('writer-management - remove writer', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  t.ok(auto2.writable, 'auto2 is writable')

  await auto1.append(encode({ removeWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  t.absent(auto2.writable, 'auto2 is no longer writable')

  const writerInfo = await auto1.system.get(auto2.local.key)
  t.ok(writerInfo, 'writer info still exists in system')
  t.ok(writerInfo.isRemoved, 'writer is marked as removed')
})

test('writer-management - remove writer that does not exist', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  t.absent(auto2.writable, 'auto2 is not writable')

  // Try to remove a writer that was never added
  await auto1.append(encode({ removeWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  t.absent(auto2.writable, 'auto2 is still not writable')

  const writerInfo = await auto1.system.get(auto2.local.key)
  // Writer info might not exist or might be marked as removed
  if (writerInfo) {
    t.ok(writerInfo.isRemoved, 'if writer info exists, it is marked as removed')
  }
})

test('writer-management - remove then re-add writer', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  // Add writer
  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)
  t.ok(auto2.writable, 'auto2 is writable after being added')

  // Remove writer
  await auto1.append(encode({ removeWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)
  t.absent(auto2.writable, 'auto2 is not writable after being removed')

  // Re-add writer
  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)
  t.ok(auto2.writable, 'auto2 is writable again after being re-added')

  const writerInfo = await auto1.system.get(auto2.local.key)
  t.ok(writerInfo, 'writer info exists')
  t.absent(writerInfo.isRemoved, 'writer is not marked as removed')
})

test('writer-management - add multiple writers in one batch', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)
  const auto3 = await create(t, auto1.key)

  await auto1.append([encode({ addWriter: auto2.local.id }), encode({ addWriter: auto3.local.id })])

  await replicateAndSync(auto1, auto2, auto3)

  t.ok(auto2.writable, 'auto2 is writable')
  t.ok(auto3.writable, 'auto3 is writable')

  const writer2Info = await auto1.system.get(auto2.local.key)
  const writer3Info = await auto1.system.get(auto3.local.key)

  t.ok(writer2Info, 'auto2 writer info exists')
  t.ok(writer3Info, 'auto3 writer info exists')
})

test('writer-management - writer permissions persist after restart', async function (t) {
  const storage = await t.tmp()

  let auto1Key, auto2Key

  {
    const auto1 = await create(t, { storage })
    const auto2 = await create(t, auto1.key)

    auto1Key = auto1.key
    auto2Key = auto2.local.key

    await auto1.append(encode({ addWriter: auto2.local.id }))
    await replicateAndSync(auto1, auto2)

    t.ok(auto2.writable, 'auto2 is writable before restart')

    await auto1.close()
    await auto2.close()
  }

  {
    const Corestore = require('corestore')
    const Autobee = require('../index.js')
    const { apply } = require('./helpers')

    const auto1 = new Autobee(new Corestore(storage), { apply, encryptionKey })
    await auto1.ready()

    t.alike(auto1.key, auto1Key, 'auto1 key matches after restart')

    const writerInfo = await auto1.system.get(auto2Key)
    t.ok(writerInfo, 'writer info persists after restart')
    t.absent(writerInfo.isRemoved, 'writer is not marked as removed')

    await auto1.close()
  }
})

test('writer-management - remove self', async function (t) {
  const auto1 = await create(t)

  // Bootstrap auto1 by writing first
  await auto1.append(encode({ msg: 'bootstrap' }))
  t.ok(auto1.writable, 'auto1 is initially writable')

  await auto1.append(encode({ removeWriter: auto1.local.id }))

  t.absent(auto1.writable, 'auto1 is no longer writable after removing self')

  const writerInfo = await auto1.system.get(auto1.local.key)
  t.ok(writerInfo, 'writer info exists')
  t.ok(writerInfo.isRemoved, 'writer is marked as removed')
})

test('writer-management - genesis state check', async function (t) {
  const auto1 = await create(t)

  const isGenesis = auto1.system.isGenesis()
  t.ok(isGenesis, 'new autobee is in genesis state')

  await auto1.append(encode({ hello: 'world' }))

  const isGenesisAfter = auto1.system.isGenesis()
  t.absent(isGenesisAfter, 'autobee is not in genesis state after append')
})

test('writer-management - writer state during partial replication', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)
  const auto3 = await create(t, auto1.key)

  // auto1 adds auto2 and auto3
  await auto1.append(encode({ addWriter: auto2.local.id }))
  await auto1.append(encode({ addWriter: auto3.local.id }))

  // Only replicate to auto2, not auto3
  await replicateAndSync(auto1, auto2)

  t.ok(auto2.writable, 'auto2 is writable after partial replication')
  t.absent(auto3.writable, 'auto3 is not writable without replication')

  // Now replicate to auto3
  await replicateAndSync(auto1, auto3)

  t.ok(auto3.writable, 'auto3 is writable after replication')
})

test('writer-management - get writer info for non-existent writer', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  const writerInfo = await auto1.system.get(auto2.local.key)

  t.is(writerInfo, null, 'writer info is null for non-existent writer')
})

test('writer-management - multiple add/remove cycles', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  for (let i = 0; i < 5; i++) {
    // Add
    await auto1.append(encode({ addWriter: auto2.local.id }))
    await replicateAndSync(auto1, auto2)
    t.ok(auto2.writable, `auto2 is writable after add cycle ${i}`)

    // Remove
    await auto1.append(encode({ removeWriter: auto2.local.id }))
    await replicateAndSync(auto1, auto2)
    t.absent(auto2.writable, `auto2 is not writable after remove cycle ${i}`)
  }

  // Final add
  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)
  t.ok(auto2.writable, 'auto2 is writable after final add')
})

test('writer-management - writer length tracking', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  const initialInfo = await auto1.system.get(auto2.local.key)
  const initialLength = initialInfo.length

  // auto2 writes some data
  await auto2.append(encode({ msg: 'from auto2' }))
  await replicateAndSync(auto1, auto2)

  const updatedInfo = await auto1.system.get(auto2.local.key)

  t.ok(updatedInfo.length > initialLength, 'writer length increased after append')
})

test('writer-management - indexer flag', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  const writerInfo = await auto1.system.get(auto2.local.key)

  t.ok(writerInfo, 'writer info exists')
  // Check if isIndexer flag is present and has expected value
  t.ok(typeof writerInfo.isIndexer === 'boolean', 'isIndexer is a boolean')
})

test('writer-management - concurrent remove and write from removed writer', async function (t) {
  const { replicate } = require('./helpers')

  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)
  const auto3 = await create(t, auto1.key)

  // auto1 adds auto2 and auto3 as writers
  await auto1.append(encode({ addWriter: auto2.local.id }))
  await auto1.append(encode({ addWriter: auto3.local.id }))
  await replicateAndSync(auto1, auto2, auto3)

  t.ok(auto2.writable, 'auto2 is writable')
  t.ok(auto3.writable, 'auto3 is writable')

  // auto2 writes some data before knowing it will be removed
  await auto2.append(encode({ msg: 'from auto2 before removal' }))

  // auto1 removes auto2 concurrently (auto2 doesn't know yet)
  await auto1.append(encode({ removeWriter: auto2.local.id }))

  // auto2 writes MORE data, still not knowing it's removed
  await auto2.append(encode({ msg: 'from auto2 after removal but unaware' }))

  // Sync auto1 and auto3 first (they agree on the removal)
  await replicateAndSync(auto1, auto3)

  // Now replicate auto2's data to auto1 and let auto1 process what it can
  const done = replicate(auto1, auto2)

  // Wait for auto1 to see auto2's oplog, then flush
  // We can't use sync() because auto1 will never fully index a removed writer's entries
  await new Promise((resolve) => setTimeout(resolve, 500))
  await auto1.flush()
  await auto2.flush()
  await new Promise((resolve) => setTimeout(resolve, 500))
  await auto1.flush()

  await done()

  // auto2 should learn it's been removed
  const done2 = replicate(auto1, auto2)
  await new Promise((resolve) => setTimeout(resolve, 500))
  await auto2.flush()
  await done2()

  t.absent(auto2.writable, 'auto2 is not writable after sync')

  const writerInfo1 = await auto1.system.get(auto2.local.key)
  t.ok(writerInfo1, 'writer info exists on auto1')
  t.ok(writerInfo1.isRemoved, 'auto2 is marked as removed on auto1')

  // Sync auto3 to see the final state
  await replicateAndSync(auto1, auto3)

  const writerInfo3 = await auto3.system.get(auto2.local.key)
  t.ok(writerInfo3, 'writer info exists on auto3')
  t.ok(writerInfo3.isRemoved, 'auto2 is marked as removed on auto3')

  // auto3 should still be writable and unaffected
  t.ok(auto3.writable, 'auto3 is still writable')
  await auto3.append(encode({ msg: 'auto3 still works' }))
  await replicateAndSync(auto1, auto3)
})

test('writer-management - removed writer re-added by third party while writing', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)
  const auto3 = await create(t, auto1.key)

  // Setup: auto1 adds auto2 and auto3
  await auto1.append(encode({ addWriter: auto2.local.id }))
  await auto1.append(encode({ addWriter: auto3.local.id }))
  await replicateAndSync(auto1, auto2, auto3)

  // auto1 removes auto2
  await auto1.append(encode({ removeWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2, auto3)
  t.absent(auto2.writable, 'auto2 is removed')

  // auto3 re-adds auto2 concurrently with auto2 not yet knowing
  await auto3.append(encode({ addWriter: auto2.local.id }))

  // Sync auto3 -> auto1 first (auto1 learns about re-add)
  await replicateAndSync(auto1, auto3)

  // Now sync auto2 with everyone
  await replicateAndSync(auto1, auto2, auto3)

  t.ok(auto2.writable, 'auto2 is writable again after re-add by auto3')

  const info1 = await auto1.system.get(auto2.local.key)
  const info3 = await auto3.system.get(auto2.local.key)

  t.absent(info1.isRemoved, 'auto1 sees auto2 as not removed')
  t.absent(info3.isRemoved, 'auto3 sees auto2 as not removed')

  // auto2 should be able to write now
  await auto2.append(encode({ msg: 'auto2 writes after re-add' }))
  await replicateAndSync(auto1, auto2, auto3)

  // Verify the write was accepted
  const finalInfo = await auto1.system.get(auto2.local.key)
  t.ok(finalInfo.length > 0, 'auto2 writes were tracked')
})

test('writer-management - oplog flag', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  // Add auto2 as a writer so it gets stored in the system bee
  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  const writerInfo = await auto1.system.get(auto2.local.key)

  t.ok(writerInfo, 'writer info exists for added writer')
  t.ok(typeof writerInfo.isOplog === 'boolean', 'isOplog is a boolean')

  // The local writer is also stored in the system bee after it writes
  const localWriterInfo = await auto1.system.get(auto1.local.key)
  t.ok(localWriterInfo, 'local writer is stored in system bee after writing')
  t.ok(typeof localWriterInfo.isOplog === 'boolean', 'local writer isOplog is a boolean')
  t.ok(localWriterInfo.isOplog, 'local writer is marked as the current oplog (last writer)')
  t.ok(localWriterInfo.isIndexer, 'local writer is marked as indexer')
  t.absent(localWriterInfo.isRemoved, 'local writer is not removed')
})
