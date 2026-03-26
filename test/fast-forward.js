const test = require('brittle')
const b4a = require('b4a')

const { create, replicate, same, encode } = require('./helpers')

test('fast-forward - simple', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  for (let i = 0; i < 1000; i++) {
    await auto1.append(encode({ value: 'a' + i }))
  }

  auto2.queueFastForward(auto1.system.bee.head())

  const ff = new Promise((resolve) => auto2.on('fast-forward', resolve))

  t.teardown(replicate(auto1, auto2))

  await t.execution(ff)

  t.alike(auto1.view.head(), auto2.view.head())
  t.ok(await same(auto1, auto2))

  const node = await auto2.view.get(b4a.from('latest'))

  t.alike(node.value, encode({ value: 'a999' }))
})
