const test = require('brittle')
const b4a = require('b4a')
const { create, encode, apply } = require('./helpers')
const { decodeOplog } = require('../lib/encoding')
const Autobee = require('..')
const Corestore = require('corestore')

test('compat - custom oplog', async function (t) {
  const storage = await t.tmp()
  t.plan(2)

  {
    const auto = await create(t, { storage })

    await auto.append(encode({ hello: 'world' }))
    await auto.append(encode({ hej: 'verden' }))

    await auto.close()
  }

  {
    const auto = new Autobee(new Corestore(storage), {
      apply,
      decodeOplog: (buf) => {
        t.ok(buf)
        return decodeOplog(buf)
      }
    })

    const node = await auto.view.get(b4a.from('latest'))

    t.alike(node.value, encode({ hej: 'verden' }))

    await auto.close()
  }
})
