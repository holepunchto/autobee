const test = require('brittle')
const b4a = require('b4a')
const { create, replicate, replicateAndSync, encode, decode, same } = require('./helpers')

test('batch - single writer multi-value append', async function (t) {
  const auto1 = await create(t)

  await auto1.append([
    encode({ msg: 'first' }),
    encode({ msg: 'second' }),
    encode({ msg: 'third' })
  ])

  const node = await auto1.bee.get(b4a.from('latest'))
  t.ok(node, 'latest exists')
  t.alike(decode(node.value), { msg: 'third' }, 'latest is the last value in the batch')
})

test('batch - multi-value append syncs to second peer', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  await auto1.append([
    encode({ msg: 'batch-1' }),
    encode({ msg: 'batch-2' }),
    encode({ msg: 'batch-3' })
  ])

  await replicateAndSync(auto1, auto2)

  t.ok(await same(auto1, auto2), 'peers converge after multi-value append')
})

test('batch - both writers do multi-value appends concurrently', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  await auto1.append([encode({ msg: 'a1' }), encode({ msg: 'a2' })])

  await auto2.append([encode({ msg: 'b1' }), encode({ msg: 'b2' })])

  await replicateAndSync(auto1, auto2)

  t.ok(await same(auto1, auto2), 'peers converge after concurrent multi-value appends')
})

test('batch - mix of single and multi-value appends', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  await auto1.append(encode({ msg: 'single-1' }))
  await auto1.append([encode({ msg: 'batch-1' }), encode({ msg: 'batch-2' })])
  await auto1.append(encode({ msg: 'single-2' }))

  await replicateAndSync(auto1, auto2)

  t.ok(await same(auto1, auto2), 'peers converge with mixed single and batch appends')
})

test('batch - multi-value append followed by concurrent writes', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  // auto1 does a batch append
  await auto1.append([
    encode({ msg: 'batch-a1' }),
    encode({ msg: 'batch-a2' }),
    encode({ msg: 'batch-a3' })
  ])

  // auto2 does a single append concurrently
  await auto2.append(encode({ msg: 'single-b1' }))

  await replicateAndSync(auto1, auto2)

  t.ok(await same(auto1, auto2), 'peers converge after batch then concurrent write')
})

test('batch - multiple rounds of multi-value appends', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  for (let round = 0; round < 3; round++) {
    await auto1.append([
      encode({ round, from: 'auto1', idx: 0 }),
      encode({ round, from: 'auto1', idx: 1 })
    ])

    await auto2.append([
      encode({ round, from: 'auto2', idx: 0 }),
      encode({ round, from: 'auto2', idx: 1 })
    ])

    await replicateAndSync(auto1, auto2)
    t.ok(await same(auto1, auto2), 'peers converge after round ' + round)
  }
})

test('batch - three writers with multi-value appends', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)
  const auto3 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await auto1.append(encode({ addWriter: auto3.local.id }))
  await replicateAndSync(auto1, auto2, auto3)

  await auto1.append([encode({ msg: 'a1' }), encode({ msg: 'a2' })])
  await auto2.append([encode({ msg: 'b1' }), encode({ msg: 'b2' })])
  await auto3.append([encode({ msg: 'c1' }), encode({ msg: 'c2' })])

  await replicateAndSync(auto1, auto2, auto3)

  t.ok(await same(auto1, auto2, auto3), 'three peers converge with multi-value appends')
})

test('batch - concurrent large batches force topo sort', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  // Both do large batches concurrently
  const batch1 = []
  const batch2 = []
  for (let i = 0; i < 10; i++) {
    batch1.push(encode({ from: 'auto1', idx: i }))
    batch2.push(encode({ from: 'auto2', idx: i }))
  }

  await auto1.append(batch1)
  await auto2.append(batch2)

  await replicateAndSync(auto1, auto2)

  t.ok(await same(auto1, auto2), 'peers converge after concurrent large batches')
})

test('batch - batch followed by single write then batch', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  await auto1.append([encode({ msg: 'b1-a' }), encode({ msg: 'b1-b' })])
  await auto1.append(encode({ msg: 'single' }))
  await auto1.append([encode({ msg: 'b2-a' }), encode({ msg: 'b2-b' })])

  // auto2 writes concurrently
  await auto2.append([encode({ msg: 'b3-a' }), encode({ msg: 'b3-b' }), encode({ msg: 'b3-c' })])

  await replicateAndSync(auto1, auto2)

  t.ok(await same(auto1, auto2), 'peers converge with interleaved batch and single writes')
})

test('batch - three writers mixed batch sizes staggered sync', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)
  const auto3 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await auto1.append(encode({ addWriter: auto3.local.id }))
  await replicateAndSync(auto1, auto2, auto3)

  // Different batch sizes from each writer
  await auto1.append([encode({ msg: 'a1' })])
  await auto2.append([encode({ msg: 'b1' }), encode({ msg: 'b2' }), encode({ msg: 'b3' })])
  await auto3.append([encode({ msg: 'c1' }), encode({ msg: 'c2' })])

  // Staggered sync: 1↔2 first
  await replicateAndSync(auto1, auto2)

  // More writes while auto3 is disconnected
  await auto1.append([encode({ msg: 'a2' }), encode({ msg: 'a3' })])
  await auto2.append(encode({ msg: 'b4' }))

  // Now sync auto3 — forces undo/redo with mixed batch sizes
  await replicateAndSync(auto1, auto3)
  await replicateAndSync(auto1, auto2, auto3)

  t.ok(
    await same(auto1, auto2, auto3),
    'three peers converge with mixed batch sizes and staggered sync'
  )
})

test('batch - addWriter during multi-value batch sequence', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)
  const auto3 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  // auto1 does a batch, then adds auto3, then another batch
  await auto1.append([encode({ msg: 'before-add-1' }), encode({ msg: 'before-add-2' })])
  await auto1.append(encode({ addWriter: auto3.local.id }))
  await auto1.append([encode({ msg: 'after-add-1' }), encode({ msg: 'after-add-2' })])

  // auto2 writes a batch concurrently
  await auto2.append([encode({ msg: 'auto2-1' }), encode({ msg: 'auto2-2' })])

  await replicateAndSync(auto1, auto2, auto3)

  t.ok(auto3.writable, 'auto3 is writable')
  t.ok(await same(auto1, auto2, auto3), 'all peers converge after addWriter mid-batch-sequence')
})

test('batch - concurrent batches from 4 writers with chain sync', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)
  const auto3 = await create(t, auto1.key)
  const auto4 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await auto1.append(encode({ addWriter: auto3.local.id }))
  await auto1.append(encode({ addWriter: auto4.local.id }))
  await replicateAndSync(auto1, auto2, auto3, auto4)

  // All four write batches concurrently
  await auto1.append([encode({ msg: 'a1' }), encode({ msg: 'a2' })])
  await auto2.append([encode({ msg: 'b1' }), encode({ msg: 'b2' }), encode({ msg: 'b3' })])
  await auto3.append([encode({ msg: 'c1' })])
  await auto4.append([encode({ msg: 'd1' }), encode({ msg: 'd2' })])

  // Chain sync: 1↔2, 2↔3, 3↔4, 4↔1
  await replicateAndSync(auto1, auto2)
  await replicateAndSync(auto2, auto3)
  await replicateAndSync(auto3, auto4)
  await replicateAndSync(auto4, auto1)

  // Final full sync
  await replicateAndSync(auto1, auto2, auto3, auto4)

  t.ok(await same(auto1, auto2, auto3, auto4), 'four peers converge after chain sync with batches')
})

test('batch - rapid small batches without sync then big sync', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  // Many small batches from both writers without syncing
  for (let i = 0; i < 5; i++) {
    await auto1.append([
      encode({ from: 'a', round: i, idx: 0 }),
      encode({ from: 'a', round: i, idx: 1 })
    ])
    await auto2.append([
      encode({ from: 'b', round: i, idx: 0 }),
      encode({ from: 'b', round: i, idx: 1 })
    ])
  }

  // Single big sync
  await replicateAndSync(auto1, auto2)

  t.ok(await same(auto1, auto2), 'peers converge after many unsynchronized small batches')
})

test('batch - batch with causal links across writers', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  // auto1 writes a batch
  await auto1.append([encode({ msg: 'a1' }), encode({ msg: 'a2' }), encode({ msg: 'a3' })])
  await replicateAndSync(auto1, auto2)

  // auto2 sees auto1's batch and writes its own batch (links to auto1's entries)
  await auto2.append([encode({ msg: 'b1-after-a' }), encode({ msg: 'b2-after-a' })])

  // auto1 writes another batch concurrently
  await auto1.append([encode({ msg: 'a4' }), encode({ msg: 'a5' })])

  await replicateAndSync(auto1, auto2)

  t.ok(await same(auto1, auto2), 'peers converge with causal batch links')
})

test('batch - undo-redo with asymmetric batch sizes', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  // auto1 does many small single appends
  for (let i = 0; i < 5; i++) {
    await auto1.append(encode({ from: 'auto1', idx: i }))
  }

  // auto2 does one large batch
  const bigBatch = []
  for (let i = 0; i < 5; i++) {
    bigBatch.push(encode({ from: 'auto2', idx: i }))
  }
  await auto2.append(bigBatch)

  await replicateAndSync(auto1, auto2)

  t.ok(await same(auto1, auto2), 'peers converge with asymmetric batch sizes during undo-redo')
})

test('batch - multiple batches from same writer between syncs', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  // auto1 does 3 separate batch appends without syncing
  await auto1.append([encode({ msg: 'a-batch1-0' }), encode({ msg: 'a-batch1-1' })])
  await auto1.append([encode({ msg: 'a-batch2-0' }), encode({ msg: 'a-batch2-1' })])
  await auto1.append([encode({ msg: 'a-batch3-0' }), encode({ msg: 'a-batch3-1' })])

  // auto2 does 3 separate batch appends without syncing
  await auto2.append([encode({ msg: 'b-batch1-0' }), encode({ msg: 'b-batch1-1' })])
  await auto2.append([encode({ msg: 'b-batch2-0' }), encode({ msg: 'b-batch2-1' })])
  await auto2.append([encode({ msg: 'b-batch3-0' }), encode({ msg: 'b-batch3-1' })])

  await replicateAndSync(auto1, auto2)

  t.ok(await same(auto1, auto2), 'peers converge with multiple batches from same writer')
})

test('batch - single entry batches interleaved with multi-entry batches', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  // auto1: single, batch, single, batch
  await auto1.append(encode({ msg: 'a-single-1' }))
  await auto1.append([
    encode({ msg: 'a-batch-1' }),
    encode({ msg: 'a-batch-2' }),
    encode({ msg: 'a-batch-3' })
  ])
  await auto1.append(encode({ msg: 'a-single-2' }))
  await auto1.append([encode({ msg: 'a-batch-4' }), encode({ msg: 'a-batch-5' })])

  // auto2: batch, single, batch, single
  await auto2.append([encode({ msg: 'b-batch-1' }), encode({ msg: 'b-batch-2' })])
  await auto2.append(encode({ msg: 'b-single-1' }))
  await auto2.append([
    encode({ msg: 'b-batch-3' }),
    encode({ msg: 'b-batch-4' }),
    encode({ msg: 'b-batch-5' })
  ])
  await auto2.append(encode({ msg: 'b-single-2' }))

  await replicateAndSync(auto1, auto2)

  t.ok(await same(auto1, auto2), 'peers converge with interleaved single and multi-entry batches')
})

test('batch - three writers each doing multiple batches then staggered sync', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)
  const auto3 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await auto1.append(encode({ addWriter: auto3.local.id }))
  await replicateAndSync(auto1, auto2, auto3)

  // Each writer does multiple batches
  await auto1.append([encode({ msg: 'a1' }), encode({ msg: 'a2' })])
  await auto1.append([encode({ msg: 'a3' })])

  await auto2.append([encode({ msg: 'b1' }), encode({ msg: 'b2' }), encode({ msg: 'b3' })])
  await auto2.append([encode({ msg: 'b4' }), encode({ msg: 'b5' })])

  await auto3.append(encode({ msg: 'c1' }))
  await auto3.append([encode({ msg: 'c2' }), encode({ msg: 'c3' })])

  // Staggered: sync 1↔2, then 2 writes more, then sync 2↔3, then sync all
  await replicateAndSync(auto1, auto2)

  await auto2.append([encode({ msg: 'b6-after-sync' }), encode({ msg: 'b7-after-sync' })])

  await replicateAndSync(auto2, auto3)
  await replicateAndSync(auto1, auto2, auto3)

  t.ok(
    await same(auto1, auto2, auto3),
    'three peers converge with multiple batches and staggered sync'
  )
})

test('batch - batch size of 1 treated same as single append', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)
  const auto3 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await auto1.append(encode({ addWriter: auto3.local.id }))
  await replicateAndSync(auto1, auto2, auto3)

  // auto2 uses array-of-one (batch size 1)
  await auto2.append([encode({ msg: 'batch-of-one' })])

  // auto3 uses single value
  await auto3.append(encode({ msg: 'single-value' }))

  await replicateAndSync(auto1, auto2, auto3)

  t.ok(await same(auto1, auto2, auto3), 'batch-of-one and single append converge')
})

test('batch - writer removed mid-batch-sequence', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  // auto2 does multiple batches
  await auto2.append([encode({ msg: 'b1' }), encode({ msg: 'b2' })])
  await auto2.append([encode({ msg: 'b3' }), encode({ msg: 'b4' })])

  // auto1 removes auto2 concurrently
  await auto1.append(encode({ removeWriter: auto2.local.id }))

  // auto2 does more batches not knowing it's removed
  await auto2.append([encode({ msg: 'b5-removed' }), encode({ msg: 'b6-removed' })])

  // Use replicate + manual wait since sync() can't converge for removed writers
  const done = replicate(auto1, auto2)
  await new Promise((resolve) => setTimeout(resolve, 1000))
  await auto1.flush()
  await new Promise((resolve) => setTimeout(resolve, 500))
  await done()

  const info = await auto1.system.get(auto2.local.key)
  t.ok(info, 'writer info exists')
  t.ok(info.isRemoved, 'auto2 is marked as removed')
})

test('batch - large batch from each of 4 writers concurrent', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)
  const auto3 = await create(t, auto1.key)
  const auto4 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await auto1.append(encode({ addWriter: auto3.local.id }))
  await auto1.append(encode({ addWriter: auto4.local.id }))
  await replicateAndSync(auto1, auto2, auto3, auto4)

  // Each writer does a large batch
  const mkBatch = (prefix, n) => {
    const b = []
    for (let i = 0; i < n; i++) b.push(encode({ from: prefix, idx: i }))
    return b
  }

  await auto1.append(mkBatch('a', 8))
  await auto2.append(mkBatch('b', 12))
  await auto3.append(mkBatch('c', 6))
  await auto4.append(mkBatch('d', 10))

  await replicateAndSync(auto1, auto2, auto3, auto4)

  t.ok(await same(auto1, auto2, auto3, auto4), 'four peers converge with large concurrent batches')
})

test('batch - large batch append', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  const values = []
  for (let i = 0; i < 20; i++) {
    values.push(encode({ idx: i }))
  }

  await auto1.append(values)
  await replicateAndSync(auto1, auto2)

  t.ok(await same(auto1, auto2), 'peers converge after large batch append')
})
