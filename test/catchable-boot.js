const test = require('brittle')
const Corestore = require('corestore')
const Autobee = require('../')
const { apply } = require('./helpers')

// A boot failure (here: encrypted but the encryption key resolves null, as
// happens when a room is opened before its local state is durable) must reject
// ready() and must NOT escape as an uncaught rejection from the internal
// _bootGuard.ready() awaiters (bee preload, _bootOnline, _bump, wakeup).
test('boot failure is catchable via ready()', async function (t) {
  const store = new Corestore(await t.tmp())
  t.teardown(() => store.close())

  const auto = new Autobee(store, {
    apply,
    encrypted: true,
    encryptionKey: Promise.resolve(null)
  })
  auto.on('error', () => {})

  await t.exception(auto.ready(), 'ready() rejects on boot failure')

  // give any stray internal rejections a tick to fire - if the fix is missing
  // an uncaught rejection here aborts the whole test run
  await new Promise((resolve) => setTimeout(resolve, 250))

  await auto.close()
  t.pass('no uncaught rejection escaped the failed boot')
})

// wakeup is a host-facing API like append, so a failed boot surfaces there too
test('wakeup after failed boot rejects with the boot error', async function (t) {
  const store = new Corestore(await t.tmp())
  t.teardown(() => store.close())

  const auto = new Autobee(store, {
    apply,
    encrypted: true,
    encryptionKey: Promise.resolve(null)
  })
  auto.on('error', () => {})

  await t.exception(auto.ready())

  await t.exception(
    auto.wakeup({
      key: store.createKeyPair ? (await store.createKeyPair('x')).publicKey : Buffer.alloc(32),
      length: 1
    }),
    'wakeup rejects with the boot error'
  )

  await auto.close()
})

test('failed boot releases the exclusive local core', { timeout: 10000 }, async function (t) {
  const { WriteBatch } = require(
    require.resolve('rocksdb-native').replace(/index\.js$/, 'lib/batch.js')
  )
  const flush = WriteBatch.prototype._flush
  let failing = false

  WriteBatch.prototype._flush = async function () {
    if (!failing) return flush.call(this)
    if (this._handle === null) await this.ready()
    await null
    this._db._state.io.inc()
    this._onwrite(new Error('injected write failure'))
  }
  t.teardown(() => {
    WriteBatch.prototype._flush = flush
  })

  const store = new Corestore(await t.tmp())
  t.teardown(() => store.close())

  const db = new Autobee(store.session(), null, { apply })
  await db.ready()
  await db.append(Buffer.from(JSON.stringify({ value: 'hello' })))
  const key = db.key
  await db.close()

  failing = true
  const broken = new Autobee(store.session(), key, { apply })
  broken.on('error', () => {})
  await t.exception(broken.ready(), /Batch was not applied/)
  await broken.close()
  failing = false

  const again = new Autobee(store.session(), key, { apply })
  await again.ready()
  t.pass('reopened after storage recovered')
  await again.close()
})

test(
  'post-boot open failure releases the exclusive local core',
  { timeout: 10000 },
  async function (t) {
    const store = new Corestore(await t.tmp())
    t.teardown(() => store.close())

    const broken = new Autobee(store, {
      apply,
      encrypted: true,
      encryptionKey: Promise.resolve(null)
    })
    broken.on('error', () => {})

    await t.exception(broken.ready(), /Encryption key is expected/)
    await broken.close()

    const again = new Autobee(store, broken.key, { apply })
    await again.ready()
    t.pass('reopened after the open failure')
    await again.close()
  }
)
