const test = require('brittle')
const b4a = require('b4a')
const AckTracker = require('../lib/ack-tracker.js')
const { create, replicate, sync, encode } = require('./helpers')

test('acks - tracker add, settle and clear', function (t) {
  const acks = new AckTracker()
  const a = b4a.alloc(32).fill('a')
  const b = b4a.alloc(32).fill('b')

  acks.add(a, 1)
  acks.add(a, 3)
  acks.add(a, 2)
  acks.add(b, 1)
  t.is(acks.size, 2, 'deduped per key, keeps max length')

  acks.settle({ key: a }, { key: a, length: 5 })
  t.is(acks.size, 2, 'self-advance does not settle')

  acks.settle({ key: b }, { key: a, length: 2 })
  t.is(acks.size, 2, 'link below owed length does not settle')

  acks.settle({ key: b }, { key: a, length: 3 })
  t.is(acks.size, 1, 'link at owed length settles')

  acks.clear()
  t.is(acks.size, 0)
})

test('acks - tracker delay is deterministic and pays after the deadline', function (t) {
  const acks = new AckTracker()
  const key = b4a.alloc(32).fill('k')
  const local = b4a.alloc(32).fill('l')

  t.is(acks.delay(local, 1000, 10), 0, 'nothing pending')

  acks.add(key, 1)

  const d1 = acks.delay(local, 1000, 10)
  const d2 = acks.delay(local, 1000, 10)
  t.is(d1, d2, 'same draw for same inputs')

  if (d1 === 0) {
    t.pass('drew zero, pays immediately')
  } else {
    t.is(acks.delay(local, 1000 + d1, 10), 0, 'pays once the deadline passed')
  }
})

test('acks - tracker window scales with member count and target', function (t) {
  const key = b4a.alloc(32).fill('k')
  const local = b4a.alloc(32).fill('l')

  const small = new AckTracker()
  small.add(key, 1)
  t.ok(small.delay(local, 0, 1) < 200, 'single member draws within one target slot')

  const big = new AckTracker()
  big.add(key, 1)
  t.ok(big.delay(local, 0, 1000) < 200000, 'big room draws within members * target')

  const fast = new AckTracker({ target: 30 })
  fast.add(key, 1)
  t.ok(fast.delay(local, 0, 1) < 30, 'target option shrinks the window')
})

test('acks - a single writer acks an optimistic join', async function (t) {
  t.timeout(60000)

  const root = await create(t, null, { ackTarget: 30 })
  const autos = [root]

  for (let i = 0; i < 9; i++) {
    const auto = await create(t, root.key, { ackTarget: 30 })
    await root.append(encode({ addWriter: auto.local.id }))
    autos.push(auto)
  }

  const done = replicate(...autos)
  await sync(...autos)

  const joiner = await create(t, root.key, { ackTarget: 30 })
  await joiner.append(encode({ addWriter: joiner.local.id, ackWriter: joiner.local.id }), {
    optimistic: true
  })

  const baseline = autos.map((a) => a.local.length)

  const doneJoiner = replicate(root, joiner)
  await root.wakeup({ key: joiner.local.key, length: joiner.local.length })
  await sync(...autos, joiner)

  await new Promise((resolve) => setTimeout(resolve, 500))
  await sync(...autos, joiner)

  const ackers = []
  for (let i = 0; i < autos.length; i++) {
    if (autos[i].local.length > baseline[i]) ackers.push(i)
  }

  t.ok(ackers.length >= 1, 'someone acked the join')
  t.ok(ackers.length <= 3, `acks did not fan out (${ackers.length} of ${autos.length} writers)`)

  const info = await root.system.get(joiner.local.key)
  t.ok(info && info.length >= joiner.local.length, 'join processed')

  await done()
  await doneJoiner()
})
