const test = require('brittle')
const b4a = require('b4a')
const { create, replicateAndSync, same, encode } = require('./helpers')

test('three-way fork and merge', async function (t) {
  t.comment('Setup: Create three autobees')
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)
  const auto3 = await create(t, auto1.key)

  t.comment('Phase 1: Bootstrap - auto1 writes initial value and adds auto2 and auto3 as writers')
  await auto1.append(encode({ msg: 'initial', from: 1 }))
  await auto1.append(encode({ addWriter: auto2.local.id }))
  await auto1.append(encode({ addWriter: auto3.local.id }))

  t.comment('Phase 2: Sync all nodes to get writer permissions')
  await replicateAndSync(auto1, auto2, auto3)

  t.ok(auto1.writable, 'auto1 is writable')
  t.ok(auto2.writable, 'auto2 is writable')
  t.ok(auto3.writable, 'auto3 is writable')

  t.comment('Phase 3: Create three-way fork - each node writes independently')
  await auto1.append(encode({ msg: 'fork', from: 1 }))
  await auto2.append(encode({ msg: 'fork', from: 2 }))
  await auto3.append(encode({ msg: 'fork', from: 3 }))

  t.comment('Phase 4: Merge - replicate and sync all nodes')
  await replicateAndSync(auto1, auto2, auto3)

  t.comment('Phase 5: Verify all nodes converged to same state')
  t.ok(await same(auto1, auto2), 'auto1 and auto2 have same state')
  t.ok(await same(auto2, auto3), 'auto2 and auto3 have same state')
  t.ok(await same(auto1, auto3), 'auto1 and auto3 have same state')

  t.comment('Phase 6: Verify merge completed - check final state')
  const node = await auto1.view.get(b4a.from('latest'))
  t.ok(node, 'final state exists')
  
  // The test helper only stores the latest value, so we verify the merge happened
  // by checking that all nodes have the same state and local lengths increased
  t.is(auto1.local.length, 4, 'auto1 wrote 4 entries (initial + 2 addWriter + fork)')
  t.is(auto2.local.length, 1, 'auto2 wrote 1 entry (fork)')
  t.is(auto3.local.length, 1, 'auto3 wrote 1 entry (fork)')
})

test('sequential fork and merge - multiple rounds', async function (t) {
  t.comment('Setup: Create two autobees')
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  t.comment('Phase 1: Bootstrap - auto1 adds auto2 as writer')
  await auto1.append(encode({ msg: 'initial', from: 1 }))
  await auto1.append(encode({ addWriter: auto2.local.id }))

  t.comment('Phase 2: Sync to grant writer permissions')
  await replicateAndSync(auto1, auto2)

  t.ok(auto1.writable, 'auto1 is writable')
  t.ok(auto2.writable, 'auto2 is writable')

  t.comment('Phase 3: Round 1 - Fork')
  await auto1.append(encode({ msg: 'round1', from: 1 }))
  await auto2.append(encode({ msg: 'round1', from: 2 }))

  t.comment('Phase 4: Round 1 - Merge')
  await replicateAndSync(auto1, auto2)

  t.ok(await same(auto1, auto2), 'round 1 merge successful')
  const round1Length1 = auto1.local.length
  const round1Length2 = auto2.local.length

  t.comment('Phase 5: Round 2 - Fork again')
  await auto1.append(encode({ msg: 'round2', from: 1 }))
  await auto2.append(encode({ msg: 'round2', from: 2 }))

  t.comment('Phase 6: Round 2 - Merge')
  await replicateAndSync(auto1, auto2)

  t.ok(await same(auto1, auto2), 'round 2 merge successful')

  t.comment('Phase 7: Verify local lengths increased each round')
  t.is(auto1.local.length, round1Length1 + 1, 'auto1 wrote one more entry in round 2')
  t.is(auto2.local.length, round1Length2 + 1, 'auto2 wrote one more entry in round 2')

  t.comment('Phase 8: Round 3 - Fork and merge one more time')
  await auto1.append(encode({ msg: 'round3', from: 1 }))
  await auto2.append(encode({ msg: 'round3', from: 2 }))

  await replicateAndSync(auto1, auto2)

  t.ok(await same(auto1, auto2), 'round 3 merge successful')

  t.comment('Phase 9: Verify final state')
  const node = await auto1.view.get(b4a.from('latest'))
  t.ok(node, 'final state exists')
  
  // auto1: initial + addWriter + round1 + round2 + round3 = 5 entries
  // auto2: round1 + round2 + round3 = 3 entries
  t.is(auto1.local.length, 5, 'auto1 wrote 5 entries total')
  t.is(auto2.local.length, 3, 'auto2 wrote 3 entries total')
})
