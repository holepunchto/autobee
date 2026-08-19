const test = require('brittle')
const b4a = require('b4a')
const Corestore = require('corestore')

const FastForward = require('../lib/fast-forward.js')

const { create, replicate, replicateAndSync, same, encode, decode } = require('./helpers')

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
  const auto1 = await create(t)

  for (let i = 0; i < 1000; i++) {
    await auto1.append(encode({ value: 'a' + i }))
  }

  const auto2 = await create(t, auto1.key, { isTrusted: () => true })
  t.teardown(replicate(auto1, auto2))

  await new Promise((resolve) => auto2.once('move-to', resolve))
  t.pass('the fast-forward went through under the conservative default')
})

test('ff onto a trusted head keeps the untrusted tip pending', async function (t) {
  const auto1 = await create(t, { isTrusted: () => false })
  const auto2 = await create(t, auto1.key, { isTrusted: () => false })

  let trusted = null
  let trustedCalls = 0

  const auto3 = await create(t, auto1.key, {
    mostRecentTrusted: () => {
      trustedCalls++
      return trusted
    }
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
  let writerAtMove = null

  const moved = new Promise((resolve, reject) => {
    const timer = setTimeout(reject, 10_000)
    auto3.once('move-to', () => {
      clearTimeout(timer)
      flushesAtMove = auto3.system.flushes
      writerAtMove = auto3.writers.active.get(id) || null
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

  t.ok(trustedCalls > 0, 'mostRecentTrusted was consulted for the untrusted head')

  t.ok(writerAtMove, 'the woken writer was not closed by the fast-forward')
  t.ok(writerAtMove && writerAtMove.isPending, 'it still has the tip pending')

  // auto3 is sparse after the ff
  t.teardown(replicate(auto1, auto2, auto3))
  t.ok(await same(auto2, auto3), 'auto3 converged on the tip')

  t.ok(auto3.system.flushes > flushesAtMove, 'auto3 applied past the head it moved to')

  const info = await auto3.system.get(auto2.local.key)
  t.is(info.length, auto2.local.length, 'the woken writer was applied in full')

  const entry = await auto3.view.get(b4a.from('latest'))
  t.alike(decode(entry.value), { hello: 'tip' + (TIP - 1) }, 'the tip landed after the ff')
})
