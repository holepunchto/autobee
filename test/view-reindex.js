const IS_BARE = typeof global.Bare !== 'undefined'

const test = require('brittle')
const b4a = require('b4a')
const Corestore = require('corestore')
const os = IS_BARE ? null : require('os')

const Autobee = require('../index.js')
const encoding = require('../lib/encoding.js')
const { replicate, sync } = require('./helpers/index.js')

const skip = IS_BARE || !['linux', 'darwin'].includes(os.platform())

const path = skip ? null : require('path')
const fs = skip ? null : require('fs/promises')

const FIXTURE = skip ? null : path.join(__dirname, 'fixtures/migration/autobee-v2-view-linux')
const META = skip ? null : require(path.join(FIXTURE, 'meta.json'))
const BASE_KEY = b4a.from('7f22e8f8460095e563eb47a71843a6be852bd8c800d27904eef26068149b921a', 'hex')
const SECRET_KEY = b4a.alloc(32).fill('secret')

async function apply(batch, view, base) {
  for (const { value } of batch) {
    if (!value) continue
    const data = JSON.parse(b4a.toString(value))
    if (!data || typeof data !== 'object') continue
    if (data.add) await base.addWriter(b4a.from(data.add, 'hex'), { indexer: !!data.indexer })
    if (data.puts || data.dels) {
      const w = view.write()
      for (const [k, v] of data.puts || []) w.tryPut(b4a.from(k), b4a.from(v))
      for (const k of data.dels || []) w.tryDelete(b4a.from(k))
      await w.flush()
    }
  }
}

async function openFixture(t, dir = null, { patch = null, fastForward = undefined } = {}) {
  if (dir === null) {
    dir = await t.tmp()
    await fs.cp(path.join(FIXTURE, 'a'), dir, { recursive: true })
  }

  const store = new Corestore(dir, { allowBackup: true, manifestVersion: 2 })
  const auto = new Autobee(store, BASE_KEY, {
    apply,
    migrate: async () => {},
    legacyViews: ['not-a-view'],
    encrypted: true,
    encryptionKey: SECRET_KEY,
    fastForward
  })

  if (patch) patch(auto)

  await auto.ready()
  await auto.flush()

  return { auto, store, dir }
}

async function closeFixture({ auto, store }) {
  await auto.close()
  await store.close()
}

async function entries(bee) {
  const out = []
  for await (const { key, value } of bee.createReadStream()) {
    out.push([b4a.toString(key), b4a.toString(value)])
  }
  return out
}

async function history(bee) {
  const heads = []
  for await (const { head } of bee.createChangesStream()) heads.unshift(head)

  const versions = []
  for (const head of heads) {
    const checkout = bee.checkout(head)
    versions.push(await entries(checkout))
    await checkout.close()
  }
  return versions
}

async function manifestVersion(auto, key) {
  const core = auto.store.get({ key, active: false })
  await core.ready()
  const version = core.manifest.version
  await core.close()
  return version
}

async function coreVersions(auto, bee) {
  const versions = []
  for (const key of await bee.cores()) versions.push(await manifestVersion(auto, key))
  return versions
}

async function append(auto, puts, dels = []) {
  await auto.append(b4a.from(JSON.stringify({ puts, dels })))
  await auto.update()
}

test('view reindex - fixture holds a v2 view written by main', { skip }, async function (t) {
  t.is(META.view.manifestVersion, 2)
  t.is(META.viewCores, 1)
  t.is(META.versions.length, META.rounds)
})

test(
  'view reindex - a v2 view is reindexed into the v3 local view core',
  { skip },
  async function (t) {
    const f = await openFixture(t)
    t.teardown(() => closeFixture(f))

    const bee = f.auto._workingBee
    const head = bee.head()
    const local = bee.context.local

    t.alike(head.key, local.key, 'the view head is on the local view core')
    t.absent(
      b4a.equals(head.key, b4a.from(META.view.key, 'hex')),
      'the v2 view core is left behind'
    )
    t.is(await manifestVersion(f.auto, head.key), 3)
    t.is(head.length, local.length)
    t.is((await bee.cores()).length, 1, 'no references to the v2 view core')

    t.alike(await entries(f.auto.view), META.versions[META.versions.length - 1])
    t.alike(await history(bee), META.versions, 'every batch survives the reindex')

    t.alike(f.auto.system.view, head, 'the system records the reindexed view')

    const oplog = await f.auto.writers.getLatestLocalOplog()
    t.alike(oplog.views.view.key, local.key, 'our oplog advertises the v3 view core')
    t.is(oplog.views.view.start + oplog.views.view.length, local.length)
  }
)

test(
  'view reindex - the system is reindexed into the v3 local system core',
  { skip },
  async function (t) {
    const f = await openFixture(t)
    t.teardown(() => closeFixture(f))

    const sys = f.auto.system.bee
    const head = sys.head()
    const local = sys.context.local

    t.alike(head.key, local.key, 'the system head is on the local system core')
    t.is(head.length, local.length)
    t.is(await manifestVersion(f.auto, head.key), 3)
    t.absent((await coreVersions(f.auto, sys)).includes(2), 'no references to a v2 system core')

    const boot = encoding.decodeBootRecord(await f.auto.local.getUserData('autobee/head'))
    t.alike(boot, head, 'the stored boot record is the reindexed system head')

    const oplog = await f.auto.writers.getLatestLocalOplog()
    t.alike(oplog.views.system.key, local.key, 'our oplog advertises the v3 system core')
    t.is(oplog.views.system.start + oplog.views.system.length, local.length)
  }
)

test('view reindex - writes after the reindex land on the v3 core', { skip }, async function (t) {
  const f = await openFixture(t)
  t.teardown(() => closeFixture(f))

  await append(f.auto, [['after', 'reindex']], ['key0001'])

  const bee = f.auto._workingBee
  const expected = META.versions[META.versions.length - 1]
    .filter(([k]) => k !== 'key0001')
    .concat([['after', 'reindex']])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  t.alike(await entries(f.auto.view), expected)
  t.is((await bee.cores()).length, 1)
  t.is(await manifestVersion(f.auto, bee.head().key), 3)
  t.is((await history(bee)).length, META.versions.length + 1)
})

test('view reindex - reopening does not reindex again', { skip }, async function (t) {
  const first = await openFixture(t)
  const dir = first.dir
  const length = first.auto._workingBee.context.local.length
  const systemLength = first.auto.system.bee.context.local.length
  await closeFixture(first)

  const f = await openFixture(t, dir)
  t.teardown(() => closeFixture(f))

  const bee = f.auto._workingBee

  t.is(bee.context.local.length, length, 'the local view core did not grow')
  t.alike(bee.head().key, bee.context.local.key)
  t.alike(await history(bee), META.versions)

  const sys = f.auto.system.bee
  t.is(sys.context.local.length, systemLength, 'the local system core did not grow')
  t.alike(sys.head().key, sys.context.local.key, 'the system boots from the reindexed core')
})

test(
  'view reindex - the reindexed system head is stored before the drain ends',
  { skip },
  async function (t) {
    const first = await openFixture(t, null, {
      patch: (auto) => {
        auto._storeBoot = async () => {}
      }
    })
    const dir = first.dir
    const length = first.auto._workingBee.context.local.length
    const systemLength = first.auto.system.bee.context.local.length
    const head = first.auto.system.bee.head()

    const boot = encoding.decodeBootRecord(await first.auto.local.getUserData('autobee/head'))
    t.alike(boot, head, 'the system head is stored by the reindex flush')
    await closeFixture(first)

    const f = await openFixture(t, dir)
    t.teardown(() => closeFixture(f))

    t.is(f.auto._workingBee.context.local.length, length, 'the local view core did not grow')
    t.is(f.auto.system.bee.context.local.length, systemLength, 'the local system core did not grow')
    t.alike(f.auto.system.bee.head(), head)
    t.alike(
      f.auto.system.view.key,
      f.auto._workingBee.context.local.key,
      'info.view is the v3 view core'
    )
    t.is(await manifestVersion(f.auto, f.auto.system.view.key), 3)
    t.alike(f.auto._workingBee.head().key, f.auto._workingBee.context.local.key)
    t.alike(await history(f.auto._workingBee), META.versions)
  }
)

test('view reindex - a peer fast-forwards onto a reindexed view', { skip }, async function (t) {
  const dir = await t.tmp()
  await fs.cp(path.join(FIXTURE, 'a'), dir, { recursive: true })

  const a = await openFixture(t)
  t.teardown(() => closeFixture(a))

  let reindexed = 0
  let fastForwards = 0
  let done = null

  const b = await openFixture(t, dir, {
    patch: (auto) => {
      const reindexBee = auto._reindexBee.bind(auto)
      auto._reindexBee = (bee) => {
        reindexed++
        return reindexBee(bee)
      }
      const applyFastForward = auto._applyFastForward.bind(auto)
      auto._applyFastForward = async () => {
        fastForwards++
        return applyFastForward()
      }
      done = replicate(a.auto, auto)
    }
  })
  t.teardown(() => closeFixture(b))

  t.teardown(() => done())

  await sync(a.auto, b.auto)

  t.is(fastForwards, 1, 'the peer fast-forwarded')
  t.is(reindexed, 0, 'the peer did not reindex locally')
  t.alike(b.auto.system.bee.head(), a.auto.system.bee.head(), 'the peer is on the reindexed system')
  t.alike(b.auto.system.view, a.auto.system.view, 'the peer records the reindexed view')
  t.is(await manifestVersion(b.auto, b.auto.system.view.key), 3)
  t.alike(await entries(b.auto.view), META.versions[META.versions.length - 1])
})

test(
  'view reindex - a forced boot fast-forward reindexes before anything applies',
  { skip },
  async function (t) {
    // a host boots from an oplog head (like keet): the forced fast-forward onto
    // the v2 head must not let pending remote nodes apply on top of it
    const first = await openFixture(t, null, {
      patch: (auto) => {
        auto.compactMaybe = () => {}
      }
    })
    const dir = first.dir
    const boot = { key: first.auto.local.key, length: first.auto.local.length }
    await closeFixture(first)

    let fastForwards = 0
    const appliesOnV2 = []

    const f = await openFixture(t, dir, {
      fastForward: { boot: { head: boot } },
      patch: (auto) => {
        const applyFastForward = auto._applyFastForward.bind(auto)
        auto._applyFastForward = () => {
          fastForwards++
          return applyFastForward()
        }
        const bumpPendingWriters = auto._bumpPendingWriters.bind(auto)
        auto._bumpPendingWriters = async (opts) => {
          const head = auto.system.bee.head()
          if (head && (await auto._shouldReindex(head.key))) appliesOnV2.push(head)
          return bumpPendingWriters(opts)
        }
      }
    })
    t.teardown(() => closeFixture(f))
    await f.auto.update()

    t.is(fastForwards, 1, 'booted through a forced fast-forward')
    t.is(appliesOnV2.length, 0, 'apply never ran against the v2 head')

    const sys = f.auto.system.bee
    t.alike(sys.head().key, sys.context.local.key, 'the system head is on the local core')
    t.is(await manifestVersion(f.auto, sys.head().key), 3)
    t.absent((await coreVersions(f.auto, sys)).includes(2), 'no references to a v2 system core')
    t.absent(
      (await coreVersions(f.auto, f.auto._workingBee)).includes(2),
      'no references to a v2 view core'
    )
    t.alike(await entries(f.auto.view), META.versions[META.versions.length - 1])
  }
)

test(
  'view reindex - a crash before the reindex ack reaches the oplog still boots',
  { skip },
  async function (t) {
    const first = await openFixture(t, null, {
      patch: (auto) => {
        auto.on('error', () => {})
        auto._flushLocal = async () => {
          throw new Error('crash')
        }
      }
    })
    const dir = first.dir
    const localLength = first.auto.local.length

    t.ok(first.auto.writers.localWriter.pending, 'the reindex ack never reached the oplog')
    await closeFixture(first)

    const errors = []
    const f = await openFixture(t, dir, {
      patch: (auto) => {
        auto.on('error', (err) => errors.push(err))
      }
    })
    t.teardown(() => closeFixture(f))

    const info = await f.auto.system.get(f.auto.local.key)
    t.ok(
      info.length <= f.auto.local.length,
      'the system does not reference local nodes missing from the oplog'
    )

    await append(f.auto, [['after', 'crash']])

    t.alike(errors, [], 'no background errors')
    t.ok(f.auto.local.length > localLength, 'the local oplog advanced')
    t.alike(
      await entries(f.auto.view),
      META.versions[META.versions.length - 1]
        .concat([['after', 'crash']])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      'the write after the crash is applied'
    )
  }
)
