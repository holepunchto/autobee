const test = require('brittle')
const { create, replicateAndSync, encode } = require('./helpers')

test('view range - remote applies do not inflate our range', async function (t) {
  const a1 = await create(t)
  const a2 = await create(t, a1.key)

  await a1.append(encode({ addWriter: a2.local.id }))
  await replicateAndSync(a1, a2)

  // remote writer commits a batch; a1 applies it. After this the shared view is
  // 3 blocks long (genesis + addWriter + remote) and the system is 2 blocks.
  await a2.append([encode({ m: 'b1' }), encode({ m: 'b2' })])
  await replicateAndSync(a1, a2)

  t.is(a1._workingBee.context.local.length, 3, 'view is 3 blocks before our batch')
  t.is(a1.system.bee.context.local.length, 2, 'system is 2 blocks before our batch')

  // our own batch, applied on top of the remote blocks
  await a1.append([encode({ m: 'a1' }), encode({ m: 'a2' }), encode({ m: 'a3' })])
  await a1.update()
  await a1.updated()

  const op = await a1.writers.localWriter.getLatest()

  // our range covers only what our batch wrote: view [3, 6), system [2, 3).
  // start excludes the remote blocks; length is our own block count.
  t.is(op.views.view.start, 3, 'view range starts at 3 (after the remote blocks)')
  t.is(op.views.view.length, 3, 'view range length is our 3 blocks')
  t.is(op.views.system.start, 2, 'system range starts at 2 (after the remote blocks)')
  t.is(op.views.system.length, 1, 'system range length is our 1 block')
})
