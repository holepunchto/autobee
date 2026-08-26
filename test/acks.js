const test = require('brittle')
const b4a = require('b4a')
const AckTracker = require('../lib/ack-tracker.js')
const { create, replicate, sync, encode } = require('./helpers')

test('acks - tracker add, settle and clear', function (t) {
  const acks = new AckTracker()
  const a = b4a.alloc(32).fill('a')
  const b = b4a.alloc(32).fill('b')

  acks.add(a, 1, 0)
  acks.add(a, 3, 0)
  acks.add(a, 2, 0)
  acks.add(b, 1, 0)
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

test('acks - an optimistic link inherits the entry', function (t) {
  const acks = new AckTracker()
  const a = b4a.alloc(32).fill('a')
  const b = b4a.alloc(32).fill('b')

  acks.add(a, 1, 5)

  acks.settle({ key: b, length: 2, optimistic: true }, { key: a, length: 1 })
  t.is(acks.size, 1, 'entry transferred, not dropped')
  t.ok(b4a.equals(acks.pending[0].key, b), 'transferred to the linking node')
  t.is(acks.pending[0].since, 5, 'inherits the original since')

  acks.settle({ key: a, length: 3 }, { key: b, length: 2 })
  t.is(acks.size, 0, 'a non-optimistic link settles the chain')
})

test('acks - tracker delay is deterministic and pays after the deadline', function (t) {
  const acks = new AckTracker({ round: 200 })
  const key = b4a.alloc(32).fill('k')
  const local = b4a.alloc(32).fill('l')

  t.is(acks.delay(local, 1000, 10), 0, 'nothing pending')

  acks.add(key, 1, 1000)

  const d1 = acks.delay(local, 1000, 10)
  const d2 = acks.delay(local, 1000, 10)
  t.is(d1, d2, 'same draw for same inputs')

  if (d1 === 0) {
    t.pass('due immediately')
  } else {
    t.is(acks.delay(local, 1000 + d1, 10), 0, 'pays once the deadline passed')
  }

  acks.clear()
})

test('acks - a single member pays within the first round', function (t) {
  const key = b4a.alloc(32).fill('k')
  const local = b4a.alloc(32).fill('l')

  const acks = new AckTracker({ round: 200 })
  acks.add(key, 1, 0)
  t.ok(acks.delay(local, 0, 1) < acks.round, 'due within one round')
  acks.clear()
})

test('acks - every member is due once participation saturates', function (t) {
  const key = b4a.alloc(32).fill('k')
  const members = 1024
  const horizon = (Math.ceil(Math.log2(members)) + 1) * 200

  let early = 0

  for (let i = 0; i < 100; i++) {
    const acks = new AckTracker({ round: 200 })
    acks.add(key, 1, 0)
    const local = b4a.alloc(32).fill(i + 1)

    if (acks.delay(local, 0, members) < 200) early++
    t.absent(acks.delay(local, horizon, members), `writer ${i} due within log2(members) rounds`)
    acks.clear()
  }

  t.ok(early < 20, `round 0 participation is sparse (${early}/100)`)
})

test('acks - tracker timer is cancelled on clear and on settling out', function (t) {
  const key = b4a.alloc(32).fill('k')
  const other = b4a.alloc(32).fill('o')
  const local = b4a.alloc(32).fill('l')

  const acks = new AckTracker({ round: 200 })
  acks.add(key, 1, Date.now())

  const d = acks.delay(local, Date.now(), 10)
  if (d === 0) {
    t.pass('due immediately, no timer to cancel')
  } else {
    t.ok(acks.timer !== null, 'timer scheduled while holding off')
    acks.clear()
    t.is(acks.timer, null, 'clear cancels the timer')
  }

  acks.add(key, 1, Date.now())
  if (acks.delay(local, Date.now(), 10) > 0) {
    acks.settle({ key: other }, { key, length: 1 })
    t.is(acks.size, 0, 'settled out')
    t.is(acks.timer, null, 'settling the last entry cancels the timer')
  }
})

test('acks - a rolled back optimistic link does not erase the entry', async function (t) {
  t.timeout(60000)

  // a huge round so nobody pays while the scenario is set up
  const opts = { ackRound: 60000 }

  const root = await create(t, null, opts)
  const joiner = await create(t, root.key, opts)
  const chainer = await create(t, root.key, opts)

  await root.append(encode({ hello: 'world' }))

  // A: an optimistic join the root applies and now owes a linking node
  await joiner.append(encode({ addWriter: joiner.local.id, ackWriter: joiner.local.id }), {
    optimistic: true
  })

  const done1 = replicate(root, joiner, chainer)
  await root.wakeup({ key: joiner.local.key, length: joiner.local.length })
  await chainer.wakeup({ key: joiner.local.key, length: joiner.local.length })
  await sync(root, joiner)
  await sync(chainer, joiner)

  t.is(root._acks.size, 1, 'root owes the join a linking node')
  t.ok(b4a.equals(root._acks.pending[0].key, joiner.local.key), 'entry keyed to the joiner')

  // B: an optimistic node that links A and then aborts in apply -
  // addNode settles A before the failure, the rollback must restore it
  await chainer.append(encode({ abort: true, ackWriter: chainer.local.id }), {
    optimistic: true
  })

  await root.wakeup({ key: chainer.local.key, length: chainer.local.length })
  await new Promise((resolve) => setTimeout(resolve, 300))

  t.is(root._acks.size, 1, 'still exactly one entry after the rollback')
  t.ok(
    b4a.equals(root._acks.pending[0].key, joiner.local.key),
    'entry restored to the joiner, not chained to the aborted node'
  )

  await done1()
})

test('acks - a single writer acks an optimistic join', async function (t) {
  t.timeout(60000)

  const root = await create(t, null, { ackRound: 30 })
  const autos = [root]

  for (let i = 0; i < 9; i++) {
    const auto = await create(t, root.key, { ackRound: 30 })
    await root.append(encode({ addWriter: auto.local.id }))
    autos.push(auto)
  }

  const done = replicate(...autos)
  await sync(...autos)

  const joiner = await create(t, root.key, { ackRound: 30 })
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
