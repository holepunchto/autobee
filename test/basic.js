const test = require('brittle')
const b4a = require('b4a')
const Corestore = require('corestore')
const crypto = require('hypercore-crypto')
const {
  create,
  replicateAndSync,
  same,
  encode,
  decode,
  apply,
  replicate,
  sync,
  encryptionKey
} = require('./helpers')
const Autobee = require('../index.js')
const { getEncoding } = require('../encoding/spec/autobee')

test('basic', async function (t) {
  const auto = await create(t)

  const val = encode({ hello: 'world' })
  await auto.append(val)

  const node = await auto.view.get(b4a.from('latest'))

  t.alike(node.value, val)
})

test('basic - preapply gates the first apply', async function (t) {
  let release = null
  const gate = new Promise((resolve) => {
    release = resolve
  })

  let applied = false
  let preapplied = null

  const auto = await create(t, {
    preapply: (view) => {
      preapplied = view
      return gate
    },
    apply: async (batch, view, host) => {
      applied = true
      return apply(batch, view, host)
    }
  })

  const appended = auto.append(encode({ hello: 'world' }))

  await new Promise((resolve) => setTimeout(resolve, 200))
  t.is(applied, false, 'nothing applies while preapply is pending')

  release()
  await appended

  t.is(applied, true, 'apply ran once preapply resolved')
  t.is(preapplied, auto.view, 'preapply received the view')

  const node = await auto.view.get(b4a.from('latest'))
  t.alike(node.value, encode({ hello: 'world' }))
})

test('basic - accept keyPair', async function (t) {
  const keyPair = crypto.keyPair()

  const auto = await create(t, {
    keyPair: new Promise((resolve) => setImmediate(resolve, keyPair))
  })

  // writer not setup until we append
  const val = encode({ hello: 'world' })
  await auto.append(val)

  const node = await auto.view.get(b4a.from('latest'))

  t.alike(node.value, val)
  t.alike(auto.local.keyPair.publicKey, keyPair.publicKey)
})

test('basic - replication', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  const val = encode({ hello: 'world' })
  await auto1.append(val)

  await replicateAndSync(auto1, auto2)

  t.ok(await same(auto1, auto2))
})

test('basic - replication (batch)', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  const val1 = encode({ hello: 'world' })
  const val2 = encode({ hej: 'verden' })
  await auto1.append([val1, val2])

  await replicateAndSync(auto1, auto2)

  t.ok(await same(auto1, auto2))
})

test('basic - fork and replication', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ hello: 'world' }))
  await auto1.append(encode({ addWriter: auto2.local.id }))

  await replicateAndSync(auto1, auto2)

  await auto1.append(encode({ fork: 1 }))
  await auto2.append(encode({ fork: 2 }))

  await replicateAndSync(auto1, auto2)

  t.ok(await same(auto1, auto2))
})

test('basic - removal', async function (t) {
  const auto = await create(t)

  await auto.append(encode({ hello: 'world' }))

  t.ok(auto.writable)

  await auto.append(encode({ removeWriter: auto.local.id }))

  t.absent(auto.writable)
})

test('basic - restart', async function (t) {
  const storage = await t.tmp()

  {
    const auto = await create(t, { storage })

    await auto.append(encode({ hello: 'world' }))
    await auto.append(encode({ hej: 'verden' }))

    await auto.close()
  }

  {
    const auto = new Autobee(new Corestore(storage), { apply, encryptionKey })
    await auto.ready()

    const node = await auto.view.get(b4a.from('latest'))

    t.alike(node.value, encode({ hej: 'verden' }))

    await auto.close()
  }
})

test('basic - encode/decode value', async function (t) {
  const buf = Autobee.encodeValue(b4a.from('hello'))
  const value = await Autobee.decodeValue(buf)
  t.alike(value, b4a.from('hello'))
})

test('legacy - encoding a null value does not throw (createAnchor path)', async function (t) {
  // this mirrors the exact call Autobee#createAnchor makes for a node whose
  // writer is still on the legacy oplog format (index.js: `node.version <= 2`)
  let block = null
  t.execution(() => {
    block = Autobee.encodeValue(null, {
      legacy: true,
      timestamp: 0,
      links: [],
      heads: [],
      padding: 0
    })
  }, 'encodeValue(null, { legacy: true }) should not throw')

  t.not(block, null, 'block was returned')

  let value
  await t.execution(async () => {
    value = await Autobee.decodeValue(block)
  }, 'can decode encode null value')
  t.is(value, null, 'a legacy null value round-trips as null, not an empty buffer')
})

test('legacy - decoding a pre-existing zero-length value yields null, not an empty buffer', function (t) {
  const Node = getEncoding('@autobase-compat/node')

  // hand-rolled bytes matching what compact-encoding@2's `c.buffer` produced
  // on disk for { heads: [], batch: 1, value: null }
  const bytes = Uint8Array.from([
    0x00, // heads: empty array
    0x01, // batch: 1
    0x00 // value: zero-length prefix (this is what v2 wrote for `null`)
  ])

  const decoded = Node.decode({ start: 0, end: bytes.length, buffer: bytes })

  t.is(decoded.value, null, 'zero-length legacy value decodes to null')
})

test('basic - optimistic', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  await auto1.append(encode({ hello: 'world' }))
  await auto2.append(encode({ test: 42 }), { optimistic: true })

  const done = replicate(auto1, auto2)

  await auto1.wakeup({ key: auto2.local.key, length: auto2.local.length })
  await sync(auto1, auto2)

  done()

  t.pass('applied')
})

test('basic - anchor', async function (t) {
  const auto = await create(t, null, { apply })

  await auto.append(encode({ hello: 'world' }))
  await auto.append(encode({ anchor: true }))

  t.pass('applied')

  async function apply(nodes, view, host) {
    for (const node of nodes) {
      const data = decode(node.value)

      if (data.anchor) {
        const anchor = await host.createAnchor(node.key, node.length)
        t.ok(anchor.key)
        t.ok(anchor.length)
      }

      if (data.removeWriter) {
        host.removeWriter(data.removeWriter)
      }

      const w = view.write()
      w.tryPut(b4a.from('latest'), node.value)
      await w.flush()
    }
  }
})

test('basic - isIndexer', async function (t) {
  const auto = await create(t)

  // writer not setup until we append
  const val = encode({ hello: 'world' })
  await auto.append(val)

  const info = await auto.system.get(auto.local.key)
  // granted capability lives in maxWeight - record.weight is the resolved
  // sort weight of the writer's last applied node (see lib/witness.js)
  t.is(info.maxWeight, 3)
  t.ok(auto.isIndexer)
})

test('basic - isIndexer', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  // writer not setup until we append
  const val = encode({ hello: 'world' })
  await auto1.append(val)

  t.ok(auto1.isIndexer)
  t.not(auto2.isIndexer)

  await replicateAndSync(auto1, auto2)

  t.ok(auto1.isIndexer)
  t.not(auto2.isIndexer)

  // we all agree who the indexers are
  t.is(auto1.writers.active.get(auto1.local.key.toString('hex')).isIndexer, auto1.isIndexer)
  t.is(auto2.writers.active.get(auto1.local.key.toString('hex')).isIndexer, auto1.isIndexer)
  t.is(auto2.writers.active.get(auto2.local.key.toString('hex')).isIndexer, auto2.isIndexer)
})

test('basic - writers', async function (t) {
  const auto = await create(t)

  t.ok(auto.writers.has(b4a.toString(auto.key, 'hex')))
  t.absent(auto.writers.has(b4a.alloc(32).toString('hex')))
})

test('basic - append during bump', async function (t) {
  const auto = await create(t)

  // set high to ensure trigger
  const APPENDS = 100

  const ops = []
  for (let i = 0; i < APPENDS; i++) {
    ops.push(auto.append(encode({ hello: 'world' + i })))
    await new Promise(setImmediate)
  }

  await t.execution(Promise.all(ops))

  t.ok(auto.writable)
})

test('removing writer #0 keeps the bootstrap session (and wakeup) alive', async function (t) {
  const a = await create(t)
  const b = await create(t, a.key)

  t.teardown(replicate(a, b))

  await a.append(encode({ addWriter: b.local.id }))
  await settle(
    t,
    async () => {
      await b.update()
      return b.writable
    },
    'member admitted'
  )

  t.ok(b.bootstrap.peers.length > 0, 'bootstrap has a wakeup peer before removal')

  // writer #0 - the creator, whose core is every member's bootstrap - departs
  await a.append(encode({ removeWriter: a.local.id }))
  await settle(
    t,
    async () => {
      await b.update()
      const info = await b.system.get(a.local.key)
      return !!(info && info.isRemoved)
    },
    'member applied the removal'
  )

  t.is(b.bootstrap.closed, false, 'base still runs on its bootstrap session')
  // the coupler lives on that session: it must keep its replication peer
  await settle(
    t,
    () => b.bootstrap.peers.length > 0,
    'bootstrap keeps its wakeup peer after removal'
  )
})

async function settle(t, fn, message, { timeout = 20000, interval = 50 } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await fn()) return t.pass(message)
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  t.fail(message)
}
