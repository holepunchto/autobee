const test = require('brittle')
const b4a = require('b4a')
const c = require('compact-encoding')
const Corestore = require('corestore')
const os = require('os')

const Hypercore = require('hypercore')
const Autobee = require('../index.js')
const FastForward = require('../lib/fast-forward.js')
const { migrateCore, Remapper } = require('../lib/remap.js')
const {
  replicate,
  replicateAsRecovery,
  sync,
  recoveryPeers,
  remapped: settled
} = require('./helpers/index.js')

const MOCK_REMAPPER = {
  auto: { key: b4a.alloc(32, 1) },
  destroyed: false
}

const NAMESPACE = b4a.toString(MOCK_REMAPPER.auto.key, 'hex')

const skip = !['linux', 'darwin'].includes(os.platform())

const path = skip ? null : require('path')
const fs = skip ? null : require('fs/promises')

const FIXTURES = skip ? null : path.join(__dirname, 'fixtures/migration')
const VIEW = skip ? null : fixture('autobee-v2-view-linux')
const HEADS = skip ? null : fixture('autobee-v2-heads-linux')
const EMPTY = skip ? null : fixture('autobee-v2-empty-view-linux')
const WRITERS = skip ? null : fixture('autobee-v2-writers-linux')

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
  { fixture = VIEW, dir = null, patch = null, peer = true, flush = true, opts = {} } = {}
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
    encryptionKey: SECRET_KEY,
    ...opts
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

async function copyFixture(t, fixture = VIEW, member = 'a') {
  const dir = await t.tmp()
  await fs.cp(path.join(fixture.dir, member), dir, { recursive: true })
  return dir
}

// a stage that hangs like a read nobody serves and fails like one once cancelled
function stall(remapper, stage) {
  const real = remapper[stage].bind(remapper)
  let stalled = false
  remapper[stage] = async (...args) => {
    if (stalled) return real(...args)
    stalled = true
    const epoch = remapper.epoch
    while (epoch === remapper.epoch && !remapper.destroyed) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error('request destroyed')
  }
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

  const copy = await migrateCore(store, MOCK_REMAPPER, key, viewEncryption())
  t.teardown(() => copy.close())

  t.is(copy.manifest.version, 3, 'the copy is a current core')
  t.is(copy.length, src.length, 'of the same length')
  t.absent(copy.writable, 'that nobody can write to')
  t.alike(copy.key, Hypercore.key(copy.manifest), 'keyed by its manifest')

  const opened = store.get({ key: copy.key, encryption: viewEncryption() })
  await opened.ready()
  t.alike(await blocks(opened), await blocks(src), 'the copy reads as the source')
  await opened.close()

  const again = await migrateCore(store, MOCK_REMAPPER, key, viewEncryption())
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

    const ca = await migrateCore(a, MOCK_REMAPPER, key, viewEncryption())
    const cb = await migrateCore(b, MOCK_REMAPPER, key, viewEncryption())
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

  const expected = await migrateCore(source, MOCK_REMAPPER, key, viewEncryption())
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

    let landed = null
    b.auto.once('move-to', () => {
      landed = b.auto.remapped
    })

    // a is a peer of b, not a recovery peer: only the landing can end b's wait
    const done = replicate(a.auto, b.auto)
    t.teardown(() => done())

    await sync(a.auto, b.auto)
    await settled(b.auto)

    t.is(landed, true, 'remapped as soon as it landed')

    t.is(b.events.remap, 0, 'nothing was remapped')
    t.alike(b.auto.system.bee.head(), a.auto.system.bee.head(), 'the store landed on the writer')
    t.is(b.auto.system.version, 4)
    t.ok(b.auto.remapped, 'and counts as remapped')
    t.alike(await entries(b.auto.view), VIEW.meta.versions[VIEW.meta.versions.length - 1])
  }
)

test(
  'remap fixtures - a forced move onto an old head restarts the remap',
  { skip },
  async function (t) {
    const dir = await copyFixture(t)
    const local = b4a.from(VIEW.meta.localKey, 'hex')
    const before = await coreLength(dir, local)

    const first = await openFixture(t, { dir })
    const keys = await mapped(first.auto)
    t.ok(first.auto.remapped)

    const run = Remapper.prototype.run
    Remapper.prototype.run = () => new Promise(() => {})

    try {
      t.ok(await first.auto.moveTo({ key: local, length: before }), 'landed on the old head')
      t.is(first.auto.system.version, 3)
      t.absent(first.auto.remapped, 'and does not count as remapped')
      t.ok(first.auto._remapper !== null, 'a remap was started right away')

      await append(first.auto, [['after', 'landing']])
      t.is(first.auto.system.version, 3, 'nothing written claims the new generation')

      await closeFixture(first)
    } finally {
      Remapper.prototype.run = run
    }

    const f = await openFixture(t, { dir, patch: (auto) => (auto._remapSettle = 200) })
    t.teardown(() => closeFixture(f))

    t.ok(f.auto.remapped, 'the next boot remaps again')
    t.is(f.auto.system.version, 4)
    t.alike(await mapped(f.auto), keys, 'through the same copies')
  }
)

test(
  'remap fixtures - a failed remap warns and opens the store to old heads',
  { skip },
  async function (t) {
    const dir = await copyFixture(t)
    const local = b4a.from(VIEW.meta.localKey, 'hex')
    const before = await coreLength(dir, local)

    const run = Remapper.prototype.run
    Remapper.prototype.run = () => Promise.reject(new Error('remap failed'))
    t.teardown(() => (Remapper.prototype.run = run))

    const errors = []
    const warnings = []
    const f = await openFixture(t, {
      dir,
      peer: false,
      flush: false,
      patch: (auto) => {
        auto.on('error', (err) => errors.push(err))
        auto.on('warning', (err) => warnings.push(err.message))
      }
    })
    t.teardown(() => closeFixture(f))

    await new Promise((resolve) => setTimeout(resolve, 500))
    t.alike(warnings, ['remap failed'])
    t.is(errors.length, 0, 'no error')
    t.absent(f.auto.closed, 'the store stays open')
    t.ok(f.auto._remapFailed)
    t.absent(f.auto.remapped)

    const old = { key: local, length: before }
    Remapper.prototype.run = () => new Promise(() => {})
    t.ok(await f.auto.moveTo(old), 'landed')
    t.absent(f.auto._remapFailed, 'the landing clears the failure')
    t.ok(f.auto._remapper !== null, 'and starts a new remap')
  }
)

test(
  'remap fixtures - an interrupted copy resumes on its staging core',
  { skip },
  async function (t) {
    const dir = await copyFixture(t)
    const store = openStore(t, dir)
    const key = b4a.from(VIEW.meta.view.key, 'hex')

    const copy = await migrateCore(store, MOCK_REMAPPER, key, viewEncryption())
    const staging = store.get({
      name: 'remap/' + NAMESPACE + '/' + VIEW.meta.view.key + '/' + copy.length
    })
    await staging.ready()
    t.is(staging.length, copy.length, 'the copy was staged on a core named for it')
    t.is(
      staging.core.state.storage.core.dataPointer,
      copy.core.state.storage.core.dataPointer,
      'and the copy is that storage'
    )

    const again = await migrateCore(store, MOCK_REMAPPER, key, viewEncryption())
    t.alike(again.key, copy.key, 'copying again reuses it')
    t.is(staging.length, copy.length)

    for (let i = 0; i < copy.length; i++) {
      t.alike(await again.get(i), await copy.get(i), 'block ' + i)
    }

    await staging.close()
    await again.close()
    await copy.close()
  }
)

test(
  'remap fixtures - a copy cancelled part way resumes after a reopen',
  { skip },
  async function (t) {
    const dir = await copyFixture(t)
    const key = b4a.from(VIEW.meta.view.key, 'hex')

    // one block per append, cancelled once two are on disk
    const first = new Corestore(dir, { allowBackup: true, manifestVersion: 2 })
    let appended = 0
    const spy = first.get({
      name: 'remap/' + NAMESPACE + '/' + VIEW.meta.view.key + '/' + VIEW.meta.view.length
    })
    await spy.ready()
    spy.on('append', () => appended++)

    const cancellableRemapper = {
      auto: { key: b4a.alloc(32, 1) },
      get destroyed() {
        return appended >= 2
      }
    }

    await t.exception(
      migrateCore(first, cancellableRemapper, key, viewEncryption(), {
        batchBytes: 1
      }),
      /Copy cancelled/
    )
    t.is(spy.length, 2, 'two blocks were staged before the cancel')
    await spy.close()
    await first.close()

    const store = openStore(t, dir)
    const copy = await migrateCore(store, MOCK_REMAPPER, key, viewEncryption())
    t.is(copy.length, VIEW.meta.view.length, 'the resumed copy is whole')

    const expected = await migrateCore(
      openStore(t, await copyFixture(t)),
      MOCK_REMAPPER,
      key,
      viewEncryption()
    )
    t.alike(copy.key, expected.key, 'and is the same core an uninterrupted copy makes')
    for (let i = 0; i < copy.length; i++) {
      t.alike(await copy.get(i), await expected.get(i), 'block ' + i)
    }

    await copy.close()
    await expected.close()
  }
)

test(
  'remap fixtures - concurrent copies of one source are serialised',
  { skip },
  async function (t) {
    const dir = await copyFixture(t)
    const store = openStore(t, dir)
    const key = b4a.from(VIEW.meta.view.key, 'hex')

    const [a, b] = await Promise.all([
      migrateCore(store, MOCK_REMAPPER, key, viewEncryption(), { batchBytes: 1 }),
      migrateCore(store, MOCK_REMAPPER, key, viewEncryption(), { batchBytes: 1 })
    ])

    t.alike(a.key, b.key, 'both land on the same copy')
    t.is(a.length, VIEW.meta.view.length, 'with no repeated blocks')
    await a.close()
    await b.close()
  }
)

test(
  'remap fixtures - the copy is made at the verified length and never waits',
  { skip },
  async function (t) {
    const dir = await copyFixture(t)
    const store = openStore(t, dir)
    const key = b4a.from(VIEW.meta.view.key, 'hex')

    const short = await migrateCore(store, MOCK_REMAPPER, key, viewEncryption(), { length: 3 })
    t.is(short.length, 3, 'copied at the length asked for')
    await short.close()

    const whole = await migrateCore(store, MOCK_REMAPPER, key, viewEncryption())
    t.is(whole.length, VIEW.meta.view.length)
    t.unlike(whole.key, short.key, 'a different copy from a different length')
    await whole.close()

    // a block that is not held locally fails the copy instead of waiting for a peer
    const src = store.get({ key, active: false })
    await src.ready()
    await src.clear(4, 6)
    await src.close()

    const other = { auto: { key: b4a.alloc(32, 2) }, destroyed: false }
    await t.exception(
      migrateCore(store, other, key, viewEncryption()),
      /Remap block missing: 4/,
      'the copy fails at once'
    )
  }
)

// the mappings write is held open: the remap has committed but not claimed
function holdMappingsWrite() {
  let release = null
  const held = new Promise((resolve) => (release = resolve))
  let reached = null
  const parked = new Promise((resolve) => (reached = resolve))

  const patch = (auto) => {
    const write = auto._workingBee.write.bind(auto._workingBee)
    auto._workingBee.write = (opts) => {
      const w = write(opts)
      if (opts && opts.mappings) {
        const flush = w.flush.bind(w)
        w.flush = async () => {
          reached()
          await held
          return flush()
        }
      }
      return w
    }
  }

  return { patch, parked, release }
}

// drives the store until the condition holds
async function drive(auto, cond, { ticks = 400 } = {}) {
  for (let i = 0; i < ticks; i++) {
    await auto.update()
    if (cond()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

// waits for the condition without driving the store, for when its drain is parked
async function poll(cond, { ticks = 400 } = {}) {
  for (let i = 0; i < ticks; i++) {
    if (cond()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

// drives the store until it is parked in its mappings write. The driver is
// handed back, not awaited: its last update is the parked one, so it only
// ends once the write is released
async function park(auto, parked) {
  let driving = true
  const driver = (async () => {
    while (driving) {
      await auto.update()
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  })()
  await parked
  driving = false
  return { driver }
}

test(
  'remap fixtures - an old head is refused while the remap is finished',
  { skip },
  async function (t) {
    const { patch, parked, release } = holdMappingsWrite()
    const f = await openFixture(t, { flush: false, patch })
    t.teardown(() => closeFixture(f))

    const { driver } = await park(f.auto, parked)

    t.absent(f.auto.remapped, 'not claimed yet')
    t.ok(f.auto.committing, 'but still committing')

    const head = f.auto.system.bee.head()
    const old = {
      system: { flushes: f.auto.system.flushes + 16, version: 3 },
      run: async () => ({ head: { key: head.key, length: head.length }, migrate: null }),
      close: async () => {}
    }
    t.absent(await f.auto._runFastForward(old), 'an old head is refused')
    t.absent(f.auto.fastForwardTo)

    release()
    await driver
    await settled(f.auto)

    t.ok(f.auto.remapped)
    t.is(f.auto.system.version, 4)
    t.is(f.auto.stats.fastForwards, 0, 'nothing landed')
    t.is(f.events.remap, 1)
  }
)

test(
  'remap fixtures - a run interrupted before its claim resolves its root on the next run',
  { skip },
  async function (t) {
    t.timeout(120000)
    const dir = await copyFixture(t)
    const v2 = b4a.from(VIEW.meta.view.key, 'hex')

    // the mappings checkpoint is written, then the store dies before the claim
    let died = false
    const first = await openFixture(t, {
      dir,
      flush: false,
      patch: (auto) => {
        auto.on('error', () => {})
        auto._onremapped = () => {
          died = true
          throw new Error('simulated crash before the claim')
        }
      }
    })
    while (!died) {
      await first.auto.update()
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    await closeFixture(first).catch(() => {})

    const again = await openFixture(t, { dir })
    t.ok(again.auto.remapped, 'the next run remaps')
    t.is(again.auto.system.version, 4)
    t.unlike(again.auto.system.view.key, v2, 'the claim does not point at the original')
    t.unlike(again.auto._workingBee.context.core.key, v2, 'nor does the root')
    t.alike(await entries(again.auto.view), VIEW.meta.versions[VIEW.meta.versions.length - 1])
    await closeFixture(again)

    // the original is not needed any more
    await clearCores(dir, [v2])
    const last = await openFixture(t, { dir, peer: false })
    t.teardown(() => closeFixture(last))
    t.ok(last.auto.remapped)
    t.alike(await entries(last.auto.view), VIEW.meta.versions[VIEW.meta.versions.length - 1])
  }
)

test(
  'remap fixtures - a forced move during the finish does not claim',
  { skip },
  async function (t) {
    const dir = await copyFixture(t)
    const local = b4a.from(VIEW.meta.localKey, 'hex')
    const before = await coreLength(dir, local)

    const { patch, parked, release } = holdMappingsWrite()
    const f = await openFixture(t, { dir, flush: false, patch })
    t.teardown(() => closeFixture(f))

    const { driver } = await park(f.auto, parked)
    const remapper = f.auto._remapper
    t.ok(f.auto.committing, 'committing')

    // the remap the move starts is kept from running, so the outcome is stable
    const run = Remapper.prototype.run
    Remapper.prototype.run = () => new Promise(() => {})
    t.teardown(() => (Remapper.prototype.run = run))

    const moved = f.auto.moveTo({ key: local, length: before })
    t.ok(await poll(() => remapper.destroyed), 'the move destroyed the finishing remap')
    t.ok(f.auto.fastForwardTo !== null, 'and is scheduled')

    release()
    await driver
    t.ok(await moved, 'moved')

    t.absent(f.auto.remapped, 'the finished remap did not claim')
    t.is(f.auto.system.version, 3, 'the store is on the old generation')
    t.is(f.events.remap, 0, 'no remap event')
    t.ok(f.auto._remapper !== null && f.auto._remapper !== remapper, 'a new remap started')
    t.absent(f.auto._remapFailed)
  }
)

test(
  'remap fixtures - a copy destroyed by a forced move is not a failure',
  { skip },
  async function (t) {
    const dir = await copyFixture(t)
    const local = b4a.from(VIEW.meta.localKey, 'hex')
    const before = await coreLength(dir, local)

    const f = await openFixture(t, { dir, flush: false })
    t.teardown(() => closeFixture(f))

    await f.auto.update()
    const remapper = f.auto._remapper
    t.ok(remapper, 'the remap started')

    // the first block read of the first copy is held, so the move lands mid-copy
    let release = null
    const held = new Promise((resolve) => (release = resolve))
    let reached = null
    const copying = new Promise((resolve) => (reached = resolve))
    let hooked = false
    const get = f.auto.store.get.bind(f.auto.store)
    f.auto.store.get = (opts) => {
      const core = get(opts)
      if (!hooked && remapper.committing && opts && opts.encryption && opts.active === true) {
        hooked = true
        const read = core.get.bind(core)
        core.get = async (...args) => {
          reached()
          await held
          return read(...args)
        }
      }
      return core
    }

    let result = null
    const commit = remapper._commit.bind(remapper)
    remapper._commit = async () => {
      try {
        return (result = { mappings: await commit() }).mappings
      } catch (err) {
        result = { err }
        throw err
      }
    }

    await copying
    t.ok(remapper.committing && f.auto.committing, 'phase two is reading its first block')
    t.ok(remapper.cores.length > 0, 'with cores to copy')

    const warnings = []
    f.auto.on('warning', (err) => warnings.push(err.message))

    const run = Remapper.prototype.run
    Remapper.prototype.run = () => new Promise(() => {})
    t.teardown(() => (Remapper.prototype.run = run))

    const moved = f.auto.moveTo({ key: local, length: before })
    t.ok(await drive(f.auto, () => remapper.destroyed), 'the committing remap was destroyed')
    t.ok(await drive(f.auto, () => f.auto.fastForwardTo === null), 'the move applied')
    t.ok(await moved, 'moved')

    release()
    t.ok(await drive(f.auto, () => result !== null), 'the commit ended')
    t.ok(result.err && /Copy cancelled/.test(result.err.message), 'the copy was cancelled')
    await new Promise((resolve) => setTimeout(resolve, 100))
    t.absent(f.auto._remapFailed, 'which is not a failure')
    t.alike(warnings, [], 'and is not warned about')
    t.absent(f.auto.remapped)
    t.is(f.auto.system.version, 3)
  }
)

test(
  'remap fixtures - the commit copies the length that was verified',
  { skip },
  async function (t) {
    const dir = await copyFixture(t)
    const v2 = b4a.from(VIEW.meta.view.key, 'hex')

    let release = null
    const held = new Promise((resolve) => (release = resolve))
    let mappings = null

    const f = await openFixture(t, {
      dir,
      flush: false,
      // the claim is captured instead of acked: the copy is deliberately short
      patch: (auto) => {
        auto._onremapped = (m) => {
          mappings = m
          auto.remapped = true
        }
      }
    })
    t.teardown(() => closeFixture(f))

    await f.auto.update()
    const remapper = f.auto._remapper
    const commit = remapper._commit.bind(remapper)
    remapper._commit = async () => {
      await held
      return commit()
    }

    // the recovery peer takes a retry to notice each core
    t.ok(await drive(f.auto, () => remapper.committing, { ticks: 1200 }), 'phase two started')
    const view = remapper.cores.find((core) => b4a.equals(core.key, v2))
    t.is(view.length, VIEW.meta.view.length, 'the verified length was recorded')

    // the source is longer than what was verified by the time the commit copies it
    view.length = 3
    release()
    t.ok(await drive(f.auto, () => mappings !== null), 'the remap finished')

    const mapping = mappings.views.find((m) => b4a.equals(m.from, v2))
    const copy = f.store.get({ key: mapping.to, active: false })
    await copy.ready()
    t.is(copy.length, 3, 'the copy is as long as was verified')
    await copy.close()

    const expected = await migrateCore(f.store, remapper, v2, viewEncryption(), { length: 3 })
    t.alike(mapping.to, expected.key, 'the copy made at that length')
    await expected.close()
  }
)

test('remap fixtures - the copy refuses what it cannot copy', { skip }, async function (t) {
  const store = openStore(t, await copyFixture(t))
  const key = b4a.from(VIEW.meta.view.key, 'hex')

  const empty = store.get({ name: 'empty' })
  await empty.ready()
  await t.exception(
    migrateCore(store, MOCK_REMAPPER, empty.key, null),
    /Cannot migrate an empty core/,
    'an empty source'
  )

  // a staging core for length 2 that already holds 3 blocks
  const staging = store.get({ name: 'remap/' + NAMESPACE + '/' + VIEW.meta.view.key + '/2' })
  await staging.ready()
  await staging.append([b4a.from('x'), b4a.from('y'), b4a.from('z')])
  await staging.close()
  await t.exception(
    migrateCore(store, MOCK_REMAPPER, key, viewEncryption(), { length: 2 }),
    /Staging core ahead of its source: 3 > 2/,
    'a staging core past its source'
  )

  await t.exception(
    migrateCore(store, MOCK_REMAPPER, key, viewEncryption(), {
      length: VIEW.meta.view.length + 5
    }),
    /Source core shorter than its copy/,
    'a length the source does not have'
  )
})

test(
  'remap fixtures - a restarted walk copies the head it landed on',
  { skip },
  async function (t) {
    t.timeout(180000)
    const meta = WRITERS.meta
    const coresOf = (m) => [b4a.from(m.view.key, 'hex'), b4a.from(m.systemCore, 'hex')]
    const [aView, aSystem] = coresOf(meta.a)
    const [bView, bSystem] = coresOf(meta.b)
    const hex = (keys) => keys.map((k) => b4a.toString(k, 'hex')).sort()

    // a user boots onto a's head, with a copy of a's store as its recovery peer
    const user = await openFixture(t, {
      fixture: WRITERS,
      dir: await t.tmp(),
      peer: false,
      flush: false,
      opts: {
        fastForward: {
          boot: { head: { key: b4a.from(meta.a.localKey, 'hex'), length: meta.a.localLength } }
        }
      }
    })
    t.teardown(() => closeFixture(user))

    const mirrorA = openStore(t, await copyFixture(t, WRITERS, 'a'))
    const a1 = user.store.replicate(true)
    const a2 = mirrorA.replicate(false)
    a1.pipe(a2).pipe(a1)
    recoveryPeers(a2)
    const leaveA = () => {
      a1.destroy()
      a2.destroy()
    }
    t.teardown(leaveA)

    t.ok(await drive(user.auto, () => user.auto.stats.fastForwards > 0), 'the user landed on a')
    const remapper = user.auto._remapper
    t.ok(remapper, 'and started remapping')
    stall(remapper, '_download')

    t.ok(await drive(user.auto, () => remapper.walked, { ticks: 1200 }), 'the walk found')
    t.alike(hex(remapper.cores.map((c) => c.key)), hex([aView, aSystem]), "a's v2 view and system")

    // meanwhile a and b carry on on the old generation, far past that head
    const previous = (auto) => (auto._startRemap = noop)
    const dirB = await copyFixture(t, WRITERS, 'b')
    let b = await openFixture(t, {
      fixture: WRITERS,
      dir: dirB,
      peer: false,
      flush: false,
      patch: previous
    })
    const a = await openFixture(t, {
      fixture: WRITERS,
      dir: await copyFixture(t, WRITERS, 'a'),
      peer: false,
      flush: false,
      patch: previous
    })
    const done = replicate(a.auto, b.auto)
    for (let i = 0; i < 20; i++) {
      await a.auto.append(b4a.from(JSON.stringify({ puts: [['a-later' + i, 'x']] })))
      await b.auto.append(b4a.from(JSON.stringify({ puts: [['b-later' + i, 'x']] })))
      await sync(a.auto, b.auto)
    }
    t.ok(b.auto.system.flushes - user.auto.system.flushes > FastForward.MIN_GAP, 'far ahead')
    t.is(b.auto.system.version, 3, 'still on the old generation')
    const head = { key: b.auto.local.key, length: b.auto.local.length }
    const expected = await entries(b.auto.view)
    await done()
    await closeFixture(a)
    await closeFixture(b)

    // b comes back, and a copy of it serves as the user's recovery peer for b's cores
    const mirror = openStore(
      t,
      await copyFixture(t, { dir: path.dirname(dirB), meta }, path.basename(dirB))
    )
    b = await openFixture(t, {
      fixture: WRITERS,
      dir: dirB,
      peer: false,
      flush: false,
      patch: previous
    })
    t.teardown(() => closeFixture(b))
    const s1 = user.store.replicate(true)
    const s2 = mirror.replicate(false)
    s1.pipe(s2).pipe(s1)
    recoveryPeers(s2)
    const undo = replicate(user.auto, b.auto)
    t.teardown(() => {
      s1.destroy()
      s2.destroy()
      return undo()
    })

    // the user lands on b's head: the walk is restarted from there
    t.ok(await user.auto.moveTo(head), 'the user moved onto b')
    t.is(user.auto._remapper, remapper, 'the remap was restarted, not replaced')
    t.absent(remapper.destroyed)

    t.ok(await drive(user.auto, () => user.auto.remapped, { ticks: 2400 }), 'and finished')
    t.ok(remapper.finished && remapper.mappings !== null, 'by the same remap')

    t.alike(hex(remapper.mappings.views.map((m) => m.from)), hex([bView]), "it copied b's view")
    t.alike(hex(remapper.mappings.systems.map((m) => m.from)), hex([bSystem]), "and b's system")
    t.absent(
      remapper.mappings.views.some((m) => b4a.equals(m.from, aView)),
      "not a's, which the user no longer reads"
    )
    t.alike(await entries(user.auto.view), expected, 'the view is whole')

    // a's cores stay in the user's own core table, from the nodes it applied
    // while on a's head: a table lists what an undo could still need. The
    // user's lineage is b's now, which cannot undo onto those nodes, so with
    // a's v2 view gone and nobody serving it the view still reads whole
    leaveA()
    const stale = user.store.get({ key: aView, active: false })
    await stale.ready()
    await stale.clear(0, stale.length)
    await stale.close()
    const out = []
    for await (const { key, value } of user.auto.view.createReadStream({ timeout: 5000 })) {
      out.push([b4a.toString(key), b4a.toString(value)])
    }
    t.alike(out, expected, "and reads none of a's v2 view")
  }
)

// what the remapper needs of an autobee, for a store holding the fixture's bootstrap
function remapperFor(store, views) {
  return {
    store,
    key: b4a.from(VIEW.meta.baseKey, 'hex'),
    bootstrap: { key: b4a.from(VIEW.meta.baseKey, 'hex') },
    getViewEncryption: () => viewEncryption(),
    getSystemEncryption: () => null,
    _unmappedCores: async () => ({ views, systems: [] }),
    emit() {}
  }
}

function noop() {}
