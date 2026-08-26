const test = require('brittle')
const b4a = require('b4a')
const { create, replicate, sync, encode } = require('./helpers')

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
