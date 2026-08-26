const test = require('brittle')
const b4a = require('b4a')
const { create, replicateAndSync, encode } = require('./helpers')

function nodesOf(replay, key) {
  return replay.filter((n) => b4a.equals(n.key, key))
}

async function weightsEverywhere(t, pool, key, label) {
  const seen = []
  for (const [name, auto] of pool) {
    seen.push(
      nodesOf(await auto.replay(), key)
        .map((n) => n.weight)
        .join(',')
    )
    t.is(seen[seen.length - 1], seen[0], `${label}: ${name} agrees`)
  }
  return seen[0]
}

test('demotion - a cited demotion lowers the writer on every peer', async function (t) {
  const a = await create(t)
  const b = await create(t, a.key)
  const c = await create(t, a.key)
  const pool = [
    ['a', a],
    ['b', b],
    ['c', c]
  ]

  await a.append(encode({ addWriter: b.local.id, weight: 3 }))
  await replicateAndSync(a, b, c)

  await b.append(encode({ msg: 'at 3' }))
  await replicateAndSync(a, b, c)
  t.is(await weightsEverywhere(t, pool, b.local.key, 'promoted'), '3', 'b sits at 3')

  // a demotes b to 1; b cites the demotion on its next append
  await a.append(encode({ demoteWriter: b.local.id, weight: 1 }))
  await replicateAndSync(a, b, c)

  await b.append(encode({ msg: 'at 1' }))
  await replicateAndSync(a, b, c)

  t.is(await weightsEverywhere(t, pool, b.local.key, 'demoted'), '3,1', 'the new node is 1')

  // no retroactivity: the pre-demotion node keeps the weight it was written at
  const mine = nodesOf(await c.replay(), b.local.key)
  t.is(mine[0].weight, 3, 'pre-demotion node still 3')
  t.is(mine[1].weight, 1, 'post-demotion node is 1')
})

test('demotion - inheritance still works after a demotion', async function (t) {
  const a = await create(t)
  const b = await create(t, a.key)
  const pool = [
    ['a', a],
    ['b', b]
  ]

  await a.append(encode({ addWriter: b.local.id, weight: 3 }))
  await replicateAndSync(a, b)
  await b.append(encode({ msg: 'up' }))
  await replicateAndSync(a, b)

  await a.append(encode({ demoteWriter: b.local.id, weight: 1 }))
  await replicateAndSync(a, b)

  // first append cites the demotion, the next two carry no witness at all
  await b.append(encode({ msg: 'cites' }))
  await b.append(encode({ msg: 'inherits 1' }))
  await b.append(encode({ msg: 'inherits 1 again' }))
  await replicateAndSync(a, b)

  t.is(
    await weightsEverywhere(t, pool, b.local.key, 'inherit'),
    '3,1,1,1',
    'demoted weight is inherited'
  )

  const mine = nodesOf(await a.replay(), b.local.key)
  t.ok(mine[1].witness, 'the first post-demotion node carries the citation')
  t.absent(mine[2].witness, 'later nodes carry none and inherit')
})

test('demotion - re-promotion after a demotion', async function (t) {
  const a = await create(t)
  const b = await create(t, a.key)
  const pool = [
    ['a', a],
    ['b', b]
  ]

  await a.append(encode({ addWriter: b.local.id, weight: 3 }))
  await replicateAndSync(a, b)
  await b.append(encode({ msg: '3' }))
  await replicateAndSync(a, b)

  await a.append(encode({ demoteWriter: b.local.id, weight: 1 }))
  await replicateAndSync(a, b)
  await b.append(encode({ msg: '1' }))
  await replicateAndSync(a, b)

  await a.append(encode({ addWriter: b.local.id, weight: 3 }))
  await replicateAndSync(a, b)
  await b.append(encode({ msg: '3 again' }))
  await replicateAndSync(a, b)

  t.is(
    await weightsEverywhere(t, pool, b.local.key, 'churn'),
    '3,1,3',
    'weight tracks the cited grants'
  )
})

// the known limitation, asserted so it can't regress silently into a
// consistency bug: citing is the demoted writer's own move, so a writer that
// refuses keeps its standing. that must stay CONSISTENT on every peer - the
// demotion is ineffective, never divergent
test('demotion - a writer refusing to cite keeps its weight, consistently', async function (t) {
  const a = await create(t)
  const b = await create(t, a.key)
  const c = await create(t, a.key)
  const pool = [
    ['a', a],
    ['b', b],
    ['c', c]
  ]

  await a.append(encode({ addWriter: b.local.id, weight: 3 }))
  await replicateAndSync(a, b, c)
  await b.append(encode({ msg: 'at 3' }))
  await replicateAndSync(a, b, c)

  await a.append(encode({ demoteWriter: b.local.id, weight: 1 }))
  await replicateAndSync(a, b, c)

  // b appends WITHOUT citing the demotion (append() would cite it, so force
  // a witness-free node the way a non-cooperating writer would)
  const links = b.system.getLinks(b.local.key)
  const ts = Math.max(b._now(), b.system.timestamp)
  b.writers.appendLocal(encode({ msg: 'refuses' }), ts, { start: 0, end: 0 }, links, false, null)
  await b._bump()
  await replicateAndSync(a, b, c)

  t.is(
    await weightsEverywhere(t, pool, b.local.key, 'refusal'),
    '3,3',
    'inherits 3, demotion ineffective'
  )

  // capability, which IS a live read, did drop - so removal remains the hammer
  const rec = await a.system.get(b.local.key)
  t.is(rec.maxWeight, 1, 'the granted capability is 1 even though the sort weight is 3')
})
