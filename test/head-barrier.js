// Targeted tests for the headBarrier option (index.js#_checkHeadBarrier):
// hold the drain until every known writer's hinted data is locally
// present, so bulk catch-up applies once over complete knowledge instead
// of churning undos on partial knowledge.
const test = require('brittle')
const Corestore = require('corestore')
const { Transform } = require('streamx')

const Autobee = require('../index.js')
const { apply, replicate, sync, encode, same, encryptionKey } = require('./helpers')

async function create(t, key, opts) {
  const storage = await t.tmp()
  const store = new Corestore(storage, { manifestVersion: 2 })
  const auto = new Autobee(store, key, {
    apply,
    bootstrapWeight: 3,
    ackThreshold: Infinity,
    // keep --encrypt-all coverage: the suite-wide key the helpers use
    encryptionKey,
    encrypted: !!encryptionKey,
    ...opts
  })
  t.teardown(() => auto.close())
  await auto.ready()
  return auto
}

// throttle by BYTES, not chunks: one stream chunk can carry an entire
// core's blocks, so a per-chunk delay leaves throughput unbounded and the
// transfer can complete in a handful of chunks on a fast machine. Slicing
// into MTU-sized pieces, one per tick, bounds the rate by this timer -
// opening a real window between "announced the head" (handshake, a few
// slices) and "has the data" (many slices) on any hardware
function delay(ms, mtu = 512) {
  return new Transform({
    transform(data, cb) {
      let i = 0
      const tick = () => {
        if (this.destroyed) return
        this.push(data.subarray(i, i + mtu))
        i += mtu
        if (i < data.byteLength) setTimeout(tick, ms)
        else cb(null)
      }
      setTimeout(tick, ms)
    }
  })
}

function replicateThrottled(joiner, room, delayMs) {
  const teardowns = []

  for (const member of room) {
    const s1 = joiner.replicate(true)
    const s2 = member.replicate(false)
    const d1 = delay(delayMs)
    const d2 = delay(delayMs)

    s1.pipe(d1).pipe(s2)
    s2.pipe(d2).pipe(s1)

    // teardown destroys the pipelines mid-flight by design
    for (const s of [s1, s2, d1, d2]) s.on('error', () => {})

    teardowns.push(async () => {
      s1.destroy()
      s2.destroy()
      await Promise.all([
        new Promise((resolve) => s1.once('close', resolve)),
        new Promise((resolve) => s2.once('close', resolve))
      ])
    })
  }

  return async () => {
    for (const teardown of teardowns) await teardown()
  }
}

// genesis + 3 writers with distinct weights, appends made while
// disconnected so every writer's segment is concurrent with the others' -
// the ordering-hostile backlog shape bulk catch-up faces
async function buildRoom(t) {
  const genesis = await create(t, null, {})
  await genesis.append(encode({ msg: 'genesis' }))

  const room = [genesis]
  for (let i = 0; i < 3; i++) {
    room.push(await create(t, genesis.key, {}))
    await genesis.append(encode({ addWriter: room[i + 1].local.id, weight: 1 + i }))
  }

  const done0 = replicate(...room)
  await sync(...room)
  await done0()

  let seq = 0
  for (let i = 0; i < 60; i++) {
    seq++
    await room[i % room.length].append(encode({ msg: `m${seq}` }))
  }

  const done1 = replicate(...room)
  await sync(...room)
  await done1()

  return room
}

async function runJoiner(t, room, opts, { latency = 0 } = {}) {
  const joiner = await create(t, room[0].key, { fastForward: false, ...opts })

  for (const member of room) {
    joiner.hintWakeup({ key: member.local.key, length: member.local.length })
  }
  await joiner.update()

  joiner.stats.undos = 0
  joiner.stats.applies = 0

  const done = latency > 0 ? replicateThrottled(joiner, room, latency) : replicate(joiner, ...room)
  await sync(joiner, ...room)
  await done()

  return joiner
}

test('head barrier - bulk catch-up converges to the same state, without undos', async function (t) {
  t.timeout(120000)

  const room = await buildRoom(t)

  const baseline = await runJoiner(t, room, {}, { latency: 2 })
  const barriered = await runJoiner(t, room, { headBarrier: true }, { latency: 2 })

  const expected = (await baseline.replay()).map((n) => ({ value: n.value, weight: n.weight }))
  const actual = (await barriered.replay()).map((n) => ({ value: n.value, weight: n.weight }))

  t.alike(actual, expected, 'same order and pinned weights as the eager path')
  // the scenario must actually produce reorder pressure, or the comparison
  // is vacuous
  t.ok(baseline.stats.undos > 0, 'the eager path undid at least once')
  t.is(barriered.stats.undos, 0, 'applied the whole backlog without a single undo')
  t.ok(barriered.stats.applies <= baseline.stats.applies, 'never more apply() calls than eager')
})

test('head barrier - a hint beyond the announced length never gates the drain', async function (t) {
  t.timeout(120000)

  const room = await buildRoom(t)

  // an absurd, unsuppliable hint. the gate is capped at the signed
  // announced tree length, so this must not stall - the huge stall
  // timeout turns a broken cap into a hang instead of a silent pass
  const joiner = await create(t, room[0].key, {
    headBarrier: true,
    headBarrierStallMs: 600000,
    fastForward: false
  })

  for (const member of room) {
    joiner.hintWakeup({ key: member.local.key, length: 1000000 })
  }
  await joiner.update()

  const done = replicate(joiner, ...room)
  await sync(joiner, ...room)
  await done()

  const reference = await room[0].replay()
  t.is((await joiner.replay()).length, reference.length, 'fully caught up')
})

// passes bytes through until the budget is spent, then swallows forever
// while keeping the stream OPEN - a peer that announced data and then
// withholds it, byte-deterministically (no clocks, no cut races)
function budgetValve(limit) {
  let used = 0
  return new Transform({
    transform(data, cb) {
      if (used >= limit) return cb(null)
      used += data.byteLength
      cb(null, data)
    }
  })
}

test('head barrier - stall fallback applies without the missing data', async function (t) {
  t.timeout(120000)

  const room = await buildRoom(t)

  // one member extends its core while disconnected: a tail only it can
  // supply, far bigger than the byte budget below can carry
  const holdout = room[1]
  const tail = []
  for (let i = 0; i < 200; i++) tail.push(encode({ msg: `tail${i}` }))
  await holdout.append(tail)

  const joiner = await create(t, room[0].key, {
    headBarrier: true,
    headBarrierStallMs: 300,
    fastForward: false
  })

  for (const member of room) {
    joiner.hintWakeup({ key: member.local.key, length: member.local.length })
  }
  await joiner.update()

  // the settled room arrives whole through genesis (it holds every core);
  // the holdout connection passes its handshake and length announcement
  // but can never fit the 200-block tail - the barrier is now holding for
  // blocks that will not arrive, with everything else locally present
  const done0 = replicate(joiner, room[0])

  const s1 = joiner.replicate(true)
  const s2 = holdout.replicate(false)
  const valve = budgetValve(6 * 1024)
  s1.pipe(s2)
  s2.pipe(valve).pipe(s1)
  for (const s of [s1, s2, valve]) s.on('error', () => {})
  t.teardown(() => {
    s1.destroy()
    s2.destroy()
  })

  // the announcement must make it through the budget, or nothing gates
  const holdoutCore = joiner.store.get({ key: holdout.local.key })
  await holdoutCore.ready()
  t.teardown(() => holdoutCore.close())
  while (holdoutCore.length < holdout.local.length) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  // the stall (300ms) must release the drain and the release must LATCH:
  // everything locally available - the entire settled room - applies
  // eagerly, not one batch per stall interval
  await new Promise((resolve) => setTimeout(resolve, 800))
  await joiner.update()

  const info = await joiner.system.get(room[0].local.key)
  t.ok(
    info !== null && info.length === room[0].local.length,
    `applied the whole settled room despite the unmet tail hint (got ${info ? info.length : 0}/${room[0].local.length})`
  )

  // byte-deterministic non-vacuity: the announced tail cannot have fit
  t.ok(holdoutCore.contiguousLength < holdout.local.length, 'the tail was genuinely withheld')

  await done0()

  // and recovers to full convergence once the data source returns
  const done1 = replicate(joiner, holdout)
  await sync(joiner, holdout)
  await done1()

  t.ok(await same(joiner, holdout), 'fully caught up after the holdout returns')
})

test('head barrier - coexists with fast-forward on a sparse core', async function (t) {
  t.timeout(120000)

  const source = await create(t, null, {
    mostRecentTrusted: () => ({ key: source.local.key, length: source.local.length })
  })
  for (let i = 0; i < 200; i++) await source.append(encode({ msg: `a${i}` }))

  // the FF leaves the joiner's copy of the source core sparse below the FF
  // point - those blocks never download, and a barrier gating on the whole
  // prefix (rather than the applied range) would deadlock here forever
  const joiner = await create(t, source.key, { isTrusted: () => true, headBarrier: true })
  t.teardown(replicate(source, joiner))

  await new Promise((resolve) => joiner.once('move-to', resolve))
  await sync(source, joiner)

  t.ok(joiner.stats.fastForwards >= 1, 'fast-forwarded over the backlog')

  // post-FF tail catch-up runs through the barrier over the sparse core
  for (let i = 0; i < 20; i++) await source.append(encode({ msg: `b${i}` }))
  await sync(source, joiner)

  t.ok(await same(source, joiner), 'converged through the barrier after the fast-forward')
})
