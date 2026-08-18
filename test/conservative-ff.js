const test = require('brittle')
const b4a = require('b4a')
const { create, replicate, encode } = require('./helpers')

test('conservative ff skips a sparse head nobody can serve', async function (t) {
  const auto1 = await create(t)

  for (let i = 0; i < 100; i++) {
    await auto1.append(encode({ value: 'a' + i }))
  }

  const auto2 = await create(t, auto1.key, { onwakeup: (head) => head })

  // fetch just the head block, then cut the transport
  const unreplicate = replicate(auto1, auto2)
  const oplog = auto2.openCore(auto1.local.key)
  await oplog.get(auto1.local.length - 1)
  await unreplicate()
  await oplog.close()

  const reboots = []
  const moveTo = auto2._moveTo.bind(auto2)
  auto2._moveTo = (head, tip) => {
    reboots.push(head)
    return moveTo(head, tip)
  }

  const hints = new Map([[b4a.toString(auto1.local.key, 'hex'), auto1.local.length]])
  const moved = await auto2.rebootFromHeads(hints)

  t.absent(moved, 'the fast-forward was skipped')
  t.is(reboots.length, 0, 'no ff was attempted')
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

  const reboots = []
  const moveTo = auto2._moveTo.bind(auto2)
  auto2._moveTo = (head, tip) => {
    reboots.push(head)
    return moveTo(head, tip)
  }

  const hints = new Map([[b4a.toString(auto1.local.key, 'hex'), auto1.local.length]])
  await auto2.rebootFromHeads(hints)

  t.ok(reboots.length > 0, 'the ff was attempted instead of skipped')
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
