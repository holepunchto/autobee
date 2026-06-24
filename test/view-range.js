const test = require('brittle')
const { create, replicateAndSync, encode } = require('./helpers')

test('view range - remote applies do not inflate our range', async function (t) {
  const a1 = await create(t)
  const a2 = await create(t, a1.key)

  await a1.append(encode({ addWriter: a2.local.id }))
  await replicateAndSync(a1, a2)

  // remote writer commits a batch; a1 applies it, growing the shared view/system
  await a2.append([encode({ m: 'b1' }), encode({ m: 'b2' })])
  await replicateAndSync(a1, a2)

  const viewBefore = a1._workingBee.head().length
  const sysBefore = a1.system.bee.head().length
  t.ok(viewBefore > 0, 'view already has genesis + remote blocks before our batch')

  // our own batch, applied on top of the remote blocks
  await a1.append([encode({ m: 'a1' }), encode({ m: 'a2' }), encode({ m: 'a3' })])
  await a1.update()
  await a1.updated()

  const op = await a1.writers.localWriter.getLatest()
  const viewAfter = a1._workingBee.head().length
  const sysAfter = a1.system.bee.head().length

  t.is(op.views.view.start, viewBefore, 'view range starts after the remote blocks, not at 0')
  t.is(op.views.view.end, viewAfter, 'view range ends at our post-commit head')
  t.is(op.views.system.start, sysBefore, 'system range starts after the remote blocks')
  t.is(op.views.system.end, sysAfter, 'system range ends at our post-commit head')
})
