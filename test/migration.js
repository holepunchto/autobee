const test = require('brittle')
const b4a = require('b4a')
const Corestore = require('corestore')
const Hyperbee = require('hyperbee2')
const { AutobeeEncryption } = require('autobee-encryption')

const Autobee = require('../index.js')
const { replicate, sync } = require('./helpers')

const IS_BARE = typeof global.Bare !== 'undefined'
const skip = IS_BARE || require('os').platform() !== 'linux'

const path = skip ? null : require('path')
const fs = skip ? null : require('fs/promises')

const FIXTURE = skip ? null : path.join(__dirname, 'fixtures/migration/autobase-v7.28.1-linux')
const BASE_KEY = b4a.from('7f22e8f8460095e563eb47a71843a6be852bd8c800d27904eef26068149b921a', 'hex')
const SECRET_KEY = b4a.alloc(32).fill('secret')
const LEGACY_VIEW_NAME = 'log'

const A_CONFIRMED = 200
const B_CONFIRMED = 200
const C_CONFIRMED = 100

async function apply(batch, view, base) {
  for (const { value } of batch) {
    if (!value) continue

    const data = JSON.parse(b4a.toString(value))
    if (data && data.add) {
      await base.addWriter(Buffer.from(data.add, 'hex'), { indexer: !!data.indexer })
    }
  }
}

function migrateInto(store, state, getAuto, baseKey = BASE_KEY) {
  return async function (views) {
    state.calls = (state.calls || 0) + 1

    const legacy = views.get(LEGACY_VIEW_NAME)
    if (!legacy) return null

    const legacyCore = store.get({ key: legacy.key })
    await legacyCore.ready()
    await legacyCore.setEncryption(
      AutobeeEncryption.getViewEncryption(baseKey, SECRET_KEY, LEGACY_VIEW_NAME)
    )

    const auto = getAuto()
    const bee = new Hyperbee(store.namespace('migrated-log'), {
      getEncryptionProvider: auto.getViewEncryption
    })
    await bee.ready()

    const w = bee.write()
    for (let i = 0; i < legacy.length; i++) {
      const block = await legacyCore.get(i)
      w.tryPut(indexKey(i), b4a.from(block))
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

function makeAutobee(store, state, opts = {}) {
  let auto
  auto = new Autobee(store, BASE_KEY, {
    apply,
    migrate: migrateInto(store, state, () => auto),
    legacyViews: [LEGACY_VIEW_NAME],
    encrypted: true,
    encryptionKey: SECRET_KEY,
    ...opts
  })
  return auto
}

async function openFixture(t, name, state, opts = {}) {
  const dir = await t.tmp()
  await copyFixture(t, name, dir)

  const store = new Corestore(dir, { allowBackup: true })
  const auto = makeAutobee(store, state, opts)

  t.teardown(() => auto.close())
  await auto.ready()

  return auto
}

async function messageAt(auto, i) {
  const entry = await auto.view.get(indexKey(i))
  return entry && JSON.parse(b4a.toString(entry.value))
}

function localHead(auto) {
  return { key: auto.local.key, length: auto.local.length }
}

const B_SAFE_HEAD_LENGTH = 87

function safeHeadOfB(b) {
  return { key: b.local.key, length: B_SAFE_HEAD_LENGTH }
}

const skipFF = skip

async function sameContent(t, a, b, count, label) {
  for (let i = 0; i < count; i++) {
    t.alike(await messageAt(a, i), await messageAt(b, i), `${label} message ${i} matches`)
  }
}

async function copyFixture(t, name, dest) {
  await fs.cp(path.join(FIXTURE, name), dest, { recursive: true })
}

test('migration - a (indexer, frozen fully indexed at 200) migrates', { skip }, async function (t) {
  const state = {}
  const a = await openFixture(t, 'a', state)

  t.ok(state.calls, 'migrate handler ran')
  t.is(state.length, A_CONFIRMED)
  t.is(await messageAt(a, A_CONFIRMED - 1), 'm198')
})

test(
  'migration - b (indexer, unconfirmed tail past 200) migrates to the confirmed prefix',
  { skip },
  async function (t) {
    const state = {}
    const b = await openFixture(t, 'b', state)

    t.ok(state.calls, 'migrate handler ran')
    t.is(state.length, B_CONFIRMED)
    t.is(await messageAt(b, B_CONFIRMED - 1), 'm198')
  }
)

test('migration - c (non-indexer, frozen at 100) migrates', { skip }, async function (t) {
  const state = {}
  const c = await openFixture(t, 'c', state)

  t.ok(state.calls, 'migrate handler ran')
  t.is(state.length, C_CONFIRMED)
  t.is(await messageAt(c, C_CONFIRMED - 1), 'm98')
})

test(
  'migration - 1) c migrates, b migrates, c fast-forwards onto b',
  { skip: skipFF },
  async function (t) {
    const cState = {}
    const c = await openFixture(t, 'c', cState)

    t.is(cState.length, C_CONFIRMED)

    const before = []
    for (let i = 0; i < C_CONFIRMED; i++) before.push(await messageAt(c, i))

    const bState = {}
    const b = await openFixture(t, 'b', bState)

    const done = replicate(b, c)

    const ff = await c.moveTo(safeHeadOfB(b))
    t.ok(ff, 'c fast-forwarded onto b')

    await sync(b, c)
    await done()

    for (let i = 0; i < C_CONFIRMED; i++) {
      t.alike(await messageAt(c, i), before[i], `message ${i} unchanged after ff`)
    }

    for (let i = C_CONFIRMED; i < B_CONFIRMED; i++) {
      t.alike(await messageAt(c, i), await messageAt(b, i), `message ${i} caught up from b`)
    }

    t.is(await messageAt(c, B_CONFIRMED - 1), 'm198')
  }
)

test(
  'migration - 2) a fresh peer boots straight onto a migrated head, triggering ff migration',
  { skip: skipFF },
  async function (t) {
    const bState = {}
    const b = await openFixture(t, 'b', bState)

    const head = safeHeadOfB(b)

    const joinerStore = new Corestore(await t.tmp())
    const joinerState = {}
    const joiner = makeAutobee(joinerStore, joinerState, { fastForward: { boot: { head } } })
    t.teardown(() => joiner.close())

    const done = replicate(b, joiner)

    await joiner.ready()

    await sync(b, joiner)
    await done()

    t.ok(joinerState.calls, 'ff-triggered migration called the migrate handler')
    t.is(joinerState.length, B_CONFIRMED)

    t.is(await messageAt(joiner, B_CONFIRMED - 1), 'm198')
    await sameContent(t, joiner, b, B_CONFIRMED, 'joiner vs b')
  }
)

test(
  'migration - 4) a fresh peer boots straight from a bare legacy system key',
  { skip: skipFF },
  async function (t) {
    const bState = {}
    const b = await openFixture(t, 'b', bState)

    // what an old (pre-migration) invite carries: the legacy system key, no length
    const systemKey = b._migratedHead.system.key

    const joinerStore = new Corestore(await t.tmp())
    const joinerState = {}
    const joiner = makeAutobee(joinerStore, joinerState, {
      fastForward: { boot: { key: systemKey } }
    })
    t.teardown(() => joiner.close())

    const done = replicate(b, joiner)

    await joiner.ready()
    await sync(b, joiner)
    await done()

    t.ok(joinerState.calls, 'boot from the bare legacy key called the migrate handler')
    t.is(joinerState.length, B_CONFIRMED)

    t.is(await messageAt(joiner, B_CONFIRMED - 1), 'm198')
    await sameContent(t, joiner, b, B_CONFIRMED, 'joiner vs b')
  }
)

test(
  'migration - 5) an old system key chases indexer rotations to the newest generation',
  { skip: skipFF },
  async function (t) {
    const fixture = path.join(__dirname, 'fixtures/migration/autobase-rotation-v7.28.1-linux')
    const meta = JSON.parse(await fs.readFile(path.join(fixture, 'meta.json')))

    const serverDir = await t.tmp()
    await fs.cp(path.join(fixture, 'a'), serverDir, { recursive: true })

    const serverStore = new Corestore(serverDir, { allowBackup: true })
    t.teardown(() => serverStore.close())

    const bootstrap = b4a.from(meta.bootstrap, 'hex')

    const joinerStore = new Corestore(await t.tmp())
    const joinerState = {}
    let joiner
    joiner = new Autobee(joinerStore, bootstrap, {
      apply,
      migrate: migrateInto(joinerStore, joinerState, () => joiner, bootstrap),
      legacyViews: [LEGACY_VIEW_NAME],
      encrypted: true,
      encryptionKey: SECRET_KEY,
      // the original (generation 0) system key, two indexer rotations old
      fastForward: { boot: { key: b4a.from(meta.gen0SystemKey, 'hex') } }
    })
    t.teardown(() => joiner.close())

    const s1 = serverStore.replicate(true)
    const s2 = joinerStore.replicate(false)
    s1.pipe(s2).pipe(s1)
    t.teardown(() => {
      s1.destroy()
      s2.destroy()
    })

    await joiner.ready()

    // the chase can invoke migrate on intermediate candidates that carry no
    // legacy view (state.calls ticks, state.length does not) - wait for a
    // COMPLETED migration, not the first attempt
    while (!joinerState.length || !joiner._migratedHead) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    t.is(joinerState.length, meta.finalViewLength)
    t.alike(
      joiner._migratedHead.system.key,
      b4a.from(meta.finalSystemKey, 'hex'),
      'migrated at the newest generation'
    )

    for (let i = 0; i < meta.totalMessages; i++) {
      t.is(await messageAt(joiner, i), meta.messages[i], `message ${i} matches`)
    }
  }
)

test(
  'migration - 6) after a writer moves to autobee an old key fast-forwards onto its autobee head',
  { skip: skipFF },
  async function (t) {
    const fixture = path.join(__dirname, 'fixtures/migration/autobase-rotation-v7.28.1-linux')
    const meta = JSON.parse(await fs.readFile(path.join(fixture, 'meta.json')))
    const bootstrap = b4a.from(meta.bootstrap, 'hex')

    // writer a migrates its legacy storage to autobee and keeps writing,
    // burying its legacy oplog stamps under autobee-format nodes
    const aDir = await t.tmp()
    await fs.cp(path.join(fixture, 'a'), aDir, { recursive: true })

    const aStore = new Corestore(aDir, { allowBackup: true })
    const aState = {}
    let a
    a = new Autobee(aStore, bootstrap, {
      apply,
      migrate: migrateInto(aStore, aState, () => a, bootstrap),
      legacyViews: [LEGACY_VIEW_NAME],
      encrypted: true,
      encryptionKey: SECRET_KEY
    })
    t.teardown(() => a.close())

    await a.ready()
    t.ok(aState.calls, 'a migrated locally')

    await a.append(JSON.stringify({ noop: 1 }))
    await a.append(JSON.stringify({ noop: 2 }))

    const joinerStore = new Corestore(await t.tmp())
    const joinerState = {}
    let preapplies = 0
    let joiner
    joiner = new Autobee(joinerStore, bootstrap, {
      apply,
      migrate: migrateInto(joinerStore, joinerState, () => joiner, bootstrap),
      preapply: () => {
        preapplies++
      },
      legacyViews: [LEGACY_VIEW_NAME],
      encrypted: true,
      encryptionKey: SECRET_KEY,
      // the original (generation 0) system key, two rotations and one
      // autobee migration old
      fastForward: { boot: { key: b4a.from(meta.gen0SystemKey, 'hex') } }
    })
    t.teardown(() => joiner.close())

    const done = replicate(a, joiner)

    await joiner.ready()
    await sync(a, joiner)
    await done()

    t.absent(joinerState.calls, 'joiner fast-forwarded instead of migrating')
    t.absent(joiner._migratedHead, 'no migrated head, a plain fast-forward')
    t.is(preapplies, 1, 'preapply runs exactly once')

    for (let i = 0; i < meta.totalMessages; i++) {
      t.is(await messageAt(joiner, i), meta.messages[i], `message ${i} matches`)
    }
  }
)

test(
  'migration - 3) a online, c migrates and ffs onto a, then b online and c ffs onto b too',
  { skip: skipFF },
  async function (t) {
    const aState = {}
    const a = await openFixture(t, 'a', aState)

    const cState = {}
    const c = await openFixture(t, 'c', cState)

    t.is(cState.length, C_CONFIRMED)

    const doneA = replicate(a, c)
    const ffA = await c.moveTo(localHead(a))
    t.ok(ffA, 'c fast-forwarded onto a')

    await sync(a, c)
    await doneA()

    t.is(await messageAt(c, A_CONFIRMED - 1), 'm198')

    const bState = {}
    const b = await openFixture(t, 'b', bState)

    const doneB = replicate(b, c)
    const ffB = await c.moveTo(safeHeadOfB(b))
    t.absent(ffB, 'b has nothing new past what a already gave c')

    await doneB()

    t.is(await messageAt(c, B_CONFIRMED - 1), 'm198')
    await sameContent(t, c, b, B_CONFIRMED, 'c vs b')
  }
)

// the legacy fixture's roles, from the tests above: a and b are indexers, c is
// a plain writer. autobase had no witnesses, so standing cannot be re-derived
// from the oplog - memberLegacyMap is the only thing carrying it across
const A_KEY = b4a.from('7f22e8f8460095e563eb47a71843a6be852bd8c800d27904eef26068149b921a', 'hex')
const B_KEY = b4a.from('5e5a09af', 'hex')
const C_KEY = b4a.from('a3cdf514', 'hex')

async function recordFor(auto, prefix) {
  for await (const rec of auto.system.list()) {
    if (b4a.toString(rec.key, 'hex').startsWith(b4a.toString(prefix, 'hex'))) return rec
  }
  return null
}

test('migration - legacy weights survive: indexer 2, writer 1', { skip }, async function (t) {
  const state = {}
  const a = await openFixture(t, 'a', state)

  const legacy = {
    a: await recordFor(a, A_KEY),
    b: await recordFor(a, B_KEY),
    c: await recordFor(a, C_KEY)
  }

  t.is(legacy.a.weight, 2, 'a was an indexer: sort weight 2')
  t.is(legacy.b.weight, 2, 'b was an indexer: sort weight 2')
  t.is(legacy.c.weight, 1, 'c was a plain writer: sort weight 1')

  // capability has to come across too, or a legacy indexer reads as a
  // non-indexer and its session is closed on the next reset()
  t.is(legacy.a.maxWeight, 2, 'a keeps indexer capability')
  t.is(legacy.b.maxWeight, 2, 'b keeps indexer capability')
  t.is(legacy.c.maxWeight, 1, 'c keeps writer capability')

  // no witness on a legacy node, so resolveWeight can only return the record's
  // own standing - which is exactly why the map has to be right
  for (let i = 0; i < a.local.length; i++) {
    const node = require('../lib/encoding.js').decodeOplog(await a.local.get(i))
    if (node.version > 2) continue
    t.absent(node.witness, 'legacy nodes carry no witness')
    break
  }
})

test('migration - legacy weights survive a v4 flush', { skip }, async function (t) {
  const state = {}
  const a = await openFixture(t, 'a', state)

  await a.append(b4a.from(JSON.stringify({ msg: 'post-migration' })))
  await a.update()
  await a.updated()

  const after = {
    a: await recordFor(a, A_KEY),
    b: await recordFor(a, B_KEY)
  }

  t.is(after.a.weight, 2, 'a still sorts at 2 once rewritten as v4')
  t.is(after.b.weight, 2, 'b still sorts at 2 once rewritten as v4')
  t.is(after.a.maxWeight, 2, 'a keeps its ceiling through the rewrite')
  t.is(after.b.maxWeight, 2, 'b keeps its ceiling through the rewrite')

  const writer = a.writers.active.get(b4a.toString(after.b.key, 'hex'))
  if (writer) t.ok(writer.isIndexer, 'a migrated indexer still reads as an indexer')
  else t.pass('b has no open session in this fixture')
})
