const test = require('brittle')
const b4a = require('b4a')
const { create, replicateAndSync, encode } = require('./helpers')

test('perf - append 1k', async function (t) {
  t.timeout(120_000)

  const auto = await create(t)
  let val = null

  for (let i = 0; i < 1_000; i++) {
    val = encode({ hello: '#' + i })
    await auto.append(val)
  }

  const node = await auto.view.get(b4a.from('latest'))

  t.alike(node.value, val)
})

test('perf - append 1k (2 autos)', async function (t) {
  t.timeout(120_000)

  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  let val = null

  for (let i = 0; i < 1_000; i++) {
    val = encode({ hello: '#' + i })
    await auto1.append(val)
  }

  t.comment('inserted 1k')

  await replicateAndSync(auto1, auto2)

  const node = await auto2.view.get(b4a.from('latest'))

  t.alike(node.value, val)
})
