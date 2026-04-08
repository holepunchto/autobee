const test = require('brittle')

const { create, encode } = require('./helpers')

test('updates - simple', async (t) => {
  const auto = await create(t, { update })
  t.plan(4)

  await auto.append(encode({ hello: 'world' }))

  t.is(auto.view.core.length, 1)

  await auto.append(encode({ hello: 'world2' }))

  t.is(auto.view.core.length, 2)

  async function update(view, changes) {
    const update = changes.get('view')

    // always appending one
    t.is(update.to.length - update.from.length, 1)
  }
})
