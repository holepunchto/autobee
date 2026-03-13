const test = require('brittle')
const b4a = require('b4a')
const { create, replicateAndSync, encode, decode, same } = require('./helpers')

test('view - read after write returns correct data', async function (t) {
  const auto1 = await create(t)

  await auto1.append(encode({ msg: 'hello' }))

  const node = await auto1.bee.get(b4a.from('latest'))
  t.ok(node, 'node exists')
  t.alike(decode(node.value), { msg: 'hello' }, 'value matches what was written')
})

test('view - multiple writes are all readable', async function (t) {
  const auto1 = await create(t)

  await auto1.append(encode({ key: 'a', value: 1 }))
  await auto1.append(encode({ key: 'b', value: 2 }))
  await auto1.append(encode({ key: 'c', value: 3 }))

  const node = await auto1.bee.get(b4a.from('latest'))
  t.ok(node, 'latest node exists')
  t.alike(decode(node.value), { key: 'c', value: 3 }, 'latest value is the last write')
})

test('view - two peers read same values after sync', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  await auto1.append(encode({ msg: 'from auto1' }))
  await replicateAndSync(auto1, auto2)

  const node1 = await auto1.bee.get(b4a.from('latest'))
  const node2 = await auto2.bee.get(b4a.from('latest'))

  t.ok(node1, 'auto1 has latest')
  t.ok(node2, 'auto2 has latest')
  t.alike(decode(node1.value), decode(node2.value), 'both peers read same value')
})

test('view - snapshot updates after flush', async function (t) {
  const auto1 = await create(t)

  await auto1.append(encode({ msg: 'first' }))

  const node1 = await auto1.bee.get(b4a.from('latest'))
  t.alike(decode(node1.value), { msg: 'first' }, 'first write readable')

  await auto1.append(encode({ msg: 'second' }))

  const node2 = await auto1.bee.get(b4a.from('latest'))
  t.alike(decode(node2.value), { msg: 'second' }, 'second write readable after update')
})

test('view - concurrent writes from two peers produce same view', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  // Both write concurrently
  await auto1.append(encode({ msg: 'auto1-data' }))
  await auto2.append(encode({ msg: 'auto2-data' }))

  await replicateAndSync(auto1, auto2)

  t.ok(await same(auto1, auto2), 'views are identical after concurrent writes')
})

test('view - view consistent after multiple sync rounds', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  for (let i = 0; i < 5; i++) {
    await auto1.append(encode({ round: i, from: 'auto1' }))
    await auto2.append(encode({ round: i, from: 'auto2' }))
    await replicateAndSync(auto1, auto2)

    t.ok(await same(auto1, auto2), 'views match after round ' + i)
  }
})

test('view - correct state after undo-redo from late arriving writer', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)
  const auto3 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await auto1.append(encode({ addWriter: auto3.local.id }))
  await replicateAndSync(auto1, auto2, auto3)

  // All three write concurrently
  await auto1.append(encode({ msg: 'from-1' }))
  await auto2.append(encode({ msg: 'from-2' }))
  await auto3.append(encode({ msg: 'from-3' }))

  // Sync only auto1 ↔ auto2 first
  await replicateAndSync(auto1, auto2)
  t.ok(await same(auto1, auto2), 'auto1 and auto2 agree after first sync')

  // Now sync auto3 — forces undo/redo on auto1
  await replicateAndSync(auto1, auto3)
  await replicateAndSync(auto1, auto2, auto3)

  t.ok(await same(auto1, auto2, auto3), 'all three converge after undo-redo')

  // Verify the view is actually readable and not corrupted
  const entries = []
  for await (const data of auto1.bee.createReadStream()) {
    entries.push(data)
  }
  t.ok(entries.length > 0, 'view has entries after undo-redo')

  // All peers should have the same number of entries
  const entries2 = []
  for await (const data of auto2.bee.createReadStream()) {
    entries2.push(data)
  }
  const entries3 = []
  for await (const data of auto3.bee.createReadStream()) {
    entries3.push(data)
  }
  t.is(entries.length, entries2.length, 'auto1 and auto2 have same entry count')
  t.is(entries.length, entries3.length, 'auto1 and auto3 have same entry count')
})

test('view - deterministic winner for conflicting key writes', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  // Both write to 'latest' key concurrently (the apply function always writes to 'latest')
  await auto1.append(encode({ msg: 'auto1-wins' }))
  await auto2.append(encode({ msg: 'auto2-wins' }))

  await replicateAndSync(auto1, auto2)

  // Both should see the same value for 'latest'
  const node1 = await auto1.bee.get(b4a.from('latest'))
  const node2 = await auto2.bee.get(b4a.from('latest'))

  t.ok(node1, 'auto1 has latest')
  t.ok(node2, 'auto2 has latest')
  t.alike(node1.value, node2.value, 'both peers see same winner for conflicting key')
})

test('view - multiple undo-redo cycles produce correct final state', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)
  const auto3 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await auto1.append(encode({ addWriter: auto3.local.id }))
  await replicateAndSync(auto1, auto2, auto3)

  // Round 1: concurrent writes, partial sync
  await auto1.append(encode({ round: 1, from: 'auto1' }))
  await auto2.append(encode({ round: 1, from: 'auto2' }))
  await replicateAndSync(auto1, auto2)

  // Round 2: auto3 writes (still disconnected from round 1)
  await auto3.append(encode({ round: 1, from: 'auto3' }))
  await auto3.append(encode({ round: 2, from: 'auto3' }))

  // Sync auto3 with auto1 — first undo/redo
  await replicateAndSync(auto1, auto3)

  // Round 3: more concurrent writes
  await auto1.append(encode({ round: 3, from: 'auto1' }))
  await auto2.append(encode({ round: 3, from: 'auto2' }))

  // Sync auto2 — may trigger another undo/redo
  await replicateAndSync(auto1, auto2)

  // Final full sync
  await replicateAndSync(auto1, auto2, auto3)

  t.ok(await same(auto1, auto2, auto3), 'all peers converge after multiple undo-redo cycles')

  // Verify view integrity
  const entries = []
  for await (const data of auto1.bee.createReadStream()) {
    entries.push(data)
  }
  t.ok(entries.length > 0, 'view has entries')
})

test('view - snapshot isolation from working bee', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  await auto1.append(encode({ msg: 'first' }))
  await replicateAndSync(auto1, auto2)

  // Take a snapshot of the current state
  const snap1 = []
  for await (const data of auto1.bee.createReadStream()) {
    snap1.push(b4a.toString(data.value, 'hex'))
  }

  // Write more data
  await auto1.append(encode({ msg: 'second' }))

  // The snapshot bee should have updated after append
  const snap2 = []
  for await (const data of auto1.bee.createReadStream()) {
    snap2.push(b4a.toString(data.value, 'hex'))
  }

  t.not(JSON.stringify(snap1), JSON.stringify(snap2), 'snapshot changed after new write')
})

test('view - rapid alternating writes then single sync', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  // Both fire off many writes without syncing
  for (let i = 0; i < 10; i++) {
    await auto1.append(encode({ seq: i, from: 'auto1' }))
    await auto2.append(encode({ seq: i, from: 'auto2' }))
  }

  // Single sync at the end
  await replicateAndSync(auto1, auto2)

  t.ok(await same(auto1, auto2), 'peers converge after rapid alternating writes')

  // Verify view is not empty
  const entries = []
  for await (const data of auto1.bee.createReadStream()) {
    entries.push(data)
  }
  t.ok(entries.length > 0, 'view has entries')
})

test('view - restart converges with peers after undo-redo', async function (t) {
  const { dump } = require('./helpers')

  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  // Concurrent writes to force undo/redo
  await auto1.append(encode({ msg: 'auto1-concurrent' }))
  await auto2.append(encode({ msg: 'auto2-concurrent' }))
  await replicateAndSync(auto1, auto2)

  t.ok(await same(auto1, auto2), 'peers converge before restart')

  console.log('\n--- before restart ---')
  console.log('auto1 view:\n' + (await dump(auto1)))
  console.log('auto2 view:\n' + (await dump(auto2)))

  // Restart auto1 from same storage
  const storage = auto1.store.storage
  const auto1Key = auto1.key

  const auto1b = await create(t, auto1Key, { storage })
  await auto1b.ready()

  console.log('\n--- after restart, before sync ---')
  console.log('auto1b view:\n' + (await dump(auto1b)))

  // Sync restarted node with auto2
  await replicateAndSync(auto1b, auto2)

  console.log('\n--- after restart + sync ---')
  console.log('auto1b view:\n' + (await dump(auto1b)))
  console.log('auto2 view:\n' + (await dump(auto2)))

  // The restarted node must converge with auto2
  t.ok(await same(auto1b, auto2), 'restarted node converges with peer')

  // Write more data after restart to verify the system is healthy
  await auto1b.append(encode({ msg: 'after-restart' }))
  await replicateAndSync(auto1b, auto2)

  t.ok(await same(auto1b, auto2), 'peers converge after post-restart write')
})

test('view - four peers staggered sync all converge', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)
  const auto3 = await create(t, auto1.key)
  const auto4 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await auto1.append(encode({ addWriter: auto3.local.id }))
  await auto1.append(encode({ addWriter: auto4.local.id }))
  await replicateAndSync(auto1, auto2, auto3, auto4)

  // All four write concurrently
  await auto1.append(encode({ msg: 'a' }))
  await auto2.append(encode({ msg: 'b' }))
  await auto3.append(encode({ msg: 'c' }))
  await auto4.append(encode({ msg: 'd' }))

  // Staggered sync: 1↔2, 3↔4, then 1↔3
  await replicateAndSync(auto1, auto2)
  await replicateAndSync(auto3, auto4)
  await replicateAndSync(auto1, auto3)

  // More writes while partially synced
  await auto1.append(encode({ msg: 'a2' }))
  await auto4.append(encode({ msg: 'd2' }))

  // Full sync
  await replicateAndSync(auto1, auto2, auto3, auto4)

  t.ok(await same(auto1, auto2, auto3, auto4), 'all four peers converge after staggered sync')
})

test('view - overwrite same key across undo-redo produces deterministic result', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)
  const auto3 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await auto1.append(encode({ addWriter: auto3.local.id }))
  await replicateAndSync(auto1, auto2, auto3)

  // All three overwrite 'latest' concurrently
  await auto1.append(encode({ winner: 'auto1' }))
  await auto2.append(encode({ winner: 'auto2' }))

  // Sync 1↔2 first
  await replicateAndSync(auto1, auto2)

  // auto3 writes and syncs — forces undo/redo, 'latest' may change
  await auto3.append(encode({ winner: 'auto3' }))
  await replicateAndSync(auto1, auto2, auto3)

  const val123_1 = await auto1.bee.get(b4a.from('latest'))
  const val123_2 = await auto2.bee.get(b4a.from('latest'))
  const val123_3 = await auto3.bee.get(b4a.from('latest'))

  t.ok(val123_1, 'auto1 has latest')
  t.ok(val123_2, 'auto2 has latest')
  t.ok(val123_3, 'auto3 has latest')
  t.alike(val123_1.value, val123_2.value, 'auto1 and auto2 agree on latest')
  t.alike(val123_1.value, val123_3.value, 'auto1 and auto3 agree on latest')
})

test('view - read stream consistent across all peers after complex sync', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)
  const auto3 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await auto1.append(encode({ addWriter: auto3.local.id }))
  await replicateAndSync(auto1, auto2, auto3)

  // Round 1: all write concurrently
  await auto1.append(encode({ round: 1, from: 1 }))
  await auto2.append(encode({ round: 1, from: 2 }))
  await auto3.append(encode({ round: 1, from: 3 }))

  // Partial sync
  await replicateAndSync(auto1, auto2)

  // Round 2: more writes
  await auto1.append(encode({ round: 2, from: 1 }))
  await auto3.append(encode({ round: 2, from: 3 }))

  // Full sync
  await replicateAndSync(auto1, auto2, auto3)

  // Collect all entries from each peer's read stream
  async function collect(auto) {
    const entries = []
    for await (const data of auto.bee.createReadStream()) {
      entries.push({
        key: b4a.toString(data.key, 'hex'),
        value: b4a.toString(data.value, 'hex')
      })
    }
    return JSON.stringify(entries)
  }

  const s1 = await collect(auto1)
  const s2 = await collect(auto2)
  const s3 = await collect(auto3)

  t.is(s1, s2, 'auto1 and auto2 read streams match')
  t.is(s1, s3, 'auto1 and auto3 read streams match')
})

test('view - three peers all converge to same view', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)
  const auto3 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await auto1.append(encode({ addWriter: auto3.local.id }))
  await replicateAndSync(auto1, auto2, auto3)

  await auto1.append(encode({ msg: 'from-1' }))
  await auto2.append(encode({ msg: 'from-2' }))
  await auto3.append(encode({ msg: 'from-3' }))

  await replicateAndSync(auto1, auto2, auto3)

  t.ok(await same(auto1, auto2, auto3), 'all three peers have identical views')
})
