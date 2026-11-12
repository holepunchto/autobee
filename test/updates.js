const test = require('brittle')
const b4a = require('b4a')

const { create, encode, replicateAndSync } = require('./helpers')

test('updates - simple', async (t) => {
  const auto = await create(t, { update })
  t.plan(4)

  await auto.append(encode({ hello: 'world' }))

  t.is(auto.view.core.length, 1)

  await auto.append(encode({ hello: 'world2' }))

  t.is(auto.view.core.length, 2)

  function update(view, changes) {
    const update = changes.get('view')

    // always appending one
    t.is(update.to.length - update.from.length, 1)
  }
})

test('updates - appends are incremental', async (t) => {
  const seen = []
  const auto = await create(t, { update })

  await auto.append(encode({ hello: 'world' }))
  await auto.append(encode({ hello: 'world2' }))

  t.alike(seen, [true, true])

  function update(view, changes) {
    seen.push(changes.get('view').incremental)
  }
})

test('updates - reorder below from is not incremental', async (t) => {
  const clock = { a: 100, b: 100 }
  const seenA = []
  const seenB = []

  const a = await create(t, { update: track(seenA), now: () => clock.a })
  const b = await create(t, a.key, { update: track(seenB), now: () => clock.b })

  await a.append(encode({ addWriter: b4a.toString(b.local.key, 'hex'), weight: 3 }))
  await replicateAndSync(a, b)
  t.ok(b.writable)

  clock.a = 300
  clock.b = 200

  seenA.length = 0
  seenB.length = 0

  await a.append(encode({ msg: 'a1' }))
  await b.append(encode({ msg: 'b1' }))

  t.alike(seenA, [true])
  t.alike(seenB, [true])

  seenA.length = 0
  seenB.length = 0

  const undosA = a.stats.undos
  const undosB = b.stats.undos
  await replicateAndSync(a, b)

  const reorderedA = a.stats.undos > undosA
  const reorderedB = b.stats.undos > undosB

  t.ok(reorderedA !== reorderedB, 'one side reordered below its last update')
  t.alike(seenA, reorderedA ? [false] : [true])
  t.alike(seenB, reorderedB ? [false] : [true])

  function track(seen) {
    return function update(view, changes) {
      seen.push(changes.get('view').incremental)
    }
  }
})
