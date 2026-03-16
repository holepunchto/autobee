const test = require('brittle')
const Corestore = require('corestore')
const { create, replicateAndSync, same, encode, apply } = require('./helpers')
const Autobee = require('../index.js')

test('basic - restart', async function (t) {
  const storage = await t.tmp()

  let auto2
  {
    const auto1 = await create(t, { storage })
    auto2 = await create(t, auto1.key)

    await auto1.append(encode({ addWriter: auto2.local.id }))
    await auto1.append(encode({ hello: 'world' }))
    await auto1.append(encode({ hej: 'verden' }))

    await replicateAndSync(auto1, auto2)

    await auto2.append(encode({ msg: 'other' }))
    await replicateAndSync(auto1, auto2)

    await auto1.append(encode({ msg: 'guy' }))

    await replicateAndSync(auto1, auto2)

    t.ok(await same(auto1, auto2), 'views are identical after concurrent writes')

    await auto1.close()
  }

  {
    const auto1 = new Autobee(new Corestore(storage), { apply })

    await auto1.ready()

    t.ok(await same(auto1, auto2))

    await auto1.close()
  }
})
