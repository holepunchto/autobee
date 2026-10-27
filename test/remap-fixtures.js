const test = require('brittle')
const b4a = require('b4a')
const c = require('compact-encoding')
const Corestore = require('corestore')
const os = require('os')

const Hypercore = require('hypercore')
const Autobee = require('../index.js')
const { migrateCore, Remapper } = require('../lib/remap.js')
const { ManifestData } = require('../lib/encoding.js')
const {
  replicate,
  replicateAsRecovery,
  sync,
  recoveryPeers,
  remapped: settled
} = require('./helpers/index.js')

const skip = !['linux', 'darwin'].includes(os.platform())

const path = skip ? null : require('path')
const fs = skip ? null : require('fs/promises')

const FIXTURES = skip ? null : path.join(__dirname, 'fixtures/migration')
const VIEW = skip ? null : fixture('autobee-v2-view-linux')
const HEADS = skip ? null : fixture('autobee-v2-heads-linux')
const EMPTY = skip ? null : fixture('autobee-v2-empty-view-linux')

const SECRET_KEY = b4a.alloc(32).fill('secret')

function fixture(name) {
  const dir = path.join(FIXTURES, name)
  return { dir, meta: require(path.join(dir, 'meta.json')) }
}

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
  { fixture = VIEW, dir = null, patch = null, peer = true, flush = true } = {}
) {
  if (dir === null) {
    dir = await t.tmp()
    await fs.cp(path.join(fixture.dir, 'a'), dir, { recursive: true })
  }

  const store = new Corestore(dir, { allowBackup: true, manifestVersion: 2 })
  const auto = new Autobee(store, b4a.from(fixture.meta.baseKey, 'hex'), {
    apply,
    migrate: () => Promise.resolve(),
    legacyViews: ['not-a-view'],
    encrypted: true,
    encryptionKey: SECRET_KEY
  })

  const events = { remap: 0 }
  // remap fires on every transition to the remapped generation, with the cores copied or null
  auto.on('remap', (mappings) => {
    if (mappings !== null) events.remap++
  })

  if (patch) patch(auto)
  if (peer) await servePeer(t, store, fixture)

  await auto.ready()
  if (flush) {
    await auto.flush()
    await settled(auto)
  }

  return { auto, store, dir, events }
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

// the mappings are written into a checkpoint of their own, a change that
// leaves the entries as they were
function remapped(versions) {
  return versions.concat([versions[versions.length - 1]])
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

async function manifestVersion(store, key) {
  const core = store.get({ key, active: false })
  await core.ready()
  const version = core.manifest === null ? null : core.manifest.version
  await core.close()
  return version
}

// every core a bee can reach, with the manifest version it is read from. A
// legacy (v1) core stays linked as it is, only v2 cores are remapped
async function reachable(auto, bee) {
  const out = []
  for (const key of await bee.cores({ recursive: true })) {
    out.push({ key, version: await manifestVersion(auto.store, key) })
  }
  return out
}

// the mappings of the view come with its table, read on the first use
async function mapped(auto) {
  await auto.bee.cores()
  return [...auto.bee.context.mappings.known.keys()].map((hex) => b4a.from(hex, 'hex'))
}

async function append(auto, puts, dels = []) {
  await auto.append(b4a.from(JSON.stringify({ puts, dels })))
  await auto.update()
}

async function copyFixture(t, fixture = VIEW) {
  const dir = await t.tmp()
  await fs.cp(path.join(fixture.dir, 'a'), dir, { recursive: true })
  return dir
}

// a blind peer holding the fixture, the remap waits to have what it has
async function servePeer(t, store, fixture) {
  const peer = openStore(t, await copyFixture(t, fixture))
  const s1 = store.replicate(true)
  const s2 = peer.replicate(false)
  s1.pipe(s2).pipe(s1)
  recoveryPeers(s2)
  t.teardown(() => {
    s1.destroy()
    s2.destroy()
  })
}

function openStore(t, dir) {
  const store = new Corestore(dir, { allowBackup: true, manifestVersion: 2 })
  t.teardown(() => store.close())
  return store
}

function viewEncryption(fixture = VIEW) {
  return Autobee.getViewEncryption(b4a.from(fixture.meta.baseKey, 'hex'), SECRET_KEY, 'view')
}

async function blocks(core) {
  const out = []
  for (let i = 0; i < core.length; i++) out.push(await core.get(i))
  return out
}

async function coreLength(dir, key) {
  const store = new Corestore(dir, { allowBackup: true, manifestVersion: 2 })
  const core = store.get({ key, active: false })
  await core.ready()
  const length = core.length
  await core.close()
  await store.close()
  return length
}

async function clearCores(dir, keys) {
  const store = new Corestore(dir, { allowBackup: true, manifestVersion: 2 })
  for (const key of keys) {
    const core = store.get({ key, active: false })
    await core.ready()
    await core.clear(0, core.length)
    await core.close()
  }
  await store.close()
}

test('remap fixtures - the fixture holds a v2 view written by main', { skip }, function (t) {
  t.is(VIEW.meta.view.manifestVersion, 2)
  t.is(VIEW.meta.versions.length, VIEW.meta.rounds)
})

test('remap fixtures - opening a store with v2 views remaps them', { skip }, async function (t) {
  const dir = await t.tmp()
  await fs.cp(path.join(VIEW.dir, 'a'), dir, { recursive: true })
  const before = await coreLength(dir, b4a.from(VIEW.meta.localKey, 'hex'))

  const f = await openFixture(t, { dir })
  t.teardown(() => closeFixture(f))

  t.is(
    f.auto.local.length,
    before + 1,
    'the writer acked once remapped, so its head carries the mappings'
  )

  const v2 = b4a.from(VIEW.meta.view.key, 'hex')
  t.is(await manifestVersion(f.store, v2), 2, 'the v2 view is still in the store')
  t.is(f.events.remap, 1, 'the cores were remapped on open')

  const copy = f.auto.bee.context.mappings.resolve(v2)
  t.absent(b4a.equals(copy, v2), 'the v2 view is mapped')
  t.is(await manifestVersion(f.store, copy), 3, 'to a v3 core')
  t.alike(
    f.auto.bee.head().key,
    f.auto._workingBee.context.local.key,
    'the view head is on the local core'
  )
  t.ok(
    (await f.auto.bee.cores()).some((k) => b4a.equals(k, copy)),
    'reading through the copy'
  )
  t.is(f.auto.system.version, 4, 'the system claims the remapped generation')

  for (const bee of [f.auto.bee, f.auto.system.bee]) {
    const cores = await reachable(f.auto, bee)
    t.ok(cores.length > 0)
    t.absent(
      cores.some((c) => c.version === 2),
      'no reachable core is read as a v2 core'
    )
  }

  t.alike(await entries(f.auto.view), VIEW.meta.versions[VIEW.meta.versions.length - 1])
  t.alike(
    await history(f.auto.bee),
    remapped(VIEW.meta.versions),
    'every batch reads through the copies'
  )
})

test('remap fixtures - writes after the remap land on the v3 core', { skip }, async function (t) {
  const f = await openFixture(t)
  t.teardown(() => closeFixture(f))

  await append(f.auto, [['after', 'remap']], ['key0001'])

  const expected = VIEW.meta.versions[VIEW.meta.versions.length - 1]
    .filter(([k]) => k !== 'key0001')
    .concat([['after', 'remap']])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  t.alike(await entries(f.auto.view), expected)

  const bee = f.auto._workingBee
  t.alike(bee.head().key, bee.context.local.key, 'the head is on the local core')
  t.is(await manifestVersion(f.store, bee.head().key), 3)
  t.is((await history(bee)).length, VIEW.meta.versions.length + 2)

  const oplog = await f.auto.writers.getLatestLocalOplog()
  t.alike(oplog.views.view.key, bee.context.local.key, 'our oplog advertises the v3 view core')
})

test('remap fixtures - reopening does not remap again', { skip }, async function (t) {
  const first = await openFixture(t)
  const dir = first.dir
  const keys = await mapped(first.auto)
  const length = first.auto._workingBee.context.local.length
  t.is(first.events.remap, 1)
  await closeFixture(first)

  const f = await openFixture(t, { dir })
  t.teardown(() => closeFixture(f))

  t.is(f.events.remap, 0, 'nothing was left to remap')
  t.is(f.auto.system.version, 4, 'the generation was read back')
  t.alike(await mapped(f.auto), keys, 'the mappings were loaded')
  t.is(f.auto._workingBee.context.local.length, length, 'the local view core did not grow')
  t.alike(await history(f.auto.bee), remapped(VIEW.meta.versions))
})

test('remap fixtures - the originals are not needed once remapped', { skip }, async function (t) {
  const first = await openFixture(t)
  const dir = first.dir
  const keys = await mapped(first.auto)
  t.ok(keys.length > 0)
  await closeFixture(first)

  await clearCores(dir, keys)

  const f = await openFixture(t, { dir })
  t.teardown(() => closeFixture(f))

  t.is(f.events.remap, 0)
  t.alike(
    await history(f.auto.bee),
    remapped(VIEW.meta.versions),
    'every batch reads through the copies'
  )

  await append(f.auto, [['after', 'purge']])
  t.ok((await entries(f.auto.view)).some(([k]) => k === 'after'))
})

test(
  'remap fixtures - a large system with several view flushes per batch',
  { skip },
  async function (t) {
    const f = await openFixture(t, { fixture: HEADS })
    t.teardown(() => closeFixture(f))

    t.is(f.events.remap, 1)

    for (const bee of [f.auto.bee, f.auto.system.bee]) {
      t.ok(
        (await reachable(f.auto, bee)).every((c) => c.version === 3),
        'every reachable core is read as a v3 core'
      )
    }

    t.alike(await entries(f.auto.view), HEADS.meta.versions[HEADS.meta.versions.length - 1])
    t.alike(
      await history(f.auto.bee),
      remapped(HEADS.meta.versions),
      'every view flush reads through the copies'
    )
  }
)

test('remap fixtures - a view that was never written', { skip }, async function (t) {
  t.is(EMPTY.meta.viewChanges, 0)

  const f = await openFixture(t, { fixture: EMPTY })
  const dir = f.dir
  t.teardown(() => closeFixture(f))
  t.is(f.events.remap, 1, 'the system core was remapped, the empty view has nothing to copy')
  t.absent(
    (await reachable(f.auto, f.auto.system.bee)).some((c) => c.version === 2),
    'no reachable system core is read as a v2 core'
  )

  await append(f.auto, [['first', 'write']])
  t.alike(await entries(f.auto.view), [['first', 'write']])

  const viewLength = f.auto._workingBee.context.local.length
  await closeFixture(f)

  const again = await openFixture(t, { fixture: EMPTY, dir })
  t.teardown(() => closeFixture(again))

  t.is(again.events.remap, 0)
  t.is(again.auto._workingBee.context.local.length, viewLength)
  t.alike(await entries(again.auto.view), [['first', 'write']])
})

test(
  'remap fixtures - a peer fast-forwards onto the remapped writer',
  { skip },
  async function (t) {
    const a = await openFixture(t)
    t.teardown(() => closeFixture(a))
    t.is(a.events.remap, 1)

    const b = await openFixture(t, { dir: await t.tmp() })
    t.teardown(() => closeFixture(b))

    const done = replicate(a.auto, b.auto)
    t.teardown(() => done())

    // a landing of its own may already be on the way, so only the outcome is checked
    await b.auto.moveTo({ key: a.auto.local.key, length: a.auto.local.length })
    await sync(a.auto, b.auto)
    t.is(b.events.remap, 0, 'and had nothing left to remap')
    t.alike(b.auto.system.bee.head(), a.auto.system.bee.head(), 'the peer is on the writer')
    t.alike(await mapped(b.auto), await mapped(a.auto), 'with the mappings the writer recorded')
    t.absent(
      (await reachable(b.auto, b.auto.bee)).some((c) => c.version === 2),
      'no core the peer reads is a v2 core'
    )
    t.alike(await entries(b.auto.view), VIEW.meta.versions[VIEW.meta.versions.length - 1])
  }
)

test('remap fixtures - the v2 view is copied into a current core', { skip }, async function (t) {
  const store = openStore(t, await copyFixture(t))
  const key = b4a.from(VIEW.meta.view.key, 'hex')

  const src = store.get({ key, encryption: viewEncryption() })
  await src.ready()
  t.teardown(() => src.close())
  t.is(src.manifest.version, 2)

  const copy = await migrateCore(store, key, viewEncryption())
  t.teardown(() => copy.close())

  t.is(copy.manifest.version, 3, 'the copy is a current core')
  t.is(copy.length, src.length, 'of the same length')
  t.absent(copy.writable, 'that nobody can write to')
  t.alike(copy.key, Hypercore.key(copy.manifest), 'keyed by its manifest')
  t.alike(c.decode(ManifestData, copy.manifest.userData).namespace, key, 'which names the source')

  const opened = store.get({ key: copy.key, encryption: viewEncryption() })
  await opened.ready()
  t.alike(await blocks(opened), await blocks(src), 'the copy reads as the source')
  await opened.close()

  const again = await migrateCore(store, key, viewEncryption())
  t.alike(again.key, copy.key, 'copying again gives the same core')
  await again.close()
})

test(
  'remap fixtures - every peer copying the v2 view gets the same core',
  { skip },
  async function (t) {
    const key = b4a.from(VIEW.meta.view.key, 'hex')

    const a = openStore(t, await copyFixture(t))
    const b = openStore(t, await copyFixture(t))

    const ca = await migrateCore(a, key, viewEncryption())
    const cb = await migrateCore(b, key, viewEncryption())
    t.teardown(() => ca.close())
    t.teardown(() => cb.close())

    t.alike(cb.key, ca.key)
  }
)

test('remap fixtures - the remapper fetches the v2 view from a peer', { skip }, async function (t) {
  const key = b4a.from(VIEW.meta.view.key, 'hex')

  const source = openStore(t, await copyFixture(t))
  const store = openStore(t, await t.tmp())
  t.is(await store.storage.hasCore(Hypercore.discoveryKey(key)), false, 'the store never saw it')

  const s1 = source.replicate(true)
  const s2 = store.replicate(false)
  s1.pipe(s2).pipe(s1)
  recoveryPeers(s1)
  t.teardown(() => {
    s1.destroy()
    s2.destroy()
  })

  const auto = remapperFor(store, [key])
  const mappings = await new Remapper(auto).run()

  const expected = await migrateCore(source, key, viewEncryption())
  t.teardown(() => expected.close())

  t.alike(mappings, { views: [{ from: key, to: expected.key }], systems: [] }, 'the same copy')
})

test(
  'remap fixtures - the remapper without a peer waits until destroyed',
  { skip },
  async function (t) {
    const key = b4a.from(VIEW.meta.view.key, 'hex')
    const store = openStore(t, await t.tmp())
    const auto = remapperFor(store, [key])

    const remapper = new Remapper(auto)
    const running = remapper.run()
    await new Promise((resolve) => setTimeout(resolve, 500))
    remapper.destroy()
    t.is(await running, null, 'destroyed while waiting it maps nothing')
  }
)

test(
  'remap fixtures - offline the remap waits, closing tears it down',
  { skip },
  async function (t) {
    const dir = await copyFixture(t)
    await clearCores(dir, [b4a.from(VIEW.meta.view.key, 'hex')])

    const a = await openFixture(t, { dir, peer: false, flush: false })
    await new Promise((resolve) => setTimeout(resolve, 1500))

    t.is(a.events.remap, 0, 'nothing was remapped')
    t.absent(a.auto.remapped)
    t.is(a.auto.stats.applies, 0, 'and nothing was applied meanwhile')
    t.ok(a.auto._remapper !== null, 'the remap is waiting for a recovery peer')

    const closed = closeFixture(a)
    const timer = new Promise((resolve) => setTimeout(resolve, 5000, 'timed out'))
    t.is(
      await Promise.race([closed.then(() => 'closed'), timer]),
      'closed',
      'close returns at once'
    )
  }
)

test(
  'remap fixtures - a recovery peer without the cores keeps the remap waiting',
  { skip },
  async function (t) {
    const dir = await copyFixture(t)
    await clearCores(dir, [b4a.from(VIEW.meta.view.key, 'hex')])

    const a = await openFixture(t, { dir, peer: false, flush: false })
    const errors = []
    a.auto.on('error', (err) => errors.push(err))

    // a recovery peer of the room that does not hold the v2 view
    const b = await openFixture(t, { dir: await t.tmp(), peer: false })
    t.teardown(() => closeFixture(b))

    const done = replicateAsRecovery(a.auto, b.auto)
    t.teardown(() => done())
    await new Promise((resolve) => setTimeout(resolve, 3000))

    t.is(errors.length, 0, 'nothing failed')
    t.ok(a.auto.remapping, 'the remap is still waiting for the view')
    t.ok(a.auto._remapper !== null)

    const closed = closeFixture(a)
    const timer = new Promise((resolve) => setTimeout(resolve, 5000, 'timed out'))
    t.is(
      await Promise.race([closed.then(() => 'closed'), timer]),
      'closed',
      'close returns at once'
    )
  }
)

test(
  'remap fixtures - a landing cancels a remap waiting on recovery',
  { skip },
  async function (t) {
    const a = await openFixture(t)
    t.teardown(() => closeFixture(a))
    t.is(a.events.remap, 1)

    // no recovery peer will come: the remap waits, and a landing has to win
    const b = await openFixture(t, { dir: await copyFixture(t), peer: false, flush: false })
    t.teardown(() => closeFixture(b))

    // a is a peer of b, not a recovery peer: only the landing can end b's wait
    const done = replicate(a.auto, b.auto)
    t.teardown(() => done())

    await sync(a.auto, b.auto)
    await settled(b.auto)

    t.is(b.events.remap, 0, 'nothing was remapped')
    t.alike(b.auto.system.bee.head(), a.auto.system.bee.head(), 'the store landed on the writer')
    t.is(b.auto.system.version, 4)
    t.ok(b.auto.remapped, 'and counts as remapped')
    t.alike(await entries(b.auto.view), VIEW.meta.versions[VIEW.meta.versions.length - 1])
  }
)

test('remap fixtures - a peer only lands on a remapped head', { skip }, async function (t) {
  const dir = await copyFixture(t)
  const local = b4a.from(VIEW.meta.localKey, 'hex')
  const before = await coreLength(dir, local)

  const a = await openFixture(t, { dir })
  t.teardown(() => closeFixture(a))

  const b = await openFixture(t, { dir: await t.tmp() })
  t.teardown(() => closeFixture(b))

  const done = replicate(a.auto, b.auto)
  t.teardown(() => done())

  t.is(
    await b.auto.moveTo({ key: local, length: before }),
    null,
    'not on the head from before the remap'
  )
  await b.auto.moveTo({ key: local, length: a.auto.local.length })
  await sync(a.auto, b.auto)
  t.alike(b.auto.system.bee.head(), a.auto.system.bee.head(), 'but on the one after')
  t.is(b.auto.system.version, 4)
})

// what the remapper needs of an autobee, for a store holding the fixture's bootstrap
function remapperFor(store, views) {
  return {
    store,
    bootstrap: { key: b4a.from(VIEW.meta.baseKey, 'hex') },
    getViewEncryption: () => viewEncryption(),
    getSystemEncryption: () => null,
    _unmappedCores: async () => ({ views, systems: [] })
  }
}
