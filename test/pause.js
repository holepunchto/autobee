const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Corestore = require('corestore')
const Autobee = require('../index.js')
const {
  apply,
  create,
  encode,
  decode,
  encryptionKey,
  replicate,
  replicateAndSync,
  sync,
  syncExpected,
  dump
} = require('./helpers')

test('pause - waits for the current drain and refuses new ones', async function (t) {
  const auto = await create(t)
  await auto.append(encode({ hello: 'world' }))

  const events = []
  auto.on('busy', () => events.push('busy'))
  auto.on('idle', () => events.push('idle'))

  await auto.pause()
  t.ok(auto.paused, 'paused')
  t.absent(auto.busy, 'not busy once pause resolves')

  await t.exception(auto.append(encode({ a: 1 })), /Autobee paused/)
  await t.exception(auto.update(), /Autobee paused/)
  auto.hintWakeup({ key: crypto.randomBytes(32), length: 1 })

  await new Promise((resolve) => setTimeout(resolve, 200))
  t.alike(events, [], 'no busy/idle emitted while paused')

  await auto.resume()
  t.absent(auto.paused, 'no longer paused')

  await auto.append(encode({ a: 1 }))
  t.ok(events.includes('busy') && events.includes('idle'), 'drains run again after resume')
})

test('pause - resume with nothing pending is a no-op', async function (t) {
  const auto = await create(t)

  await auto.pause()
  await auto.resume()

  await auto.append(encode({ hello: 'world' }))

  t.pass('append still works normally after an idle pause/resume cycle')
})

test('pause - a wakeup hint still pending at close is durably group-registered', async function (t) {
  const storage = await t.tmp()
  const ghostKey = crypto.randomBytes(32)

  {
    const auto = await create(t, { storage })
    await auto.append(encode({ hello: 'world' }))

    await auto.pause()
    auto.hintWakeup({ key: ghostKey, length: 5 })
    t.ok(auto._wakeup.hints.size > 0, 'hint buffered in memory pre-close')

    await auto.close()
  }

  {
    const store = new Corestore(storage)
    const core = store.get({ key: ghostKey })
    await core.ready()
    t.ok(core.core.header.group, 'ghost core picked up the wakeup group on close')
    await core.close()
    await store.close()
  }
})

test('pause - two writers make many updates while paused, resume catches up once they are gone', async function (t) {
  const storage = await t.tmp()

  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key, { storage })
  const auto3 = await create(t, auto1.key)

  await auto1.append(encode({ addWriter: auto2.local.id }))
  await auto1.append(encode({ addWriter: auto3.local.id }))
  await replicateAndSync(auto1, auto2, auto3)

  const events = []
  auto1.on('busy', () => events.push('busy'))
  auto1.on('idle', () => events.push('idle'))

  await auto1.pause()

  const done = replicate(auto1, auto2, auto3)

  const MESSAGES = 50
  for (let i = 0; i < MESSAGES; i++) {
    await auto2.append(encode({ msg: 'auto2-' + i }))
    await auto3.append(encode({ msg: 'auto3-' + i }))
  }

  await sync(auto2, auto3)

  const expected = await dump(auto2)

  await done()
  await auto2.close()
  await auto3.close()

  const mirror = new Corestore(storage)
  await mirror.ready()

  t.teardown(replicate(mirror, auto1))

  t.absent(auto1.busy, 'auto1 never drained while paused')
  t.alike(events, [], 'no busy/idle emitted while paused')

  await auto1.resume()
  await auto1.updated()

  await syncExpected(expected, auto1)

  t.is(await dump(auto1), expected, 'auto1 converges after resume, without its peers')

  await mirror.close()
})

test('pause - waits for an in-flight drain', async function (t) {
  let release = null
  const gate = new Promise((resolve) => {
    release = resolve
  })

  const auto = await create(t, {
    apply: async (batch, view, host) => {
      for (const node of batch) {
        if (JSON.parse(node.value.toString()).slow) await gate
      }
      return apply(batch, view, host)
    }
  })
  await auto.append(encode({ hello: 'world' }))

  const appended = auto.append(encode({ slow: true }))
  await new Promise((resolve) => setTimeout(resolve, 50))
  t.ok(auto.busy, 'drain is in flight')

  let paused = false
  const pausing = auto.pause().then(() => {
    paused = true
  })

  await new Promise((resolve) => setTimeout(resolve, 100))
  t.absent(paused, 'pause waits for the drain')

  release()
  await pausing
  await appended

  t.ok(paused)
  t.absent(auto.busy, 'idle once pause resolves')
})

test('pause - waits for a pending resume', async function (t) {
  const auto = await create(t)
  await auto.append(encode({ hello: 'world' }))

  await auto.pause()

  let resumed = false
  const resuming = auto.resume().then(() => {
    resumed = true
  })
  await auto.pause()

  t.ok(resumed, 'resume settled before pause resolved')
  t.ok(auto.paused, 'the later pause wins')
  t.absent(auto.busy)
  await resuming

  await t.exception(auto.append(encode({ a: 1 })), /Autobee paused/)

  await auto.resume()
  await auto.append(encode({ a: 1 }))

  t.pass()
})

test('pause - the last of overlapping pause/resume calls wins', async function (t) {
  const auto = await create(t)
  await auto.append(encode({ hello: 'world' }))

  await auto.pause()
  await Promise.all([auto.resume(), auto.pause(), auto.resume()])
  t.absent(auto.paused, 'resume, pause, resume ends resumed')
  await auto.append(encode({ a: 1 }))

  await Promise.all([auto.pause(), auto.resume(), auto.pause()])
  t.ok(auto.paused, 'pause, resume, pause ends paused')
  t.absent(auto.busy)
  await t.exception(auto.append(encode({ b: 1 })), /Autobee paused/)

  await auto.resume()
})

test('pause - overlapping resumes both settle', async function (t) {
  const auto = await create(t)

  await auto.pause()

  await Promise.all([auto.resume(), auto.resume()])
  t.absent(auto.paused)

  await auto.append(encode({ hello: 'world' }))
  t.pass()
})

test('busy - an interrupt in apply leaves the db idle', async function (t) {
  const auto = await create(t, {
    apply: (batch, view, host) => {
      for (const node of batch) {
        if (JSON.parse(node.value.toString()).stop) host.interrupt('stop')
      }
      return apply(batch, view, host)
    }
  })

  await auto.append(encode({ hello: 'world' }))

  const events = []
  auto.on('busy', () => events.push('busy'))
  auto.on('idle', () => events.push('idle'))

  const interrupted = new Promise((resolve) => auto.once('interrupt', resolve))

  await auto.append(encode({ stop: true }))

  t.is(await interrupted, 'stop')
  t.absent(auto.busy, 'not busy after an interrupt')
  t.is(events[0], 'busy')
  t.is(events[events.length - 1], 'idle')
  t.is(
    events.filter((e) => e === 'busy').length,
    events.filter((e) => e === 'idle').length,
    'every busy has its idle'
  )
})

test('pause - a -1 (unknown length) wakeup hint does not crash a close or a normal drain', async function (t) {
  const storage = await t.tmp()
  const ghostKey = crypto.randomBytes(32)

  {
    const auto = await create(t, { storage })
    await auto.append(encode({ hello: 'world' }))

    await auto.pause()
    auto.hintWakeup({ key: ghostKey, length: -1 })

    await auto.close()
  }

  {
    const auto = new Autobee(new Corestore(storage), { apply, encryptionKey })
    await auto.ready()

    auto.hintWakeup({ key: crypto.randomBytes(32), length: -1 })
    await auto.append(encode({ more: 'data' }))

    t.pass('drain completed without throwing')

    await auto.close()
  }
})

test('busy - idle is not emitted while an overlapping drain has already started', async function (t) {
  let releaseUpdate = null
  const updateGate = new Promise((resolve) => {
    releaseUpdate = resolve
  })
  let updateHits = 0

  const auto = await create(t, {
    update: async () => {
      updateHits++
      if (updateHits === 2) await updateGate
    }
  })

  await auto.append(encode({ hello: 'world' }))

  const events = []
  auto.on('busy', () => events.push(['busy', auto.busy]))
  auto.on('idle', () => events.push(['idle', auto.busy]))

  const appendA = auto.append(encode({ a: 1 }))
  await new Promise((resolve) => setTimeout(resolve, 100))
  t.absent(auto._draining, 'drain A has nulled _draining while parked in the update hook')
  t.ok(auto._updating, 'drain A is still mid its _updating phase')

  auto.bumpSoon()
  t.ok(auto._draining, 'drain B has already reassigned _draining')
  const drainB = auto._draining

  releaseUpdate()
  await appendA
  await drainB.catch(() => {})

  t.alike(events, [
    ['busy', true],
    ['idle', false]
  ])
  t.absent(auto.busy)
})

test('pause - pause() racing close() during an in-flight resume() still ends up paused', async function (t) {
  const storage = await t.tmp()
  const ghostKey = crypto.randomBytes(32)
  const auto = await create(t, { storage })

  await auto.append(encode({ hello: 'world' }))
  await auto.pause()

  t.ok(await auto._transitionLock.lock())
  auto._resuming = true
  auto._paused = false

  const pausing = auto.pause()
  t.absent(auto.paused, 'pause defers to the in-flight resume')

  auto.hintWakeup({ key: ghostKey, length: 5 })

  const closing = auto.close()

  auto._resuming = false
  auto._transitionLock.unlock()

  await Promise.allSettled([pausing, closing])

  t.ok(auto.paused, 'the pause requested before close still took effect')

  const store = new Corestore(storage)
  const core = store.get({ key: ghostKey })
  await core.ready()
  t.ok(core.core.header.group, 'ghost core picked up the wakeup group on close')
  await core.close()
  await store.close()
})

test('pause - no busy event while paused, even straight after construction', async function (t) {
  const auto = await create(t)

  const busyWhilePaused = []
  auto.on('busy', () => busyWhilePaused.push(auto.paused))

  await auto.pause()
  await auto.resume()

  await auto.append(encode({ hello: 'world' }))

  t.ok(busyWhilePaused.length > 0, 'drains ran after resume')
  t.ok(
    busyWhilePaused.every((paused) => paused === false),
    'busy never fired while paused'
  )
})

test('pause - append() rejects without writing when paused mid-flight', async function (t) {
  const auto = await create(t)
  await auto.append(encode({ warmup: true }))

  const appending = auto.append(encode({ a: 1 }))
  await auto.pause()
  t.ok(auto.paused, 'paused before append() settles')

  await t.exception(appending, /Autobee paused/)

  await auto.resume()

  const latest = await auto.bee.get(b4a.from('latest'))
  t.alike(decode(latest.value), { warmup: true }, 'nothing was appended')
})

test('pause - update() and append() surface a boot error rather than "Autobee paused"', async function (t) {
  const store = new Corestore(await t.tmp())
  t.teardown(() => store.close())

  const auto = new Autobee(store, {
    apply,
    encrypted: true,
    encryptionKey: Promise.resolve(null)
  })
  auto.on('error', () => {})

  await auto.pause()

  await t.exception(auto.ready(), /Encryption key is expected/)
  await t.exception(auto.update(), /Encryption key is expected/)
  await t.exception(auto.append(encode({ a: 1 })), /Encryption key is expected/)

  await auto.close()
})

test('pause - an append rejected while paused does not mark its approvals as sent', async function (t) {
  const auto = await create(t)
  await auto.append(encode({ hello: 'world' }))

  const key = crypto.randomBytes(32)
  const hex = b4a.toString(key, 'hex')

  auto._collectApprovals = async () => {
    auto.system.promotions.changed = false
    auto._approvalCheck = false
    auto._approvedPending.set(hex, 2)
    await auto.pause()
    return [{ key, weight: 2 }]
  }

  await t.exception(auto.append(encode({ a: 1 })), /Autobee paused/)

  t.absent(auto._approvedPending.has(hex), 'the approval is not marked as sent')
  t.ok(auto._approvalCheck, 'approvals are collected again on the next append')
})
