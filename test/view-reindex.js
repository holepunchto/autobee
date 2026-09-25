const IS_BARE = typeof global.Bare !== 'undefined'

const test = require('brittle')
const b4a = require('b4a')
const Corestore = require('corestore')
const os = IS_BARE ? null : require('os')

const Autobee = require('../index.js')
const encoding = require('../lib/encoding.js')
const { create, replicate, sync } = require('./helpers/index.js')

const skip = IS_BARE || !['linux', 'darwin'].includes(os.platform())

const path = skip ? null : require('path')
const fs = skip ? null : require('fs/promises')

const FIXTURE = skip ? null : path.join(__dirname, 'fixtures/migration/autobee-v2-view-linux')
const META = skip ? null : require(path.join(FIXTURE, 'meta.json'))
const HEADS_FIXTURE = skip
  ? null
  : path.join(__dirname, 'fixtures/migration/autobee-v2-heads-linux')
const HEADS_META = skip ? null : require(path.join(HEADS_FIXTURE, 'meta.json'))
const EMPTY_FIXTURE = skip
  ? null
  : path.join(__dirname, 'fixtures/migration/autobee-v2-empty-view-linux')
const EMPTY_META = skip ? null : require(path.join(EMPTY_FIXTURE, 'meta.json'))
const BASE_KEY = b4a.from('7f22e8f8460095e563eb47a71843a6be852bd8c800d27904eef26068149b921a', 'hex')
const SECRET_KEY = b4a.alloc(32).fill('secret')

async function apply(batch, view, base) {
  for (const { value } of batch) {
    if (!value) continue
    const data = JSON.parse(b4a.toString(value))
    if (!data || typeof data !== 'object') continue
    if (data.add) await base.addWriter(b4a.from(data.add, 'hex'), { indexer: !!data.indexer })
    if (data.puts || data.dels) {
      // the heads fixture flushes the view once per chunk of puts
      const chunks = data.puts && Array.isArray(data.puts[0][0]) ? data.puts : [data.puts || []]
      for (const puts of chunks) {
        const w = view.write()
        for (const [k, v] of puts) w.tryPut(b4a.from(k), b4a.from(v))
        for (const k of data.dels || []) w.tryDelete(b4a.from(k))
        await w.flush()
      }
    }
  }
}

async function openFixture(
  t,
  dir = null,
  { patch = null, fastForward = undefined, fixture = FIXTURE, key = BASE_KEY } = {}
) {
  if (dir === null) {
    dir = await t.tmp()
    await fs.cp(path.join(fixture, 'a'), dir, { recursive: true })
  }

  const store = new Corestore(dir, { allowBackup: true, manifestVersion: 2 })
  const auto = new Autobee(store, key, {
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

test('view reindex - copied system records point at the v3 view', { skip }, async function (t) {
  const f = await openFixture(t)
  t.teardown(() => closeFixture(f))

  const sys = f.auto.system.bee
  const local = f.auto._workingBee.context.local

  // the copied history, before it links back into the legacy system core
  const heads = []
  for await (const { head } of sys.createChangesStream()) {
    if (!b4a.equals(head.key, sys.context.local.key)) break
    heads.push(head)
  }

  const views = []
  for (const head of heads) {
    const checkout = sys.checkout(head)
    const node = await checkout.get(b4a.from([0]))
    await checkout.close()
    if (node) views.push(encoding.decodeSystemInfo(node.value).view)
  }

  t.ok(views.length > 1, 'the system history was copied')
  for (const view of views) {
    t.alike(
      view.key,
      local.key,
      'system record at view length ' + view.length + ' is on the v3 core'
    )
  }
  t.alike(views[0], f.auto.system.view, 'the head record matches the in-memory view')

  // an undo reloads the view from an older system record: it must stay on v3
  const previous = views.findIndex((v) => v.length === local.length - 1)
  t.ok(previous > 0, 'a record from before the last view batch was copied')

  const view = await f.auto.system.undo(heads[previous])
  t.alike(view, { key: local.key, length: local.length - 1 }, 'undo lands the view on the v3 core')
  t.ok(await f.auto._isReindexed(), 'undo does not reintroduce the v2 view')
  const checkout = f.auto._workingBee.checkout(view)
  t.alike(await entries(checkout), META.versions[META.versions.length - 2])
  await checkout.close()
})

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
  'view reindex - a reindex whose head was never stored is adopted on reopen',
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

test(
  'view reindex - a large system with several view flushes per batch',
  { skip },
  async function (t) {
    t.ok(HEADS_META.infoSize > 1024, 'the system info is not inlined')
    t.not(
      HEADS_META.systemChanges,
      HEADS_META.viewChanges,
      'system and view batches do not line up'
    )

    const key = b4a.from(HEADS_META.baseKey, 'hex')
    const f = await openFixture(t, null, { fixture: HEADS_FIXTURE, key })
    const dir = f.dir
    t.teardown(() => closeFixture(f))

    const bee = f.auto._workingBee
    const sys = f.auto.system.bee
    const local = bee.context.local

    t.alike(bee.head(), { key: local.key, length: local.length }, 'the view is on the v3 core')
    t.is((await bee.cores()).length, 1)
    t.alike(sys.head().key, sys.context.local.key, 'the system is on the v3 core')
    t.absent((await coreVersions(f.auto, sys)).includes(2))
    t.alike(f.auto.system.view, bee.head())

    t.alike(await entries(f.auto.view), HEADS_META.versions[HEADS_META.versions.length - 1])
    t.alike(await history(bee), HEADS_META.versions, 'every view flush survives the reindex')

    const viewHeads = new Set([0])
    for await (const { head } of bee.createChangesStream()) viewHeads.add(head.length)

    const heads = []
    for await (const { head } of sys.createChangesStream()) heads.push(head)
    t.ok(heads.length >= HEADS_META.systemChanges, 'the whole system history was copied')

    let large = 0
    let most = 0
    const views = []
    for (const head of heads) {
      const checkout = sys.checkout(head)
      const node = await checkout.get(b4a.from([0]))
      await checkout.close()
      if (!node) continue
      if (node.value.byteLength > 1024) large++
      const info = encoding.decodeSystemInfo(node.value)
      most = Math.max(most, info.heads.length)
      views.push(info.view)
    }

    t.ok(large > 1, 'copied system records with a non-inlined value')
    t.is(most, HEADS_META.heads, 'the copied records still carry every head')
    t.is(views.length, heads.length)
    t.ok(
      views.every((v) => b4a.equals(v.key, local.key) && viewHeads.has(v.length)),
      'every system record points at a v3 view head'
    )

    const previous = views.findIndex((v) => v.length === local.length - 1)
    const view = await f.auto.system.undo(heads[previous])
    t.alike(view, { key: local.key, length: local.length - 1 }, 'undo lands on the v3 view')
    t.ok(await f.auto._isReindexed())
    const checkout = bee.checkout(view)
    t.alike(await entries(checkout), HEADS_META.versions[HEADS_META.versions.length - 2])
    await checkout.close()

    const viewLength = local.length
    const systemLength = sys.context.local.length
    await closeFixture(f)

    const again = await openFixture(t, dir, { fixture: HEADS_FIXTURE, key })
    t.teardown(() => closeFixture(again))

    t.is(again.auto._workingBee.context.local.length, viewLength, 'the view did not reindex again')
    t.is(
      again.auto.system.bee.context.local.length,
      systemLength,
      'the system did not reindex again'
    )
  }
)

test('view reindex - a view that was never written', { skip }, async function (t) {
  t.is(EMPTY_META.viewChanges, 0)
  t.is(EMPTY_META.systemView.length, 0)

  const key = b4a.from(EMPTY_META.baseKey, 'hex')
  const f = await openFixture(t, null, { fixture: EMPTY_FIXTURE, key })
  const dir = f.dir
  t.teardown(() => closeFixture(f))

  const bee = f.auto._workingBee
  const sys = f.auto.system.bee
  const local = bee.context.local

  t.alike(bee.head(), { key: local.key, length: 0 }, 'the empty view is on the v3 core')
  t.alike(sys.head().key, sys.context.local.key, 'the system is on the v3 core')
  t.absent((await coreVersions(f.auto, sys)).includes(2))
  t.ok(await f.auto._isReindexed())

  const views = []
  for await (const { head } of sys.createChangesStream()) {
    const checkout = sys.checkout(head)
    const node = await checkout.get(b4a.from([0]))
    await checkout.close()
    if (node) views.push(encoding.decodeSystemInfo(node.value).view)
  }

  t.ok(views.length >= EMPTY_META.systemChanges)
  t.ok(
    views.every((v) => b4a.equals(v.key, local.key) && v.length === 0),
    'every system record points at the empty v3 view'
  )

  await append(f.auto, [['first', 'write']])
  t.alike(await entries(f.auto.view), [['first', 'write']])
  t.alike(bee.head(), { key: local.key, length: local.length })
  t.is((await bee.cores()).length, 1)

  const viewLength = local.length
  const systemLength = sys.context.local.length
  await closeFixture(f)

  const again = await openFixture(t, dir, { fixture: EMPTY_FIXTURE, key })
  t.teardown(() => closeFixture(again))

  t.is(again.auto._workingBee.context.local.length, viewLength, 'the view did not reindex again')
  t.is(again.auto.system.bee.context.local.length, systemLength, 'the system did not reindex again')
  t.alike(await entries(again.auto.view), [['first', 'write']])
})

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
        auto._flushLocal = () => Promise.reject(new Error('crash'))
      }
    })
    const dir = first.dir
    const localLength = first.auto.local.length

    t.ok(first.auto.writers.localWriter.pending, 'the reindex ack never reached the oplog')
    await closeFixture(first)

    const errors = []
    const reboots = []
    const f = await openFixture(t, dir, {
      patch: (auto) => {
        auto.on('error', (err) => errors.push(err))
        const compactMaybe = auto.compactMaybe.bind(auto)
        auto.compactMaybe = async () => {
          await compactMaybe()
          const info = await auto.system.get(auto.local.key)
          reboots.push({ system: info.length, oplog: auto.local.length })
        }
      }
    })
    t.teardown(() => closeFixture(f))

    t.ok(reboots.length > 0, 'the reopen went through the reindex')
    t.ok(
      reboots.every(({ system, oplog }) => system <= oplog),
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

test('view reindex - strictReindex only accepts v3 cores', async function (t) {
  const loose = await create(t)
  const strict = await create(t, { strictReindex: true })

  const shouldReindex = async (auto) => {
    const out = []
    for (const manifestVersion of [1, 2, 3]) {
      const core = auto.store.get({ name: 'v' + manifestVersion, manifestVersion })
      await core.ready()
      out.push(await auto._shouldReindex(core.key))
      await core.close()
    }
    return out
  }

  t.alike(await shouldReindex(loose), [false, true, false], 'by default only v2 is reindexed')
  t.alike(await shouldReindex(strict), [true, true, false], 'strict reindexes v1 and v2')
})
