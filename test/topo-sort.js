const test = require('brittle')
const { create, replicateAndSync, encode, same } = require('./helpers')

test('topo-sort - two writers concurrent writes converge', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  // auto1 adds auto2 as a writer
  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  t.ok(auto2.writable, 'auto2 is writable')

  // Both write concurrently without syncing
  await auto1.append(encode({ msg: 'from auto1' }))
  await auto2.append(encode({ msg: 'from auto2' }))

  // Sync and verify convergence
  await replicateAndSync(auto1, auto2)

  t.ok(await same(auto1, auto2), 'both peers converge to same state')
})

test('topo-sort - two writers multiple concurrent writes converge', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  // Both write multiple entries concurrently
  await auto1.append(encode({ msg: 'auto1-a' }))
  await auto1.append(encode({ msg: 'auto1-b' }))
  await auto2.append(encode({ msg: 'auto2-a' }))
  await auto2.append(encode({ msg: 'auto2-b' }))

  await replicateAndSync(auto1, auto2)

  t.ok(await same(auto1, auto2), 'both peers converge to same state')
})

test('topo-sort - three writers all write before syncing', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)
  const auto3 = await create(t, auto1.key)

  // auto1 adds auto2 and auto3
  await auto1.append(encode({ addWriter: auto2.local.id }))
  await auto1.append(encode({ addWriter: auto3.local.id }))
  await replicateAndSync(auto1, auto2, auto3)

  t.ok(auto2.writable, 'auto2 is writable')
  t.ok(auto3.writable, 'auto3 is writable')

  // All three write concurrently
  await auto1.append(encode({ msg: 'from auto1' }))
  await auto2.append(encode({ msg: 'from auto2' }))
  await auto3.append(encode({ msg: 'from auto3' }))

  // Sync all and verify convergence
  await replicateAndSync(auto1, auto2, auto3)

  t.ok(await same(auto1, auto2, auto3), 'all three peers converge to same state')
})

test('topo-sort - sequential writes maintain order', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  // Write sequentially with syncs in between — no conflicts
  await auto1.append(encode({ msg: 'step1' }))
  await replicateAndSync(auto1, auto2)

  await auto2.append(encode({ msg: 'step2' }))
  await replicateAndSync(auto1, auto2)

  await auto1.append(encode({ msg: 'step3' }))
  await replicateAndSync(auto1, auto2)

  t.ok(await same(auto1, auto2), 'both peers converge to same state')
})

test('topo-sort - concurrent writes then sequential writes', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  // Phase 1: concurrent writes
  await auto1.append(encode({ msg: 'concurrent-auto1' }))
  await auto2.append(encode({ msg: 'concurrent-auto2' }))
  await replicateAndSync(auto1, auto2)

  // Phase 2: sequential writes (should be fast-path, no undo needed)
  await auto1.append(encode({ msg: 'sequential-1' }))
  await replicateAndSync(auto1, auto2)

  await auto2.append(encode({ msg: 'sequential-2' }))
  await replicateAndSync(auto1, auto2)

  t.ok(await same(auto1, auto2), 'both peers converge to same state')
})

test('topo-sort - one writer many entries vs another writer one entry', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  // auto1 writes many entries
  for (let i = 0; i < 5; i++) {
    await auto1.append(encode({ msg: 'auto1-' + i }))
  }

  // auto2 writes one entry
  await auto2.append(encode({ msg: 'auto2-only' }))

  await replicateAndSync(auto1, auto2)

  t.ok(await same(auto1, auto2), 'both peers converge to same state')
})

test('topo-sort - multiple rounds of concurrent writes', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  // Multiple rounds of concurrent writes with syncs between
  for (let round = 0; round < 3; round++) {
    await auto1.append(encode({ msg: 'auto1-round-' + round }))
    await auto2.append(encode({ msg: 'auto2-round-' + round }))
    await replicateAndSync(auto1, auto2)

    t.ok(await same(auto1, auto2), 'peers converge after round ' + round)
  }
})

test('topo-sort - interleaved partial syncs force multiple undo-redo cycles', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)
  const auto3 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await auto1.append(encode({ addWriter: auto3.local.id }))
  await replicateAndSync(auto1, auto2, auto3)

  // Phase 1: all three write concurrently (no one sees each other)
  await auto1.append(encode({ msg: 'a1' }))
  await auto2.append(encode({ msg: 'b1' }))
  await auto3.append(encode({ msg: 'c1' }))

  // Phase 2: sync only A↔B — A's indexer does first topo sort
  await replicateAndSync(auto1, auto2)

  // Phase 3: C writes more while still disconnected from A
  await auto3.append(encode({ msg: 'c2' }))
  await auto3.append(encode({ msg: 'c3' }))

  // Phase 4: sync B↔C — B now has C's old + new writes
  await replicateAndSync(auto2, auto3)

  // Phase 5: sync A↔C — A must undo its previous topo result and redo
  // with C's writes interleaved, forcing a second undo/redo cycle
  await replicateAndSync(auto1, auto3)

  // Final: sync everyone to ensure full convergence
  await replicateAndSync(auto1, auto2, auto3)

  t.ok(await same(auto1, auto2, auto3), 'all three peers converge after interleaved partial syncs')
})

test('topo-sort - chain of partial syncs across 4 writers', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)
  const auto3 = await create(t, auto1.key)
  const auto4 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await auto1.append(encode({ addWriter: auto3.local.id }))
  await auto1.append(encode({ addWriter: auto4.local.id }))
  await replicateAndSync(auto1, auto2, auto3, auto4)

  // All four write concurrently
  await auto1.append(encode({ msg: 'a1' }))
  await auto2.append(encode({ msg: 'b1' }))
  await auto3.append(encode({ msg: 'c1' }))
  await auto4.append(encode({ msg: 'd1' }))

  // Chain sync: 1↔2, then 2↔3, then 3↔4
  // Each peer only sees the previous peer's data
  await replicateAndSync(auto1, auto2)
  await replicateAndSync(auto2, auto3)
  await replicateAndSync(auto3, auto4)

  // Now sync 4↔1 — auto1 must reconcile data that traveled through the chain
  await replicateAndSync(auto4, auto1)

  // Final full sync
  await replicateAndSync(auto1, auto2, auto3, auto4)

  t.ok(await same(auto1, auto2, auto3, auto4), 'all four peers converge after chain sync')
})

test('topo-sort - writer added during concurrent writes triggers undo-redo', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)
  const auto3 = await create(t, auto1.key)

  // Only auto2 is added initially
  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  // auto1 and auto2 both write concurrently
  await auto1.append(encode({ msg: 'a1' }))
  await auto2.append(encode({ msg: 'b1' }))

  // Sync so the topo sort resolves these concurrent writes
  await replicateAndSync(auto1, auto2)

  // Now auto1 adds auto3 while auto2 writes more
  await auto1.append(encode({ addWriter: auto3.local.id }))
  await auto2.append(encode({ msg: 'b2' }))

  // Sync auto1↔auto3 so auto3 learns it's a writer
  await replicateAndSync(auto1, auto3)
  t.ok(auto3.writable, 'auto3 is writable')

  // auto3 writes before syncing with auto2
  await auto3.append(encode({ msg: 'c1' }))

  // Now sync everyone — forces undo/redo with new writer's data mid-replay
  await replicateAndSync(auto1, auto2, auto3)

  t.ok(
    await same(auto1, auto2, auto3),
    'all peers converge after writer added during concurrent writes'
  )
})

test('topo-sort - three writers pairwise sync converges', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)
  const auto3 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await auto1.append(encode({ addWriter: auto3.local.id }))
  await replicateAndSync(auto1, auto2, auto3)

  // All three write concurrently
  await auto1.append(encode({ msg: 'from auto1' }))
  await auto2.append(encode({ msg: 'from auto2' }))
  await auto3.append(encode({ msg: 'from auto3' }))

  // Sync pairwise instead of all at once
  await replicateAndSync(auto1, auto2)
  await replicateAndSync(auto2, auto3)
  await replicateAndSync(auto1, auto3)

  t.ok(await same(auto1, auto2, auto3), 'all three peers converge after pairwise sync')
})
