const test = require('brittle')
const Corestore = require('corestore')
const fs = require('fs/promises')

const Autobee = require('../index.js')
const FastForward = require('../lib/fast-forward.js')
const { MAPPED_AUTOBEE_VERSION } = require('../lib/constants.js')
const { Remapper } = require('../lib/remap.js')
const { apply, encode, recoveryPeers, same } = require('./helpers/index.js')

// a room from the release before the remap: in sync, on v2 cores

function open(t, dir, key, { previous = false, ...opts } = {}) {
  const store = new Corestore(dir, { manifestVersion: 2, allowBackup: true })
  const auto = new Autobee(store, key, {
    apply,
    ackThreshold: Infinity,
    bootstrapWeight: 3,
    remapSettle: 100,
    ...opts
  })

  if (previous) auto._startRemap = noop

  t.teardown(async () => {
    await auto.close()
    await store.close()
  })

  return { auto, store }
}

// unlike the helpers, only a recovery peer counts as one
function connect(t, a, b, { recovery = false } = {}) {
  const s1 = a.replicate(true)
  const s2 = b.replicate(false)
  s1.pipe(s2).pipe(s1)
  if (recovery) recoveryPeers(s2)
  const leave = () => {
    s1.destroy()
    s2.destroy()
  }
  t.teardown(leave)
  return leave
}

async function settled(autos) {
  for (let i = 0; i < 100; i++) {
    let ok = true
    for (const a of autos) {
      await a.update()
      for (const b of autos) {
        if (a === b) continue
        const info = await b.system.get(a.local.key)
        if (!info || info.length !== a.local.length) ok = false
      }
    }
    if (ok) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('room did not settle')
}

async function landed(autos, { ticks = 200 } = {}) {
  return until(autos, () => autos.every((a) => a.system.version >= MAPPED_AUTOBEE_VERSION), {
    ticks
  })
}

async function until(autos, cond, { ticks = 200 } = {}) {
  for (let i = 0; i < ticks; i++) {
    for (const a of autos) await a.update()
    if (cond()) {
      // the version moves first, the landing that moved it may still be applying
      for (const a of autos) await a.updated()
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

// a copy of a store, serving as its recovery peer, less the cores it is without
async function mirror(t, dir, { without = [] } = {}) {
  const copy = await t.tmp()
  await fs.cp(dir, copy, { recursive: true })
  const blind = new Corestore(copy, { manifestVersion: 2, allowBackup: true })
  await blind.ready()
  t.teardown(() => blind.close())

  for (const key of without) {
    const core = blind.get({ key, active: false })
    await core.ready()
    await core.clear(0, core.length)
    await core.close()
  }

  return blind
}

// the writers post rounds, everyone else keeps up
async function rounds(writers, n, readers = []) {
  for (let i = 0; i < n; i++) {
    for (const w of writers) await w.append(encode({ round: i }))
    await settled(writers)
  }
  for (const r of readers) {
    const ok = await until([r, writers[0]], () => r.system.flushes === writers[0].system.flushes)
    if (!ok) throw new Error('reader did not keep up')
  }
}

async function seed(t) {
  const dirs = { a: await t.tmp(), b: await t.tmp(), c: await t.tmp() }

  const a = open(t, dirs.a, null, { previous: true })
  await a.auto.ready()
  const b = open(t, dirs.b, a.auto.key, { previous: true })
  const c = open(t, dirs.c, a.auto.key, { previous: true })
  await b.auto.ready()
  await c.auto.ready()

  const streams = []
  for (const [x, y] of [
    [a, b],
    [a, c],
    [b, c]
  ]) {
    const s1 = x.store.replicate(true)
    const s2 = y.store.replicate(false)
    s1.pipe(s2).pipe(s1)
    streams.push(s1, s2)
  }

  await a.auto.append(encode({ addWriter: b.auto.local.id, weight: 1 }))
  await a.auto.append(encode({ addWriter: c.auto.local.id, weight: 1 }))
  await settled([a.auto, b.auto, c.auto])

  for (let i = 0; i < 20; i++) {
    await a.auto.append(encode({ i }))
    await b.auto.append(encode({ i }))
    await c.auto.append(encode({ i }))
  }
  await settled([a.auto, b.auto, c.auto])

  for (const p of [a, b, c]) t.is(p.auto.system.version, MAPPED_AUTOBEE_VERSION - 1)

  // only the oplogs are v2 here: the view and system cores are current ones,
  // so a remap in this room copies nothing and claims on its own
  t.alike(await a.auto._unmappedCores(), { views: [], systems: [] }, 'nothing to copy')

  for (const s of streams) s.destroy()
  for (const p of [a, b, c]) {
    await p.auto.close()
    await p.store.close()
  }

  return { dirs, key: a.auto.key }
}

async function room(t) {
  const { dirs } = await seed(t)

  // only a gets a recovery peer
  const blind = await mirror(t, dirs.a)

  const a = open(t, dirs.a, null)
  await a.auto.ready()
  const b = open(t, dirs.b, a.auto.key)
  const c = open(t, dirs.c, a.auto.key)
  await b.auto.ready()
  await c.auto.ready()

  connect(t, b.store, c.store)
  connect(t, a.store, blind, { recovery: true })

  const join = () => {
    const leaves = [connect(t, a.store, b.store), connect(t, a.store, c.store)]
    return () => leaves.forEach((leave) => leave())
  }

  return { a: a.auto, b: b.auto, c: c.auto, join, blind }
}

// b and c write while a is away remapping, so they run ahead of its claim
async function ahead(t, { a, b, c, join }, rounds) {
  t.ok(await landed([a]), 'a remapped on its own')
  const before = b.system.flushes

  for (let i = 0; i < rounds; i++) {
    await b.append(encode({ busy: i }))
    await c.append(encode({ busy: i }))
    await settled([b, c])
  }

  join()
  return b.system.flushes - before
}

test('remap landing - peers in lock step land on the writer that remapped', async function (t) {
  const { a, b, c, join } = await room(t)
  join()

  t.ok(await landed([a, b, c]), 'every peer is on the remapped generation')

  t.ok(a.remapped)
  t.is(a.stats.fastForwards, 0, 'the writer remapped itself')

  for (const peer of [b, c]) {
    t.is(peer.system.version, MAPPED_AUTOBEE_VERSION)
    t.ok(peer.remapped, 'counts as remapped')
    t.is(peer.stats.fastForwards, 1, 'landed on the writer')
    t.absent(peer._remapper, 'and gave up remapping itself')
  }

  await settled([a, b, c])
  t.ok(await same(a, b, c), 'the views agree')
})

test('remap landing - a room a little ahead of the claim lands on it', async function (t) {
  const peers = await room(t)
  const { a, b, c } = peers

  const flushes = await ahead(t, peers, 4)
  t.ok(flushes > 0 && flushes <= FastForward.MIN_GAP, 'ahead of the claim, within the slack')

  t.ok(await landed([a, b, c]), 'every peer is on the remapped generation')

  for (const peer of [b, c]) {
    t.is(peer.system.version, MAPPED_AUTOBEE_VERSION)
    t.is(peer.stats.fastForwards, 1, 'landed on the writer')
  }

  await settled([a, b, c])
  t.ok(await same(a, b, c), 'nothing was lost')
})

test('remap landing - a room far ahead of the claim stays where it is', async function (t) {
  const peers = await room(t)
  const { a, b, c } = peers

  const flushes = await ahead(t, peers, 20)
  t.ok(flushes > FastForward.MIN_GAP, 'ahead of the claim by more than the slack')

  t.absent(await landed([a, b, c], { ticks: 40 }), 'the claim is too old to land on')

  t.is(a.system.version, MAPPED_AUTOBEE_VERSION)
  t.is(a.stats.fastForwards, 0, 'and the writer that remapped never goes back')

  for (const peer of [b, c]) {
    t.is(peer.system.version, MAPPED_AUTOBEE_VERSION - 1)
    t.is(peer.stats.fastForwards, 0)
  }

  await settled([a, b, c])
  t.ok(await same(a, b, c), 'and keeps up')
  t.is(a.stats.fastForwards, 0, 'still without going back')

  // the writer's next write claims again, at the current flushes
  await a.append(encode({ claim: 'again' }))
  t.ok(await landed([a, b, c]), 'and the room lands on that')
  t.is(a.stats.fastForwards, 0)
  for (const peer of [b, c]) t.is(peer.stats.fastForwards, 1, 'landed on the writer')
  await settled([a, b, c])
  t.ok(await same(a, b, c), 'the views agree')
})

test('remap landing - phase one reports its progress', async function (t) {
  const { a } = await room(t)

  await a.update()
  const remapper = a._remapper
  t.ok(remapper, 'the remap started')

  t.alike(
    [
      remapper.recovered,
      remapper.walked,
      remapper.downloaded,
      remapper.committing,
      remapper.finished
    ],
    [false, false, false, false, false],
    'waiting at the gate'
  )

  const seen = []
  const walk = remapper._walk.bind(remapper)
  remapper._walk = async () => {
    await walk()
    seen.push('walk ' + remapper.recovered + ' ' + remapper.walked)
  }

  const commit = remapper._commit.bind(remapper)
  remapper._commit = () => {
    seen.push('commit ' + remapper.downloaded + ' ' + remapper.committing)
    return commit()
  }

  t.ok(await landed([a]), 'a remapped on its own')

  t.alike(seen, ['walk true false', 'commit true true'], 'the stages ran in order')
  t.ok(remapper.recovered && remapper.walked && remapper.downloaded, 'phase one is complete')
  t.ok(remapper.committing && remapper.finished, 'and so is phase two')
  t.absent(a._remapper, 'the remap was picked up')
})

test('remap landing - an old head lands during phase one and restarts it', async function (t) {
  const { dirs, key } = await seed(t)

  // b remaps but has no recovery peer, so phase one waits at the gate
  const b = open(t, dirs.b, key)
  await b.auto.ready()
  await b.auto.update()

  const remapper = b.auto._remapper
  t.ok(remapper, 'the remap started')
  t.absent(remapper.recovered, 'and waits at the gate')

  // meanwhile a runs far ahead on the old generation
  let a = open(t, dirs.a, null, { previous: true })
  await a.auto.ready()
  for (let i = 0; i < 20; i++) await a.auto.append(encode({ busy: i }))
  await a.auto.update()
  t.ok(a.auto.system.flushes - b.auto.system.flushes > FastForward.MIN_GAP, 'far ahead')
  await a.auto.close()
  await a.store.close()

  const blind = await mirror(t, dirs.a)

  a = open(t, dirs.a, null, { previous: true })
  await a.auto.ready()
  connect(t, a.store, b.store)

  t.ok(
    await until([a.auto, b.auto], () => b.auto.stats.fastForwards > 0),
    'b landed on the old head'
  )
  t.is(b.auto.system.version, MAPPED_AUTOBEE_VERSION - 1)
  t.is(b.auto.system.flushes, a.auto.system.flushes)
  t.is(b.auto._remapper, remapper, 'the remap is the same one')
  t.absent(remapper.destroyed)
  t.absent(remapper.cancelled, 'and was restarted')
  t.absent(b.auto._remapFailed)

  // a recovery peer turns up: phase one runs from the head it landed on
  connect(t, b.store, blind, { recovery: true })

  t.ok(await landed([a.auto, b.auto]), 'b remapped on its own')
  t.is(b.auto.stats.fastForwards, 1)
  t.ok(b.auto.remapped)
  t.absent(b.auto._remapper)
  t.ok(remapper.finished)

  await settled([a.auto, b.auto])
  t.ok(await same(a.auto, b.auto), 'the views agree')
})

test('remap landing - an old head does not land during phase two', async function (t) {
  const peers = await room(t)
  const { a, b, c, join } = peers

  await a.update()
  const remapper = a._remapper
  t.ok(remapper, 'the remap started')

  // hold the commit open
  let release = null
  const held = new Promise((resolve) => {
    release = resolve
  })
  const commit = remapper._commit.bind(remapper)
  remapper._commit = async () => {
    await held
    return commit()
  }

  t.ok(await until([a], () => remapper.committing), 'phase two started')
  t.ok(a.committing)
  t.is(a.system.version, MAPPED_AUTOBEE_VERSION - 1)

  // b and c run far ahead on the old generation meanwhile
  for (let i = 0; i < 20; i++) {
    await b.append(encode({ busy: i }))
    await c.append(encode({ busy: i }))
    await settled([b, c])
  }
  t.ok(b.system.flushes - a.system.flushes > FastForward.MIN_GAP, 'far ahead')

  join()

  t.absent(await until([a, b, c], () => a.stats.fastForwards > 0, { ticks: 40 }), 'a stays put')
  t.ok(remapper.committing, 'the commit was not cancelled')

  release()

  // a caught up on the old generation meanwhile, so its claim is current
  t.ok(await landed([a, b, c]), 'every peer is on the remapped generation')
  t.is(a.stats.fastForwards, 0, 'a never went back')
  for (const peer of [b, c]) t.is(peer.stats.fastForwards, 1, 'landed on the writer')

  await settled([a, b, c])
  t.ok(await same(a, b, c), 'the views agree')
})

test('remap landing - a forced move during phase two replaces the remap', async function (t) {
  const peers = await room(t)
  const { a, b, c, join } = peers

  await a.update()
  const remapper = a._remapper
  t.ok(remapper, 'the remap started')

  let release = null
  const held = new Promise((resolve) => {
    release = resolve
  })
  const commit = remapper._commit.bind(remapper)
  remapper._commit = async () => {
    await held
    return commit()
  }

  t.ok(await until([a], () => remapper.committing), 'phase two started')

  for (let i = 0; i < 20; i++) {
    await b.append(encode({ busy: i }))
    await c.append(encode({ busy: i }))
    await settled([b, c])
  }

  join()
  t.ok(await until([a, b, c], () => a.system.flushes === b.system.flushes), 'a caught up')

  // an explicit move onto the old head goes through regardless
  const old = { key: b.local.key, length: b.local.length }
  t.ok(await a.moveTo(old), 'moved')

  t.ok(remapper.destroyed, 'the committing remap was destroyed')
  t.not(a._remapper, remapper, 'and replaced')
  t.ok(a._remapper, 'by a new one')
  t.absent(a.remapped)

  release()
  await a.update()
  t.absent(a._remapFailed, 'the destroyed commit is not a failure')

  t.ok(await landed([a, b, c]), 'every peer is on the remapped generation')
  t.ok(await same(a, b, c), 'the views agree')
})

// failure modes of the remap, and that the room runs on through all of them.
// the room's cores are current ones, so a stalled stage is simulated: it
// hangs like a read nobody serves and fails like one once it is cancelled

function hold(remapper, stage) {
  const real = remapper[stage].bind(remapper)
  let release = null
  const held = new Promise((resolve) => {
    release = resolve
  })
  remapper[stage] = async (...args) => {
    await held
    return real(...args)
  }
  return release
}

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

test('remap scenarios - no recovery peer: the room runs on the old generation', async function (t) {
  const { dirs, key } = await seed(t)

  const a = open(t, dirs.a, null)
  await a.auto.ready()
  const b = open(t, dirs.b, key)
  const c = open(t, dirs.c, key)
  await b.auto.ready()
  await c.auto.ready()

  const admins = [a.auto, b.auto, c.auto]
  connect(t, a.store, b.store)
  connect(t, a.store, c.store)
  connect(t, b.store, c.store)

  // a user joins by fast-forwarding onto the old head
  const d = open(t, await t.tmp(), key, { fastForward: { boot: { head: headOf(a.auto) } } })
  connect(t, d.store, a.store)
  await d.auto.ready()
  t.ok(await until([...admins, d.auto], () => d.auto.stats.fastForwards > 0), 'the user landed')
  t.is(d.auto.system.version, MAPPED_AUTOBEE_VERSION - 1)

  // the admins write and the user keeps up
  await rounds(admins, 10, [d.auto])
  t.ok(await same(...admins, d.auto), 'the views agree')

  for (const x of admins) {
    t.is(x.system.version, MAPPED_AUTOBEE_VERSION - 1)
    t.ok(x._remapper && !x._remapper.recovered, 'the remap waits for a recovery peer')
    t.absent(x._remapFailed)
  }

  // a user joining later still fast-forwards onto the old head
  const e = open(t, await t.tmp(), key, { fastForward: { boot: { head: headOf(a.auto) } } })
  connect(t, e.store, a.store)
  await e.auto.ready()
  t.ok(await until([...admins, e.auto], () => e.auto.stats.fastForwards > 0), 'a late user landed')
  t.is(e.auto.system.version, MAPPED_AUTOBEE_VERSION - 1)
  await rounds(admins, 1, [e.auto])
  t.ok(await same(...admins, e.auto), 'and keeps up')
})

for (const stage of ['_walk', '_download']) {
  test(`remap scenarios - a stalled ${stage.slice(1)}: the room runs on, a landing retries it`, async function (t) {
    const { a, b, c, join } = await room(t)

    await a.update()
    const remapper = a._remapper
    stall(remapper, stage)

    const leave = join()
    t.ok(await until([a, b, c], () => remapper.recovered), 'the remap passed the gate')
    await rounds([a, b, c], 5)
    t.ok(await same(a, b, c), 'the views agree')

    for (const peer of [a, b, c]) t.is(peer.system.version, MAPPED_AUTOBEE_VERSION - 1)
    t.is(a._remapper, remapper, 'the remap is still the same one')
    t.absent(remapper.downloaded, 'and still stalled')
    t.absent(a._remapFailed)

    // the others run far ahead: a lands on them and the remap retries from there
    leave()
    await rounds([b, c], 20)
    t.ok(b.system.flushes - a.system.flushes > FastForward.MIN_GAP, 'far ahead')
    join()

    t.ok(await until([a, b, c], () => a.stats.fastForwards > 0), 'a landed on the old head')
    t.absent(remapper.destroyed, 'the remap was restarted, not replaced')
    t.absent(a._remapFailed, 'the cancelled stage is not a failure')

    t.ok(await landed([a, b, c]), 'every peer is on the remapped generation')
    t.ok(remapper.finished && remapper.mappings !== null, 'by the same remap finishing')
    t.ok(a.remapped)
    t.is(a.stats.fastForwards, 1)
    for (const peer of [b, c]) t.is(peer.stats.fastForwards, 1, 'landed on the writer')
    t.ok(await same(a, b, c), 'the views agree')
  })
}

test('remap scenarios - a zero length core fails the remap until the next landing', async function (t) {
  const { a, b, c, join, blind } = await room(t)

  const empty = blind.get({ name: 'empty' })
  await empty.ready()
  t.is(empty.length, 0)

  await a.update()
  const remapper = a._remapper
  const walk = remapper._walk.bind(remapper)
  remapper._walk = async () => {
    await walk()
    remapper.cores.push({ key: empty.key, encryption: null, system: false })
  }

  const warnings = []
  a.on('warning', (err) => warnings.push(err.message))

  // the recovery peer takes a retry to notice each new core
  t.ok(await until([a], () => a._remapFailed, { ticks: 600 }), 'the remap failed')
  t.ok(remapper.finished)
  t.ok(/Remap core incomplete/.test(warnings[0]), 'and said why')
  t.is(a.system.version, MAPPED_AUTOBEE_VERSION - 1)
  t.absent(a.remapped)

  // the room runs on
  const leave = join()
  await rounds([a, b, c], 5)
  t.ok(await same(a, b, c), 'the views agree')
  t.is(a._remapper, remapper, 'nothing retried by itself')

  // a landing gives it another go, this time it succeeds
  leave()
  await rounds([b, c], 20)
  t.ok(b.system.flushes - a.system.flushes > FastForward.MIN_GAP, 'far ahead')
  join()

  t.ok(await until([a, b, c], () => a.stats.fastForwards > 0), 'a landed on the old head')
  t.absent(a._remapFailed, 'the failure is forgotten')
  t.not(a._remapper, remapper, 'a new remap started')

  t.ok(await landed([a, b, c]), 'every peer is on the remapped generation')
  t.ok(a.remapped)
  t.is(a.stats.fastForwards, 1)
  for (const peer of [b, c]) t.is(peer.stats.fastForwards, 1, 'landed on the writer')
  t.ok(await same(a, b, c), 'the views agree')
})

test('remap scenarios - the claim wins over old heads posted meanwhile', async function (t) {
  const { a, b, c, join } = await room(t)

  await a.update()
  const remapper = a._remapper
  const release = hold(remapper, '_walk')
  join()
  t.ok(await until([a, b, c], () => remapper.recovered), 'the remap passed the gate')

  // the other admins keep posting on the old generation while a remaps
  let posted = 0
  while (!a.remapped && posted < 100) {
    await b.append(encode({ posted }))
    await c.append(encode({ posted }))
    if (++posted === 5) release()
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  t.ok(posted >= 5 && a.remapped, 'heads were posted during the remap')

  t.ok(await landed([a, b, c]), 'every peer is on the remapped generation')
  t.is(a.stats.fastForwards, 0)
  for (const peer of [b, c]) t.is(peer.stats.fastForwards, 1, 'the old heads lost to the claim')

  // and they carry on posting, now on the new generation
  await rounds([a, b, c], 5)
  for (const peer of [a, b, c]) t.is(peer.system.version, MAPPED_AUTOBEE_VERSION)
  t.ok(await same(a, b, c), 'nothing was lost')
})

test('remap scenarios - a user that remapped itself lands on a later admin remap', async function (t) {
  const { dirs, key } = await seed(t)
  const blind = await mirror(t, dirs.a)

  // the user remaps first, on its own
  const b = open(t, dirs.b, key)
  await b.auto.ready()
  connect(t, b.store, blind, { recovery: true })
  t.ok(await landed([b.auto]), 'the user remapped itself')
  t.is(b.auto.stats.fastForwards, 0)

  // the admin remaps later and runs ahead on the new generation
  const a = open(t, dirs.a, null)
  await a.auto.ready()
  connect(t, a.store, blind, { recovery: true })
  t.ok(await landed([a.auto]), 'the admin remapped itself')
  for (let i = 0; i < 20; i++) await a.auto.append(encode({ i }))
  await a.auto.update()
  t.ok(a.auto.system.flushes - b.auto.system.flushes > FastForward.MIN_GAP, 'far ahead')

  connect(t, a.store, b.store)
  t.ok(await until([a.auto, b.auto], () => b.auto.stats.fastForwards > 0), 'the user landed on it')
  t.is(b.auto.system.version, MAPPED_AUTOBEE_VERSION)
  t.is(b.auto.system.flushes, a.auto.system.flushes)
  t.ok(await same(a.auto, b.auto), 'the views agree')

  // and one that never remapped lands on it too
  const c = open(t, dirs.c, key)
  await c.auto.ready()
  connect(t, c.store, a.store)
  t.ok(await landed([a.auto, c.auto]), 'the other user landed')
  t.is(c.auto.stats.fastForwards, 1)
  t.absent(c.auto._remapper, 'and gave up remapping itself')
  t.ok(await same(a.auto, b.auto, c.auto), 'the views agree')
})

test('remap scenarios - a landing accepted during a landing keeps the remap cancelled', async function (t) {
  const { a, b, c, join } = await room(t)

  await a.update()
  const remapper = a._remapper
  const release = hold(remapper, '_walk')

  const leave = join()
  t.ok(await until([a, b, c], () => remapper.recovered), 'the remap passed the gate')
  leave()
  await rounds([b, c], 20)
  const older = { key: b.local.key, length: b.local.length - 2 }
  join()

  // a second landing is accepted while the first one is still being applied
  const applyFastForward = a._applyFastForward.bind(a)
  const storeBoot = a._storeBoot.bind(a)
  let applying = false
  let second = null
  a._applyFastForward = async () => {
    applying = true
    try {
      return await applyFastForward()
    } finally {
      applying = false
    }
  }
  a._storeBoot = async () => {
    if (applying && second === null) {
      second = a.moveTo(older)
      for (let i = 0; i < 1000 && a.fastForwardTo === null; i++) {
        await new Promise((resolve) => setImmediate(resolve))
      }
    }
    return storeBoot()
  }

  const seen = []
  a.on('move-to', () =>
    seen.push([a.stats.fastForwards, remapper.cancelled, a.fastForwardTo !== null])
  )

  t.ok(await until([a, b, c], () => a.stats.fastForwards > 1), 'both landed')
  t.ok(second !== null && a.fastForwardTo === null)
  t.alike(seen[0], [1, true, true], 'the first landing left the remap cancelled for the second')
  t.alike(seen[1], [2, false, false], 'which restarted it')

  release()
  t.ok(await landed([a, b, c]), 'every peer is on the remapped generation')
  t.ok(remapper.finished && remapper.mappings !== null, 'by the same remap')
  t.ok(await same(a, b, c), 'the views agree')
})

test('remap scenarios - a remap that fails after being replaced does not fail the store', async function (t) {
  const { dirs, key } = await seed(t)
  const blind = await mirror(t, dirs.a)

  // the first remap breaks in its walk, but its failure only surfaces later
  let release = null
  const held = new Promise((resolve) => (release = resolve))
  const run = Remapper.prototype.run
  Remapper.prototype.run = function (opts) {
    Remapper.prototype.run = run
    this._walk = async () => {
      throw new Error('walk broke')
    }
    return run.call(this, opts).catch(async (err) => {
      await held
      throw err
    })
  }
  t.teardown(() => (Remapper.prototype.run = run))

  const a = open(t, dirs.a, null)
  connect(t, a.store, blind, { recovery: true })
  await a.auto.ready()
  await a.auto.update()
  const remapper = a.auto._remapper
  t.ok(await until([a.auto], () => remapper.finished), 'the first remap is over')
  t.absent(a.auto._remapFailed, 'but has not failed yet')
  t.is(a.auto.system.version, MAPPED_AUTOBEE_VERSION - 1)

  // the others run ahead, a lands on them and the finished remap is replaced
  const b = open(t, dirs.b, key, { previous: true })
  const c = open(t, dirs.c, key, { previous: true })
  await b.auto.ready()
  await c.auto.ready()
  connect(t, b.store, c.store)
  await rounds([b.auto, c.auto], 20)
  connect(t, a.store, b.store)
  connect(t, a.store, c.store)

  const autos = [a.auto, b.auto, c.auto]
  t.ok(await until(autos, () => a.auto.stats.fastForwards > 0), 'a landed on the old head')
  t.ok(a.auto._remapper !== null && a.auto._remapper !== remapper, 'a new remap started')

  const warnings = []
  a.auto.on('warning', (err) => warnings.push(err.message))
  release()
  await new Promise((resolve) => setTimeout(resolve, 50))
  t.absent(a.auto._remapFailed, 'the late failure is not the new remap failing')
  t.alike(warnings, [], 'and is not warned about')

  t.ok(await landed(autos), 'every peer is on the remapped generation')
  t.ok(a.auto.remapped)
  t.ok(await same(...autos), 'the views agree')
})

test('remap scenarios - a commit that fails resets the store', async function (t) {
  const { a, b, c, join } = await room(t)

  await a.update()
  const remapper = a._remapper
  remapper._commit = async () => {
    throw new Error('commit broke')
  }

  const warnings = []
  a.on('warning', (err) => warnings.push(err.message))

  t.ok(await until([a], () => a._remapFailed), 'the remap failed')
  t.ok(remapper.finished)
  t.absent(remapper.committing, 'and is no longer committing')
  t.absent(a.committing, 'so neither is the store')
  t.alike(warnings, ['commit broke'])
  t.is(a.system.version, MAPPED_AUTOBEE_VERSION - 1)
  t.absent(a.remapped)

  // the room runs on, nothing retries by itself
  const leave = join()
  await rounds([a, b, c], 5)
  t.ok(await same(a, b, c), 'the views agree')
  t.is(a._remapper, remapper, 'nothing retried by itself')

  // a landing gives it another go
  leave()
  await rounds([b, c], 20)
  t.ok(b.system.flushes - a.system.flushes > FastForward.MIN_GAP, 'far ahead')
  join()

  t.ok(await until([a, b, c], () => a.stats.fastForwards > 0), 'a landed on the old head')
  t.absent(a._remapFailed, 'the failure is forgotten')
  t.not(a._remapper, remapper, 'a new remap started')
  t.ok(await landed([a, b, c]), 'every peer is on the remapped generation')
  t.ok(await same(a, b, c), 'the views agree')
})

test('remap scenarios - old heads within the gap are not landed on', async function (t) {
  const { a, b, c, join } = await room(t)

  await a.update()
  const remapper = a._remapper
  const release = hold(remapper, '_walk')
  join()
  t.ok(await until([a, b, c], () => remapper.recovered), 'the remap passed the gate')

  // the others post while a keeps up by applying: no head is far enough ahead
  for (let i = 0; i < 20; i++) {
    await b.append(encode({ i }))
    await c.append(encode({ i }))
    await settled([a, b, c])
  }
  t.is(a.stats.fastForwards, 0, 'a never landed')
  t.is(remapper.epoch, 0, 'and the remap was never cancelled')
  t.absent(remapper.cancelled)

  release()
  t.ok(await landed([a, b, c]), 'every peer is on the remapped generation')
  t.ok(await same(a, b, c), 'the views agree')
})

test('remap scenarios - old heads within the gap are refused before the warmup', async function (t) {
  const { dirs, key } = await seed(t)

  // no recovery peer: a stays on the old generation and keeps up by applying
  let warmups = 0
  const a = open(t, dirs.a, null, { warmup: async () => warmups++ })
  const b = open(t, dirs.b, key, { previous: true })
  const c = open(t, dirs.c, key, { previous: true })
  await a.auto.ready()
  await b.auto.ready()
  await c.auto.ready()
  connect(t, a.store, b.store)
  connect(t, a.store, c.store)
  connect(t, b.store, c.store)

  for (let i = 0; i < 10; i++) {
    await b.auto.append(encode({ i }))
    await c.auto.append(encode({ i }))
    await settled([a.auto, b.auto, c.auto])
  }

  t.is(a.auto.system.version, MAPPED_AUTOBEE_VERSION - 1)
  t.is(a.auto.stats.fastForwards, 0, 'a never landed')
  t.is(warmups, 0, 'nor warmed up a head it did not land on')
})

test('remap scenarios - a legacy boot pointer within the gap is still booted onto', async function (t) {
  const { dirs, key } = await seed(t)

  // a moves a few flushes ahead on the old generation
  let a = open(t, dirs.a, null, { previous: true })
  await a.auto.ready()
  for (let i = 0; i < 3; i++) await a.auto.append(encode({ i }))
  await a.auto.update()
  const system = a.auto.system.bee.head()
  const flushes = a.auto.system.flushes
  await a.auto.close()
  await a.store.close()

  const blind = await mirror(t, dirs.a)

  // b opens pointed straight at that system head, the legacy boot form
  const b = open(t, dirs.b, key, {
    fastForward: { boot: { key: system.key, length: system.length } }
  })
  connect(t, b.store, blind)
  await b.auto.ready()
  t.ok(flushes - b.auto.system.flushes < FastForward.MIN_GAP, 'within the gap')

  t.ok(await until([b.auto], () => b.auto.stats.fastForwards > 0), 'booted onto it anyway')
  t.is(b.auto.system.flushes, flushes)
  t.is(b.auto.system.version, MAPPED_AUTOBEE_VERSION - 1)
})

function headOf(auto) {
  return { key: auto.local.key, length: auto.local.length }
}

function noop() {}
