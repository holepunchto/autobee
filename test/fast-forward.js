const test = require('brittle')
const b4a = require('b4a')
const Corestore = require('corestore')

const { create, replicate, same, encode } = require('./helpers')

// predates the moveTo removal
test.skip('fast-forward - simple', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  for (let i = 0; i < 1000; i++) {
    await auto1.append(encode({ value: 'a' + i }))
  }

  const to = auto1.system.bee.head()

  const ff = auto2.moveTo(to)

  t.teardown(replicate(auto1, auto2))

  await t.execution(ff)

  t.alike((await ff).to, to)
  t.alike(auto1.view.head(), auto2.view.head())
  t.ok(await same(auto1, auto2))

  const node = await auto2.view.get(b4a.from('latest'))

  t.alike(node.value, encode({ value: 'a999' }))
})

test('conservative ff skips a sparse head nobody can serve', async function (t) {
  const dir = await t.tmp()
  const auto1 = await create(t)

  for (let i = 0; i < 100; i++) {
    await auto1.append(encode({ value: 'a' + i }))
  }

  // a mirror holding only the head block never advertises the head whole
  const mirror = new Corestore(dir + '/mirror', { manifestVersion: 2 })
  t.teardown(() => mirror.close())

  const copy = mirror.get({ key: auto1.local.key })
  await copy.ready()

  const s1 = auto1.store.replicate(true)
  const s2 = mirror.replicate(false)
  s1.pipe(s2).pipe(s1)
  await copy.get(auto1.local.length - 1)
  s1.destroy()
  s2.destroy()

  const auto2 = await create(t, auto1.key, { onwakeup: (head) => head })

  const s3 = mirror.replicate(true)
  const s4 = auto2.store.replicate(false)
  s3.pipe(s4).pipe(s3)
  const oplog = auto2.openCore(auto1.local.key)
  await oplog.get(auto1.local.length - 1)
  s3.destroy()
  s4.destroy()
  await oplog.close()

  const ffs = []
  const moveTo = auto2._moveTo.bind(auto2)
  auto2._moveTo = (head, tip) => {
    ffs.push(head)
    return moveTo(head, tip)
  }

  const hints = new Map([[b4a.toString(auto1.local.key, 'hex'), auto1.local.length]])
  const moved = await auto2.fastForwardFromHeads(hints)

  t.absent(moved, 'the fast-forward was skipped')
  t.is(ffs.length, 0, 'no ff was attempted')
})

test('conservative: false attempts the sparse head', async function (t) {
  const auto1 = await create(t)

  for (let i = 0; i < 100; i++) {
    await auto1.append(encode({ value: 'a' + i }))
  }

  const auto2 = await create(t, auto1.key, {
    onwakeup: (head) => head,
    fastForward: { conservative: false }
  })

  // fetch just the head block, then cut the transport
  const unreplicate = replicate(auto1, auto2)
  const oplog = auto2.openCore(auto1.local.key)
  await oplog.get(auto1.local.length - 1)
  await unreplicate()
  await oplog.close()

  const ffs = []
  const moveTo = auto2._moveTo.bind(auto2)
  auto2._moveTo = (head, tip) => {
    ffs.push(head)
    return moveTo(head, tip)
  }

  const hints = new Map([[b4a.toString(auto1.local.key, 'hex'), auto1.local.length]])
  await auto2.fastForwardFromHeads(hints)

  t.ok(ffs.length > 0, 'the ff was attempted instead of skipped')
})

test('conservative ff proceeds once a connected peer advertises the head whole', async function (t) {
  const auto1 = await create(t)

  for (let i = 0; i < 1000; i++) {
    await auto1.append(encode({ value: 'a' + i }))
  }

  const auto2 = await create(t, auto1.key, { onwakeup: (head) => head })
  t.teardown(replicate(auto1, auto2))

  await new Promise((resolve) => auto2.once('move-to', resolve))
  t.pass('the fast-forward went through under the conservative default')
})
