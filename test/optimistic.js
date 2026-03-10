const test = require('brittle')
const { create, replicate, replicateAndSync, encode, same } = require('./helpers')

test('optimistic - added writer can append with optimistic flag', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  t.ok(auto2.writable, 'auto2 is writable')

  // Optimistic flag on an already-added writer should work fine
  await auto2.append(encode({ msg: 'optimistic from added writer' }), { optimistic: true })
  await replicateAndSync(auto1, auto2)

  t.ok(await same(auto1, auto2), 'peers converge')
})

test('optimistic - unadded writer can append optimistically', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  // auto2 is NOT added as a writer yet
  // Replicate so auto2 knows about auto1
  await replicateAndSync(auto1, auto2)

  t.absent(auto2.writable, 'auto2 is not writable')

  // auto2 writes optimistically
  await auto2.append(encode({ msg: 'optimistic before add' }), { optimistic: true })

  // auto1 adds auto2
  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  t.ok(auto2.writable, 'auto2 is writable after being added')
  t.ok(await same(auto1, auto2), 'peers converge with optimistic write accepted')
})

test('optimistic - unadded writer optimistic write rejected if never added', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await replicateAndSync(auto1, auto2)

  t.absent(auto2.writable, 'auto2 is not writable')

  // auto2 writes optimistically
  await auto2.append(encode({ msg: 'optimistic never added' }), { optimistic: true })

  // auto1 writes normally but never adds auto2
  await auto1.append(encode({ msg: 'auto1 data' }))

  // Can't use replicateAndSync — auto1 will never index auto2's optimistic
  // entry since auto2 is never added, so sync() would hang forever
  const done = replicate(auto1, auto2)
  await new Promise((resolve) => setTimeout(resolve, 500))
  await auto1.flush()
  await auto2.flush()
  await new Promise((resolve) => setTimeout(resolve, 500))
  await done()

  // auto2's optimistic write should not appear in auto1's view
  t.absent(auto2.writable, 'auto2 is still not writable')
})

test('optimistic - optimistic write followed by normal write after being added', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await replicateAndSync(auto1, auto2)

  // auto2 writes optimistically before being added
  await auto2.append(encode({ msg: 'optimistic' }), { optimistic: true })

  // auto1 adds auto2
  await auto1.append(encode({ addWriter: auto2.local.id }))
  await replicateAndSync(auto1, auto2)

  t.ok(auto2.writable, 'auto2 is writable')

  // auto2 now writes normally
  await auto2.append(encode({ msg: 'normal write' }))
  await replicateAndSync(auto1, auto2)

  t.ok(await same(auto1, auto2), 'peers converge after optimistic then normal writes')
})

test('optimistic - non-optimistic write from unadded writer throws', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await replicateAndSync(auto1, auto2)

  t.absent(auto2.writable, 'auto2 is not writable')

  await t.exception(
    () => auto2.append(encode({ msg: 'should fail' })),
    'non-optimistic write from unadded writer throws'
  )
})
