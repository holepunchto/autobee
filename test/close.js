const test = require('brittle')
const c = require('compact-encoding')
const migrations = require('../lib/migrations.js')
const crypto = require('hypercore-crypto')
const Corestore = require('corestore')
const Autobee = require('../')
const { create, encode, apply, encryptionKey } = require('./helpers')
const { Oplog } = require('../lib/encoding.js')

test('close settles while a drain waits on unavailable blocks', async function (t) {
  const auto1 = await create(t)

  for (let i = 0; i < 50; i++) {
    await auto1.append(encode({ value: 'a' + i }))
  }

  // boot a member from auto1's head without any replication - the first drain
  // fast-forwards towards the head and fetches blocks that can never arrive
  const to = { key: auto1.local.key, length: auto1.local.length }
  const auto2 = await create(t, auto1.key, { fastForward: { boot: to } })

  auto2.update().catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 200))

  let timer = null
  const started = Date.now()
  const result = await Promise.race([
    auto2.close().then(() => 'closed'),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve('timed out'), 10000)
    })
  ])
  clearTimeout(timer)

  t.is(result, 'closed')
  t.comment('close took ' + (Date.now() - started) + 'ms')
})

// the local writer closes the local core early in the teardown, which used to
// drop its exclusive lock while the rest of the instance was still closing
test('local core lock is held until the store session is torn down', async function (t) {
  const store = new Corestore(await t.tmp(), { manifestVersion: 2 })
  t.teardown(() => store.close())

  const auto = new Autobee(store.session(), null, {
    encryptionKey,
    encrypted: !!encryptionKey,
    bootstrapWeight: 3,
    apply
  })
  await auto.ready()
  await auto.append(encode({ value: 'a' }))

  // contend for the lock the way a second instance on the same store would
  const local = store.get({ key: auto.local.key, exclusive: true })
  const locked = local.ready().then(() => auto.store.closed)
  t.teardown(() => local.close())

  await auto.close()

  t.is(await locked, true, 'lock granted only after the store session was torn down')
})

// _getOplog is called fire-and-forget from the wakeup path, so a core it leaves
// open outlives the store that tracks it and trips corestore's close
test('_getOplog closes its core when the head is empty', async function (t) {
  const auto = await create(t)
  const opened = trackOpenCores(auto)

  t.is(await auto._getOplog(crypto.keyPair().publicKey, 0), null)

  t.is(opened.length, 1)
  t.ok(opened[0].closed, 'oplog core was closed')
})

test('_getOplog closes its core when reading the oplog throws', async function (t) {
  const auto = await create(t)
  await auto.append(encode({ value: 'a' }))

  const opened = trackOpenCores(auto, (core) => {
    core.get = () => Promise.reject(new Error('boom'))
  })

  await t.exception(auto._getOplog(auto.local.key, 1), /boom/)

  t.is(opened.length, 1)
  t.ok(opened[0].closed, 'oplog core was closed')
})

test('legacy oplogs with no digest or checkpoint inflate without views', async function (t) {
  const auto = await create(t)

  // a legacy writer that was never an indexer appends neither a digest nor a
  // checkpoint, so there is no system info to fast-forward from - the node itself is
  // still readable
  const value = encode({ value: 'a' })
  const buf = c.encode(Oplog, {
    version: 2,
    node: { heads: [], batch: 1, value },
    checkpoint: null,
    digest: null,
    optimistic: true,
    trace: null
  })

  const op = await migrations.inflateLegacyOplog(buf, null, 0)

  t.is(op.views, null, 'nothing to fast-forward from')
  t.alike(op.value, value, 'value is still readable')
})

function trackOpenCores(auto, onopen) {
  const opened = []
  const openCore = auto.openCore.bind(auto)

  auto.openCore = function (key) {
    const core = openCore(key)
    opened.push(core)
    if (onopen) onopen(core)
    return core
  }

  return opened
}
