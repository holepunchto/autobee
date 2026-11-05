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
  for (let i = 0; i < ticks; i++) {
    for (const a of autos) await a.update()
    if (autos.every((a) => a.system.version >= MAPPED_AUTOBEE_VERSION)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

async function room(t) {
  const dirs = { a: await t.tmp(), b: await t.tmp(), c: await t.tmp() }

  let a = open(t, dirs.a, null, { previous: true })
  await a.auto.ready()
  let b = open(t, dirs.b, a.auto.key, { previous: true })
  let c = open(t, dirs.c, a.auto.key, { previous: true })
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

  // only a gets a recovery peer
  dirs.blind = await t.tmp()
  await fs.cp(dirs.a, dirs.blind, { recursive: true })
  const blind = new Corestore(dirs.blind, { manifestVersion: 2, allowBackup: true })
  await blind.ready()
  t.teardown(() => blind.close())

  a = open(t, dirs.a, null)
  await a.auto.ready()
  b = open(t, dirs.b, a.auto.key)
  c = open(t, dirs.c, a.auto.key)
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

  for (const peer of [b, c]) {
    t.is(peer.system.version, MAPPED_AUTOBEE_VERSION - 1)
    t.is(peer.stats.fastForwards, 0)
  }

  await settled([a, b, c])
  t.ok(await same(a, b, c), 'and keeps up')
})

function noop() {}
