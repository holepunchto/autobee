const test = require('brittle')
const b4a = require('b4a')
const Corestore = require('corestore')

const FastForward = require('../lib/fast-forward.js')
const encoding = require('../lib/encoding.js')

const {
  create,
  replicate,
  replicateAndSync,
  same,
  sync,
  encode,
  decode,
  dump
} = require('./helpers')

// predates the moveTo removal
test.skip('fast-forward - simple', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  for (let i = 0; i < 1000; i++) {
    await auto1.append(encode({ value: 'a' + i }))
  }

  const to = auto1.system.bee.head()

  const ff = auto2.moveTo(to)

  t.teardown(replicate(auto1, auto2))

  await t.execution(ff)

  t.alike((await ff).to, to)
  t.alike(auto1.view.head(), auto2.view.head())
  t.ok(await same(auto1, auto2))

  const node = await auto2.view.get(b4a.from('latest'))

  t.alike(node.value, encode({ value: 'a999' }))
})

test('conservative ff skips a sparse head nobody can serve', async function (t) {
  const dir = await t.tmp()
  const auto1 = await create(t)

  for (let i = 0; i < 100; i++) {
    await auto1.append(encode({ value: 'a' + i }))
  }

  // a mirror holding only the head block never advertises the head whole
  const mirror = new Corestore(dir + '/mirror', { manifestVersion: 2 })
  t.teardown(() => mirror.close())

  const copy = mirror.get({ key: auto1.local.key })
  await copy.ready()

  const s1 = auto1.store.replicate(true)
  const s2 = mirror.replicate(false)
  s1.pipe(s2).pipe(s1)
  await copy.get(auto1.local.length - 1)
  s1.destroy()
  s2.destroy()

  const auto2 = await create(t, auto1.key, { isTrusted: () => true })

  const s3 = mirror.replicate(true)
  const s4 = auto2.store.replicate(false)
  s3.pipe(s4).pipe(s3)
  const oplog = auto2.openCore(auto1.local.key)
  await oplog.get(auto1.local.length - 1)
  s3.destroy()
  s4.destroy()
  await oplog.close()

  const head = { key: auto1.local.key, length: auto1.local.length }
  const ff = await FastForward.fromHead(auto2, head, null)

  t.absent(ff, 'the fast-forward was skipped')
})

test('conservative: false attempts the sparse head', async function (t) {
  const auto1 = await create(t)

  for (let i = 0; i < 100; i++) {
    await auto1.append(encode({ value: 'a' + i }))
  }

  const auto2 = await create(t, auto1.key, {
    isTrusted: () => true,
    fastForward: { conservative: false }
  })

  // fetch just the head block, then cut the transport
  const unreplicate = replicate(auto1, auto2)
  const oplog = auto2.openCore(auto1.local.key)
  await oplog.get(auto1.local.length - 1)
  await unreplicate()
  await oplog.close()

  const head = { key: auto1.local.key, length: auto1.local.length }
  const ff = await FastForward.fromHead(auto2, head, null)

  t.ok(ff, 'the ff was attempted instead of skipped')
  await ff.close()
})

test('conservative ff proceeds once a connected peer advertises the head whole', async function (t) {
  const auto1 = await create(t, {
    mostRecentTrusted: () => ({ key: auto1.local.key, length: auto1.local.length })
  })

  for (let i = 0; i < 1000; i++) {
    await auto1.append(encode({ value: 'a' + i }))
  }

  const auto2 = await create(t, auto1.key, { isTrusted: () => true })
  t.teardown(replicate(auto1, auto2))

  await new Promise((resolve) => auto2.once('move-to', resolve))
  t.pass('the fast-forward went through under the conservative default')

  // move-to fires before the tip is reapplied, so let the catch-up settle
  await sync(auto1, auto2)
})

test('ff onto a trusted head keeps the untrusted tip pending', async function (t) {
  let trusted = null
  let trustedCalls = 0

  const advertise = () => {
    trustedCalls++
    return trusted
  }

  const auto1 = await create(t, { mostRecentTrusted: advertise })
  const auto2 = await create(t, auto1.key, { mostRecentTrusted: advertise })

  // auto3 only ever accepts a head belonging to auto1
  const auto3 = await create(t, auto1.key, {
    isTrusted: (key) => b4a.equals(key, auto1.local.key)
  })

  await auto1.append(encode({ hello: 'world' }))
  await auto1.append(encode({ addWriter: auto2.local.id, weight: 1 }))

  await replicateAndSync(auto1, auto2, auto3)

  for (let i = 0; i < 100; i++) {
    await auto1.append(encode({ hello: 'world' + i }))
  }

  await replicateAndSync(auto1, auto2)

  // the only head auto3 trusts, captured before auto2 writes the tip
  trusted = { key: auto1.local.key, length: auto1.local.length }

  const TIP = 5
  for (let i = 0; i < TIP; i++) {
    await auto2.append(encode({ hello: 'tip' + i }))
  }

  const id = b4a.toString(auto2.local.key, 'hex')

  let flushesAtMove = -1
  let writerWasOpenAtMove = false
  let writerWasPendingAtMove = false

  const moved = new Promise((resolve, reject) => {
    const timer = setTimeout(reject, 10_000)
    auto3.once('move-to', () => {
      clearTimeout(timer)
      flushesAtMove = auto3.system.flushes
      // snapshot booleans here - the writer is only guaranteed to still be
      // pending at this exact instant, since the drain reapplies the tip
      // (and may gc the now-caught-up writer) as soon as this listener returns
      const writerAtMove = auto3.writers.active.get(id) || null
      writerWasOpenAtMove = !!writerAtMove
      writerWasPendingAtMove = !!writerAtMove && writerAtMove.isPending
      resolve()
    })
  })

  await replicateAndSync(auto1, auto2, auto3)

  try {
    await moved
    t.pass('auto3 fast-forwarded')
  } catch {
    t.fail('auto3 did not fast-forward')
    return
  }

  t.ok(trustedCalls > 0, 'the writers advertised a trusted head')

  t.ok(writerWasOpenAtMove, 'the woken writer was not closed by the fast-forward')
  t.ok(writerWasPendingAtMove, 'it still has the tip pending')

  // auto3 is sparse after the ff
  t.teardown(replicate(auto1, auto2, auto3))
  t.ok(await same(auto2, auto3), 'auto3 converged on the tip')

  t.ok(auto3.system.flushes > flushesAtMove, 'auto3 applied past the head it moved to')

  const info = await auto3.system.get(auto2.local.key)
  t.is(info.length, auto2.local.length, 'the woken writer was applied in full')

  const entry = await auto3.view.get(b4a.from('latest'))
  t.alike(decode(entry.value), { hello: 'tip' + (TIP - 1) }, 'the tip landed after the ff')
})

test('boot from a head ignores trust', async function (t) {
  const auto1 = await create(t)

  for (let i = 0; i < 40; i++) await auto1.append(encode({ value: 'a' + i }))

  const auto2 = await create(t, auto1.key, {
    isTrusted: () => false,
    fastForward: {
      boot: { head: { key: auto1.local.key, length: auto1.local.length } }
    }
  })

  t.teardown(replicate(auto1, auto2))

  await new Promise((resolve) => auto2.once('move-to', resolve))
  t.pass('booted onto the head we were handed')

  await replicateAndSync(auto1, auto2)
  t.ok(await same(auto1, auto2), 'converged')
})

test('boot from a stale head searches for the latest', async function (t) {
  const auto1 = await create(t)

  for (let i = 0; i < 40; i++) await auto1.append(encode({ value: 'a' + i }))

  const stale = { key: auto1.local.key, length: 4 }

  for (let i = 0; i < 40; i++) await auto1.append(encode({ value: 'b' + i }))

  const block = await auto1.local.get(auto1.local.length - 1)
  const { views } = encoding.decodeOplog(block)
  const latest = { key: views.system.key, length: views.system.start + views.system.length }

  const auto2 = await create(t, auto1.key, {
    isTrusted: () => false,
    fastForward: { boot: { head: stale } }
  })

  t.teardown(replicate(auto1, auto2))

  const to = await new Promise((resolve) => auto2.once('move-to', resolve))
  t.alike(to, latest, 'booted onto the latest oplog head, not the length we were handed')

  await replicateAndSync(auto1, auto2)
  t.ok(await same(auto1, auto2), 'converged')
})

test('boot from a head above the last flush', async function (t) {
  const auto1 = await create(t)
  for (let i = 0; i < 40; i++) await auto1.append(encode({ value: 'a' + i }))

  // a batch: only its last node carries views, so mid-batch is not a flush head
  await auto1.append([encode({ value: 'x' }), encode({ value: 'y' }), encode({ value: 'z' })])

  const mid = { key: auto1.local.key, length: auto1.local.length - 1 }

  const block = await auto1.local.get(mid.length - 1)
  const op = encoding.decodeOplog(block)
  t.absent(op.views, 'the head we boot from is not a flush head')

  const auto2 = await create(t, auto1.key, { fastForward: { boot: { head: mid } } })
  t.teardown(replicate(auto1, auto2))

  const moved = await Promise.race([
    new Promise((resolve) => auto2.once('move-to', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 3000))
  ])

  t.ok(moved, 'resolved the nearest flush head and booted')

  await sync(auto1, auto2)
  t.ok(await same(auto1, auto2), 'converged on the full tip')
})

test('a fast-forward asks peers to re-announce', async function (t) {
  const auto1 = await create(t, {
    mostRecentTrusted: () => ({ key: auto1.local.key, length: auto1.local.length })
  })

  for (let i = 0; i < 40; i++) await auto1.append(encode({ value: 'a' + i }))

  const auto2 = await create(t, auto1.key, { isTrusted: () => true })

  let requests = 0
  const session = auto2._wakeup._session
  const broadcastLookup = session.broadcastLookup.bind(session)
  session.broadcastLookup = (req) => {
    requests++
    return broadcastLookup(req)
  }

  let requestsAtMove = -1
  auto2.once('move-to', () => {
    requestsAtMove = requests
  })

  t.teardown(replicate(auto1, auto2))

  await new Promise((resolve) => auto2.once('move-to', resolve))

  t.is(requestsAtMove, 1, 'the fast-forward requested a wakeup')

  await sync(auto1, auto2)
})

test('candidate views are opened and closed through the handlers', async function (t) {
  const auto1 = await create(t, {
    mostRecentTrusted: () => ({ key: auto1.local.key, length: auto1.local.length })
  })

  for (let i = 0; i < 40; i++) await auto1.append(encode({ value: 'a' + i }))

  let opens = 0
  let closes = 0
  const seen = []

  const auto2 = await create(t, auto1.key, {
    open(bee, auto) {
      opens++
      return {
        bee,
        wrapped: true,
        get: (k) => bee.get(k),
        write: (opts) => bee.write(opts)
      }
    },
    close(view) {
      closes++
      if (view && view.wrapped) seen.push('wrapped')
    },
    isTrusted: () => false,
    mostRecentTrusted: (target, reference) => {
      if (reference !== null) {
        seen.push(target && target.wrapped ? 'candidate-wrapped' : 'candidate-raw')
      }
      return { key: auto1.local.key, length: auto1.local.length }
    }
  })

  t.teardown(replicate(auto1, auto2))

  await new Promise((resolve) => auto2.once('move-to', resolve))
  await sync(auto1, auto2)

  t.ok(seen.includes('candidate-wrapped'), 'mostRecentTrusted got the opened view')
  t.ok(seen.includes('wrapped'), 'close() got the opened view')

  // only the main and working views stay open, every candidate view we opened
  // along the way has to have been closed again
  t.comment('after ff: opens=' + opens + ' closes=' + closes)
  t.ok(opens > 2, 'candidate views were opened as well as the main and working views')
  t.is(opens - closes, 2, 'no candidate view was left open')
})

test('boot from a legacy pointer', async function (t) {
  const auto1 = await create(t)
  for (let i = 0; i < 40; i++) await auto1.append(encode({ value: 'a' + i }))

  // legacy pointers carry no length, which the boot resolves itself
  const { key } = auto1.system.bee.head()

  // isTrusted rules out the wakeup path, so only the boot can move us
  const auto2 = await create(t, auto1.key, {
    isTrusted: () => false,
    fastForward: { boot: { legacy: { key, length: 0 } } }
  })

  t.teardown(replicate(auto1, auto2))

  await new Promise((resolve) => auto2.once('move-to', resolve))
  t.pass('booted from the legacy pointer')

  await replicateAndSync(auto1, auto2)
  t.ok(await same(auto1, auto2), 'converged')
})

test('a bare key boots as a legacy pointer', async function (t) {
  const auto1 = await create(t)
  for (let i = 0; i < 40; i++) await auto1.append(encode({ value: 'a' + i }))

  const { key } = auto1.system.bee.head()

  const auto2 = await create(t, auto1.key, {
    isTrusted: () => false,
    fastForward: { boot: { key, length: 0 } }
  })

  t.teardown(replicate(auto1, auto2))

  await new Promise((resolve) => auto2.once('move-to', resolve))
  t.pass('the oldest shape still boots')
})

test('boot from an unservable head gives up after the timeout', async function (t) {
  t.timeout(60000)

  const auto1 = await create(t)
  for (let i = 0; i < 40; i++) await auto1.append(encode({ value: 'a' + i }))

  const head = { key: auto1.local.key, length: auto1.local.length }

  const errors = []
  let moved = false

  const auto2 = await create(t, auto1.key, { fastForward: { boot: { head } } })
  auto2.on('error', (err) => errors.push(err))
  auto2.once('move-to', () => {
    moved = true
  })

  // no peers: the boot read times out (5s) and must not take the instance down
  await new Promise((resolve) => setTimeout(resolve, 6000))

  t.is(errors.length, 0, 'the timeout did not surface as an error')
  t.absent(auto2.closing, 'the instance is still alive')
  t.absent(moved, 'nothing was booted')

  // boot is one shot, so a peer showing up later syncs the ordinary way
  t.teardown(replicate(auto1, auto2))
  await sync(auto1, auto2)

  t.ok(await same(auto1, auto2), 'converged once a peer showed up')
})

test('close settles while a boot attempt is in flight', async function (t) {
  t.timeout(60000)

  const auto1 = await create(t)
  for (let i = 0; i < 40; i++) await auto1.append(encode({ value: 'a' + i }))

  const store = await t.tmp()
  const auto2 = await create(t, auto1.key, {
    storage: store,
    fastForward: { boot: { head: { key: auto1.local.key, length: auto1.local.length } } }
  })

  await new Promise((resolve) => setTimeout(resolve, 200))

  const started = Date.now()
  await auto2.close()
  const elapsed = Date.now() - started

  t.comment('close took ' + elapsed + 'ms')
  t.ok(elapsed < 5000, 'close did not wait out the boot timeout')
})

// after a fast-forward the system bee points into the writer's system core, and
// the local replica's announced length keeps advancing past the blocks that
// were actually fetched - a restart with no peers must still boot fully from
// storage (the reads are pinned by the persisted checkpoint, never the tip)
test('boots offline after a fast-forward', async function (t) {
  t.timeout(60000)

  const auto1 = await create(t)
  for (let i = 0; i < 40; i++) await auto1.append(encode({ value: 'a' + i }))

  const storage = await t.tmp()
  const auto2 = await create(t, auto1.key, {
    storage,
    fastForward: { boot: { head: { key: auto1.local.key, length: auto1.local.length } } }
  })

  const unreplicate = replicate(auto1, auto2)

  await new Promise((resolve) => auto2.once('move-to', resolve))
  await sync(auto1, auto2)

  // advance the writer's system core: the joiner replays these through the
  // oplog, so it only ever learns the new system length, not the blocks
  const sys = auto1.system.bee.context.local
  for (let i = 0; i < 20; i++) await auto1.append(encode({ value: 'b' + i }))
  await sync(auto1, auto2)

  const remote = auto2.store.get({ key: sys.key })
  await remote.ready()
  while (remote.length < sys.length) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  t.absent(await remote.has(remote.length - 1), 'system core tip was announced but not fetched')
  await remote.close()

  // the ff left the joiner's bees referencing the writer's cores - all mode
  // must surface them so a mirror pins the full dependency set
  const pinned = await auto2.cores({ all: true })
  const hexes = pinned.views.map((k) => b4a.toString(k, 'hex'))
  t.ok(hexes.includes(b4a.toString(sys.key, 'hex')), 'all mode pins the referenced system core')
  t.ok(
    hexes.includes(b4a.toString(auto1._workingBee.context.local.key, 'hex')),
    'all mode pins the referenced view core'
  )

  const expected = await dump(auto2)

  await unreplicate()
  await auto2.close()

  // reopen with no peers attached: the boot must complete from storage alone
  const auto3 = await create(t, auto1.key, { storage })

  t.ok(auto3._bootGuard.opened, 'state boot completed offline')

  await auto3.update()
  t.is(await dump(auto3), expected, 'view intact after the offline boot')
})

test('warmup runs against the candidate view during fast-forward', async function (t) {
  const auto1 = await create(t, {
    mostRecentTrusted: () => ({ key: auto1.local.key, length: auto1.local.length })
  })

  for (let i = 0; i < 40; i++) await auto1.append(encode({ value: 'a' + i }))

  const seen = []

  const auto2 = await create(t, auto1.key, {
    isTrusted: () => true,
    async warmup(view) {
      const clock = await view.get(b4a.from('clock'))
      seen.push({
        clock: clock === null ? -1 : Number(b4a.toString(clock.value)),
        fastForwards: auto2.stats.fastForwards
      })
    }
  })

  t.teardown(replicate(auto1, auto2))

  await new Promise((resolve) => auto2.once('move-to', resolve))
  await sync(auto1, auto2)

  t.ok(seen.length > 0, 'warmup ran')
  t.ok(seen[0].clock > 0, 'warmup read the candidate view, not the local one')
  t.is(seen[0].fastForwards, 0, 'warmup ran before the fast-forward was applied')
  t.is(auto2.stats.fastForwards, 1, 'the fast-forward landed')
})

test('a failing warmup rejects the fast-forward candidate', async function (t) {
  const auto1 = await create(t, {
    mostRecentTrusted: () => ({ key: auto1.local.key, length: auto1.local.length })
  })

  for (let i = 0; i < 40; i++) await auto1.append(encode({ value: 'a' + i }))

  let attempts = 0
  let moved = false

  const auto2 = await create(t, auto1.key, {
    isTrusted: () => true,
    async warmup(view) {
      attempts++
      await view.get(b4a.from('clock'))
      throw new Error('warmup failed')
    }
  })

  auto2.on('move-to', () => {
    moved = true
  })

  t.teardown(replicate(auto1, auto2))

  await sync(auto1, auto2)

  t.ok(attempts > 0, 'warmup was attempted')
  t.absent(moved, 'the fast-forward candidate was rejected')
  t.is(auto2.stats.fastForwards, 0, 'no fast-forward landed')
  t.ok(await same(auto1, auto2), 'the view caught up by applying instead')
})

test('the warmup view is opened and closed through the handlers', async function (t) {
  const auto1 = await create(t, {
    mostRecentTrusted: () => ({ key: auto1.local.key, length: auto1.local.length })
  })

  for (let i = 0; i < 40; i++) await auto1.append(encode({ value: 'a' + i }))

  let opens = 0
  let closes = 0
  let wrapped = false

  const auto2 = await create(t, auto1.key, {
    open(bee) {
      opens++
      return {
        bee,
        wrapped: true,
        get: (k) => bee.get(k),
        write: (opts) => bee.write(opts)
      }
    },
    close() {
      closes++
    },
    isTrusted: () => true,
    async warmup(view) {
      wrapped = !!(view && view.wrapped)
      await view.get(b4a.from('clock'))
    }
  })

  t.teardown(replicate(auto1, auto2))

  await new Promise((resolve) => auto2.once('move-to', resolve))
  await sync(auto1, auto2)

  t.ok(wrapped, 'warmup got the opened view')
  t.ok(opens > 2, 'a warmup view was opened as well as the main and working views')
  t.is(opens - closes, 2, 'the warmup view was closed again')
})

test('cancelling a fast-forward cancels the warmup reads', async function (t) {
  t.timeout(60000)

  const auto1 = await create(t)
  for (let i = 0; i < 100; i++) await auto1.append(encode({ value: 'a' + i }))

  let onStarted = null
  const started = new Promise((resolve) => {
    onStarted = resolve
  })

  let state = 'pending'
  let unreplicate = null

  const auto2 = await create(t, auto1.key, {
    fastForward: false,
    isTrusted: () => true,
    async warmup(view) {
      // cut the transport first, so the read below can never be served
      await unreplicate()
      onStarted()

      try {
        await view.get(b4a.from('clock'))
        state = 'resolved'
      } catch (err) {
        state = 'rejected:' + err.code
        throw err
      }
    }
  })

  unreplicate = replicate(auto1, auto2)

  const oplog = auto2.openCore(auto1.local.key)
  await oplog.get(auto1.local.length - 1)
  await oplog.close()

  const head = { key: auto1.local.key, length: auto1.local.length }
  const ff = await FastForward.fromHead(auto2, head, null, { force: true, timeout: 5000 })
  t.ok(ff, 'the fast-forward candidate was accepted')

  const running = ff.run()

  await started
  await new Promise((resolve) => setTimeout(resolve, 500))
  t.is(state, 'pending', 'the warmup read is in flight and cannot be served')

  const started_at = Date.now()
  await ff.close()
  const elapsed = Date.now() - started_at

  t.comment('ff.close() took ' + elapsed + 'ms')
  t.ok(elapsed < 3000, 'close did not wait out the blocked warmup')
  t.is(state, 'rejected:REQUEST_CANCELLED', 'closing the view cancelled the warmup read')

  t.absent(await running, 'the cancelled fast-forward produced no result')
})
