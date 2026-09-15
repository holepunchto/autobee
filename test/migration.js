const IS_BARE = typeof global.Bare !== 'undefined'

const test = require('brittle')
const b4a = require('b4a')
const Corestore = require('corestore')
const { AutobeeEncryption } = require('autobee-encryption')
const uncaughts = require('uncaughts')
const os = IS_BARE ? null : require('os')

const Autobee = require('../index.js')
const { AUTOBEE_VERSION, LEGACY_AUTOBASE_VERSION } = require('../lib/constants.js')
const encoding = require('../lib/encoding.js')
const { decodeBlock } = require('hyperbee2/lib/encoding.js')
const { replicate, sync } = require('./helpers')

const skip = IS_BARE || !['linux', 'darwin'].includes(os.platform())

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

// autobee picks the view head itself now, so the handler no longer returns
// one - it runs only once a legacy head is locked in, and by then the legacy
// view is readable, locally or over the wire
function migrateHandler(store, state, baseKey = BASE_KEY) {
  return async function (views, systemHead) {
    state.calls = (state.calls || 0) + 1
    state.views = views
    state.systemHead = systemHead

    const legacy = views.get(LEGACY_VIEW_NAME)
    state.length = legacy ? legacy.length : 0

    if (!legacy) return

    const legacyCore = store.get({ key: legacy.key })
    await legacyCore.ready()
    await legacyCore.setEncryption(
      AutobeeEncryption.getViewEncryption(baseKey, SECRET_KEY, LEGACY_VIEW_NAME)
    )

    try {
      const block = await legacyCore.get(legacy.length - 1)
      state.last = JSON.parse(b4a.toString(block))
    } finally {
      await legacyCore.close()
    }
  }
}

function makeAutobee(store, state, { key = BASE_KEY, ...opts } = {}) {
  let auto
  auto = new Autobee(store, key, {
    apply,
    migrate: migrateHandler(store, state),
    legacyViews: [LEGACY_VIEW_NAME],
    encrypted: true,
    encryptionKey: SECRET_KEY,
    ...opts
  })
  return auto
}

async function openFixture(t, name, state, { prepare = null, ...opts } = {}) {
  const dir = await t.tmp()
  await copyFixture(t, name, dir)

  if (prepare) await prepare(dir)

  const store = new Corestore(dir, { allowBackup: true })
  const auto = makeAutobee(store, state, opts)

  t.teardown(() => auto.close())
  await auto.ready()

  // a migration boots in the background after ready(), and the fixture is
  // local on disk, so wait for it to settle before the tests poke at state
  await auto.flush()

  return auto
}

// the migrated view IS the legacy view core, so read it back in place
async function messageAt(auto, i) {
  const view = auto.system.view
  if (!view.key || i >= view.length) return null

  const core = auto.store.get({ key: view.key })
  await core.ready()
  await core.setEncryption(
    AutobeeEncryption.getViewEncryption(auto.key, SECRET_KEY, LEGACY_VIEW_NAME)
  )

  try {
    const block = await core.get(i)
    return block && JSON.parse(b4a.toString(block))
  } finally {
    await core.close()
  }
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

  t.is(state.calls, 1, 'migrate handler ran once, on the head we booted')
  t.is(state.length, A_CONFIRMED)
  t.is(state.last, 'm198', 'the handler could read the legacy view')
  t.is(await messageAt(a, A_CONFIRMED - 1), 'm198')
})

test(
  'migration - b (indexer, unconfirmed tail past 200) migrates to the confirmed prefix',
  { skip },
  async function (t) {
    const state = {}
    const b = await openFixture(t, 'b', state)

    t.is(state.calls, 1, 'migrate handler ran once, on the head we booted')
    t.is(state.length, B_CONFIRMED)
    t.is(state.last, 'm198', 'the handler could read the legacy view')
    t.is(await messageAt(b, B_CONFIRMED - 1), 'm198')
  }
)

// the legacy system core of a fixture dir: signed main + local batch session
async function openLegacySystem(dir) {
  const store = new Corestore(dir, { allowBackup: true })
  const local = store.get({ name: 'local' })
  await local.ready()

  const record = encoding.decodeAutobaseBootRecord(await local.getUserData('autobase/boot'))
  const encryptionKey = await local.getUserData('autobase/encryption')

  const main = store.get({ key: record.key, encryption: null })
  await main.ready()
  await AutobeeEncryption.setSystemEncryption(BASE_KEY, encryptionKey, main)

  const batch = main.session({ name: 'batch', writable: true })
  await batch.ready()

  return {
    store,
    main,
    batch,
    systemLength: record.systemLength,
    async close() {
      await batch.close()
      await main.close()
      await local.close()
      await store.close()
    }
  }
}

function isLegacyInfo(block) {
  const { key } = decodeBlock(block).keys[0]
  return key[0] === 0x00 && key[1] === 0x00
}

test('migration - c (non-indexer, frozen at 100) migrates', { skip }, async function (t) {
  const state = {}
  const c = await openFixture(t, 'c', state)

  t.is(state.calls, 1, 'migrate handler ran once, on the head we booted')
  t.is(state.length, C_CONFIRMED)
  t.is(state.last, 'm98', 'the handler could read the legacy view')
  t.is(await messageAt(c, C_CONFIRMED - 1), 'm98')
})

// legacy autobase stored the referrer on the local core, so a keyless open
// resolves the same base - it has to find the legacy storage just the same
test('migration - a keyless open of legacy storage still migrates', { skip }, async function (t) {
  for (const name of ['a', 'c']) {
    const dir = await t.tmp()
    await copyFixture(t, name, dir)

    const store = new Corestore(dir, { allowBackup: true })
    const state = {}
    const auto = makeAutobee(store, state, { key: null })
    t.teardown(() => auto.close())

    await auto.ready()
    await auto.flush()

    t.alike(auto.key, BASE_KEY, `${name}: resolved the base key from the referrer`)
    t.is(state.calls, 1, `${name}: migrate handler ran once`)
    t.is(state.last, name === 'c' ? 'm98' : 'm198', `${name}: the legacy view was migrated`)
    t.absent(await auto.local.getUserData('autobase/boot'), `${name}: legacy boot record cleared`)
  }
})

// a diverged legacy peer's batch session disagrees with the signed core below
// its boot record, and a fast-forward probe leaves one indexer INFO block there
test(
  'migration - c migrates when a fast-forward probe left an indexer INFO block above a diverged batch',
  { skip },
  async function (t) {
    const state = {}

    const aDir = await t.tmp()
    await copyFixture(t, 'a', aDir)

    // a stands in for the indexers serving the probe. the boot itself runs
    // offline: the head has to be one c holds
    const aStore = new Corestore(aDir, { allowBackup: true })
    t.teardown(() => aStore.close())

    function peer(store) {
      const s1 = store.replicate(true)
      const s2 = aStore.replicate(false)
      s1.pipe(s2).pipe(s1)
      return () => {
        s1.destroy()
        s2.destroy()
      }
    }

    let fork = 0

    const c = await openFixture(t, 'c', state, {
      async prepare(dir) {
        const sys = await openLegacySystem(dir)
        const { main, batch, systemLength } = sys

        // regroup c's tail [member, INFO, member, INFO] as [member, member, INFO]
        fork = main.length
        t.is(systemLength, fork + 2, 'boot record sits past the first tail INFO')
        t.ok(!isLegacyInfo(await batch.get(fork)), 'tail starts with a member')
        t.ok(isLegacyInfo(await batch.get(fork + 1)), 'then an INFO')
        t.ok(!isLegacyInfo(await batch.get(fork + 2)), 'then a member')
        t.ok(isLegacyInfo(await batch.get(fork + 3)), 'then an INFO')

        const tail = [await batch.get(fork), await batch.get(fork + 2), await batch.get(fork + 3)]
        await batch.truncate(fork)
        await batch.append(tail)

        // the probe fetches the indexers' INFO at fork + 1
        const unpeer = peer(sys.store)

        try {
          t.ok(isLegacyInfo(await main.get(fork + 1)), 'probe fetched an indexer INFO')
        } finally {
          unpeer()
        }

        t.ok(main.length >= systemLength, 'main core upgraded past the boot record')
        t.absent(await main.get(fork, { wait: false }), 'but the block before it was never fetched')

        await sys.close()
      }
    })

    t.is(state.systemHead.length, fork, 'booted from the last INFO both sessions share')
    t.is(state.calls, 1, 'migrate handler ran once, on the head we booted')
    t.is(state.length, C_CONFIRMED)
    t.is(state.last, 'm98', 'the handler could read the legacy view')
    t.is(await messageAt(c, C_CONFIRMED - 1), 'm98')
  }
)

// the same probe on a batch that agrees with the indexers: the fetched INFO is
// a valid head, so booting moves up to it
test(
  'migration - c boots from a fetched indexer INFO block when its batch agrees with it',
  { skip },
  async function (t) {
    const state = {}

    const aDir = await t.tmp()
    await copyFixture(t, 'a', aDir)

    const aStore = new Corestore(aDir, { allowBackup: true })
    t.teardown(() => aStore.close())

    let fork = 0

    const c = await openFixture(t, 'c', state, {
      async prepare(dir) {
        const sys = await openLegacySystem(dir)
        const { main, batch } = sys

        fork = main.length
        t.ok(isLegacyInfo(await batch.get(fork + 1)), 'the tail has an INFO at fork + 1')

        const s1 = sys.store.replicate(true)
        const s2 = aStore.replicate(false)
        s1.pipe(s2).pipe(s1)

        try {
          await main.get(fork)
          t.ok(
            isLegacyInfo(await main.get(fork + 1)),
            'fetched the indexer INFO and the block before it'
          )
        } finally {
          s1.destroy()
          s2.destroy()
        }

        t.ok(fork + 2 > batch.signedLength, 'it sits past the batch dependency')

        await sys.close()
      }
    })

    t.is(state.systemHead.length, fork + 2, 'booted from the fetched INFO')
    t.is(state.calls, 1, 'migrate handler ran once, on the head we booted')
    t.is(state.length, C_CONFIRMED)
    t.is(state.last, 'm98', 'the handler could read the legacy view')
    t.is(await messageAt(c, C_CONFIRMED - 1), 'm98')
  }
)

// legacy addHead drops a replayed node below its head but still flushes the INFO
test(
  'migration - c migrates over a legacy INFO block that no member block precedes',
  { skip },
  async function (t) {
    const state = {}
    let shared = 0

    const c = await openFixture(t, 'c', state, {
      async prepare(dir) {
        const sys = await openLegacySystem(dir)
        const { batch, systemLength } = sys

        // replay c's tail [member, INFO] as [INFO, member, INFO]
        const member = await batch.get(systemLength)
        const info = await batch.get(systemLength + 1)

        t.ok(!isLegacyInfo(member), 'tail starts with a member')
        t.ok(isLegacyInfo(info), 'then an INFO')

        await batch.truncate(systemLength)
        await batch.append([info, member, info])

        shared = batch.signedLength
        await sys.close()
      }
    })

    t.is(state.systemHead.length, shared, 'booted from the last INFO both sessions share')
    t.is(state.calls, 1, 'migrate handler ran once, on the head we booted')
    t.is(state.length, C_CONFIRMED)
    t.is(state.last, 'm98', 'the handler could read the legacy view')
    t.is(await messageAt(c, C_CONFIRMED - 1), 'm98')
  }
)

test('migration - only the designated legacy view becomes the view', { skip }, async function (t) {
  const state = {}
  const a = await openFixture(t, 'a', state, { legacyViews: ['not-a-view', LEGACY_VIEW_NAME] })

  t.absent(state.views.get('not-a-view'), 'the designated name matched nothing')
  t.ok(state.views.get(LEGACY_VIEW_NAME), 'the other legacy view is still resolved for the handler')
  t.is(a.system.view.length, 0, 'it is never adopted as the view: its blocks use a different key')
})

test('migration - no matching legacy view migrates to an empty view', { skip }, async function (t) {
  const state = {}
  const a = await openFixture(t, 'a', state, { legacyViews: ['not-a-view'] })

  t.is(state.calls, 1, 'migrate handler ran')
  t.is(a.system.view.length, 0, 'nothing to adopt: the view starts empty')
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

    for (let i = 0; i < C_CONFIRMED; i++) {
      t.alike(await messageAt(c, i), before[i], `message ${i} unchanged after ff`)
    }

    for (let i = C_CONFIRMED; i < B_CONFIRMED; i++) {
      t.alike(await messageAt(c, i), await messageAt(b, i), `message ${i} caught up from b`)
    }

    t.is(await messageAt(c, B_CONFIRMED - 1), 'm198')

    await done()
  }
)

test(
  'migration - 2) a fresh peer boots from the legacy system pointer, triggering ff migration',
  { skip: skipFF },
  async function (t) {
    const bState = {}
    const b = await openFixture(t, 'b', bState)

    const legacy = {
      key: b4a.from('6fd1e0b67c3946a8665cbd1f1bca90aad868def590d83f6e6dc8ca64bcd92de6', 'hex'),
      length: 0
    }

    const joinerStore = new Corestore(await t.tmp())
    const joinerState = {}
    const joiner = makeAutobee(joinerStore, joinerState, { fastForward: { boot: { legacy } } })
    t.teardown(() => joiner.close())

    const done = replicate(b, joiner)

    await joiner.ready()

    await sync(b, joiner)

    t.is(joinerState.calls, 1, 'ff-triggered migration called the migrate handler once')
    t.is(joinerState.length, B_CONFIRMED)

    t.is(await messageAt(joiner, B_CONFIRMED - 1), 'm198')
    await sameContent(t, joiner, b, B_CONFIRMED, 'joiner vs b')

    await done()
  }
)

test(
  'migration - 4) a fresh peer boots straight from a bare legacy system key',
  { skip: skipFF },
  async function (t) {
    const bState = {}
    const b = await openFixture(t, 'b', bState)

    // what an old (pre-migration) invite carries: the legacy system key, no length
    const systemKey = b4a.from(
      '6fd1e0b67c3946a8665cbd1f1bca90aad868def590d83f6e6dc8ca64bcd92de6',
      'hex'
    )

    const joinerStore = new Corestore(await t.tmp())
    const joinerState = {}
    const joiner = makeAutobee(joinerStore, joinerState, {
      fastForward: { boot: { key: systemKey } }
    })
    t.teardown(() => joiner.close())

    const done = replicate(b, joiner)

    await joiner.ready()
    await sync(b, joiner)

    t.is(joinerState.calls, 1, 'boot from the bare legacy key called the migrate handler once')
    t.is(joinerState.length, B_CONFIRMED)

    t.is(await messageAt(joiner, B_CONFIRMED - 1), 'm198')
    await sameContent(t, joiner, b, B_CONFIRMED, 'joiner vs b')

    await done()
  }
)

test(
  'migration - a peer left on a legacy boot record migrates again on restart',
  { skip: skipFF },
  async function (t) {
    const bState = {}
    const b = await openFixture(t, 'b', bState)

    const systemKey = b4a.from(
      '6fd1e0b67c3946a8665cbd1f1bca90aad868def590d83f6e6dc8ca64bcd92de6',
      'hex'
    )

    const dir = await t.tmp()
    const joinerStore = new Corestore(dir)
    const joinerState = {}
    const joiner = makeAutobee(joinerStore, joinerState, {
      fastForward: { boot: { key: systemKey } }
    })

    const done = replicate(b, joiner)

    await joiner.ready()
    await joiner.flush()

    // it booted onto the legacy head and stops there: b has migrated, but the
    // joiner has not caught up to b's autobee system
    t.is(joinerState.calls, 1, 'migrate ran once for the head the joiner booted')
    t.ok(joiner.system.version <= LEGACY_AUTOBASE_VERSION, 'still on a legacy system')

    await done()
    await joiner.close()
    await joinerStore.close()

    // no local autobase storage to re-detect, so the stored legacy boot record
    // is the only thing that can drive this - and it does, offline
    const restartStore = new Corestore(dir)
    const restartState = {}
    const restarted = makeAutobee(restartStore, restartState)
    t.teardown(() => restarted.close())

    await restarted.ready()

    t.is(restartState.calls, 1, 'migrate ran again on the restart')
    t.alike(
      restarted.system.view,
      restartState.views.get(LEGACY_VIEW_NAME),
      'the legacy view is adopted again'
    )
    t.is(await messageAt(restarted, B_CONFIRMED - 1), 'm198')
  }
)

test(
  'migration - 5) a fresh peer boots from the newest legacy system key',
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
      migrate: migrateHandler(joinerStore, joinerState, bootstrap),
      legacyViews: [LEGACY_VIEW_NAME],
      encrypted: true,
      encryptionKey: SECRET_KEY,
      // the newest legacy generation - chasing rotations from an older
      // (e.g. gen0) key is no longer supported
      fastForward: { boot: { key: b4a.from(meta.finalSystemKey, 'hex') } }
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
    await joiner.flush()

    await joiner.update()

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
      migrate: migrateHandler(aStore, aState, bootstrap),
      legacyViews: [LEGACY_VIEW_NAME],
      encrypted: true,
      encryptionKey: SECRET_KEY
    })
    t.teardown(() => a.close())

    await a.ready()
    await a.flush() // the migration boots in the background after ready()
    t.is(aState.calls, 1, 'a migrated locally')

    await a.append(JSON.stringify({ noop: 1 }))
    await a.append(JSON.stringify({ noop: 2 }))

    const joinerStore = new Corestore(await t.tmp())
    const joinerState = {}
    let preapplies = 0
    let joiner
    joiner = new Autobee(joinerStore, bootstrap, {
      apply,
      migrate: migrateHandler(joinerStore, joinerState, bootstrap),
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

    // the joiner crawls the legacy generations, finds an indexer that already
    // moved to autobee and boots its head, so it never migrates itself
    t.absent(joinerState.calls, 'the joiner booted autobee instead of migrating')
    t.is(joiner.system.version, AUTOBEE_VERSION, 'settled on an autobee system')
    t.is(preapplies, 1, 'preapply runs exactly once')

    for (let i = 0; i < meta.totalMessages; i++) {
      t.is(await messageAt(joiner, i), meta.messages[i], `message ${i} matches`)
    }

    await done()
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

    t.is(await messageAt(c, A_CONFIRMED - 1), 'm198')

    await doneA()

    const bState = {}
    const b = await openFixture(t, 'b', bState)

    const doneB = replicate(b, c)

    t.is(await messageAt(c, B_CONFIRMED - 1), 'm198')
    await sameContent(t, c, b, B_CONFIRMED, 'c vs b')

    await doneB()
  }
)

// b's legacy system boots at 211 flushes and sits at 263 once its 52 migrated
// nodes are applied - a must be MIN_FF_GAP (32) past that to be an ff candidate
const A_FF_TARGET_FLUSHES = 300

test(
  'migration - a wakeup fast-forward waits for the migrated catchup to apply',
  { skip: skipFF },
  async function (t) {
    const aState = {}
    const a = await openFixture(t, 'a', aState)

    for (let i = 0; a.system.flushes < A_FF_TARGET_FLUSHES; i++) {
      await a.append(JSON.stringify({ msg: 'post-' + i }))
      await a.update()
      await a.updated()
    }

    const bDir = await t.tmp()
    await copyFixture(t, 'b', bDir)

    const bStore = new Corestore(bDir, { allowBackup: true })
    const bState = {}
    const b = makeAutobee(bStore, bState)

    // a failing migrating drain crashes the process rather than rejecting
    // ready() or flush(), so capture that instead of listening for an error
    const crashes = []
    let oncrash = null
    const crashed = new Promise((resolve) => {
      oncrash = (err) => {
        crashes.push(err)
        resolve()
      }
    })
    uncaughts.on(oncrash)

    const done = replicate(a, b)
    t.teardown(done)
    t.teardown(() => b.close())

    // stays registered until b is down, a crashed b keeps throwing while closing
    t.teardown(() => uncaughts.off(oncrash))

    // a hint for a's head is queued before the migrating boot drains, as a boot
    // hint would be - the ff it produces must not jump ahead of the catchup
    b.hintWakeup(localHead(a))

    await b.ready()

    // once b has crashed and closed neither flush() nor sync() settle, so
    // race them against the crash instead of hanging
    await Promise.race([b.flush().then(() => sync(a, b)), crashed])
    t.is(crashes.length, 0, 'the migrating drain did not crash')
    if (crashes.length) return

    t.is(bState.calls, 1, 'b migrated')
    t.is(b.stats.fastForwards, 1, 'b still fast-forwarded onto a')

    const me = await b.system.get(b.local.key)
    t.is(me.length, b.local.length, 'the migrated tail made it into the system')
    t.absent(await b.local.getUserData('autobase/boot'), 'the legacy boot record is cleared')

    t.is(await messageAt(b, B_CONFIRMED - 1), 'm198')
    t.is(b.system.view.length, a.system.view.length, 'b landed on the same view as a')
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

test('migration - catchup is applied in linearizer order, not legacy INFO order', function (t) {
  const topo = require('../lib/topo.js')

  const low = b4a.alloc(32).fill(1)
  const mid = b4a.alloc(32).fill(2)
  const high = b4a.alloc(32).fill(3)

  const node = (key, length, links = []) => ({
    key,
    length,
    links,
    weight: 1,
    timestamp: 0,
    witness: null
  })

  // low:1 links high:1 and outranks mid:1, so high:1 is pulled ahead of mid:1
  const batches = [
    [node(high, 1)],
    [node(mid, 1)],
    [node(low, 1, [{ key: high, length: 1 }])],
    [node(low, 2, [{ key: mid, length: 1 }])]
  ]

  const order = topo.linearize(batches).map((b) => b[0].key[0] + ':' + b[0].length)

  t.alike(order, ['3:1', '1:1', '2:1', '1:2'], 'causal past is pulled ahead of outranked heads')
})

test('migration - linearized catchup never rebases on itself', function (t) {
  const topo = require('../lib/topo.js')

  // eight writers with random link lag
  let seed = 7
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff

  const W = 8
  const keys = []
  for (let i = 0; i < W; i++) keys.push(b4a.alloc(32).fill(i + 1))

  const heads = new Array(W).fill(0)
  const seen = keys.map(() => new Array(W).fill(0))
  const batches = []

  for (let r = 0; r < 40; r++) {
    for (let i = 0; i < W; i++) {
      const links = []
      for (let j = 0; j < W; j++) {
        if (j === i) continue
        if (rnd() > 0.5) seen[i][j] = heads[j]
        if (seen[i][j] > 0) links.push({ key: keys[j], length: seen[i][j] })
      }
      heads[i]++
      batches.push([
        { key: keys[i], length: heads[i], links, weight: 1, timestamp: 0, witness: null }
      ])
    }
  }

  const order = topo.linearize(batches)
  t.is(order.length, batches.length, 'every batch is handed out once')

  // every prefix must be stable
  let undos = 0
  for (let i = 1; i < order.length; i++) {
    const again = topo.linearize(order.slice(0, i + 1))
    for (let j = 0; j <= i; j++) {
      if (again[j] !== order[j]) {
        undos++
        break
      }
    }
  }

  t.is(undos, 0, 'no prefix is reordered by a later batch')
})

// legacy batch nodes link their predecessor, a link is not a batch start
test('migration - a legacy batch inflates whole when its nodes link their predecessor', async function (t) {
  const topo = require('../lib/topo.js')
  const encoding = require('../lib/encoding.js')

  const store = new Corestore(await t.tmp())
  const core = store.get({ name: 'legacy-writer' })
  await core.ready()
  t.teardown(() => store.close())

  const other = b4a.alloc(32).fill(9)

  const legacy = (heads, batch, value) =>
    encoding.encodeOplog({
      version: 2,
      node: { heads, batch, value: b4a.from(value) },
      checkpoint: null,
      digest: null,
      optimistic: false,
      trace: null
    })

  // 2-4 is one batch, remaining count 3,2,1
  await core.append([
    legacy([{ key: other, length: 1 }], 1, 'a'),
    legacy([{ key: other, length: 2 }], 3, 'b'),
    legacy([{ key: core.key, length: 2 }], 2, 'c'),
    legacy([{ key: core.key, length: 3 }], 1, 'd')
  ])

  const { batch } = await topo.getOplogBatch(null, core, 4, 1, 0)

  t.alike(
    batch.map((n) => b4a.toString(n.value)),
    ['b', 'c', 'd'],
    'the whole batch, not just the head'
  )
  t.is(batch[0].length, 2, 'starts at the first node of the batch')
  t.alike(batch[0].links, [{ key: other, length: 2 }], 'the real links sit on the start node')

  // the block before the batch may be missing after a legacy ff
  await core.clear(0)
  t.is(await core.has(0), false, 'the block before the batch is gone')

  const again = await topo.getOplogBatch(null, core, 4, 1, 0)

  t.alike(
    again.batch.map((n) => b4a.toString(n.value)),
    ['b', 'c', 'd'],
    'the batch still inflates whole without the block before it'
  )
})
