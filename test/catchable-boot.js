const test = require('brittle')
const Corestore = require('corestore')
const Autobee = require('../')
const { apply } = require('./helpers')

// A boot failure (here: encrypted but the encryption key resolves null, as
// happens when a room is opened before its local state is durable) must reject
// ready() and must NOT escape as an uncaught rejection from the internal
// _bootGuard.ready() awaiters (bee preload, _bootAll, _bump, wakeup).
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

// A wakeup arriving on an instance whose boot failed must not throw either.
test('wakeup after failed boot does not throw', async function (t) {
  const store = new Corestore(await t.tmp())
  t.teardown(() => store.close())

  const auto = new Autobee(store, {
    apply,
    encrypted: true,
    encryptionKey: Promise.resolve(null)
  })
  auto.on('error', () => {})

  await t.exception(auto.ready())

  // wakeup awaits the boot guard internally - must bail, not reject uncaught
  await auto.wakeup({
    key: store.createKeyPair ? (await store.createKeyPair('x')).publicKey : Buffer.alloc(32),
    length: 1
  })

  await auto.close()
  t.pass('wakeup returned without throwing')
})
