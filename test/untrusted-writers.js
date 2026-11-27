const test = require('brittle')
const crypto = require('hypercore-crypto')
const ID = require('hypercore-id-encoding')
const b4a = require('b4a')
const encoding = require('../lib/encoding.js')
const { WriterEncryption } = require('../lib/encryption.js')
const { create, replicate, replicateAndSync, sync, same, encode } = require('./helpers')

function randomWriters(n) {
  const keys = []
  for (let i = 0; i < n; i++) keys.push(crypto.keyPair().publicKey)
  return keys
}

// a writer core that follows the run's encryption mode
function writerCore(auto, name) {
  const encryption = auto.encryptionKey ? new WriterEncryption(auto) : null
  return auto.store.get({ name, encryption })
}

// the smallest oplog a writer needs for the drain, links as given
function oplog(links = []) {
  return {
    version: encoding.OPLOG_VERSION,
    timestamp: Date.now(),
    links,
    batch: { start: 0, end: 0 },
    views: null,
    trusted: null,
    witness: null,
    approvals: null,
    optimistic: false,
    value: encode({ msg: 'node' }),
    hash: null,
    weightHint: 0,
    drift: 0
  }
}

async function length(auto, key) {
  const info = await auto.system.get(key)
  return info ? info.length : 0
}

// an untrusted mirror at its cap: a filler holds the last slot, and the
// dependent waits on a dependency the cap would not let it track
async function atCap(t, validDependency) {
  const auto = await create(t, { isTrusted: () => false })
  auto.writers.maxUntrustedWriters = 1

  await auto.append(encode({ msg: 'init' }))

  const dependency = writerCore(auto, 'dependency')
  await dependency.ready()
  await dependency.append(
    validDependency ? encoding.encodeOplog(oplog()) : b4a.from('not a valid oplog entry')
  )

  const dependent = writerCore(auto, 'dependent')
  await dependent.ready()
  await dependent.append(encoding.encodeOplog(oplog([{ key: dependency.key, length: 1 }])))

  // recorded while nothing may be tracked, so the mirror has to wait for both
  await auto.append(encode({ addWriter: ID.encode(dependency.key) }))
  await auto.append(encode({ addWriter: ID.encode(dependent.key) }))

  auto.writers.maxUntrustedWriters = 3

  const fillerCore = writerCore(auto, 'filler')
  await fillerCore.ready()

  // a writer gc will find idle, and gc never closes it before it does
  auto.writers.track(fillerCore.key)
  await auto.writers.drain()

  const w = auto.writers.track(dependent.key)
  await auto.writers.drain()

  t.ok(auto.writers.get(fillerCore.key), 'no speculative eviction at the cap')
  t.absent(auto.writers.get(dependency.key), 'the dependency was refused at the cap')
  t.is(auto.writers.size, 3, 'the mirror tracks all it may')
  t.is(w.waiting.id, b4a.toString(dependency.key, 'hex'), 'the dependent waits on it')
  t.is(w.waiting.length, 1, 'at the required length')

  return { auto, dependency, dependent, w, filler: auto.writers.get(fillerCore.key) }
}

test('untrusted-writers - a refused dependency is retried once gc frees room', async function (t) {
  const { auto, dependency, dependent, filler } = await atCap(t, true)

  await auto.writers.refresh()

  t.absent(auto.writers.get(filler.key), 'gc closed the idle writer')

  const d = auto.writers.get(dependency.key)
  t.ok(d, 'the refused dependency was retried')
  t.is(d.linkedLength, 1, 'linked at the required length')
  t.is(d.announcedLength, 0, 'without another announcement')
  t.ok(auto.writers.size <= auto.writers.maxUntrustedWriters, 'the cap is respected')

  await auto.update()

  t.is(await length(auto, dependent.key), 1, 'the dependent applied once its link arrived')
})

test('untrusted-writers - a wakeup admits a refused dependency that gc then leaves closed', async function (t) {
  const { auto, dependency, filler, w } = await atCap(t, false)

  // the close drops the filler from the cap before it finishes, so a wakeup in
  // that window admits the dependency the cap just refused
  const closing = filler.close()
  auto.writers.wakeup(dependency.key, 1)
  await closing

  t.ok(auto.writers.get(dependency.key), 'the wakeup admitted the dependency')

  await auto.writers.drain()
  t.ok(auto.writers.get(dependency.key).isFrozen, 'the dependency froze on its invalid block')

  await auto.writers.refresh()

  t.absent(auto.writers.get(dependency.key), 'the frozen dependency was closed, not reopened')
  t.ok(w.waiting, 'the dependent still waits on the missing dependency')
})

test('untrusted-writers - an untrusted peer drops new writers past the limit', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key, { isTrusted: () => false })
  auto2.writers.maxUntrustedWriters = 3
  const auto3 = await create(t, auto1.key)

  const keys = randomWriters(3)
  for (const key of keys) await auto1.append(encode({ addWriter: ID.encode(key) }))
  await auto1.append(encode({ addWriter: auto3.local.id }))
  await replicateAndSync(auto1, auto2, auto3)

  t.ok(auto1.stats.writersOpened >= 4, 'the writer opened them all')
  t.ok(auto2.writers.size <= 3, 'never more than the budget tracked at once')

  for (const key of keys) {
    const info = await auto2.system.get(key)
    t.ok(info && !info.isRemoved && info.maxWeight > 0, 'the system still records the writer')
  }

  await auto3.append(encode({ msg: 'seen by the mirror' }))
  await replicateAndSync(auto1, auto2, auto3)

  t.is(await length(auto2, auto3.local.key), 1, 'the mirror follows the dropped writer')
})

test('untrusted-writers - a trusted peer opens past the limit', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)
  auto2.writers.maxUntrustedWriters = 2

  const keys = randomWriters(3)
  for (const key of keys) await auto1.append(encode({ addWriter: ID.encode(key) }))
  await replicateAndSync(auto1, auto2)

  t.ok(auto2.stats.writersOpened >= 4, 'the limit does not apply to trusted peers')
  t.ok(auto2.stats.writersClosed <= auto2.stats.writersOpened, 'closes never exceed opens')

  await auto2.close()

  t.is(auto2.stats.writersClosed, auto2.stats.writersOpened, 'every opened writer is closed')
})

test('untrusted-writers - a stalled mirror fast-forwards once the admin moves on', async function (t) {
  const admin = await create(t, {
    mostRecentTrusted: () => ({ key: admin.local.key, length: admin.local.length })
  })

  const writers = []
  for (let i = 0; i < 4; i++) writers.push(await create(t, admin.key))

  for (const w of writers) await admin.append(encode({ addWriter: w.local.id }))
  await replicateAndSync(admin, ...writers)

  for (const w of writers) await w.append(encode({ msg: 'from ' + w.local.id }))
  await replicateAndSync(admin, ...writers)

  await admin.append(encode({ msg: 'links them all' }))

  // trust nothing at first so the mirror applies rather than fast-forwards
  let trustAdmin = false
  const mirror = await create(t, admin.key, {
    isTrusted: (key) => trustAdmin && b4a.equals(key, admin.local.key)
  })
  mirror.writers.maxUntrustedWriters = 3

  const done = replicate(admin, mirror)

  for (let i = 0; i < 5; i++) {
    await mirror.update()
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  t.ok(mirror.writers.size <= 3, 'the mirror is at its limit')
  t.ok((await length(mirror, admin.local.key)) < admin.local.length, 'and stalled behind the admin')

  const moved = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no fast-forward')), 10_000)
    mirror.once('move-to', () => {
      clearTimeout(timer)
      resolve()
    })
  })

  trustAdmin = true
  for (let i = 0; i < 40; i++) await admin.append(encode({ value: 'fix ' + i }))

  await t.execution(moved, 'the mirror fast-forwarded')
  await sync(admin, mirror)

  t.ok(await same(admin, mirror), 'the mirror converged on the admin')

  await done()
})
