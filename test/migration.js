const test = require('brittle')
const b4a = require('b4a')
const Corestore = require('corestore')
const Hyperbee = require('hyperbee2')
const { AutobeeEncryption } = require('autobee-encryption')

const Autobee = require('../index.js')
const topo = require('../lib/topo.js')
const migrations = require('../lib/migrations.js')
const { Oplog } = require('../lib/encoding.js')
const c = require('compact-encoding')
const { replicate, sync } = require('./helpers')

// only Bare is gated, it has no bare `path`/`fs/promises` to copy the fixture.
// the stores are portable, `allowBackup` below turns off the CORESTORE device
// file that would otherwise pin them to the machine that made them
const IS_BARE = typeof global.Bare !== 'undefined'
const skip = IS_BARE

const path = skip ? null : require('path')
const fs = skip ? null : require('fs/promises')

const FIXTURE = skip ? null : path.join(__dirname, 'fixtures/migration/autobase-v7.28.1-linux')
const BASE_KEY = b4a.from('7f22e8f8460095e563eb47a71843a6be852bd8c800d27904eef26068149b921a', 'hex')
const SECRET_KEY = b4a.alloc(32).fill('secret')
const LEGACY_VIEW_NAME = 'log'

const LEGACY_KEY = b4a.alloc(32).fill('legacy')

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

    while (!joinerState.calls) await new Promise((resolve) => setTimeout(resolve, 100))

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

// --- legacy oplog batch reconstruction -------------------------------------
// hand-rolled v2 blocks, so these also cover the walk under Bare

// counters[i] is block i's v2 `node.batch`: blocks of its batch left including
// itself, so a batch of 3 is written 3, 2, 1. null means the peer lacks it
function legacyCore(counters) {
  const blocks = counters.map((batch, i) => {
    if (batch === null) return null
    return c.encode(Oplog, {
      version: 2,
      node: { heads: [], batch, value: b4a.from('v' + i) },
      checkpoint: null,
      digest: null,
      optimistic: false,
      trace: null
    })
  })

  return {
    key: LEGACY_KEY,
    reads: [],
    get(seq, opts) {
      this.reads.push(seq)
      if (seq < 0 || seq >= blocks.length) return Promise.resolve(null)
      return Promise.resolve(blocks[seq])
    }
  }
}

function batchAt(core, length, opts = null) {
  return topo.getOplogBatch(null, core, length, 7, 0, opts)
}

function lengths(entry) {
  return entry.batch.map((n) => (n === null ? null : n.length))
}

test('migration - legacy head reconstructs the whole batch', async function (t) {
  // block 0 is its own batch, blocks 1..3 are one batch of three
  const core = legacyCore([1, 3, 2, 1])
  const entry = await batchAt(core, 4)

  t.alike(lengths(entry), [2, 3, 4], 'all three blocks of the batch are returned')
  t.alike(
    entry.batch.map((n) => n.value),
    [b4a.from('v1'), b4a.from('v2'), b4a.from('v3')],
    'batch is in oplog order, head last'
  )
  t.is(entry.batch[0].weight, 7, 'members carry the head pinned weight')
})

test('migration - legacy batch of one does not pull in the previous batch', async function (t) {
  const core = legacyCore([1, 1])
  const entry = await batchAt(core, 2)

  t.alike(lengths(entry), [2], 'only the head')
  t.alike(core.reads, [1, 0], 'one block past the head is probed to find the boundary')
})

test('migration - legacy batch spanning the whole core', async function (t) {
  const core = legacyCore([3, 2, 1])
  const entry = await batchAt(core, 3)

  t.alike(lengths(entry), [1, 2, 3], 'walk stops at block 0')
})

test('migration - legacy head at seq 0', async function (t) {
  const core = legacyCore([1])
  const entry = await batchAt(core, 1)

  t.alike(lengths(entry), [1], 'single block core')
  t.alike(core.reads, [0], 'nothing below the head is probed')
})

test('migration - two adjacent legacy batches stay separate', async function (t) {
  const core = legacyCore([2, 1, 3, 2, 1])

  t.alike(lengths(await batchAt(core, 2)), [1, 2], 'first batch')
  t.alike(lengths(await batchAt(core, 5)), [3, 4, 5], 'second batch')
})

test('migration - an inconsistent legacy counter ends the walk', async function (t) {
  // block 0's counter puts its head at block 4, so it is not ours
  const core = legacyCore([5, 1])
  const entry = await batchAt(core, 2)

  t.alike(lengths(entry), [2], 'only the head')
})

test('migration - an unreadable block leaves the legacy node unresolved', async function (t) {
  // replay() reads wait: false, so an undownloaded block comes back null
  const core = legacyCore([1, null, 2, 1])
  t.is(await batchAt(core, 4, { wait: false }), null, 'missing batch member')

  const boundary = legacyCore([null, 1])
  t.is(await batchAt(boundary, 2, { wait: false }), null, 'missing boundary probe')
})

test('migration - an unreadable legacy head is unresolved', async function (t) {
  const core = legacyCore([1, null])
  t.is(await batchAt(core, 2, { wait: false }), null)
})

test('migration - a current head still uses the start it carries', async function (t) {
  const core = {
    key: LEGACY_KEY,
    reads: [],
    get(seq) {
      this.reads.push(seq)
      return Promise.resolve(
        c.encode(Oplog, {
          version: 3,
          timestamp: 0,
          links: [],
          batch: seq === 2 ? { start: 2, end: 0 } : { start: 0, end: 2 - seq },
          views: null,
          optimistic: false,
          value: b4a.from('v' + seq),
          witness: null,
          attestations: null,
          trusted: null
        })
      )
    }
  }

  const entry = await batchAt(core, 3)

  t.alike(lengths(entry), [1, 2, 3], 'v3 head describes its own batch')
  t.alike(core.reads, [2, 0, 1], 'members are read in one fan-out, no boundary probe')
})

// lib/migrations.js walks the same way on the boot path that re-applies a
// legacy autobase's unindexed tail - those nodes go straight to _processBatch

function legacyStore(counters) {
  const core = legacyCore(counters)
  core.ready = () => Promise.resolve()
  return { get: () => core, core }
}

function writerBatch(counters, length) {
  const store = legacyStore(counters)
  return migrations.getWriterBatch(store, { key: LEGACY_KEY, length }, null, null)
}

test('migration - catchup rebuilds a whole legacy batch', async function (t) {
  const batch = await writerBatch([1, 3, 2, 1], 4)

  t.alike(
    batch.map((n) => n.length),
    [2, 3, 4],
    'all three blocks are re-applied, not just the head'
  )
})

test('migration - catchup does not pull in the previous batch', async function (t) {
  const batch = await writerBatch([1, 1], 2)
  t.alike(
    batch.map((n) => n.length),
    [2],
    'only the head'
  )
})

test('migration - catchup stops on an inconsistent legacy counter', async function (t) {
  // block 0's counter puts its head at block 4, so it is not ours
  const batch = await writerBatch([5, 1], 2)
  t.alike(
    batch.map((n) => n.length),
    [2],
    'only the head'
  )
})

test('migration - catchup requires the head to be local', async function (t) {
  await t.exception(writerBatch([1, null], 2), /exist locally/)
})
