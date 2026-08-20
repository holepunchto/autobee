const test = require('brittle')
const os = require('os')
const path = require('path')
const fs = require('fs/promises')
const b4a = require('b4a')
const Corestore = require('corestore')
const Hyperbee = require('hyperbee2')

const Autobee = require('../index.js')
const { replicate, sync } = require('./helpers')

// fixture was generated on linux by autobase's own
// test/fixtures/generate/migration.js (autobase v7.28.1): a genesis writer
// (never persisted here) plus two indexers, b and c, write 200 messages while
// both are online and confirmed, b then goes offline for good, and c writes
// 50 more messages that never get confirmed. Only the confirmed prefix is
// physically present in the 'log' view core, so both fixtures migrate to the
// same 200-entry view.
const skip = os.platform() !== 'linux'

const FIXTURE = path.join(__dirname, 'fixtures/migration/autobase-v7.28.1-linux')
const BASE_KEY = b4a.from(
  'cd63f16dace3cfd47d09c9efe963741db316d5468802c7d57ce94e3dc5666243',
  'hex'
)
const CONFIRMED_LENGTH = 200

async function apply(batch, view, base) {
  for (const { value } of batch) {
    if (!value) continue

    const data = JSON.parse(b4a.toString(value))
    if (data && data.add) await base.addWriter(Buffer.from(data.add, 'hex'), { indexer: !!data.indexer })
  }
}

function migrateInto(store, state) {
  return async function migrate(views) {
    state.called = true

    const legacy = views.get('log')
    if (!legacy) return null

    const legacyCore = store.get({ key: legacy.key })
    await legacyCore.ready()

    const bee = new Hyperbee(store.namespace('migrated-log'))
    await bee.ready()

    const w = bee.write()
    for (let i = 0; i < legacy.length; i++) {
      const block = await legacyCore.get(i, { wait: false })
      w.tryPut(indexKey(i), block)
    }
    await w.flush()

    await legacyCore.close()

    state.length = legacy.length

    return bee.head()
  }
}

function indexKey(i) {
  return b4a.from('#' + i.toString().padStart(6, '0'))
}

async function openMigrated(dir, t, state) {
  const store = new Corestore(dir, { allowBackup: true })
  const auto = new Autobee(store, BASE_KEY, {
    apply,
    migrate: migrateInto(store, state),
    legacyViews: ['log']
  })

  t.teardown(() => auto.close())
  await auto.ready()

  return auto
}

test('migration - opening a legacy autobase fixture triggers the migrate handler', { skip }, async function (t) {
  const bdir = await t.tmp()
  await copyFixture(t, 'b', bdir)

  const state = {}
  const b = await openMigrated(bdir, t, state)

  t.ok(state.called, 'migrate handler ran')
  t.is(state.length, CONFIRMED_LENGTH)

  const first = await b.view.get(indexKey(0))
  t.is(JSON.parse(b4a.toString(first.value)), 'm1')

  const last = await b.view.get(indexKey(CONFIRMED_LENGTH - 1))
  t.is(JSON.parse(b4a.toString(last.value)), 'm198')
})

test('migration - a new joiner can fast-forward onto a migrated head', { skip }, async function (t) {
  const bdir = await t.tmp()
  await copyFixture(t, 'b', bdir)

  const b = await openMigrated(bdir, t, {})

  // migrating only carries over the legacy view - a peer needs at least one
  // real autobee flush of its own before its system head carries the view
  // metadata a fast-forward target requires (see FastForward.fromHead's
  // "legacy nodes ... have no system info to fast-forward from" guard)
  await b.append(b4a.from(JSON.stringify('m-post-migration')))

  const joinerStore = new Corestore(await t.tmp())
  const joiner = new Autobee(joinerStore, BASE_KEY, { apply })
  t.teardown(() => joiner.close())
  await joiner.ready()

  t.absent(await joiner.view.get(indexKey(0)), 'joiner starts empty')

  const done = replicate(b, joiner)

  const head = { key: b.local.key, length: b.local.length }
  const ff = await joiner.moveTo(head)

  t.ok(ff, 'joiner fast-forwarded onto the migrated head')

  await sync(b, joiner)
  await done()

  t.alike(joiner.view.head(), b.view.head())

  const entry = await joiner.view.get(indexKey(CONFIRMED_LENGTH - 1))
  t.is(JSON.parse(b4a.toString(entry.value)), 'm198')
})

test('migration - the c fixture (unconfirmed local tail) migrates to the same confirmed view', { skip }, async function (t) {
  const cdir = await t.tmp()
  await copyFixture(t, 'c', cdir)

  const state = {}
  const c = await openMigrated(cdir, t, state)

  t.ok(state.called, 'migrate handler ran')
  // c kept writing 50 more messages after b went offline, but those never
  // got confirmed/indexed, so only the same 200-entry prefix is physically
  // persisted in the legacy 'log' view core and available to migrate
  t.is(state.length, CONFIRMED_LENGTH)

  const last = await c.view.get(indexKey(CONFIRMED_LENGTH - 1))
  t.is(JSON.parse(b4a.toString(last.value)), 'm198')
})

async function copyFixture(t, name, dest) {
  await fs.cp(path.join(FIXTURE, name), dest, { recursive: true })
}
