const test = require('brittle')
const b4a = require('b4a')

const { create, replicateAndSync, same, encode } = require('./helpers')

const ENCRYPTION_KEY = b4a.alloc(32).fill('encryption key')

test('encryption', async function (t) {
  const auto = await create(t, { encryptionKey: ENCRYPTION_KEY })

  const val = encode({ hello: 'world' })
  await auto.append(val)

  const node = await auto.view.get(b4a.from('latest'))

  t.unlike(
    await auto.local.get(0, { valueEncoding: null }),
    await auto.local.get(0, { raw: true }),
    'writer encryption set'
  )

  t.unlike(
    await auto.view.core.get(0, { valueEncoding: null }),
    await auto.view.core.get(0, { raw: true }),
    'view encryption set'
  )

  t.alike(node.value, val)
})

test('encryption - replication', async function (t) {
  const auto1 = await create(t, { encryptionKey: ENCRYPTION_KEY })
  const auto2 = await create(t, auto1.key, { encryptionKey: ENCRYPTION_KEY })

  const val = encode({ hello: 'world' })
  await auto1.append(val)

  await replicateAndSync(auto1, auto2)

  t.unlike(
    await auto1.view.core.get(0, { valueEncoding: null }),
    await auto1.view.core.get(0, { raw: true }),
    'writer encryption set'
  )

  t.unlike(
    await auto2.view.core.get(0, { valueEncoding: null }),
    await auto2.view.core.get(0, { raw: true }),
    'view encryption set'
  )

  t.ok(await same(auto1, auto2))
})
