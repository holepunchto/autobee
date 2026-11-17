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

// per-chunk latency on the joiner's streams opens a real window between
// "announced the head" and "has the data" - locally both arrive at once
function delay(ms) {
  return new Transform({
    transform(data, cb) {
      setTimeout(() => cb(null, data), ms)
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

test('head barrier - stall fallback applies without the missing data', async function (t) {
  t.timeout(120000)

  const room = await buildRoom(t)

  const joiner = await create(t, room[0].key, {
    headBarrier: true,
    headBarrierStallMs: 300,
    fastForward: false
  })

  for (const member of room) {
    joiner.hintWakeup({ key: member.local.key, length: member.local.length })
  }
  await joiner.update()

  // cut the connection mid-transfer - genesis's first 4 blocks (its own
  // message plus 3 grants, no cross-writer deps) have landed: lengths are
  // announced on handshake, so the barrier is now holding for blocks that
  // never arrive
  const genesisCore = joiner.store.get({ key: room[0].local.key })
  await genesisCore.ready()
  t.teardown(() => genesisCore.close())

  const done = replicateThrottled(joiner, room, 20)
  while (genesisCore.contiguousLength < 4) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  await done()

  // the transfer must have been cut genuinely short SOMEWHERE - the
  // barrier gates on any missing writer - or the rest of the test is
  // vacuous
  let partial = false
  for (const member of room) {
    const core = joiner.store.get({ key: member.local.key })
    await core.ready()
    if (core.contiguousLength < member.local.length) partial = true
    await core.close()
  }
  t.ok(partial, 'cut mid-transfer')

  // the stall (300ms) must release the drain and the release must LATCH:
  // everything locally available applies eagerly, not one batch per stall
  // interval - 4 dep-free genesis batches within ~2.5x the stall window
  await new Promise((resolve) => setTimeout(resolve, 800))
  await joiner.update()

  const info = await joiner.system.get(room[0].local.key)
  t.ok(
    info !== null && info.length >= 4,
    `applied all available data despite unmet hints (got ${info ? info.length : 0})`
  )

  // and recovers to full convergence once the data source returns
  const done1 = replicate(joiner, ...room)
  await sync(joiner, ...room)
  await done1()

  const reference = await room[0].replay()
  t.is((await joiner.replay()).length, reference.length, 'fully caught up after reconnect')
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
