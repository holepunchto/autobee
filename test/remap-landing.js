const test = require('brittle')
const Corestore = require('corestore')
const fs = require('fs/promises')

const Autobee = require('../index.js')
const FastForward = require('../lib/fast-forward.js')
const { MAPPED_AUTOBEE_VERSION } = require('../lib/constants.js')
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
  t.teardown(() => {
    s1.destroy()
    s2.destroy()
  })
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

// a copy of a store, serving as its recovery peer
async function mirror(t, dir) {
  const copy = await t.tmp()
  await fs.cp(dir, copy, { recursive: true })
  const blind = new Corestore(copy, { manifestVersion: 2, allowBackup: true })
  await blind.ready()
  t.teardown(() => blind.close())
  return blind
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
    connect(t, a.store, b.store)
    connect(t, a.store, c.store)
  }

  return { a: a.auto, b: b.auto, c: c.auto, join }
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
  a.on('remap-walk', () => seen.push('walk ' + remapper.recovered + ' ' + remapper.walked))

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

function noop() {}
