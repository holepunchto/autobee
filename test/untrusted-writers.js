const test = require('brittle')
const crypto = require('hypercore-crypto')
const ID = require('hypercore-id-encoding')
const Corestore = require('corestore')
const ProtomuxWakeup = require('protomux-wakeup')
const b4a = require('b4a')
const encoding = require('../lib/encoding.js')
const Autobee = require('../')
const { ActiveWriters } = require('../lib/writers.js')
const {
  create,
  replicate,
  replicateAndSync,
  sync,
  same,
  encode,
  decode,
  apply
} = require('./helpers')

const CAP = 4

function randomWriters(n) {
  const keys = []
  for (let i = 0; i < n; i++) keys.push(crypto.keyPair().publicKey)
  return keys
}

async function length(auto, key) {
  const info = await auto.system.get(key)
  return info ? info.length : 0
}

const hex = (key) => b4a.toString(key, 'hex')

async function waitFor(label, fn, timeout = 10_000) {
  const start = Date.now()
  let state = null

  while (Date.now() - start < timeout) {
    state = await fn()
    if (state.ok) return state
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  throw new Error('timed out waiting for ' + label + ': ' + serialize(state))
}

// diagnostics only: writers and cores are cyclic, and a timeout must stay bounded
function serialize(value) {
  const seen = new WeakSet()

  try {
    return JSON.stringify(value, (key, val) => {
      if (typeof val === 'bigint') return val.toString()
      if (val === null || typeof val !== 'object') return val
      if (seen.has(val)) return '[circular]'
      seen.add(val)

      if (Array.isArray(val)) return val.slice(0, 8)
      if (val instanceof Map) return { size: val.size }
      if (val instanceof Set) return { size: val.size }
      if (b4a.isBuffer(val)) return '0x' + b4a.toString(val, 'hex').slice(0, 64)

      return val
    }).slice(0, 2000)
  } catch {
    return '<unserializable>'
  }
}

function settleWithin(promise, ms, label = 'operation') {
  let timer = null
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('settleWithin timed out: ' + label)), ms)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

async function viewHistory(auto) {
  const entries = []
  for await (const { value } of auto.view.createReadStream()) {
    entries.push(b4a.toString(value))
  }
  return entries
}

// wait until the observable counters and applied lengths stop changing without
// asking the instance to update; a failed recovery must be an assertion, not a
// fixture timeout
async function quiesce(state, { stable = 300, timeout = 10_000 } = {}) {
  const started = Date.now()
  let previous = null
  let since = started

  while (Date.now() - started < timeout) {
    const current = await state()
    const serialized = JSON.stringify(current)

    if (serialized !== previous) {
      previous = serialized
      since = Date.now()
    } else if (Date.now() - since >= stable) {
      return current
    }

    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  return state()
}

function allocationSpy() {
  const calls = { session: 0, get: 0 }

  return {
    calls,
    session() {
      calls.session++
      throw new Error('store.session was called before validation')
    },
    get() {
      calls.get++
      throw new Error('store.get was called before validation')
    }
  }
}

function connect(t, ...autos) {
  const stop = replicate(...autos)
  let closed = false

  t.teardown(async () => {
    if (closed) return
    closed = true
    await stop()
  })

  return async () => {
    if (closed) return
    closed = true
    await stop()
  }
}

test('untrusted-writers - an untrusted peer drops new writers past the limit', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key, { isTrusted: () => false, maxUntrustedWriters: 3 })
  const auto3 = await create(t, auto1.key)

  const keys = randomWriters(3)
  for (const key of keys) await auto1.append(encode({ addWriter: ID.encode(key) }))
  await auto1.append(encode({ addWriter: auto3.local.id }))
  await replicateAndSync(auto1, auto2, auto3)

  t.ok(auto1.stats.writersOpened >= 4, 'the writer opened them all')
  t.ok(auto2.writers.size <= 3, 'never more than the budget tracked at once')

  for (const key of keys) {
    const info = await auto2.system.get(key)
    t.ok(info && !info.isRemoved && info.maxWeight > 0, 'the system still records the writer')
  }

  await auto3.append(encode({ msg: 'seen by the mirror' }))
  await replicateAndSync(auto1, auto2, auto3)

  t.is(await length(auto2, auto3.local.key), 1, 'the mirror follows the dropped writer')
})

test('untrusted-writers - a trusted peer opens past the limit', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key, { maxUntrustedWriters: 2 })

  const keys = randomWriters(3)
  for (const key of keys) await auto1.append(encode({ addWriter: ID.encode(key) }))
  await replicateAndSync(auto1, auto2)

  t.ok(auto2.stats.writersOpened >= 4, 'the limit does not apply to trusted peers')
  t.ok(auto2.stats.writersClosed <= auto2.stats.writersOpened, 'closes never exceed opens')

  await auto2.close()

  t.is(auto2.stats.writersClosed, auto2.stats.writersOpened, 'every opened writer is closed')
})

test('untrusted-writers - a stalled mirror fast-forwards once the admin moves on', async function (t) {
  const admin = await create(t, {
    mostRecentTrusted: () => ({ key: admin.local.key, length: admin.local.length })
  })

  const writers = []
  for (let i = 0; i < 4; i++) writers.push(await create(t, admin.key))

  for (const w of writers) await admin.append(encode({ addWriter: w.local.id }))
  await replicateAndSync(admin, ...writers)

  for (const w of writers) await w.append(encode({ msg: 'from ' + w.local.id }))
  await replicateAndSync(admin, ...writers)

  await admin.append(encode({ msg: 'links them all' }))

  // trust nothing at first so the mirror applies rather than fast-forwards.
  // every slot is busy (local + admin) so reclamation cannot bridge the gap:
  // only the fast-forward can land this mirror once the admin moves on
  let trustAdmin = false
  const mirror = await create(t, admin.key, {
    isTrusted: (key) => trustAdmin && b4a.equals(key, admin.local.key),
    maxUntrustedWriters: 2
  })

  const done = replicate(admin, mirror)

  for (let i = 0; i < 5; i++) {
    await mirror.update()
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  t.ok(mirror.writers.size <= 2, 'the mirror is at its limit with no idle slots')
  t.ok((await length(mirror, admin.local.key)) < admin.local.length, 'and stalled behind the admin')

  const moved = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no fast-forward')), 10_000)
    mirror.once('move-to', () => {
      clearTimeout(timer)
      resolve()
    })
  })

  trustAdmin = true
  for (let i = 0; i < 40; i++) await admin.append(encode({ value: 'fix ' + i }))

  await t.execution(moved, 'the mirror fast-forwarded')
  await sync(admin, mirror)

  t.ok(await same(admin, mirror), 'the mirror converged on the admin')

  await done()
})

async function createReclaimFixture(
  t,
  { mergeOldHeads = false, sourceFirst = false, stagger = false } = {}
) {
  const admin = await create(t)
  const trustedHead = () => ({ key: admin.local.key, length: admin.local.length })
  const names = ['h1', 'h2', 'b', 'c']
  const writers = []

  for (let i = 0; i < names.length; i++) {
    writers.push(await create(t, admin.key, { mostRecentTrusted: trustedHead }))
  }

  const [h1, h2, resident, source] = writers
  const pinned = [h1, h2, resident]
  const expected = { from: 'b', n: 2 }

  // source-first also grants source earlier: the later admin add nodes carry
  // its approval, so the late source block resolves at full weight while it was
  // still appended before the resident (and therefore sorts before it).
  const addOrder = sourceFirst ? [3, 2, 0, 1] : [0, 1, 2, 3]
  for (const i of addOrder) await admin.append(encode({ addWriter: writers[i].local.id }))
  await replicateAndSync(admin, ...writers)

  // One block each against the same admin head, all isolated from one another, so
  // the admin node is their shared parent and all four nodes remain heads. The
  // optional order makes the test oracle deterministic without reading the
  // production comparator: source-first later becomes an undo insertion, while
  // h1/h2 after the resident keep the reopen stable.
  const order = sourceFirst ? [3, 2, 0, 1] : [0, 1, 2, 3]
  for (const i of order) {
    await writers[i].append(encode({ from: names[i], n: 1 }))
    if (stagger) await new Promise((resolve) => setTimeout(resolve, 5))
  }

  // Persist a snapshot at resident@1 first, before the isolated h1/h2 blocks are
  // added to it, and never replicate those blocks to the resident. Its next append
  // therefore links only the source, not the heads we want to reclaim.
  const storage = await t.tmp()
  const snapshot = await create(t, admin.key, {
    storage,
    isTrusted: (key) => b4a.equals(key, admin.local.key),
    mostRecentTrusted: trustedHead,
    // only the reopened reader is capped; this builder must apply the pinned heads
    maxUntrustedWriters: 100
  })

  let stop = connect(t, admin, resident, snapshot)
  await sync(admin, resident, snapshot)
  // finish the drain that persists the boot record before the storage is reused
  await snapshot.update()

  t.alike(
    snapshot.system.heads.map((h) => hex(h.key)),
    [hex(resident.local.key)],
    'the snapshot applied resident@1 before h1/h2'
  )
  t.is(await length(snapshot, h1.local.key), 0, 'h1 was not applied yet')
  t.is(await length(snapshot, h2.local.key), 0, 'h2 was not applied yet')
  t.is(await length(snapshot, source.local.key), 0, 'the source is absent from the snapshot')

  await stop()

  // Add the isolated h1/h2 blocks to the same snapshot. Their shared admin parent
  // was already applied, so both stay heads next to resident@1.
  stop = connect(t, admin, h1, h2, snapshot)
  await sync(admin, h1, h2, snapshot)
  await snapshot.update()

  t.alike(
    snapshot.system.heads.map((h) => hex(h.key)).sort(),
    pinned.map((w) => hex(w.local.key)).sort(),
    'the snapshot has the three pinned heads'
  )

  await stop()
  await snapshot.close()

  // The resident learns the source head, so its next append links the source block.
  // In the merge variant it also learns both old heads first, so applying it
  // removes them while an announced future tail is still outstanding.
  if (mergeOldHeads) {
    stop = connect(t, resident, h1, h2, source)
    await sync(resident, h1, h2, source)
  } else {
    stop = connect(t, resident, source)
    await sync(resident, source)
  }
  if (stagger) await new Promise((resolve) => setTimeout(resolve, 5))
  await resident.append(encode({ from: 'b', n: 2 }))

  const pending = encoding.decodeOplog(await resident.local.get(1))
  const dependency = pending.links.find((link) => b4a.equals(link.key, source.local.key))
  t.ok(dependency, 'the resident writer links the source writer')
  t.is(dependency.length, source.local.length, 'the dependency names the exact source block')

  for (const [name, writer] of [
    ['h1', h1],
    ['h2', h2]
  ]) {
    const link = pending.links.find((link) => b4a.equals(link.key, writer.local.key))

    if (mergeOldHeads) {
      t.ok(link, 'resident@2 links the ' + name + ' head it merges')
      t.is(link.length, 1, 'resident@2 links ' + name + '@1 exactly')
    } else {
      t.absent(link, 'resident@2 did not learn the ' + name + ' branch')
    }
  }

  await stop()

  return {
    admin,
    adminId: hex(admin.local.key),
    trustedHead,
    names,
    expected,
    storage,
    pinned,
    h1,
    h2,
    resident,
    source,
    h1Id: hex(h1.local.key),
    h2Id: hex(h2.local.key),
    residentId: hex(resident.local.key),
    sourceId: hex(source.local.key),
    mergeOldHeads
  }
}

async function openCappedReader(t, fixture, options = {}) {
  const reader = await create(t, fixture.admin.key, {
    storage: fixture.storage,
    isTrusted: (key) => b4a.equals(key, fixture.admin.local.key),
    mostRecentTrusted: fixture.trustedHead,
    maxUntrustedWriters: CAP,
    ...options
  })

  // update() also waits for boot-online, so the persisted heads are admitted here
  await reader.update()
  return reader
}

function connectDependencyPeers(t, fixture, reader) {
  const stop = connect(t, fixture.admin, ...fixture.pinned, fixture.source, reader)

  // Announce every head over the real wakeup channel. This also makes the resident
  // writer's missing link request the source writer.
  reader.hintWakeup({ key: fixture.admin.local.key, length: fixture.admin.local.length })
  reader.hintWakeup({ key: fixture.resident.local.key, length: fixture.resident.local.length })
  reader.hintWakeup({ key: fixture.source.local.key, length: fixture.source.local.length })

  return stop
}

async function latestValue(auto) {
  const entry = await auto.view.get(b4a.from('latest'))
  return entry ? decode(entry.value) : null
}

function dependencyProgressState(reader, fixture, writers) {
  return async function () {
    const residentApplied = await length(reader, fixture.resident.local.key)
    const sourceApplied = await length(reader, fixture.source.local.key)
    const latest = await reader.view.get(b4a.from('latest'))

    const state = {
      residentApplied,
      sourceApplied,
      latest: latest ? decode(latest.value) : null,
      active: [...reader.writers.active.keys()].map((id) => id.slice(0, 8)),
      victimH1Closed: writers.h1 ? writers.h1.isClosed : null,
      victimH2Closed: writers.h2 ? writers.h2.isClosed : null,
      opened: reader.stats.writersOpened,
      closed: reader.stats.writersClosed,
      fastForwards: reader.stats.fastForwards,
      fastForwarding: reader.fastForwarding !== null,
      fastForwardTo: reader.fastForwardTo !== null,
      flushes: reader.system.flushes
    }

    state.ok =
      state.residentApplied === 2 &&
      state.sourceApplied === 1 &&
      JSON.stringify(state.latest) === JSON.stringify(fixture.expected) &&
      (state.victimH1Closed || state.victimH2Closed) &&
      state.fastForwards === 0 &&
      !state.fastForwarding &&
      !state.fastForwardTo

    return state
  }
}

test('untrusted-writers - a capped reader reclaims an idle head for a dependency', async function (t) {
  // A full budget must not starve resident work that links a writer the cap
  // refuses. The reader reclaims a genuinely idle head, keeps its logical head
  // and applied records, and admits the useful dependency into the freed slot.
  const fixture = await createReclaimFixture(t)
  const reader = await openCappedReader(t, fixture)

  const openedAtBoot = reader.stats.writersOpened
  const closedAtBoot = reader.stats.writersClosed
  const flushesAtBoot = reader.system.flushes
  const localId = hex(reader.local.key)

  t.is(reader.writers.size, CAP, 'the reader booted with a full budget')
  t.ok(reader.writers.has(localId), 'the local writer holds a slot')
  t.is(
    await length(reader, fixture.resident.local.key),
    1,
    'the resident head is applied to the snapshot'
  )
  t.is(await length(reader, fixture.source.local.key), 0, 'the source dependency is absent')
  t.is(await reader.isLocalTrusted(), false, 'the reader remains untrusted')
  t.is(reader.stats.fastForwards, 0, 'no fast-forward completed at boot')
  t.is(reader.fastForwarding, null, 'no fast-forward is running at boot')
  t.is(reader.fastForwardTo, null, 'no fast-forward is pending at boot')
  t.is(reader.system.flushes, flushesAtBoot, 'the system is still at the snapshot flush')

  const adminHead = encoding.decodeOplog(
    await fixture.admin.local.get(fixture.admin.local.length - 1)
  )
  t.ok(adminHead.views.flushes < reader.system.flushes, 'the trusted admin head is behind')

  const h1Writer = reader.writers.active.get(fixture.h1Id)
  const h2Writer = reader.writers.active.get(fixture.h2Id)
  t.ok(h1Writer && h2Writer, 'both idle heads are admitted in the full budget')

  const victimRecords = new Map()
  const victimHeads = new Map()
  for (const victim of [fixture.h1, fixture.h2]) {
    const id = hex(victim.local.key)
    victimRecords.set(id, await reader.system.get(victim.local.key))
    victimHeads.set(
      id,
      reader.system.heads.find((h) => b4a.equals(h.key, victim.local.key))
    )
  }

  const stop = connectDependencyPeers(t, fixture, reader)

  // Deliberately read-only: no update(), settle() or recovery wakeup may be the
  // reason the blocked dependency advances. The drain that discovered the missing
  // link has to reclaim and schedule the retry itself.
  const progress = await waitFor(
    'the capped reader to reclaim for the source dependency',
    dependencyProgressState(reader, fixture, { h1: h1Writer, h2: h2Writer })
  )

  t.is(progress.residentApplied, 2, 'the previously blocked resident node applied')
  t.is(progress.sourceApplied, 1, 'the dependency applied after reclaim')
  t.alike(progress.latest, fixture.expected, 'the view holds the resident value')

  const activeNow = [...reader.writers.active.keys()]
  const evictedIds = [fixture.h1Id, fixture.h2Id].filter((id) => !activeNow.includes(id))
  t.is(evictedIds.length, 1, 'exactly one idle head was reclaimed')
  t.ok(activeNow.includes(fixture.residentId), 'the resident head session was preserved')
  t.ok(activeNow.includes(localId), 'the local writer was preserved')
  t.is(reader.writers.localWriter.isClosed, false, 'the local writer session stayed open')

  const victimId = evictedIds[0]
  const victim = victimId === fixture.h1Id ? h1Writer : h2Writer
  const victimKey = b4a.from(victimId, 'hex')

  t.ok(victim.isClosed, 'the reclaimed writer session was actually closed')
  t.absent(victim.isAttached, 'the reclaimed writer was detached')
  t.absent(reader.writers.has(victimId), 'the reclaimed writer left the active map')

  const recordBefore = victimRecords.get(victimId)
  const recordAfter = await reader.system.get(victimKey)
  t.alike(
    {
      length: recordAfter.length,
      isAdded: recordAfter.isAdded,
      isRemoved: recordAfter.isRemoved,
      maxWeight: recordAfter.maxWeight
    },
    {
      length: recordBefore.length,
      isAdded: recordBefore.isAdded,
      isRemoved: recordBefore.isRemoved,
      maxWeight: recordBefore.maxWeight
    },
    'the reclaimed head kept its applied metadata'
  )

  const headAfter = reader.system.heads.find((h) => b4a.equals(h.key, victimKey))
  t.alike(headAfter, victimHeads.get(victimId), 'the reclaimed key is still a logical head')
  t.ok(reader.system.isHead(victimKey), 'the system still reports the reclaimed key as a head')

  t.is(
    reader.stats.writersOpened - openedAtBoot,
    1,
    'only the dependency writer was opened for the reclaimed slot'
  )
  t.ok(reader.stats.writersClosed - closedAtBoot >= 1, 'reclaiming closed the idle writer session')

  t.is(progress.fastForwards, 0, 'no fast-forward completed')
  t.ok(!progress.fastForwarding, 'no fast-forward was running')
  t.ok(!progress.fastForwardTo, 'no fast-forward was pending')
  t.is(await length(reader, fixture.source.local.key), 1, 'the dependency record stayed applied')
  t.is(await reader.isLocalTrusted(), false, 'the reader stayed untrusted throughout')

  const adminHeadAfter = encoding.decodeOplog(
    await fixture.admin.local.get(fixture.admin.local.length - 1)
  )
  t.ok(
    adminHeadAfter.views.flushes < reader.system.flushes,
    'the trusted admin head is still behind the progressed reader'
  )

  await stop()
})

test('untrusted-writers - a reclaimed logical head is rediscovered by the relay', async function (t) {
  const fixture = await createReclaimFixture(t)
  const reader = await openCappedReader(t, fixture)
  const stop = connectDependencyPeers(t, fixture, reader)

  const h1Writer = reader.writers.active.get(fixture.h1Id)
  const h2Writer = reader.writers.active.get(fixture.h2Id)

  await waitFor(
    'the capped reader to reclaim for the source dependency',
    dependencyProgressState(reader, fixture, { h1: h1Writer, h2: h2Writer })
  )

  const active = [...reader.writers.active.keys()]
  const evictedIds = [fixture.h1Id, fixture.h2Id].filter((id) => !active.includes(id))
  t.is(evictedIds.length, 1, 'one idle head was actually reclaimed')

  const victimId = evictedIds[0]
  const victimPeer = victimId === fixture.h1Id ? fixture.h1 : fixture.h2
  const victimKey = b4a.from(victimId, 'hex')
  const victimWriter = victimId === fixture.h1Id ? h1Writer : h2Writer
  const victimName = victimId === fixture.h1Id ? fixture.names[0] : fixture.names[1]

  t.ok(victimWriter.isClosed, 'the reclaimed writer session is closed')
  t.ok(reader.system.isHead(victimKey), 'the reclaimed key is still a logical head')
  t.is(await length(reader, victimKey), 1, 'the reclaimed branch history is still applied')

  // Append on the same existing connection. No hint, reconnect or direct source
  // link may rescue this: the evicted head has to be found again by the protocol.
  await victimPeer.append(encode({ from: victimName, n: 2 }))

  const rediscovered = await waitFor(
    'the reclaimed head to be rediscovered after it appends',
    async () => {
      const applied = await length(reader, victimKey)
      const latest = await reader.view.get(b4a.from('latest'))

      const state = {
        applied,
        latest: latest ? decode(latest.value) : null,
        active: reader.writers.has(victimId),
        head: reader.system.isHead(victimKey),
        opened: reader.stats.writersOpened,
        fastForwards: reader.stats.fastForwards
      }

      state.ok =
        state.applied === 2 &&
        JSON.stringify(state.latest) === JSON.stringify({ from: victimName, n: 2 }) &&
        state.head &&
        state.fastForwards === 0

      return state
    },
    15_000
  )

  t.is(rediscovered.applied, 2, 'the appended block was applied through rediscovery')
  t.alike(rediscovered.latest, { from: victimName, n: 2 }, 'the view holds the rediscovered value')
  t.ok(rediscovered.active, 'the reclaimed writer was active again')
  t.ok(rediscovered.head, 'the reclaimed branch stays a logical head')
  t.is(rediscovered.fastForwards, 0, 'rediscovery did not fast-forward')

  // A peer that only ever talks to the capped relay still has to learn the branch
  // history the relay reclaimed and then rediscovered.
  const late = await create(t, fixture.admin.key)
  const stopLate = connect(t, reader, late)

  const learned = await waitFor(
    'a late peer to learn the reclaimed branch through the relay',
    async () => {
      const applied = await length(late, victimKey)
      const latest = await late.view.get(b4a.from('latest'))

      const state = {
        applied,
        latest: latest ? decode(latest.value) : null,
        head: late.system.isHead(victimKey),
        fastForwards: late.stats.fastForwards
      }

      state.ok =
        state.applied === 2 &&
        JSON.stringify(state.latest) === JSON.stringify({ from: victimName, n: 2 }) &&
        state.head &&
        state.fastForwards === 0

      return state
    },
    20_000
  )

  t.is(learned.applied, 2, 'the late peer applied the reclaimed branch history')
  t.alike(learned.latest, { from: victimName, n: 2 }, 'the late peer view holds the branch value')
  t.ok(learned.head, 'the late peer sees the reclaimed branch as a logical head')
  t.is(learned.fastForwards, 0, 'the late peer did not fast-forward')

  await stopLate()
  await stop()
})

test('untrusted-writers - a late peer learns a reclaimed head before it appends', async function (t) {
  const fixture = await createReclaimFixture(t)
  const reader = await openCappedReader(t, fixture)
  const stop = connectDependencyPeers(t, fixture, reader)

  const h1Writer = reader.writers.active.get(fixture.h1Id)
  const h2Writer = reader.writers.active.get(fixture.h2Id)

  await waitFor(
    'the capped reader to reclaim for the source dependency',
    dependencyProgressState(reader, fixture, { h1: h1Writer, h2: h2Writer })
  )

  const active = [...reader.writers.active.keys()]
  const evictedIds = [fixture.h1Id, fixture.h2Id].filter((id) => !active.includes(id))
  t.is(evictedIds.length, 1, 'one idle head was actually reclaimed')

  const victimId = evictedIds[0]
  const victimKey = b4a.from(victimId, 'hex')
  const victimWriter = victimId === fixture.h1Id ? h1Writer : h2Writer

  t.ok(victimWriter.isClosed, 'the reclaimed writer session is closed')
  t.absent(reader.writers.has(victimId), 'the reclaimed writer is absent from the relay')
  t.ok(reader.system.isHead(victimKey), 'the reclaimed branch is still a logical head')

  // The victim has not appended again. A peer that only ever talks to the capped
  // relay still has to learn the reclaimed branch history, while the relay keeps
  // the reclaimed session closed and the key as a logical head.
  const late = await create(t, fixture.admin.key)
  const stopLate = connect(t, reader, late)

  const learned = await waitFor(
    'a late peer to learn the reclaimed head through the relay',
    async () => {
      const applied = await length(late, victimKey)
      const head = late.system.isHead(victimKey)

      const state = {
        applied,
        head,
        relayActive: reader.writers.has(victimId),
        relayClosed: victimWriter.isClosed,
        relayHead: reader.system.isHead(victimKey),
        fastForwards: late.stats.fastForwards
      }

      state.ok =
        state.applied === 1 &&
        state.head &&
        state.relayHead &&
        !state.relayActive &&
        state.relayClosed

      return state
    },
    20_000
  )

  t.is(learned.applied, 1, 'the late peer applied the reclaimed branch history')
  t.ok(learned.head, 'the late peer sees the reclaimed branch as a logical head')
  t.ok(learned.relayHead, 'the reclaimed branch stayed a logical head on the relay')
  t.absent(learned.relayActive, 'the relay did not reopen the reclaimed writer')
  t.ok(learned.relayClosed, 'the reclaimed writer stayed closed for the late peer')
  t.is(learned.fastForwards, 0, 'the late peer did not fast-forward')

  await stopLate()
  await stop()
})

test('untrusted-writers - an announced dependency stays open instead of being reclaimed', async function (t) {
  const fixture = await createReclaimFixture(t)
  const reader = await openCappedReader(t, fixture)

  const h1Writer = reader.writers.active.get(fixture.h1Id)
  const h2Writer = reader.writers.active.get(fixture.h2Id)
  t.ok(h1Writer && h2Writer, 'both idle heads start admitted')

  // Announce h1@2 while h1 is not connected. The block cannot arrive, so h1 is
  // known to be behind and its session must survive the pressure reclamation.
  await reader.wakeup({ key: fixture.h1.local.key, length: 2 })

  t.is(h1Writer.hintedLength, 2, 'the future h1 length is known')
  t.is(h1Writer.isPending, true, 'h1 is queued for the announced work')
  t.is(h1Writer.isClosed, false, 'the announced writer is still open')

  // No h1/h2 peers: only their stored snapshot data is available.
  const stop = connect(t, fixture.admin, fixture.resident, fixture.source, reader)
  reader.hintWakeup({ key: fixture.admin.local.key, length: fixture.admin.local.length })
  reader.hintWakeup({ key: fixture.resident.local.key, length: fixture.resident.local.length })

  // The resident block demands the source, which still has to take the only
  // genuinely idle slot (h2). h1 must never be the victim here.
  const progress = await waitFor(
    'reclaiming without dropping the announced h1 work',
    dependencyProgressState(reader, fixture, { h1: h1Writer, h2: h2Writer })
  )

  t.is(progress.residentApplied, 2, 'the resident dependency applied')
  t.is(progress.sourceApplied, 1, 'the source dependency applied')
  t.alike(progress.latest, fixture.expected, 'the view advanced')

  t.ok(h1Writer.isAttached, 'the announced writer stayed admitted')
  t.is(h1Writer.isClosed, false, 'the announced writer was not closed')
  t.is(h1Writer.hintedLength, 2, 'the announced length was retained')
  t.is(await length(reader, fixture.h1.local.key), 1, 'h1 applied history was untouched')
  t.ok(reader.system.isHead(fixture.h1.local.key), 'h1 is still a logical head')

  t.ok(h2Writer.isClosed, 'the caught-up idle head was reclaimed instead')
  t.absent(reader.writers.has(fixture.h2Id), 'only the idle head left the active map')

  await stop()
})

test('untrusted-writers - a queued announcement protects a victim during reclaim', async function (t) {
  const fixture = await createReclaimFixture(t)
  const reader = await openCappedReader(t, fixture)

  const h1Writer = reader.writers.active.get(fixture.h1Id)
  const h2Writer = reader.writers.active.get(fixture.h2Id)
  t.ok(h1Writer && h2Writer, 'both idle heads start admitted')

  const realReclaimOne = reader.writers._reclaimOne.bind(reader.writers)
  let inspecting = false
  let queuedWriter = null
  let releaseInspection = null
  let inspectionStartedResolve = null
  const release = new Promise((resolve) => {
    releaseInspection = resolve
  })
  const started = new Promise((resolve) => {
    inspectionStartedResolve = resolve
  })

  // Gate the first candidate after its fresh update, which is the await in the
  // victim inspection. The drain's normal wakeup flush has already run, so the
  // announcement queued below can only be observed from the wakeup queue.
  for (const w of [h1Writer, h2Writer]) {
    const realUpdate = w.update.bind(w)
    w.update = async function (...args) {
      const applied = await realUpdate(...args)

      if (inspecting && queuedWriter === null) {
        queuedWriter = w
        reader.hintWakeup({ key: w.core.key, length: 2 })
        inspectionStartedResolve(true)
        await release
        w.update = realUpdate
      }

      return applied
    }
  }

  reader.writers._reclaimOne = async function (dependencies) {
    inspecting = true
    try {
      return await realReclaimOne(dependencies)
    } finally {
      inspecting = false
    }
  }

  const stop = connectDependencyPeers(t, fixture, reader)

  const inspection = await settleWithin(started, 10_000)
  t.ok(inspection, 'reclamation reached a candidate update while inspecting it')

  const queuedId = queuedWriter.id
  const alternateWriter = queuedId === fixture.h1Id ? h2Writer : h1Writer
  const alternateId = alternateWriter.id

  t.ok(
    queuedId === fixture.h1Id || queuedId === fixture.h2Id,
    'the held candidate is one of the idle heads'
  )
  t.is(reader._wakeup.hints.get(queuedId), 2, 'the announcement is queued but not flushed')
  releaseInspection()

  const progress = await waitFor(
    'reclaiming the alternate idle head for the dependency',
    dependencyProgressState(reader, fixture, { h1: h1Writer, h2: h2Writer })
  )

  t.is(progress.residentApplied, 2, 'the resident dependency applied')
  t.is(progress.sourceApplied, 1, 'the source dependency applied')
  t.alike(progress.latest, fixture.expected, 'the view advanced')

  t.is(queuedWriter.isClosed, false, 'the queued candidate stayed open')
  t.ok(reader.writers.has(queuedId), 'the queued candidate stayed in the active map')

  await waitFor('the queued announcement to reach its writer', () => ({
    ok: queuedWriter.hintedLength === 2,
    hintedLength: queuedWriter.hintedLength,
    pending: queuedWriter.isPending,
    queuedHints: reader._wakeup.hints.size
  }))

  t.is(queuedWriter.hintedLength, 2, 'the announced work is recorded on the writer')
  t.ok(queuedWriter.isPending, 'the announced work keeps the writer pending')
  t.absent(reader.writers.has(alternateId), 'the alternate idle head left the active map')
  t.ok(alternateWriter.isClosed, 'the alternate idle head was closed instead')
  t.is(progress.fastForwards, 0, 'the protected path did not fast-forward')

  await stop()
})

test('untrusted-writers - an unknown queued announcement also protects a victim', async function (t) {
  const fixture = await createReclaimFixture(t)
  const reader = await openCappedReader(t, fixture)

  const h1Writer = reader.writers.active.get(fixture.h1Id)
  const h2Writer = reader.writers.active.get(fixture.h2Id)

  // Leave h1 with known outstanding work so h2 is the only idle candidate. Then
  // announce h2 with an unresolved length while its victim inspection is held.
  await reader.wakeup({ key: fixture.h1.local.key, length: 2 })
  t.is(h1Writer.isPending, true, 'h1 already has announced work')
  const hintedBefore = h2Writer.hintedLength

  const realReclaimOne = reader.writers._reclaimOne.bind(reader.writers)
  const realUpdate = h2Writer.update.bind(h2Writer)
  let inspecting = false
  let queued = false
  let releaseInspection = null
  let inspectionStartedResolve = null
  let returnedResolve = null
  let releaseReturn = null
  const release = new Promise((resolve) => {
    releaseInspection = resolve
  })
  const started = new Promise((resolve) => {
    inspectionStartedResolve = resolve
  })
  const returned = new Promise((resolve) => {
    returnedResolve = resolve
  })
  const finishReturn = new Promise((resolve) => {
    releaseReturn = resolve
  })

  h2Writer.update = async function (...args) {
    const applied = await realUpdate(...args)

    if (inspecting && !queued) {
      queued = true
      reader.hintWakeup({ key: h2Writer.core.key, length: -1 })
      inspectionStartedResolve(true)
      await release
      h2Writer.update = realUpdate
    }

    return applied
  }

  reader.writers._reclaimOne = async function (dependencies) {
    inspecting = true
    try {
      const victim = await realReclaimOne(dependencies)

      if (queued) {
        returnedResolve(victim)
        await finishReturn
      }

      return victim
    } finally {
      inspecting = false
    }
  }

  const stop = connectDependencyPeers(t, fixture, reader)

  const inspection = await settleWithin(started, 10_000)
  t.ok(inspection, 'reclamation reached the only idle candidate')
  t.is(reader._wakeup.hints.get(fixture.h2Id), -1, 'the unknown-length hint is queued')
  releaseInspection()

  // Hold the reclaim result before the dependency can retry. No alternate idle
  // head exists, so the unknown-length candidate must not be returned as a victim.
  const victim = await settleWithin(returned, 10_000)
  t.is(victim, null, 'the unknown-length candidate was not reclaimed')
  t.is(reader._wakeup.hints.get(fixture.h2Id), -1, 'the unknown-length hint is still queued')
  t.is(reader.writers.size, CAP, 'the cap stayed full')
  t.absent(reader.writers.has(fixture.sourceId), 'no dependency was admitted without a victim')
  t.ok(reader.writers.has(fixture.h2Id), 'the unknown-length candidate stayed in the active map')
  t.is(h2Writer.isClosed, false, 'the unknown-length candidate stayed open')
  t.is(h2Writer.hintedLength, hintedBefore, 'an unresolved length did not advance the hint')
  t.is(await length(reader, fixture.h1.local.key), 1, 'h1 applied history was untouched')
  t.is(await length(reader, fixture.resident.local.key), 1, 'the resident stayed blocked')
  t.is(await length(reader, fixture.source.local.key), 0, 'the source stayed out')
  t.is(reader.stats.fastForwards, 0, 'the protected path did not fast-forward')

  releaseReturn()
  await stop()
})

test('untrusted-writers - a competing announcement cannot take the dependency slot', async function (t) {
  const fixture = await createReclaimFixture(t)
  const reader = await openCappedReader(t, fixture)

  const h1Writer = reader.writers.active.get(fixture.h1Id)
  const h2Writer = reader.writers.active.get(fixture.h2Id)
  const openedAtBoot = reader.stats.writersOpened

  // Test-only gate: hold the reclaim write lock right after the victim is closed.
  // The competing admission below has to queue on the read lock, so the dependency
  // is admitted and hinted before the slot can be handed to anyone else.
  const realReclaimOne = reader.writers._reclaimOne.bind(reader.writers)
  let gated = false
  let victimClosedResolve = null
  let releaseReclaim = null
  const victimClosed = new Promise((resolve) => {
    victimClosedResolve = resolve
  })
  const release = new Promise((resolve) => {
    releaseReclaim = resolve
  })

  reader.writers._reclaimOne = async function (dependencies) {
    const victim = await realReclaimOne(dependencies)

    if (victim && !gated) {
      gated = true
      victimClosedResolve(victim)
      await release
    }

    return victim
  }

  const stop = connectDependencyPeers(t, fixture, reader)

  let victimTimer = null
  const victim = await Promise.race([
    victimClosed,
    new Promise((resolve) => {
      victimTimer = setTimeout(() => resolve(null), 10_000)
    })
  ])
  if (victimTimer) clearTimeout(victimTimer)

  t.ok(victim, 'the reclaim closed an idle head while holding the write lock')

  const competingKey = crypto.keyPair().publicKey
  const competingId = hex(competingKey)
  const competing = reader.wakeup({ key: competingKey, length: 1 })

  // let the competing add reach the read lock while reclaim still owns the write
  // lock; it must not be able to run ahead of the dependency admission
  await new Promise((resolve) => setTimeout(resolve, 20))
  releaseReclaim()
  await competing

  t.absent(reader.writers.has(competingId), 'the competing writer was refused')

  const progress = await waitFor(
    'the dependency to win the reclaimed slot',
    dependencyProgressState(reader, fixture, { h1: h1Writer, h2: h2Writer })
  )

  t.is(progress.residentApplied, 2, 'the resident applied')
  t.is(progress.sourceApplied, 1, 'the source dependency applied')
  t.alike(progress.latest, fixture.expected, 'the view advanced')

  const activeNow = [...reader.writers.active.keys()]
  const evictedIds = [fixture.h1Id, fixture.h2Id].filter((id) => !activeNow.includes(id))
  t.is(evictedIds.length, 1, 'the competing request did not force another eviction')
  t.alike(evictedIds, [victim.id], 'the dependency used exactly the reclaimed slot')
  t.is(reader.stats.writersOpened - openedAtBoot, 1, 'only the dependency writer was opened')
  t.is(await length(reader, fixture.source.local.key), 1, 'the dependency stayed applied')
  t.is(progress.fastForwards, 0, 'no fast-forward was needed')

  await stop()
})

test('untrusted-writers - an all-busy cap stays bounded and quiescent', async function (t) {
  const fixture = await createReclaimFixture(t)
  const reader = await openCappedReader(t, fixture)

  const h1Writer = reader.writers.active.get(fixture.h1Id)
  const h2Writer = reader.writers.active.get(fixture.h2Id)
  const residentWriter = reader.writers.active.get(fixture.residentId)

  t.ok(h1Writer && h2Writer && residentWriter, 'all external heads are admitted')

  // Every external slot has known unapplied work: no eligible victim exists.
  await reader.wakeup({ key: fixture.h1.local.key, length: 2 })
  await reader.wakeup({ key: fixture.h2.local.key, length: 2 })

  const stop = connect(t, fixture.admin, fixture.resident, reader)
  reader.hintWakeup({ key: fixture.admin.local.key, length: fixture.admin.local.length })
  reader.hintWakeup({ key: fixture.resident.local.key, length: fixture.resident.local.length })

  await waitFor('the resident block to be available', async () => {
    return {
      ok: residentWriter.core.length >= 2 && residentWriter.hintedLength >= 2,
      core: residentWriter.core.length,
      hinted: residentWriter.hintedLength,
      applied: await length(reader, fixture.resident.local.key)
    }
  })

  // A drain has to consider the missing dependency before the all-busy state is
  // final. This is setup: the quiescence window below issues no update at all.
  await reader.update()

  const blocked = await waitFor('the reader to settle with no eligible victim', async () => {
    const state = {
      active: reader.writers.size,
      sourceActive: reader.writers.has(fixture.sourceId),
      residentApplied: await length(reader, fixture.resident.local.key),
      sourceApplied: await length(reader, fixture.source.local.key),
      h1Pending: h1Writer.isPending,
      h2Pending: h2Writer.isPending,
      h1Hinted: h1Writer.hintedLength,
      h2Hinted: h2Writer.hintedLength,
      opened: reader.stats.writersOpened,
      closed: reader.stats.writersClosed,
      flushes: reader.system.flushes,
      drains: reader.stats.drains
    }

    state.ok =
      state.active === CAP &&
      state.sourceActive === false &&
      state.residentApplied === 1 &&
      state.sourceApplied === 0 &&
      state.h1Pending &&
      state.h2Pending &&
      state.h1Hinted === 2 &&
      state.h2Hinted === 2

    return state
  })

  t.is(blocked.active, CAP, 'the cap is still full')
  t.is(blocked.sourceActive, false, 'no dependency was admitted without a victim')
  t.is(blocked.residentApplied, 1, 'the blocked resident stayed unapplied')
  t.is(blocked.h1Hinted, 2, 'h1 kept its announced length')
  t.is(blocked.h2Hinted, 2, 'h2 kept its announced length')

  const before = {
    active: [...reader.writers.active.keys()].sort(),
    drains: reader.stats.drains,
    opened: reader.stats.writersOpened,
    closed: reader.stats.writersClosed,
    flushes: reader.system.flushes,
    residentApplied: await length(reader, fixture.resident.local.key),
    sourceApplied: await length(reader, fixture.source.local.key),
    latest: await latestValue(reader),
    fastForwards: reader.stats.fastForwards,
    h1Closed: h1Writer.isClosed,
    h2Closed: h2Writer.isClosed
  }

  await new Promise((resolve) => setTimeout(resolve, 400))

  const after = {
    active: [...reader.writers.active.keys()].sort(),
    drains: reader.stats.drains,
    opened: reader.stats.writersOpened,
    closed: reader.stats.writersClosed,
    flushes: reader.system.flushes,
    residentApplied: await length(reader, fixture.resident.local.key),
    sourceApplied: await length(reader, fixture.source.local.key),
    latest: await latestValue(reader),
    fastForwards: reader.stats.fastForwards,
    h1Closed: h1Writer.isClosed,
    h2Closed: h2Writer.isClosed
  }

  t.alike(after, before, 'no eviction, admission, drain or view change while quiescent')
  t.absent(reader.writers.has(fixture.sourceId), 'the dependency is still out')
  t.is(after.fastForwards, 0, 'no fast-forward was attempted')

  await stop()
})

test('untrusted-writers - close settles while a dependency admission is pending', async function (t) {
  const fixture = await createReclaimFixture(t)
  const reader = await openCappedReader(t, fixture)

  const realReclaimOne = reader.writers._reclaimOne.bind(reader.writers)
  const realAddUnlocked = reader.writers._addUnlocked.bind(reader.writers)

  let armed = false
  let startedResolve = null
  let releaseResolve = null
  const started = new Promise((resolve) => {
    startedResolve = resolve
  })
  const release = new Promise((resolve) => {
    releaseResolve = resolve
  })

  // Test-only gates: hold the admission that follows a successful reclaim open,
  // so close has to interrupt it rather than racing a fast core open.
  reader.writers._reclaimOne = async function (dependencies) {
    const victim = await realReclaimOne(dependencies)
    if (victim) armed = true
    return victim
  }

  reader.writers._addUnlocked = async function (key, id) {
    if (armed && id === fixture.sourceId) {
      armed = false
      startedResolve(true)
      await release
    }

    return realAddUnlocked(key, id)
  }

  const stop = connect(t, fixture.admin, fixture.resident, reader)
  reader.hintWakeup({ key: fixture.admin.local.key, length: fixture.admin.local.length })
  reader.hintWakeup({ key: fixture.resident.local.key, length: fixture.resident.local.length })

  const admission = await settleWithin(started, 10_000)
  t.ok(admission, 'the dependency admission is pending under the write lock')

  const closing = reader.close().then(() => 'closed')
  const interrupted = await waitFor(
    'close to interrupt the pending admission',
    () => ({
      ok: reader._interrupting,
      interrupting: reader._interrupting,
      active: reader.writers.size,
      sourceActive: reader.writers.has(fixture.sourceId)
    }),
    5000
  )

  t.ok(interrupted.interrupting, 'close marked the instance as interrupting')
  t.absent(interrupted.sourceActive, 'the held dependency was not attached')

  releaseResolve()

  const result = await settleWithin(closing, 10_000)
  t.is(result, 'closed', 'close settled after the pending admission was interrupted')

  t.is(reader.writers.size, 0, 'the active map was cleared')
  t.absent(reader.writers.has(fixture.sourceId), 'the pending dependency never attached')
  t.ok(reader.writers.localWriter.isClosed, 'the local writer was closed')
  t.ok(reader.store.closed, 'the store was closed')

  await stop()
})

// Hold the scheduler immediately after it admitted the dependency. The reclaim
// write lock is still held, so a competing wakeup cannot take the slot back.
function armDependencyAdmission(t, reader, dependencyId) {
  const original = reader.writers._addUnlocked
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  let armed = true

  reader.writers._addUnlocked = async function (key, id) {
    const writer = await original.call(this, key, id)

    if (armed && id === dependencyId && writer) {
      armed = false
      entered.resolve(writer)
      await release.promise
    }

    return writer
  }

  t.teardown(release.resolve)

  return {
    entered: entered.promise,
    release: release.resolve,
    restore() {
      reader.writers._addUnlocked = original
    }
  }
}

// Hold the drain after a real wakeup refused the announced writer. At this
// point the flush that carried the announcement has already been consumed.
function armRefusedWakeup(t, reader, id) {
  const original = reader.writers.wakeup
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  let armed = true

  reader.writers.wakeup = async function (key, length) {
    const result = await original.call(this, key, length)

    if (armed && b4a.toString(key, 'hex') === id && length >= 2 && !reader.writers.has(id)) {
      armed = false
      entered.resolve({ length, queued: reader._wakeup.hints.get(id) })
      await release.promise
    }

    return result
  }

  t.teardown(release.resolve)

  return {
    entered: entered.promise,
    release: release.resolve,
    restore() {
      reader.writers.wakeup = original
    }
  }
}

// Record every announcement for the reclaimed identity so a second protocol
// event cannot silently rescue the regression.
function recordAnnouncements(reader, id) {
  const seen = []
  const original = reader._wakeup.hint

  reader._wakeup.hint = function (hints) {
    const list = Array.isArray(hints) ? hints : [hints]
    for (const { key, length } of list) {
      if (b4a.toString(key, 'hex') === id) seen.push(length)
    }
    return original.call(this, hints)
  }

  return {
    seen,
    restore() {
      reader._wakeup.hint = original
    }
  }
}

// A second store speaking the real protomux-wakeup protocol to the reader. The
// reader only exposes an ingress observer through its own hint(), so this is the
// wire path a peer announcement actually takes.
async function openWakeupAnnouncer(t, reader) {
  const store = new Corestore(await t.tmp(), { manifestVersion: 2 })
  t.teardown(() => store.close())

  const inbound = reader.replicate(false)
  const outbound = store.replicate(true)
  inbound.pipe(outbound).pipe(inbound)
  t.teardown(() => {
    inbound.destroy()
    outbound.destroy()
  })

  const protocol = new ProtomuxWakeup()
  t.teardown(() => protocol.destroy())
  protocol.addStream(outbound)

  const active = Promise.withResolvers()
  protocol.session(reader.wakeupCapability.key, {
    discoveryKey: reader.wakeupCapability.discoveryKey,
    onpeeractive(peer, session) {
      active.resolve({ peer, session })
    }
  })

  const { peer, session } = await active.promise

  return {
    announce(hints) {
      session.announce(peer, hints)
    }
  }
}

test('untrusted-writers - retries a reclaimed head announced while the dependency occupies its slot', async function (t) {
  const fixture = await createReclaimFixture(t)
  const reader = await openCappedReader(t, fixture)
  const h1Writer = reader.writers.active.get(fixture.h1Id)
  const h2Writer = reader.writers.active.get(fixture.h2Id)

  const admission = armDependencyAdmission(t, reader, fixture.sourceId)
  let pause = null
  let announcements = null
  let victim = null
  let victimPeer = null
  let victimKey = null
  let victimId = null

  const stop = connectDependencyPeers(t, fixture, reader)

  try {
    await settleWithin(admission.entered, 10_000, 'dependency admission after reclaim')
    t.ok(
      reader.writers.has(fixture.sourceId),
      'the dependency was admitted into the reclaimed slot'
    )

    const closed = [h1Writer, h2Writer].filter((writer) => writer.isClosed)
    t.is(closed.length, 1, 'exactly one idle head was reclaimed before the admission')
    victim = closed[0]
    victimPeer = victim === h1Writer ? fixture.h1 : fixture.h2
    victimKey = victim.core.key
    victimId = victim.id
    const victimName = victim === h1Writer ? fixture.names[0] : fixture.names[1]

    t.absent(reader.writers.has(victimId), 'the reclaimed session left the active map')
    t.is(reader.writers.size, CAP, 'the reclaimed slot is occupied by the dependency')

    announcements = recordAnnouncements(reader, victimId)
    pause = armRefusedWakeup(t, reader, victimId)

    await victimPeer.append(encode({ from: victimName, n: 2 }))

    const queued = await waitFor(
      'the victim tail announcement to be queued',
      () => {
        const length = reader._wakeup.hints.get(victimId)
        return {
          ok: announcements.seen.some((n) => n >= 2) && length !== undefined,
          queued: length,
          seen: announcements.seen.slice()
        }
      },
      15_000
    )

    t.ok(queued.queued >= 2, 'the real positive announcement was queued')

    admission.release()

    const refused = await settleWithin(pause.entered, 10_000, 'refused victim wakeup')
    t.is(refused.length, 2, 'the real wakeup carried the announced length')
    t.is(refused.queued, undefined, 'the flushed announcement was consumed before the refusal')
    t.is(reader.writers.size, CAP, 'the session cap is still full at the refusal')
    t.is(await length(reader, fixture.source.local.key), 0, 'the dependency has not applied yet')
    t.is(
      await length(reader, fixture.resident.local.key),
      1,
      'the resident dependency has not applied yet'
    )
    t.ok(victim.isClosed, 'the original reclaimed session is still closed')
    t.absent(reader.writers.has(victimId), 'the refused writer did not re-enter the active map')

    pause.release()

    const state = await quiesce(async () => {
      const entries = await viewHistory(reader)
      return {
        source: await length(reader, fixture.source.local.key),
        resident: await length(reader, fixture.resident.local.key),
        victim: await length(reader, victimKey),
        active: reader.writers.size,
        opened: reader.stats.writersOpened,
        closed: reader.stats.writersClosed,
        drains: reader.stats.drains,
        flushes: reader.system.flushes,
        history: entries.join('|'),
        announcements: announcements.seen.length
      }
    })

    t.is(state.source, 1, 'the dependency applied after the refusal')
    t.is(state.resident, 2, 'the resident tail applied after the dependency')
    t.is(state.victim, 2, 'the announced tail was retried and applied')
    t.ok(state.active <= CAP, 'the retry stayed inside the session cap')

    const entries = await viewHistory(reader)
    t.ok(entries.includes(fixture.sourceId + '.1'), 'the source node reached the apply view')
    t.ok(entries.includes(fixture.residentId + '.2'), 'the resident node reached the apply view')
    t.ok(entries.includes(victimId + '.2'), 'the victim tail reached the apply view')
    t.alike(
      announcements.seen.filter((n) => n >= 2),
      [2],
      'the consumed announcement is the only one that could rescue the tail'
    )
  } finally {
    admission.release()
    if (pause) pause.release()
    if (announcements) announcements.restore()
    admission.restore()
    if (pause) pause.restore()
    await stop()
  }
})

test('untrusted-writers - retains an announced tail after its old head is merged', async function (t) {
  const fixture = await createReclaimFixture(t, { mergeOldHeads: true })
  const reader = await openCappedReader(t, fixture)
  const h1Writer = reader.writers.active.get(fixture.h1Id)
  const h2Writer = reader.writers.active.get(fixture.h2Id)
  const residentWriter = reader.writers.active.get(fixture.residentId)

  const admission = armDependencyAdmission(t, reader, fixture.sourceId)
  let pause = null
  let announcements = null
  let merge = null
  let releaseMerge = null
  let merged = null
  let victim = null
  let victimPeer = null
  let victimKey = null
  let victimId = null
  let restoreReset = null

  const stop = connectDependencyPeers(t, fixture, reader)

  try {
    await settleWithin(admission.entered, 10_000, 'dependency admission after reclaim')

    const closed = [h1Writer, h2Writer].filter((writer) => writer.isClosed)
    t.is(closed.length, 1, 'exactly one idle head was reclaimed before the admission')
    victim = closed[0]
    victimPeer = victim === h1Writer ? fixture.h1 : fixture.h2
    victimKey = victim.core.key
    victimId = victim.id
    const victimName = victim === h1Writer ? fixture.names[0] : fixture.names[1]

    announcements = recordAnnouncements(reader, victimId)
    pause = armRefusedWakeup(t, reader, victimId)

    // Hold the refresh reset that follows resident@2: applying it merged the old
    // heads, while the announced tail has not been retried yet.
    const realReset = residentWriter.reset
    merge = Promise.withResolvers()
    releaseMerge = Promise.withResolvers()
    let resetArmed = true
    t.teardown(releaseMerge.resolve)

    residentWriter.reset = async function (...args) {
      if (resetArmed && (await length(reader, fixture.resident.local.key)) === 2) {
        resetArmed = false
        merged = {
          residentApplied: 2,
          victimApplied: await length(reader, victimKey),
          victimHead: reader.system.isHead(victimKey),
          victimActive: reader.writers.has(victimId)
        }
        merge.resolve(merged)
        await releaseMerge.promise
      }

      return realReset.apply(this, args)
    }
    restoreReset = () => {
      residentWriter.reset = realReset
    }

    await victimPeer.append(encode({ from: victimName, n: 2 }))

    const queued = await waitFor(
      'the victim tail announcement to be queued',
      () => {
        const length = reader._wakeup.hints.get(victimId)
        return {
          ok: announcements.seen.some((n) => n >= 2) && length !== undefined,
          queued: length,
          seen: announcements.seen.slice()
        }
      },
      15_000
    )

    t.ok(queued.queued >= 2, 'the real positive announcement was queued')

    admission.release()

    const refused = await settleWithin(pause.entered, 10_000, 'refused victim wakeup')
    t.is(refused.queued, undefined, 'the flushed announcement was consumed before the refusal')
    t.is(reader.writers.size, CAP, 'the session cap is still full at the refusal')
    t.is(await length(reader, fixture.source.local.key), 0, 'the dependency has not applied yet')
    t.is(
      await length(reader, fixture.resident.local.key),
      1,
      'the resident dependency has not applied yet'
    )
    t.ok(victim.isClosed, 'the original reclaimed session is still closed')

    pause.release()

    const mergeState = await settleWithin(merge.promise, 10_000, 'merged-head boundary')
    t.is(mergeState.residentApplied, 2, 'the merging resident node applied')
    t.is(mergeState.victimApplied, 1, 'the announced tail was still unapplied')
    t.is(mergeState.victimHead, false, 'the merged old head was removed')
    t.is(mergeState.victimActive, false, 'the reclaimed writer was not reopened yet')

    const mergedRecord = reader.writers._reclaimed.get(victimId)
    t.ok(mergedRecord, 'the merged-head record was retained while its old head was gone')
    t.is(mergedRecord.length, 2, 'the merged-head record kept the announced tail length')

    releaseMerge.resolve()

    const state = await quiesce(async () => {
      const entries = await viewHistory(reader)
      return {
        source: await length(reader, fixture.source.local.key),
        resident: await length(reader, fixture.resident.local.key),
        victim: await length(reader, victimKey),
        victimHead: reader.system.isHead(victimKey),
        active: reader.writers.size,
        opened: reader.stats.writersOpened,
        closed: reader.stats.writersClosed,
        drains: reader.stats.drains,
        history: entries.join('|'),
        announcements: announcements.seen.length
      }
    })

    t.is(state.source, 1, 'the dependency applied')
    t.is(state.resident, 2, 'the merging resident node applied')
    t.is(state.victim, 2, 'the announced tail survived the old-head merge')
    t.ok(state.victimHead, 'the applied tail became a head again')
    t.ok(state.active <= CAP, 'the retry stayed inside the session cap')

    const entries = await viewHistory(reader)
    t.ok(entries.includes(fixture.sourceId + '.1'), 'the source node reached the apply view')
    t.ok(entries.includes(fixture.residentId + '.2'), 'the resident node reached the apply view')
    t.ok(entries.includes(victimId + '.2'), 'the merged-over tail reached the apply view')
    t.alike(
      announcements.seen.filter((n) => n >= 2),
      [2],
      'the consumed announcement is the only one that could rescue the tail'
    )
  } finally {
    admission.release()
    if (pause) pause.release()
    if (releaseMerge) releaseMerge.resolve()
    if (announcements) announcements.restore()
    if (restoreReset) restoreReset()
    admission.restore()
    if (pause) pause.restore()
    await stop()
  }
})

test('untrusted-writers - captures a wire announcement before an unknown length replaces it', async function (t) {
  const fixture = await createReclaimFixture(t, { mergeOldHeads: true })
  const reader = await openCappedReader(t, fixture)
  const h1Writer = reader.writers.active.get(fixture.h1Id)
  const h2Writer = reader.writers.active.get(fixture.h2Id)
  const residentWriter = reader.writers.active.get(fixture.residentId)

  const admission = armDependencyAdmission(t, reader, fixture.sourceId)
  let announcements = null
  let captures = null
  let restoreCapture = null
  let merge = null
  let releaseMerge = null
  let restoreReset = null
  let stop = null

  try {
    const sender = await openWakeupAnnouncer(t, reader)
    stop = connectDependencyPeers(t, fixture, reader)

    await settleWithin(admission.entered, 10_000, 'dependency admission after reclaim')

    const closed = [h1Writer, h2Writer].filter((writer) => writer.isClosed)
    t.is(closed.length, 1, 'exactly one idle head was reclaimed before the admission')

    const victim = closed[0]
    const victimPeer = victim === h1Writer ? fixture.h1 : fixture.h2
    const victimName = victim === h1Writer ? fixture.names[0] : fixture.names[1]
    const victimId = victim.id
    const victimKey = b4a.from(victimId, 'hex')

    const record = reader.writers._reclaimed.get(victimId)
    t.ok(record, 'the reclaimed identity has a ledger record')
    t.is(record.length, 1, 'the record starts from the applied history')
    t.is(reader._wakeup.hints.get(victimId), undefined, 'nothing is queued for the victim yet')
    t.is(reader.writers.size, CAP, 'the dependency occupies the reclaimed slot')

    announcements = recordAnnouncements(reader, victimId)

    captures = []
    const realCapture = reader.writers.captureReclaimedAnnouncements
    if (realCapture) {
      reader.writers.captureReclaimedAnnouncements = function (hints) {
        const list = Array.isArray(hints) ? hints : [hints]
        for (const { key, length } of list) {
          if (b4a.toString(key, 'hex') === victimId) {
            captures.push({ length, batch: Array.isArray(hints) })
          }
        }
        return realCapture.call(this, hints)
      }
      restoreCapture = () => {
        reader.writers.captureReclaimedAnnouncements = realCapture
      }
    }

    // Make the tail block available first, so every block-derived group hint is
    // delivered before the unknown length. The positive then comes from the real
    // wire announcement below, with no later data event to rescue it.
    await victimPeer.append(encode({ from: victimName, n: 2 }))
    const probe = reader.store.get({ key: victimKey })
    try {
      await probe.ready()
      await settleWithin(
        (async () => {
          while (probe.length < 2) await probe.update({ wait: true })
        })(),
        10_000,
        'victim tail availability'
      )
    } finally {
      await probe.close()
    }

    const rxBefore = reader._wakeup._protocol.stats.wireAnnounce.rx
    sender.announce([{ key: victimKey, length: 2 }])

    await waitFor(
      'the real wire positive announcement to be received',
      () => ({
        ok:
          reader._wakeup.hints.get(victimId) === 2 &&
          reader._wakeup._protocol.stats.wireAnnounce.rx > rxBefore,
        queued: reader._wakeup.hints.get(victimId),
        wireAnnounceRx: reader._wakeup._protocol.stats.wireAnnounce.rx - rxBefore,
        seen: announcements.seen.slice()
      }),
      10_000
    )

    t.is(
      reader._wakeup._protocol.stats.wireAnnounce.rx - rxBefore,
      1,
      'the positive length arrived over the real wakeup wire'
    )
    t.is(reader._wakeup.hints.get(victimId), 2, 'the positive announcement is queued')
    t.ok(
      captures.some((capture) => capture.length === 2 && capture.batch),
      'the wire announcement reached the ingress observation as a batch'
    )
    t.is(
      reader.writers._reclaimed.get(victimId).length,
      2,
      'the positive maximum was captured before coalescing'
    )

    // Give any asynchronous group notification a chance to arrive before the
    // unknown replaces the queued value. A later positive would invalidate the
    // regression, because the old flushed-map capture would then see it.
    await new Promise((resolve) => setTimeout(resolve, 100))
    t.is(reader._wakeup.hints.get(victimId), 2, 'the wire positive stayed queued')

    reader.hintWakeup({ key: victimKey, length: -1 })

    t.is(reader._wakeup.hints.get(victimId), -1, 'the supported unknown length is queued')
    t.is(announcements.seen.at(-1), -1, 'the unknown was the last announcement')
    const captured = reader.writers._reclaimed.get(victimId)
    t.is(captured.length, 2, 'the unknown did not erase the positive maximum')
    if (captured.length !== 2) return

    const realReset = residentWriter.reset
    merge = Promise.withResolvers()
    releaseMerge = Promise.withResolvers()
    let resetArmed = true

    residentWriter.reset = async function (...args) {
      if (resetArmed && (await length(reader, fixture.resident.local.key)) === 2) {
        resetArmed = false
        merge.resolve({
          record: reader.writers._reclaimed.get(victimId),
          victimApplied: await length(reader, victimKey),
          victimHead: reader.system.isHead(victimKey)
        })
        await releaseMerge.promise
      }

      return realReset.apply(this, args)
    }
    restoreReset = () => {
      residentWriter.reset = realReset
    }

    admission.release()

    const merged = await settleWithin(merge.promise, 15_000, 'merged-head boundary')
    t.is(merged.victimApplied, 1, 'the announced tail is still unapplied')
    t.is(merged.victimHead, false, 'the merged old head was removed')
    t.ok(merged.record, 'the pending record survived source and resident progress')
    t.is(merged.record.length, 2, 'the pending record kept the wire length')

    releaseMerge.resolve()

    const state = await quiesce(async () => {
      const entries = await viewHistory(reader)
      return {
        source: await length(reader, fixture.source.local.key),
        resident: await length(reader, fixture.resident.local.key),
        victim: await length(reader, victimKey),
        active: reader.writers.size,
        fastForwards: reader.stats.fastForwards,
        history: entries.join('|'),
        seen: announcements.seen.slice()
      }
    })

    t.is(state.source, 1, 'the source dependency applied')
    t.is(state.resident, 2, 'the resident announcement applied')
    t.is(state.victim, 2, 'the wire-announced tail was retried and applied')
    t.ok(state.active <= CAP, 'the retry stayed inside the session cap')
    t.is(state.fastForwards, 0, 'the retry did not fast-forward')
    t.ok(state.history.includes(victimId + '.2'), 'the retried tail reached the apply view')

    const unknownAt = state.seen.indexOf(-1)
    t.ok(unknownAt >= 0, 'the regression delivered its unknown announcement')
    t.absent(
      state.seen.slice(unknownAt + 1).some((value) => value >= 2),
      'no later positive announcement rescued the tail'
    )
  } finally {
    admission.release()
    if (releaseMerge) releaseMerge.resolve()
    if (announcements) announcements.restore()
    if (restoreCapture) restoreCapture()
    if (restoreReset) restoreReset()
    admission.restore()
    if (stop) await stop()
  }
})

test('untrusted-writers - validates the independent reclamation budget before allocating resources', async function (t) {
  t.is(ActiveWriters.validateMaxReclaimedWriters(undefined), 1024, 'omitted budget defaults')
  t.is(ActiveWriters.validateMaxReclaimedWriters(0), 0, 'zero is accepted')
  t.is(ActiveWriters.validateMaxReclaimedWriters(1), 1, 'one is accepted')
  t.is(
    ActiveWriters.validateMaxReclaimedWriters(Number.MAX_SAFE_INTEGER),
    Number.MAX_SAFE_INTEGER,
    'the largest safe integer is accepted'
  )

  const typeErrors = [null, '1', true, {}, 1n, Symbol('budget')]
  const rangeErrors = [
    -1,
    1.5,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    Number.MAX_SAFE_INTEGER + 2
  ]

  for (const value of typeErrors) {
    let error = null
    try {
      ActiveWriters.validateMaxReclaimedWriters(value)
    } catch (err) {
      error = err
    }
    t.ok(error instanceof TypeError, 'rejects a non-number')
  }
  for (const value of rangeErrors) {
    let error = null
    try {
      ActiveWriters.validateMaxReclaimedWriters(value)
    } catch (err) {
      error = err
    }
    t.ok(error instanceof RangeError, 'rejects an invalid number')
  }

  const constructors = [
    (store, options) => new Autobee(store, options),
    (store, options) => new Autobee(store, null, options)
  ]

  for (const construct of constructors) {
    for (const value of typeErrors) {
      const store = allocationSpy()
      let error = null
      try {
        construct(store, { maxReclaimedWriters: value })
      } catch (err) {
        error = err
      }
      t.ok(error instanceof TypeError, 'constructor rejects non-number ' + String(value))
      t.is(store.calls.session, 0, 'no store session was allocated for a non-number')
      t.is(store.calls.get, 0, 'no core was opened for a non-number')
    }

    for (const value of rangeErrors) {
      const store = allocationSpy()
      let error = null
      try {
        construct(store, { maxReclaimedWriters: value })
      } catch (err) {
        error = err
      }
      t.ok(error instanceof RangeError, 'constructor rejects invalid number ' + String(value))
      t.is(store.calls.session, 0, 'no store session was allocated for an invalid number')
      t.is(store.calls.get, 0, 'no core was opened for an invalid number')
    }
  }

  // valid values are normalized before the handlers are handed to the writers
  const defaultValue = await create(t, { name: 'budget-default' })
  t.is(defaultValue._maxReclaimedWriters, 1024, 'omitted option normalizes to the default')
  t.is(defaultValue.writers.maxReclaimedWriters, 1024, 'the writer ledger uses the default')

  defaultValue._handlers.maxReclaimedWriters = 5
  t.is(
    defaultValue.writers.maxReclaimedWriters,
    1024,
    'the ledger keeps the normalized value when handler options mutate'
  )
  defaultValue._handlers.maxReclaimedWriters = undefined

  const explicitUndefined = await create(t, null, {
    name: 'budget-undefined',
    maxReclaimedWriters: undefined
  })
  t.is(explicitUndefined._maxReclaimedWriters, 1024, 'explicit undefined normalizes to the default')

  const zeroValue = await create(t, null, { name: 'budget-zero', maxReclaimedWriters: 0 })
  t.is(zeroValue._maxReclaimedWriters, 0, 'zero normalizes before the store is created')
  t.is(zeroValue.writers.maxReclaimedWriters, 0, 'the writer ledger keeps zero')

  const oneValue = await create(t, { name: 'budget-one', maxReclaimedWriters: 1 })
  t.is(oneValue._maxReclaimedWriters, 1, 'the options overload accepts one')

  const maxValue = await create(t, null, {
    name: 'budget-max',
    maxReclaimedWriters: Number.MAX_SAFE_INTEGER
  })
  t.is(
    maxValue._maxReclaimedWriters,
    Number.MAX_SAFE_INTEGER,
    'the key overload accepts the largest safe integer'
  )
})

test('untrusted-writers - the metadata budget is configured independently of session capacity', async function (t) {
  const smallSessions = await create(t, {
    name: 'independent-small-sessions',
    maxUntrustedWriters: 4,
    maxReclaimedWriters: 7
  })

  t.is(smallSessions.writers.maxUntrustedWriters, 4, 'the session cap keeps its own value')
  t.is(smallSessions._maxReclaimedWriters, 7, 'the metadata budget keeps its own value')
  t.is(smallSessions.writers.maxReclaimedWriters, 7, 'the ledger reads the normalized value')

  const largeSessions = await create(t, {
    name: 'independent-large-sessions',
    maxUntrustedWriters: 40,
    maxReclaimedWriters: 2
  })

  t.is(
    largeSessions.writers.maxUntrustedWriters,
    40,
    'a larger session cap does not resize metadata'
  )
  t.is(largeSessions._maxReclaimedWriters, 2, 'the metadata budget is smaller than the session cap')
  t.is(
    largeSessions.writers.maxReclaimedWriters,
    2,
    'the ledger is not derived from the session cap'
  )

  const defaulted = await create(t, { name: 'independent-default', maxUntrustedWriters: 2 })
  t.is(
    defaulted._maxReclaimedWriters,
    1024,
    'a custom session cap leaves the default metadata budget'
  )
})

test('untrusted-writers - reserves one record and stops reclaiming at the metadata budget', async function (t) {
  const fixture = await createReclaimFixture(t)
  const reader = await openCappedReader(t, fixture, { maxReclaimedWriters: 1 })
  const h1Writer = reader.writers.active.get(fixture.h1Id)
  const h2Writer = reader.writers.active.get(fixture.h2Id)

  t.is(reader._maxReclaimedWriters, 1, 'the reader has a one-record metadata budget')
  t.is(reader.writers.maxReclaimedWriters, 1, 'the ledger reads the normalized budget')
  t.is(reader.writers._reclaimed.size, 0, 'boot does not reserve records')

  // an ordinary refusal is not an actual pressure eviction and must not create a
  // record, even at a full session cap
  const refusedKey = randomWriters(1)[0]
  await reader.writers.wakeup(refusedKey, 1)
  t.absent(reader.writers.has(hex(refusedKey)), 'the unrelated writer was refused')
  t.is(reader.writers._reclaimed.size, 0, 'a refused identity did not create a record')

  const stop = connectDependencyPeers(t, fixture, reader)

  try {
    await waitFor(
      'the capped reader to reclaim for the source dependency',
      dependencyProgressState(reader, fixture, { h1: h1Writer, h2: h2Writer })
    )

    const closed = [h1Writer, h2Writer].filter((writer) => writer.isClosed)
    t.is(closed.length, 1, 'one actual eviction happened')
    const victim = closed[0]
    const victimId = victim.id
    const victimKey = victim.core.key

    t.is(reader.writers._reclaimed.size, 1, 'the actual eviction reserved one record')
    const entries = [...reader.writers._reclaimed]
    const [recordId, record] = entries[0]
    t.is(entries.length, 1, 'the ledger holds exactly one entry')
    t.is(recordId, victimId, 'the record names the evicted writer')
    t.alike(
      Object.keys(record).sort(),
      ['key', 'length'],
      'the record retains identity and length only'
    )
    t.ok(b4a.isBuffer(record.key), 'the record key is a buffer')
    t.ok(b4a.equals(record.key, victimKey), 'the record key is the evicted identity')
    t.is(record.length, 1, 'the record starts at the freshly applied length')
    t.is(typeof record.length, 'number', 'the record length is plain data')
    t.absent(record.writer, 'the record retains no writer')
    t.absent(record.core, 'the record retains no core')

    const settled = await quiesce(async () => ({
      active: reader.writers.size,
      source: await length(reader, fixture.source.local.key),
      resident: await length(reader, fixture.resident.local.key),
      victim: await length(reader, victimKey),
      opened: reader.stats.writersOpened,
      closed: reader.stats.writersClosed,
      drains: reader.stats.drains,
      records: reader.writers._reclaimed.size
    }))

    t.is(settled.source, 1, 'the dependency applied to the view')
    t.is(settled.resident, 2, 'the resident tail applied to the view')
    t.ok(settled.active < CAP, 'ordinary gc left room after the dependency applied')

    // fill the remaining session slot so a second dependency would need a victim
    const fillerKey = crypto.keyPair().publicKey
    await reader.writers.add(fillerKey)
    t.ok(reader.writers.has(hex(fillerKey)), 'the filler took the free slot')
    t.is(reader.writers.size, CAP, 'the session cap is full again')

    const before = {
      active: [...reader.writers.active.keys()].sort(),
      opened: reader.stats.writersOpened,
      closed: reader.stats.writersClosed,
      drains: reader.stats.drains,
      records: reader.writers._reclaimed.size,
      recordKey: b4a.toString(record.key, 'hex'),
      recordLength: record.length,
      h2Closed: h2Writer.isClosed
    }

    const missingKey = crypto.keyPair().publicKey
    await reader.writers._refreshReclaimed([{ key: missingKey, length: 1 }])

    t.is(reader.writers.size, CAP, 'the metadata budget stops the second eviction')
    t.is(reader.writers._reclaimed.size, 1, 'the existing obligation is still reserved')
    const retained = reader.writers._reclaimed.get(recordId)
    t.ok(retained === record, 'saturation did not replace or delete the existing record')
    t.is(retained.length, 1, 'the existing obligation is unchanged')
    t.is(h2Writer.isClosed, false, 'the other idle head was not evicted at saturation')
    t.ok(reader.writers.has(fixture.h2Id), 'the other idle head is still admitted')
    t.absent(reader.writers.has(hex(missingKey)), 'no dependency was admitted without a victim')
    t.is(reader.stats.writersOpened, before.opened, 'saturation opened no writers')
    t.is(reader.stats.writersClosed, before.closed, 'saturation closed no writers')
    t.is(reader.stats.drains, before.drains, 'saturation did not self-schedule a drain')

    // merge the victim's old head; the satisfied non-head obligation is cleaned
    // up by the next normal refresh, without a reclamation
    await sync(fixture.resident, fixture.h1)
    await fixture.resident.append(encode({ from: 'b', n: 3 }))

    const cleaned = await quiesce(async () => {
      const entries = await viewHistory(reader)
      return {
        resident: await length(reader, fixture.resident.local.key),
        victim: await length(reader, victimKey),
        victimHead: reader.system.isHead(victimKey),
        records: reader.writers._reclaimed.size,
        active: reader.writers.size,
        opened: reader.stats.writersOpened,
        closed: reader.stats.writersClosed,
        drains: reader.stats.drains,
        history: entries.join('|')
      }
    })

    t.is(cleaned.resident, 3, 'the merging resident tail applied')
    t.is(cleaned.victim, 1, 'the merged old head history is unchanged')
    t.is(cleaned.victimHead, false, 'the victim is no longer a logical head')
    t.is(cleaned.records, 0, 'legitimate cleanup removed the satisfied record')
    t.ok(cleaned.history.includes(fixture.residentId + '.3'), 'the merge reached the apply view')
    t.ok(cleaned.history.includes(victimId + '.1'), 'the old head history stayed in the view')

    // with the ledger empty again, a fresh pressure eviction may reserve a record
    let laterVictim = null
    await reader.writers._lock.write.lock()
    try {
      laterVictim = await reader.writers._reclaimOne([])
    } finally {
      reader.writers._lock.write.unlock()
    }

    t.ok(laterVictim, 'a later pressure eviction found an idle head')
    t.is(reader.writers._reclaimed.size, 1, 'cleanup permitted a later reclamation record')
    const laterEntries = [...reader.writers._reclaimed]
    const [laterId, laterRecord] = laterEntries[0]
    t.is(laterEntries.length, 1, 'the later ledger holds exactly one entry')
    t.is(laterId, laterVictim.id, 'the later record names the alternate idle head')
    t.is(
      laterRecord.length,
      await length(reader, laterVictim.core.key),
      'the later record starts at the freshly applied length'
    )
    t.ok(laterVictim.isClosed, 'the later pressure closed the alternate idle head')
    t.absent(reader.writers.has(laterVictim.id), 'the later victim left the active map')
  } finally {
    await stop()
  }
})

test('untrusted-writers - a zero metadata budget preserves ordinary admission and gc', async function (t) {
  const fixture = await createReclaimFixture(t)
  const reader = await openCappedReader(t, fixture, { maxReclaimedWriters: 0 })
  const h1Writer = reader.writers.active.get(fixture.h1Id)
  const h2Writer = reader.writers.active.get(fixture.h2Id)
  const residentWriter = reader.writers.active.get(fixture.residentId)

  t.is(reader._maxReclaimedWriters, 0, 'zero disables pressure reclamation')
  t.is(reader.writers.maxReclaimedWriters, 0, 'the ledger sees the zero budget')

  const stop = connectDependencyPeers(t, fixture, reader)

  try {
    await waitFor('the resident work to be announced under a zero budget', () => ({
      ok: residentWriter.core.length >= 2 && residentWriter.hintedLength >= 2,
      core: residentWriter.core.length,
      hinted: residentWriter.hintedLength,
      drains: reader.stats.drains
    }))

    const blocked = await quiesce(async () => ({
      active: reader.writers.size,
      source: await length(reader, fixture.source.local.key),
      resident: await length(reader, fixture.resident.local.key),
      records: reader.writers._reclaimed.size,
      opened: reader.stats.writersOpened,
      closed: reader.stats.writersClosed,
      drains: reader.stats.drains,
      h1Closed: h1Writer.isClosed,
      h2Closed: h2Writer.isClosed
    }))

    t.is(blocked.active, CAP, 'the session cap stays full')
    t.is(blocked.source, 0, 'zero did not reclaim a slot for the dependency')
    t.is(blocked.resident, 1, 'the resident stayed blocked')
    t.is(blocked.records, 0, 'zero reserved no metadata record')
    t.is(blocked.h1Closed, false, 'the first idle head stayed open')
    t.is(blocked.h2Closed, false, 'the second idle head stayed open')

    const refusedKey = randomWriters(1)[0]
    await reader.writers.wakeup(refusedKey, 1)
    t.absent(reader.writers.has(hex(refusedKey)), 'an unrelated writer was still refused')
    t.is(reader.writers._reclaimed.size, 0, 'the refused identity did not create a record')

    // ordinary gc of an idle, caught-up writer is not a pressure reclamation
    await reader.writers.remove(fixture.h2.local.key)
    t.absent(reader.writers.has(fixture.h2Id), 'ordinary gc removed the idle writer')
    t.ok(h2Writer.isClosed, 'ordinary gc closed the idle session')
    t.is(reader.writers._reclaimed.size, 0, 'ordinary gc did not reserve a record')

    // ordinary admission still uses the genuinely free slot, even at zero metadata
    await reader.writers.wakeup(fixture.source.local.key, fixture.source.local.length)

    const admitted = await waitFor('the source to apply through ordinary admission', async () => {
      return {
        ok:
          (await length(reader, fixture.source.local.key)) === 1 &&
          (await length(reader, fixture.resident.local.key)) === 2,
        source: await length(reader, fixture.source.local.key),
        resident: await length(reader, fixture.resident.local.key),
        active: reader.writers.size,
        records: reader.writers._reclaimed.size
      }
    })

    t.is(admitted.source, 1, 'ordinary admission applied the source')
    t.is(admitted.resident, 2, 'the resident dependency then applied')
    t.ok(admitted.active <= CAP, 'ordinary admission stayed inside the session cap')
    t.is(admitted.records, 0, 'zero never created a metadata record')
  } finally {
    await stop()
  }
})

test('untrusted-writers - settleWithin distinguishes a fulfilled null from a timeout', async function (t) {
  t.is(await settleWithin(Promise.resolve(null), 1000, 'fulfilled null'), null)

  let error = null
  try {
    await settleWithin(new Promise(() => {}), 25, 'held fixture gate')
  } catch (err) {
    error = err
  }

  t.ok(error instanceof Error, 'a timeout rejects instead of resolving null')
  t.ok(error.message.includes('held fixture gate'), 'the timeout names the held gate')
})

test('untrusted-writers - captures a larger hint while filtering and hands off the latest length', async function (t) {
  const fixture = await createReclaimFixture(t)
  const reader = await openCappedReader(t, fixture)
  const h1Writer = reader.writers.active.get(fixture.h1Id)
  const h2Writer = reader.writers.active.get(fixture.h2Id)
  const stop = connectDependencyPeers(t, fixture, reader)

  let originalAdd = null
  let originalFilter = null

  try {
    await waitFor(
      'the capped reader to reclaim for the source dependency',
      dependencyProgressState(reader, fixture, { h1: h1Writer, h2: h2Writer })
    )

    const closed = [h1Writer, h2Writer].filter((writer) => writer.isClosed)
    t.is(closed.length, 1, 'one idle head was reclaimed for the dependency')
    const victim = closed[0]
    const victimId = victim.id
    const victimKey = victim.core.key
    const other = victim === h1Writer ? h2Writer : h1Writer

    await quiesce(async () => ({
      active: reader.writers.size,
      source: await length(reader, fixture.source.local.key),
      opened: reader.stats.writersOpened,
      closed: reader.stats.writersClosed,
      drains: reader.stats.drains
    }))

    if (reader.writers.size >= CAP) {
      await reader.writers.remove(other.core.key)
    }

    t.ok(reader.writers.size < CAP, 'a slot is genuinely free for the retry')

    const record = reader.writers._reclaimed.get(victimId)
    t.ok(record, 'the reclaimed identity still has a record')
    record.length = 2
    t.is(record.length, 2, 'a remembered length of two is the starting obligation')

    // hold the admission of the retried tail, then deliver a larger announcement
    // through the direct wakeup path. its capture must run before its first await.
    originalAdd = reader.writers._addUnlocked
    const addEntered = Promise.withResolvers()
    const addRelease = Promise.withResolvers()
    let addArmed = true
    t.teardown(addRelease.resolve)

    reader.writers._addUnlocked = async function (key, id) {
      if (addArmed && id === victimId) {
        addArmed = false
        addEntered.resolve()
        await addRelease.promise
      }

      return originalAdd.call(this, key, id)
    }

    const closedBeforeRetry = reader.stats.writersClosed
    const refreshing = reader.writers._refreshReclaimed([])
    await settleWithin(addEntered.promise, 10_000, 'tail retry admission')

    const announcing = reader.writers.wakeup(victimKey, 3)
    t.is(
      reader.writers._reclaimed.get(victimId).length,
      3,
      'the direct wakeup captured three before its first await'
    )

    addRelease.resolve()
    await settleWithin(refreshing, 10_000, 'tail retry with latest hint')
    await announcing

    const admitted = reader.writers.active.get(victimId)
    t.ok(admitted, 'the tail was admitted by the retry')
    t.ok(admitted.hintedLength >= 3, 'the handoff transferred the latest captured length')
    t.absent(reader.writers._reclaimed.get(victimId), 'the handed-off record was deleted')
    t.is(reader.writers.size, CAP, 'the retry filled the free slot')
    t.is(
      reader.stats.writersClosed,
      closedBeforeRetry,
      'the tail retry closed no additional victim'
    )

    reader.writers._addUnlocked = originalAdd
    originalAdd = null

    // now hold filtering with an existing record and deliver a larger flushed hint
    const filtered = { key: b4a.from(victimKey), length: 2 }
    reader.writers._reclaimed.set(victimId, filtered)

    originalFilter = reader._filterHints
    const filterEntered = Promise.withResolvers()
    const filterRelease = Promise.withResolvers()
    let filterArmed = true
    t.teardown(filterRelease.resolve)

    reader._filterHints = async function (hints) {
      if (filterArmed) {
        filterArmed = false
        filterEntered.resolve(hints)
        await filterRelease.promise
      }

      return originalFilter.call(this, hints)
    }

    reader.hintWakeup({ key: victimKey, length: 3 })
    const applying = reader._applyWakeupHints()

    await settleWithin(filterEntered.promise, 10_000, 'wakeup filtering')

    t.is(
      reader.writers._reclaimed.get(victimId).length,
      3,
      'the raw flushed length was captured before filtering awaited'
    )

    filterRelease.resolve()
    await settleWithin(applying, 10_000, 'wakeup application')

    t.absent(
      reader.writers._reclaimed.get(victimId),
      'the filtered announcement handed off cleanly'
    )
    t.ok(admitted.hintedLength >= 3, 'the existing writer received the filtered announcement')
  } finally {
    if (originalAdd) reader.writers._addUnlocked = originalAdd
    if (originalFilter) reader._filterHints = originalFilter
    await stop()
  }
})

test('untrusted-writers - captures positive ingress for existing records only', async function (t) {
  const auto = await create(t)
  const trackedKey = crypto.keyPair().publicKey
  const untrackedKey = crypto.keyPair().publicKey
  const otherKey = crypto.keyPair().publicKey
  const trackedId = hex(trackedKey)
  const otherId = hex(otherKey)
  const tracked = { key: b4a.from(trackedKey), length: 1 }
  const other = { key: b4a.from(otherKey), length: 1 }

  auto.writers._reclaimed.set(trackedId, tracked)
  auto.writers._reclaimed.set(otherId, other)

  const bumps = []
  const realBump = auto.bumpSoon
  auto.bumpSoon = function (...args) {
    bumps.push(Date.now())
    return realBump.apply(this, args)
  }

  try {
    auto.writers.captureReclaimedAnnouncements({ key: trackedKey, length: 2 })
    t.is(tracked.length, 2, 'direct capture raises an existing record')
    t.is(bumps.length, 0, 'capture alone never bumps')

    auto.hintWakeup({ key: trackedKey, length: 3 })
    t.is(tracked.length, 3, 'single-object ingress captured the positive maximum')
    t.is(auto._wakeup.hints.get(trackedId), 3, 'single-object ingress stayed queued')
    t.is(bumps.length, 1, 'hint delegated exactly once to the upstream bump')

    const batch = [
      { key: trackedKey, length: 4 },
      { key: untrackedKey, length: 5 }
    ]
    auto.hintWakeup(batch)
    t.is(tracked.length, 4, 'batch ingress captured the positive maximum')
    t.is(auto._wakeup.hints.get(trackedId), 4, 'batch ingress stayed queued')
    t.absent(auto.writers._reclaimed.get(hex(untrackedKey)), 'untracked keys never grow the ledger')
    t.is(auto.writers._reclaimed.size, 2, 'batch ingress left the ledger size alone')
    t.is(auto._wakeup.hints.get(hex(untrackedKey)), 5, 'the untracked hint stayed in the queue')
    t.is(bumps.length, 2, 'batch ingress also bumped exactly once')

    auto.hintWakeup([
      { key: otherKey, length: 3 },
      { key: otherKey, length: -1 }
    ])
    t.is(other.length, 3, 'a batch followed by an unknown kept the positive maximum')
    t.is(auto._wakeup.hints.get(otherId), -1, 'the batch unknown stayed queued')

    auto.hintWakeup([
      { key: trackedKey, length: -1 },
      { key: untrackedKey, length: -1 }
    ])
    t.is(tracked.length, 4, 'unknown-only ingress kept the positive maximum')
    t.is(other.length, 3, 'unknown-only ingress did not invent an obligation')
    t.is(auto._wakeup.hints.get(trackedId), -1, 'the supported unknown length stayed queued')
    t.absent(
      auto.writers._reclaimed.get(hex(untrackedKey)),
      'unknown-only ingress created no record'
    )

    auto.hintWakeup({ key: trackedKey, length: 2 })
    t.is(tracked.length, 4, 'a lower positive cannot lower the remembered maximum')
    t.is(auto._wakeup.hints.get(trackedId), 2, 'the upstream queue kept its normal latest value')
  } finally {
    auto.bumpSoon = realBump
  }
})

test('untrusted-writers - announcement capture is safe before ready and after close', async function (t) {
  const store = new Corestore(await t.tmp(), { manifestVersion: 2 })
  t.teardown(() => store.close())

  const auto = new Autobee(store, { apply })
  t.teardown(() => auto.close())

  const key = crypto.keyPair().publicKey
  const id = hex(key)

  t.absent(auto.writers, 'writers do not exist yet')
  auto._wakeup.hint({ key, length: 1 })
  t.is(auto._wakeup.hints.get(id), 1, 'the upstream queue still accepts a pre-ready hint')
  auto._wakeup.hints.clear()

  await auto.ready()
  t.ok(auto.writers, 'writers exist after ready')
  t.absent(auto.writers._reclaimed.has(id), 'the pre-ready announcement created no record')

  auto.writers._reclaimed.set(id, { key: b4a.from(key), length: 1 })
  await auto.close()
  t.is(auto.writers._reclaimed.size, 0, 'close cleared the ledger')

  auto.hintWakeup({ key, length: 2 })
  t.absent(
    auto.writers._reclaimed.get(id),
    'an announcement after close cannot repopulate the ledger'
  )
})

test('untrusted-writers - a supplied wakeup protocol keeps base ownership semantics', async function (t) {
  const store = new Corestore(await t.tmp(), { manifestVersion: 2 })
  t.teardown(() => store.close())

  const protocol = {
    destroys: 0,
    sessions: [],
    addStream() {},
    session() {
      const session = {
        peers: [],
        destroyed: false,
        destroy() {
          this.destroyed = true
        }
      }
      this.sessions.push(session)
      return session
    },
    destroy() {
      this.destroys++
    }
  }

  const auto = new Autobee(store, { apply, wakeup: protocol })
  t.teardown(() => auto.close())

  t.absent(auto._wakeup._owner, 'the supplied protocol is not owned by the wakeup wrapper')
  await auto.ready()
  await auto.close()

  t.is(protocol.destroys, 0, 'closing the autobee does not destroy the supplied protocol')
  t.ok(
    protocol.sessions.every((session) => session.destroyed),
    'the wrapper still closed its own session'
  )
})

test('untrusted-writers - hands off records on existing, local and rotation ownership', async function (t) {
  const fixture = await createReclaimFixture(t)
  const reader = await openCappedReader(t, fixture)
  const h1Writer = reader.writers.active.get(fixture.h1Id)
  const h2Writer = reader.writers.active.get(fixture.h2Id)

  try {
    // existing admission
    const existingRecord = { key: b4a.from(h2Writer.core.key), length: 2 }
    reader.writers._reclaimed.set(h2Writer.id, existingRecord)
    await reader.writers.add(h2Writer.core.key)

    t.ok(h2Writer.hintedLength >= 2, 'the existing writer received the remembered length')
    t.absent(reader.writers._reclaimed.has(h2Writer.id), 'the existing record was deleted')

    // local admission
    const localId = hex(reader.local.key)
    const localRecord = { key: b4a.from(reader.local.key), length: 2 }
    reader.writers._reclaimed.set(localId, localRecord)
    await reader.writers.add(reader.local.key)

    t.ok(
      reader.writers.localWriter.hintedLength >= 2,
      'the local writer received the remembered length'
    )
    t.absent(reader.writers._reclaimed.has(localId), 'the local record was deleted')

    // rotation ownership
    const target = reader.store.get({ name: 'rotate-handoff' })
    await target.ready()
    await target.append(Autobee.encodeValue(encode({ rotate: true }), { optimistic: true }))

    const targetId = hex(target.key)
    reader.writers._reclaimed.set(targetId, { key: b4a.from(target.key), length: 1 })

    const rotated = new Promise((resolve) => reader.once('rotate-local-writer', resolve))
    await reader.setLocal(target.key)
    await settleWithin(rotated, 10_000, 'local rotation')

    t.ok(
      b4a.equals(reader.writers.localWriter.core.key, target.key),
      'the rotated writer owns the new local core'
    )
    t.is(
      reader.writers.active.get(targetId),
      reader.writers.localWriter,
      'exactly one local writer owns the rotated key'
    )
    t.ok(reader.writers.localWriter.hintedLength >= 1, 'rotation transferred the remembered length')
    t.absent(reader.writers._reclaimed.has(targetId), 'rotation deleted the handed-off record')

    // keep the fixture writers referenced so the test documents all ownership paths
    t.ok(h1Writer, 'the other idle head is still tracked by the fixture')
  } finally {
    await reader.close()
  }
})

test('untrusted-writers - dependency shortcuts hand off reclaimed records', async function (t) {
  const auto = await create(t, { isTrusted: () => false, maxUntrustedWriters: 4 })
  await auto.append(encode({ init: true }))
  await auto.update()

  const writers = auto.writers
  const externalKey = crypto.keyPair().publicKey
  const externalId = hex(externalKey)
  const external = await writers.add(externalKey)

  t.ok(external, 'the external writer was admitted for the shortcut')
  t.is(writers.active.get(externalId), external, 'the external writer owns its shortcut identity')

  external.hintedLength = 2
  writers._reclaimed.set(externalId, { key: b4a.from(externalKey), length: 3 })

  const externalAdvanced = await writers._reclaimForDependenciesUnlocked([
    { key: externalKey, length: 2 }
  ])

  t.is(externalAdvanced, true, 'the external handoff reported live advancement')
  t.is(external.hintedLength, 3, 'the external shortcut transferred the latest length')
  t.absent(
    writers._reclaimed.get(externalId),
    'the external shortcut deleted the handed-off record'
  )

  const localId = hex(auto.local.key)
  const localApplied = await length(auto, auto.local.key)
  const localRecordLength = localApplied + 2
  const localWriter = writers.localWriter

  writers._reclaimed.set(localId, { key: b4a.from(auto.local.key), length: localRecordLength })

  const localAdvanced = await writers._reclaimForDependenciesUnlocked([
    { key: auto.local.key, length: localApplied + 1 }
  ])

  t.is(localAdvanced, true, 'the local handoff reported live advancement')
  t.ok(
    localWriter.hintedLength >= localRecordLength,
    'the local shortcut transferred the latest length'
  )
  t.absent(writers._reclaimed.get(localId), 'the local shortcut deleted the handed-off record')
})

test('untrusted-writers - reconciliation retains obligations across cleanup races', async function (t) {
  const auto = await create(t, { isTrusted: () => false, maxUntrustedWriters: 2 })
  await auto.append(encode({ init: 1 }))
  await auto.update()
  await auto.append(encode({ init: 2 }))
  await auto.update()

  const writers = auto.writers
  const keyA = crypto.keyPair().publicKey
  const idA = hex(keyA)
  const originalGet = auto.system.get

  let pending = null
  auto.system.get = async function (key) {
    if (pending && b4a.equals(key, pending.key)) {
      await pending.promise
      return pending.info
    }
    return originalGet.call(this, key)
  }

  t.teardown(() => {
    auto.system.get = originalGet
  })

  const gateRead = (info) => {
    const gate = Promise.withResolvers()
    pending = { key: keyA, info, promise: gate.promise }
    return gate
  }

  try {
    // a larger positive hint arrives while the cleanup read is in flight
    const record = { key: b4a.from(keyA), length: 1 }
    writers._reclaimed.set(idA, record)
    let gate = gateRead({ length: 1 })
    let reconciling = writers._reconcileReclaimedUnlocked()
    writers.captureReclaimedHints(new Map([[idA, 3]]))
    gate.resolve()
    await reconciling
    t.is(writers._reclaimed.get(idA), record, 'the ahead tail was not deleted')
    t.is(record.length, 3, 'the raw positive hint raised the remembered length')

    // a queued unknown length prevents cleanup even when the applied state and
    // non-head identity would otherwise delete the record
    auto._wakeup.hints.set(idA, -1)
    record.length = 3
    gate = gateRead({ length: 3 })
    reconciling = writers._reconcileReclaimedUnlocked()
    gate.resolve()
    await reconciling
    t.is(writers._reclaimed.get(idA), record, 'the unknown queued hint prevented cleanup')
    t.is(record.length, 3, 'the unknown queued hint did not erase the known length')
    t.absent(auto.system.isHead(keyA), 'the unknown-hint record is not a head')
    t.ok(3 >= record.length, 'the applied length would have satisfied cleanup without -1')

    auto._wakeup.hints.delete(idA)
    writers._reclaimed.get(idA).length = 1
    pending = { key: keyA, info: { length: 1 }, promise: Promise.resolve() }
    const cleaned = await writers._reconcileReclaimedUnlocked()
    t.is(cleaned, false, 'cleanup alone did not report live advancement')
    t.absent(writers._reclaimed.get(idA), 'a satisfied non-head obligation was cleaned up')

    // a replacement record during the read is not deleted through the old entry
    const replacement = { key: b4a.from(keyA), length: 1 }
    writers._reclaimed.set(idA, replacement)
    gate = gateRead({ length: 1 })
    reconciling = writers._reconcileReclaimedUnlocked()
    writers._reclaimed.set(idA, { key: b4a.from(keyA), length: 1 })
    gate.resolve()
    await reconciling
    t.ok(writers._reclaimed.has(idA), 'the replacement record was retained')

    // actual system-tree movement with unchanged summary coordinates defers deletion
    const changed = { key: b4a.from(keyA), length: 1 }
    const head = auto.system.bee.head()
    const root = auto.system.bee.root
    const view = auto.system.view
    const summary = {
      flushes: auto.system.flushes,
      version: auto.system.version,
      heads: auto.system.heads.length,
      viewKey: view && view.key ? hex(view.key) : 'none',
      viewLength: view ? view.length : 0
    }

    t.ok(head.length >= 2, 'the test system has a previous root to move to')

    writers._reclaimed.set(idA, changed)
    gate = gateRead({ length: 1 })
    reconciling = writers._reconcileReclaimedUnlocked()
    auto.system.bee.move({ length: head.length - 1, key: head.key })

    const moved = auto.system.view
    t.not(auto.system.bee.root, root, 'the actual system root moved during the read')
    t.is(auto.system.flushes, summary.flushes, 'the flush count stayed unchanged')
    t.is(auto.system.version, summary.version, 'the version stayed unchanged')
    t.is(auto.system.heads.length, summary.heads, 'the summary head count stayed unchanged')
    t.is(
      moved && moved.key ? hex(moved.key) : 'none',
      summary.viewKey,
      'the application view key stayed unchanged'
    )
    t.is(
      moved ? moved.length : 0,
      summary.viewLength,
      'the application view length stayed unchanged'
    )

    gate.resolve()
    await reconciling
    t.is(writers._reclaimed.get(idA), changed, 'the actual root move deferred cleanup')
    auto.system.bee.move(head)

    // an ahead tail is retained even when flush counts decrease, and a covered
    // non-head is removed once the applied state actually covers it
    changed.length = 2
    auto.system.flushes = 0
    pending = { key: keyA, info: { length: 1 }, promise: Promise.resolve() }
    await writers._reconcileReclaimedUnlocked()
    t.ok(writers._reclaimed.has(idA), 'the ahead tail survived a lower flush count')

    pending = { key: keyA, info: { length: 2 }, promise: Promise.resolve() }
    await writers._reconcileReclaimedUnlocked()
    t.absent(writers._reclaimed.has(idA), 'the covered non-head was removed from current state')
    auto.system.flushes = summary.flushes

    // a live handoff is real advancement and reports that, unlike cleanup
    const localId = hex(auto.local.key)
    const localLength = writers.localWriter.hintedLength + 1
    writers._reclaimed.set(localId, { key: b4a.from(auto.local.key), length: localLength })
    const handedOff = await writers._reconcileReclaimedUnlocked()
    t.is(handedOff, true, 'a handoff that advanced live work reported advancement')
    t.ok(writers.localWriter.hintedLength >= localLength, 'the local writer received the handoff')
    t.absent(writers._reclaimed.has(localId), 'the handed-off local record was deleted')
  } finally {
    auto._wakeup.hints.delete(idA)
    auto.system.get = originalGet
  }
})

test('untrusted-writers - the refresh scheduler prioritizes dependencies and stays quiescent', async function (t) {
  const auto = await create(t, {
    isTrusted: () => false,
    maxUntrustedWriters: 2,
    maxReclaimedWriters: 1
  })
  await auto.append(encode({ init: true }))
  await auto.update()

  const writers = auto.writers
  const dependencyKey = crypto.keyPair().publicKey
  const dependencyId = hex(dependencyKey)
  const tailKey = crypto.keyPair().publicKey
  const tailId = hex(tailKey)

  t.is(await auto.isLocalTrusted(), false, 'the local writer is not bootstrap-trusted')
  t.is(auto.system.isGenesis(), false, 'the system has left genesis before the cap checks')

  writers._reclaimed.set(tailId, { key: b4a.from(tailKey), length: 1 })

  try {
    // one genuinely free slot, a missing dependency and a remembered tail: the
    // actual orchestrator must run the dependency stage before tail retry
    const order = []
    const realDependencies = writers._reclaimForDependenciesUnlocked
    const realRetry = writers._retryReclaimedUnlocked

    writers._reclaimForDependenciesUnlocked = function (...args) {
      order.push('dependencies')
      return realDependencies.apply(this, args)
    }
    writers._retryReclaimedUnlocked = function (...args) {
      order.push('retry')
      return realRetry.apply(this, args)
    }

    try {
      await writers._refreshReclaimed([{ key: dependencyKey, length: 1 }])
    } finally {
      writers._reclaimForDependenciesUnlocked = realDependencies
      writers._retryReclaimedUnlocked = realRetry
    }

    t.alike(order, ['dependencies', 'retry'], 'the scheduler ran dependencies before retry')
    t.ok(writers.has(dependencyId), 'the dependency used the genuinely free slot')
    t.is(writers.size, 2, 'the dependency filled the only free slot')
    t.absent(writers.has(tailId), 'the tail was not admitted without a slot')
    t.ok(writers._reclaimed.has(tailId), 'the remembered tail stayed reserved')

    const closed = auto.stats.writersClosed
    const opened = auto.stats.writersOpened

    for (let i = 0; i < 3; i++) {
      await writers._refreshReclaimed([])
    }

    t.is(auto.stats.writersClosed, closed, 'repeated orchestrator passes closed no victims')
    t.is(auto.stats.writersOpened, opened, 'repeated orchestrator passes opened no writers')
    t.ok(writers._reclaimed.has(tailId), 'the retained map is still present')

    const before = {
      active: [...writers.active.keys()].sort(),
      drains: auto.stats.drains,
      opened: auto.stats.writersOpened,
      closed: auto.stats.writersClosed,
      records: writers._reclaimed.size
    }

    // the orchestrator with an empty snapshot performs no work and must not bump
    await writers._refreshReclaimed([])

    const afterOrchestration = {
      active: [...writers.active.keys()].sort(),
      drains: auto.stats.drains,
      opened: auto.stats.writersOpened,
      closed: auto.stats.writersClosed,
      records: writers._reclaimed.size
    }
    t.alike(afterOrchestration, before, 'retained-map presence alone did not schedule work')

    await new Promise((resolve) => setTimeout(resolve, 400))

    const after = {
      active: [...writers.active.keys()].sort(),
      drains: auto.stats.drains,
      opened: auto.stats.writersOpened,
      closed: auto.stats.writersClosed,
      records: writers._reclaimed.size
    }
    t.alike(after, before, 'the all-busy reader stayed quiescent')
  } finally {
    await auto.close()
  }
})

test('untrusted-writers - close during a held tail retry clears the ledger', async function (t) {
  const auto = await create(t, {
    isTrusted: () => false,
    maxUntrustedWriters: 2,
    maxReclaimedWriters: 1
  })
  const writers = auto.writers
  const tailKey = crypto.keyPair().publicKey
  const tailId = hex(tailKey)
  const openedBefore = auto.stats.writersOpened

  writers._reclaimed.set(tailId, { key: b4a.from(tailKey), length: 1 })

  const originalAdd = writers._addUnlocked
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  let armed = true
  t.teardown(release.resolve)

  writers._addUnlocked = async function (key, id) {
    if (armed && id === tailId) {
      armed = false
      entered.resolve()
      await release.promise
    }

    return originalAdd.call(this, key, id)
  }

  const refreshing = writers._refreshReclaimed([])
  await settleWithin(entered.promise, 10_000, 'tail retry before close')

  t.ok(writers._reclaimed.has(tailId), 'the retry reached the held admission with a record')
  const closing = auto.close().then(() => 'closed')

  await waitFor(
    'close to interrupt the held retry',
    () => ({
      ok: auto._interrupting && auto.writers._closed,
      interrupting: auto._interrupting,
      closed: auto.writers._closed,
      records: writers._reclaimed.size
    }),
    5000
  )

  release.resolve()
  await settleWithin(refreshing, 10_000, 'interrupted tail retry')
  t.is(await settleWithin(closing, 10_000, 'close after held retry'), 'closed')

  t.is(writers.size, 0, 'the active map is empty after close')
  t.is(writers._reclaimed.size, 0, 'the ledger is empty after close')
  t.is(auto.stats.writersOpened, openedBefore, 'the held retry never opened a writer')
  await new Promise((resolve) => setTimeout(resolve, 50))
  t.is(writers.size, 0, 'no writer was reopened after close')
  t.is(writers._reclaimed.size, 0, 'no record was reinserted after close')

  writers._addUnlocked = originalAdd
})

test('untrusted-writers - close during rotation detach attaches no replacement', async function (t) {
  const auto = await create(t)
  const writers = auto.writers
  const target = auto.store.get({ name: 'lifecycle-rotation-target' })
  await target.ready()

  const targetId = hex(target.key)
  const local = writers.localWriter
  const originalDetach = local.detachAndClose
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  let armed = true

  local.detachAndClose = async function (...args) {
    if (armed) {
      armed = false
      entered.resolve()
      await release.promise
    }
    return originalDetach.apply(this, args)
  }
  t.teardown(release.resolve)

  const rotating = writers.rotateLocalWriter(target).then(
    (value) => value,
    (err) => err
  )

  try {
    await settleWithin(entered.promise, 10_000, 'rotation detach')

    const closing = auto.close()
    await waitFor(
      'close to interrupt the rotation',
      () => ({
        ok: writers._closed && auto._interrupting,
        closed: writers._closed,
        interrupting: auto._interrupting
      }),
      5000
    )
    await settleWithin(closing, 10_000, 'close during rotation')

    release.resolve()

    const result = await settleWithin(rotating, 10_000, 'rotation after close')
    t.is(result, false, 'rotation stopped without creating a new local owner')
    t.is(writers.size, 0, 'the active map stayed empty after rotation resumed')
    t.absent(writers.has(targetId), 'the rotated target was not attached after close')
    t.is(writers._reclaimed.size, 0, 'no reclaimed record was reinserted after close')
  } finally {
    release.resolve()
    local.detachAndClose = originalDetach
    await auto.close()
  }
})

test('untrusted-writers - close during local admission update reattaches nothing', async function (t) {
  const auto = await create(t)
  await auto.update()

  const writers = auto.writers
  const local = writers.localWriter
  const id = hex(auto.local.key)
  const originalUpdate = local.update
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  let armed = true

  local.update = async function (...args) {
    if (armed) {
      armed = false
      entered.resolve()
      await release.promise
      return this.core.length
    }
    return originalUpdate.apply(this, args)
  }
  t.teardown(release.resolve)

  const adding = writers.add(auto.local.key).then(
    (value) => value,
    (err) => err
  )

  try {
    await settleWithin(entered.promise, 10_000, 'local admission update')
    await settleWithin(writers.close(), 10_000, 'writers close during local admission')

    release.resolve()

    const result = await settleWithin(adding, 10_000, 'local admission after close')
    t.is(result, null, 'local admission stopped after the writers closed')
    t.is(writers.size, 0, 'the local writer was not reattached after close')
    t.absent(writers.has(id), 'the local identity stayed absent from the active map')
  } finally {
    release.resolve()
    local.update = originalUpdate
    await auto.close()
  }
})

test('untrusted-writers - close during the trusted admission check allocates nothing', async function (t) {
  const auto = await create(t, { isTrusted: () => false, maxUntrustedWriters: 1 })
  await auto.append(encode({ init: true }))
  await auto.update()

  const writers = auto.writers
  const key = crypto.keyPair().publicKey
  const id = hex(key)
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const originalTrusted = auto.isLocalTrusted
  const originalGet = auto.store.get
  const opened = auto.stats.writersOpened
  const calls = { get: 0 }
  let armed = true

  auto.isLocalTrusted = async function (...args) {
    if (armed) {
      armed = false
      entered.resolve()
      await release.promise
      return true
    }
    return originalTrusted.apply(this, args)
  }
  auto.store.get = function (...args) {
    calls.get++
    return originalGet.apply(this, args)
  }
  t.teardown(() => {
    release.resolve()
    auto.isLocalTrusted = originalTrusted
    auto.store.get = originalGet
  })

  const adding = writers.add(key).then(
    (value) => value,
    (err) => err
  )

  try {
    await settleWithin(entered.promise, 10_000, 'trusted admission check')

    const closing = auto.close()
    await waitFor(
      'close to interrupt the trust check',
      () => ({
        ok: writers._closed && auto._interrupting,
        closed: writers._closed,
        interrupting: auto._interrupting
      }),
      5000
    )
    await settleWithin(closing, 10_000, 'close during trusted admission')

    release.resolve()

    const result = await settleWithin(adding, 10_000, 'trusted admission after close')
    t.is(result, null, 'the trusted admission stopped after close')
    t.is(calls.get, 0, 'no store core was allocated after the trust await')
    t.is(auto.stats.writersOpened, opened, 'the closed admission never counted an open writer')
    t.is(writers.size, 0, 'the active map stayed empty after close')
    t.absent(writers.has(id), 'the refused identity did not enter the active map')
  } finally {
    release.resolve()
    auto.isLocalTrusted = originalTrusted
    auto.store.get = originalGet
    await auto.close()
  }
})

test('untrusted-writers - default refresh retains records and normal refresh revalidates them', async function (t) {
  const auto = await create(t, { isTrusted: () => false, maxUntrustedWriters: 2 })
  await auto.append(encode({ init: true }))
  await auto.update()

  const writers = auto.writers
  const key = crypto.keyPair().publicKey
  const id = hex(key)
  const tailKey = crypto.keyPair().publicKey
  const tailId = hex(tailKey)
  const originalGet = auto.system.get
  let applied = 1

  t.is(await auto.isLocalTrusted(), false, 'the local writer is not bootstrap-trusted')
  t.is(writers.size, 1, 'the local writer leaves one free untrusted slot')

  auto.system.get = function (target) {
    if (b4a.equals(target, key)) return Promise.resolve({ length: applied })
    if (b4a.equals(target, tailKey)) return Promise.resolve({ length: 0 })
    return originalGet.call(this, target)
  }

  t.teardown(() => {
    auto.system.get = originalGet
  })

  try {
    const record = { key: b4a.from(key), length: 1 }
    const tail = { key: b4a.from(tailKey), length: 1 }
    writers._reclaimed.set(id, record)
    writers._reclaimed.set(tailId, tail)

    const closed = auto.stats.writersClosed
    const opened = auto.stats.writersOpened

    // Both records are actionable if the scheduler runs: the non-head obligation
    // is already satisfied, and the free slot could admit the remembered tail.
    t.ok(
      (await auto.system.get(key)).length >= record.length && !auto.system.isHead(key),
      'the non-head record would be cleaned up by reconciliation'
    )
    t.ok((await auto.system.get(tailKey)).length < tail.length, 'the tail would be retried')
    t.ok(writers.size < writers.maxUntrustedWriters, 'the tail has a free slot to take')

    // the fast-forward refresh path never reclaims or retries
    await writers.refresh()
    t.is(writers._reclaimed.get(id), record, 'the default refresh retained the satisfied record')
    t.is(writers._reclaimed.get(tailId), tail, 'the default refresh retained the retryable tail')
    t.is(writers.size, 1, 'the default refresh admitted no writer')
    t.is(auto.stats.writersClosed, closed, 'the default refresh reclaimed no writer')
    t.is(auto.stats.writersOpened, opened, 'the default refresh opened no writer')

    // a normal refresh with the same satisfied non-head state cleans it up and
    // progresses the tail into the slot the default refresh left untouched
    await writers.refresh({ reclaim: true })
    t.absent(writers._reclaimed.get(id), 'the normal refresh removed the satisfied record')
    t.absent(writers._reclaimed.get(tailId), 'the normal refresh handed off the retried tail')
    t.ok(writers.has(tailId), 'the normal refresh admitted the previously retired tail')
    t.is(writers.size, 2, 'the retried tail used the genuinely free slot')
    t.is(auto.stats.writersOpened, opened + 1, 'the normal refresh opened exactly the tail writer')

    // an ahead tail survives even when the flush count goes backwards
    applied = 1
    const ahead = { key: b4a.from(key), length: 2 }
    writers._reclaimed.set(id, ahead)
    const flushes = auto.system.flushes
    auto.system.flushes = 0
    await writers.refresh({ reclaim: true })
    t.is(writers._reclaimed.get(id), ahead, 'the ahead tail was revalidated against applied state')
    auto.system.flushes = flushes

    // once current applied state covers the tail, the next normal refresh removes it
    applied = 2
    await writers.refresh({ reclaim: true })
    t.absent(writers._reclaimed.get(id), 'the covered non-head tail was removed')
  } finally {
    auto.system.get = originalGet
  }
})

// The real apply helper writes each applied oplog reference as the value of a
// monotonically numbered #key. Reading those keys back gives the exact applied
// sequence, including repeats.
async function appliedOperations(auto) {
  const ops = []

  for await (const { key, value } of auto.view.createReadStream()) {
    if (b4a.toString(key)[0] === '#') ops.push(b4a.toString(value))
  }

  return ops
}

function absoluteHead(head) {
  return { key: head.key, length: head.start + head.length }
}

function headToken(head) {
  return head === null ? 'none' : hex(head.key) + ':' + head.length
}

// Fetch every block of a pinned checkpoint (the oplog head and the system and
// view cores it names) before disconnecting the peers. The real landing then
// runs with no announcer left to rescue a dropped record.
async function prefetchCore(auto, key, length, label, timeout = 20_000) {
  const core = auto.store.get({ key, active: true })

  try {
    await core.ready()
    await settleWithin(
      (async () => {
        while (core.length < length) await core.update({ wait: true })

        const download = core.download({ start: 0, end: length })
        try {
          await download.done()
        } finally {
          download.destroy()
        }
      })(),
      timeout,
      'prefetch ' + label
    )

    if (core.contiguousLength < length) {
      throw new Error(
        'prefetch ' + label + ' only contiguous ' + core.contiguousLength + '/' + length
      )
    }
  } finally {
    await core.close()
  }
}

test('untrusted-writers - a real fast-forward retains an announced tail behind its merged head', async function (t) {
  // Break caught: a real landing drops the pressure-created record (or its
  // ahead tail), so a tail announced while the victim was closed is lost.
  // A record created by actual pressure eviction and raised by a real positive
  // announcement has to survive a real fast-forward whose checkpoint merged the
  // victim's old head but predates the tail. The next normal refresh must hand
  // the remembered length to a live writer, and the tail must reach the final
  // view exactly once without another announcement.
  const fixture = await createReclaimFixture(t, { mergeOldHeads: true, stagger: true })
  const checkpoint = { key: fixture.admin.local.key, length: 0 }

  let admission = null
  let reader = null
  let stopFixture = null
  let stopDeps = null
  let stopCheckpoint = null
  let announcements = null
  let restoreRefresh = null
  let restoreWriters = null

  const victimEvents = { adds: 0, handoffs: [] }

  try {
    // The trusted admin applies the resident merge and the source dependency,
    // then publishes a real flush head. The victim tail does not exist yet, so
    // the checkpoint covers every applied branch but not the tail.
    stopFixture = connect(t, fixture.admin, ...fixture.pinned, fixture.source)
    await sync(fixture.admin, ...fixture.pinned, fixture.source)

    const base = await waitFor(
      'the checkpoint builder to apply the merge',
      async () => {
        const state = {
          h1: await length(fixture.admin, fixture.h1.local.key),
          h2: await length(fixture.admin, fixture.h2.local.key),
          resident: await length(fixture.admin, fixture.resident.local.key),
          source: await length(fixture.admin, fixture.source.local.key),
          h1Head: fixture.admin.system.isHead(fixture.h1.local.key),
          h2Head: fixture.admin.system.isHead(fixture.h2.local.key)
        }

        state.ok =
          state.h1 === 1 &&
          state.h2 === 1 &&
          state.resident === 2 &&
          state.source === 1 &&
          !state.h1Head &&
          !state.h2Head

        return state
      },
      15_000
    )

    t.ok(base.ok, 'the builder applied the merge and source dependency')

    await fixture.admin.append(encode({ checkpoint: 'fast-forward-without-tail' }))
    checkpoint.length = fixture.admin.local.length

    const block = encoding.decodeOplog(await fixture.admin.local.get(checkpoint.length - 1))

    t.ok(block.views, 'the pinned head is a real flush checkpoint')
    const checkpointSystem = absoluteHead(block.views.system)
    const checkpointView = absoluteHead(block.views.view)
    t.alike(
      checkpointSystem,
      fixture.admin.system.bee.head(),
      'the decoded system head is the builder checkpoint'
    )
    t.alike(
      checkpointView,
      fixture.admin._workingBee.head(),
      'the decoded view head is the builder checkpoint'
    )

    reader = await openCappedReader(t, fixture)
    const h1Writer = reader.writers.active.get(fixture.h1Id)
    const h2Writer = reader.writers.active.get(fixture.h2Id)
    t.ok(h1Writer && h2Writer, 'both idle fixture heads are admitted before pressure')
    t.is(reader.stats.fastForwards, 0, 'no fast-forward has run before the test')
    t.is(reader.stats.undos, 0, 'the staggered snapshot boot did not undo')

    // every branch the reader has applied is covered by the checkpoint
    for (const head of reader.system.heads) {
      t.ok(
        await fixture.admin.system.has(head),
        'the checkpoint covers the applied branch ' + headToken(head)
      )
    }

    admission = armDependencyAdmission(t, reader, fixture.sourceId)
    stopDeps = connectDependencyPeers(t, fixture, reader)
    await settleWithin(admission.entered, 15_000, 'pressure admission after reclaim')

    const closed = [h1Writer, h2Writer].filter((writer) => writer.isClosed)
    t.is(closed.length, 1, 'exactly one idle head was reclaimed for the dependency')

    const victim = closed[0]
    const victimId = victim.id
    const victimKey = victim.core.key
    const victimPeer = victim === h1Writer ? fixture.h1 : fixture.h2
    const victimName = victim === h1Writer ? fixture.names[0] : fixture.names[1]
    const otherVictimKey = victimId === fixture.h1Id ? fixture.h2.local.key : fixture.h1.local.key

    t.is(
      reader.writers._reclaimed.get(victimId).length,
      1,
      'the actual eviction started the record at the applied length'
    )
    t.absent(reader.writers.has(victimId), 'the victim session is closed at the reclaim')
    t.is(await length(fixture.admin, victimKey), 1, 'the checkpoint applied the merged old head')
    t.absent(fixture.admin.system.isHead(victimKey), 'the checkpoint merged the victim old head')
    t.is(reader.writers.size, CAP, 'the reclaimed slot is occupied')

    announcements = recordAnnouncements(reader, victimId)

    await victimPeer.append(encode({ from: victimName, n: 2 }))
    const positive = await waitFor(
      'the real positive tail announcement',
      () => {
        const record = reader.writers._reclaimed.get(victimId)
        return {
          ok: !!(record && record.length === 2) && announcements.seen.some((length) => length >= 2),
          record: record && record.length,
          seen: announcements.seen.slice()
        }
      },
      15_000
    )

    t.is(positive.record, 2, 'the raw announcement raised the record maximum')
    t.ok(
      positive.seen.some((length) => length === 2),
      'the positive length arrived over the real wakeup path'
    )

    // prefetch the tail and the checkpoint so a later positive cannot be the
    // recovery route, then remove every announcer before the landing
    await prefetchCore(reader, victimKey, 2, 'the reclaimed tail')
    stopCheckpoint = connect(t, fixture.admin, reader)
    await prefetchCore(reader, checkpoint.key, checkpoint.length, 'the checkpoint oplog')
    await prefetchCore(
      reader,
      checkpointSystem.key,
      checkpointSystem.length,
      'the checkpoint system'
    )
    await prefetchCore(reader, checkpointView.key, checkpointView.length, 'the checkpoint view')

    await stopCheckpoint()
    stopCheckpoint = null
    await stopDeps()
    stopDeps = null
    await stopFixture()
    stopFixture = null

    t.is(
      reader.writers._reclaimed.get(victimId).length,
      2,
      'the record still holds the announced maximum while closed and capped'
    )
    t.absent(reader.writers.has(victimId), 'the victim stayed closed while capped')
    t.ok(victim.isClosed, 'the reclaimed session stayed closed')
    t.is(reader.fastForwardTo, null, 'no automatic fast-forward ran during setup')
    t.is(reader.stats.fastForwards, 0, 'the landing is the only fast-forward')

    const announcementsAtDisconnect = announcements.seen.length
    const ffsBefore = reader.stats.fastForwards
    let postLanding = null

    const realRefresh = reader.writers.refresh
    reader.writers.refresh = async function (opts) {
      if (!postLanding && opts && opts.reclaim && reader.stats.fastForwards > ffsBefore) {
        const record = reader.writers._reclaimed.get(victimId)
        postLanding = {
          record: record ? record.length : null,
          applied: await length(reader, victimKey),
          head: reader.system.isHead(victimKey),
          active: reader.writers.has(victimId),
          records: reader.writers._reclaimed.size
        }
      }

      return realRefresh.call(this, opts)
    }
    restoreRefresh = () => {
      reader.writers.refresh = realRefresh
    }

    const realAddUnlocked = reader.writers._addUnlocked
    const realHandoff = reader.writers._handoffReclaimed

    reader.writers._addUnlocked = async function (key, id) {
      const writer = await realAddUnlocked.call(this, key, id)
      if (writer && id === victimId) victimEvents.adds++
      return writer
    }

    reader.writers._handoffReclaimed = function (writer) {
      const record = writer && writer.id === victimId ? this._reclaimed.get(victimId) : null
      const result = realHandoff.call(this, writer)

      if (record) {
        victimEvents.handoffs.push({
          record: record.length,
          queued: this.auto._wakeup.hints.get(victimId),
          announcements: announcements.seen.length
        })
      }

      return result
    }

    restoreWriters = () => {
      reader.writers._addUnlocked = realAddUnlocked
      reader.writers._handoffReclaimed = realHandoff
    }

    const moving = reader.moveTo(checkpoint, { timeout: 5_000 })
    const published = await waitFor(
      'the real fast-forward publication',
      () => ({
        ok: reader.fastForwardTo !== null,
        published: reader.fastForwardTo !== null
      }),
      15_000
    )

    t.ok(published.published, 'the real landing is scheduled by moveTo')
    admission.release()
    admission = null

    const landed = await settleWithin(moving, 20_000, 'the real fast-forward landing')
    t.ok(landed, 'the real fast-forward landed')
    t.is(reader.stats.fastForwards, ffsBefore + 1, 'exactly one real fast-forward completed')

    const boundary = await waitFor(
      'the post-landing reclaiming refresh',
      () => ({ ok: postLanding !== null, postLanding }),
      15_000
    )

    t.alike(
      boundary.postLanding,
      { record: 2, applied: 1, head: false, active: false, records: 1 },
      'the landed checkpoint merged the old head, kept the tail record and did not reopen'
    )

    const retried = await waitFor(
      'the retained tail to be handed to a live writer',
      async () => {
        const applied = await length(reader, victimKey)
        return {
          ok: applied === 2,
          applied,
          records: reader.writers._reclaimed.size,
          active: reader.writers.has(victimId)
        }
      },
      15_000
    )

    t.is(retried.applied, 2, 'the retained tail applied after the landing')
    t.is(retried.records, 0, 'the normal refresh handed off and removed the record')

    await quiesce(async () => ({
      ops: (await appliedOperations(reader)).length,
      records: reader.writers._reclaimed.size,
      active: reader.writers.size
    }))
    await reader.update()

    const ops = await appliedOperations(reader)
    // The checkpoint node links every current head, so the apply fast path keeps
    // it after the branch work instead of sorting it by its bootstrap weight.
    const expected = [
      fixture.adminId + '.1',
      fixture.adminId + '.2',
      fixture.adminId + '.3',
      fixture.adminId + '.4',
      fixture.h1Id + '.1',
      fixture.h2Id + '.1',
      fixture.residentId + '.1',
      fixture.sourceId + '.1',
      fixture.residentId + '.2',
      fixture.adminId + '.5',
      victimId + '.2'
    ]

    t.alike(ops, expected, 'the complete applied history is exactly the expected operations')
    t.is(await length(reader, fixture.admin.local.key), 5, 'the checkpoint node is applied')
    t.is(await length(reader, fixture.resident.local.key), 2, 'the resident merge is applied')
    t.is(await length(reader, fixture.source.local.key), 1, 'the source dependency is applied')
    t.is(await length(reader, victimKey), 2, 'the reclaimed tail is applied once')
    t.is(await length(reader, otherVictimKey), 1, 'the other idle head is unchanged')
    t.is(reader.writers._reclaimed.size, 0, 'the ledger is empty after the handoff')
    t.alike(
      decode((await reader.view.get(b4a.from('latest'))).value),
      { from: victimName, n: 2 },
      'the final view value is the reclaimed tail'
    )
    t.is(victimEvents.adds, 1, 'the tail used the normal retry admission exactly once')
    t.is(
      announcements.seen.length,
      announcementsAtDisconnect,
      'no later announcement rescued the tail'
    )

    const handoff = victimEvents.handoffs.find((entry) => entry.record === 2)
    t.ok(handoff, 'the handoff recorded the remembered maximum')
    t.is(handoff.queued, undefined, 'the handoff did not depend on a queued announcement')
    t.is(
      handoff.announcements,
      announcementsAtDisconnect,
      'the handoff happened without a new positive announcement'
    )
  } finally {
    if (admission) admission.release()
    if (announcements) announcements.restore()
    if (restoreRefresh) restoreRefresh()
    if (restoreWriters) restoreWriters()
    if (stopDeps) await stopDeps()
    if (stopCheckpoint) await stopCheckpoint()
    if (stopFixture) await stopFixture()
  }
})

test('untrusted-writers - a real fast-forward cleans a tail its checkpoint already applied', async function (t) {
  // Break caught: cleanup drops an ahead tail, or reopens a victim whose
  // checkpoint already applied the tail; either way the normal landing boundary
  // loses the record's exact obligation or does unnecessary writer work.
  // A record raised by a real positive announcement must survive the real
  // landing lifecycle, then be removed by ordinary reconciliation when the
  // landed checkpoint already applied the tail and merged its old head. The
  // victim must not be reopened just to discover that.
  const fixture = await createReclaimFixture(t, { mergeOldHeads: true, stagger: true })
  const checkpoint = { key: fixture.admin.local.key, length: 0 }

  let admission = null
  let reader = null
  let stopFixture = null
  let stopDeps = null
  let stopCheckpoint = null
  let announcements = null
  let restoreRefresh = null
  let restoreWriters = null

  const victimEvents = { adds: 0, handoffs: 0 }

  try {
    stopFixture = connect(t, fixture.admin, ...fixture.pinned, fixture.source)
    await sync(fixture.admin, ...fixture.pinned, fixture.source)
    await waitFor(
      'the checkpoint builder to apply the base merge',
      async () => {
        const resident = await length(fixture.admin, fixture.resident.local.key)
        return {
          ok:
            resident === 2 &&
            !fixture.admin.system.isHead(fixture.h1.local.key) &&
            !fixture.admin.system.isHead(fixture.h2.local.key),
          resident
        }
      },
      15_000
    )

    reader = await openCappedReader(t, fixture)
    const h1Writer = reader.writers.active.get(fixture.h1Id)
    const h2Writer = reader.writers.active.get(fixture.h2Id)
    t.ok(h1Writer && h2Writer, 'both idle fixture heads are admitted before pressure')

    admission = armDependencyAdmission(t, reader, fixture.sourceId)
    stopDeps = connectDependencyPeers(t, fixture, reader)
    await settleWithin(admission.entered, 15_000, 'pressure admission after reclaim')

    const closed = [h1Writer, h2Writer].filter((writer) => writer.isClosed)
    t.is(closed.length, 1, 'exactly one idle head was reclaimed for the dependency')

    const victim = closed[0]
    const victimId = victim.id
    const victimKey = victim.core.key
    const victimPeer = victim === h1Writer ? fixture.h1 : fixture.h2
    const victimName = victim === h1Writer ? fixture.names[0] : fixture.names[1]
    const otherVictimKey = victimId === fixture.h1Id ? fixture.h2.local.key : fixture.h1.local.key

    t.is(
      reader.writers._reclaimed.get(victimId).length,
      1,
      'the actual eviction started the record at the applied length'
    )
    t.absent(reader.writers.has(victimId), 'the victim session is closed at the reclaim')

    announcements = recordAnnouncements(reader, victimId)
    await victimPeer.append(encode({ from: victimName, n: 2 }))

    const positive = await waitFor(
      'the real positive announcement for the covered tail',
      () => {
        const record = reader.writers._reclaimed.get(victimId)
        return {
          ok: !!(record && record.length === 2) && announcements.seen.some((length) => length >= 2),
          record: record && record.length,
          seen: announcements.seen.slice()
        }
      },
      15_000
    )

    t.is(positive.record, 2, 'the record kept the announced maximum while capped')

    // The resident applies the announced tail and merges it with a later block.
    // The admin then applies that later block, so its checkpoint already covers
    // the tail and the old head is no longer a head.
    const residentTail = await waitFor(
      'the resident fixture to apply the announced tail',
      async () => {
        const resident = await length(fixture.resident, victimKey)
        return { ok: resident === 2, resident }
      },
      15_000
    )
    t.is(residentTail.resident, 2, 'a real peer applied the tail')

    await fixture.resident.append(encode({ from: 'b', n: 3 }))

    const composed = await waitFor(
      'the checkpoint builder to apply the tail merge',
      async () => {
        const state = {
          resident: await length(fixture.admin, fixture.resident.local.key),
          victim: await length(fixture.admin, victimKey),
          residentHead: fixture.admin.system.isHead(fixture.resident.local.key),
          victimHead: fixture.admin.system.isHead(victimKey)
        }

        state.ok =
          state.resident === 3 &&
          state.victim === 2 &&
          state.residentHead === true &&
          state.victimHead === false

        return state
      },
      15_000
    )

    t.ok(composed.ok, 'the builder applied the tail and merged it out of the heads')

    await fixture.admin.append(encode({ checkpoint: 'fast-forward-with-tail' }))
    checkpoint.length = fixture.admin.local.length

    const block = encoding.decodeOplog(await fixture.admin.local.get(checkpoint.length - 1))

    t.ok(block.views, 'the pinned head is a real flush checkpoint')
    const checkpointSystem = absoluteHead(block.views.system)
    const checkpointView = absoluteHead(block.views.view)
    t.alike(
      checkpointSystem,
      fixture.admin.system.bee.head(),
      'the decoded system head contains the tail merge'
    )
    t.alike(
      checkpointView,
      fixture.admin._workingBee.head(),
      'the decoded view head contains the applied tail'
    )
    t.is(await length(fixture.admin, victimKey), 2, 'the checkpoint already applied the tail')
    t.absent(
      fixture.admin.system.isHead(victimKey),
      'the checkpoint does not leave the victim as a head'
    )

    await prefetchCore(reader, checkpoint.key, checkpoint.length, 'the checkpoint oplog')
    stopCheckpoint = connect(t, fixture.admin, reader)
    await prefetchCore(
      reader,
      checkpointSystem.key,
      checkpointSystem.length,
      'the checkpoint system'
    )
    await prefetchCore(reader, checkpointView.key, checkpointView.length, 'the checkpoint view')

    await stopCheckpoint()
    stopCheckpoint = null
    await stopDeps()
    stopDeps = null
    await stopFixture()
    stopFixture = null

    t.is(
      reader.writers._reclaimed.get(victimId).length,
      2,
      'the record still holds the announced maximum at the landing boundary'
    )
    t.absent(reader.writers.has(victimId), 'the victim was not reopened by setup')
    t.is(reader.fastForwardTo, null, 'no automatic fast-forward ran during setup')
    t.is(reader.stats.fastForwards, 0, 'the landing is the only fast-forward')

    const openedAtLanding = reader.stats.writersOpened
    const ffsBefore = reader.stats.fastForwards
    let postLanding = null

    const realRefresh = reader.writers.refresh
    reader.writers.refresh = async function (opts) {
      if (!postLanding && opts && opts.reclaim && reader.stats.fastForwards > ffsBefore) {
        const record = reader.writers._reclaimed.get(victimId)
        postLanding = {
          record: record ? record.length : null,
          applied: await length(reader, victimKey),
          head: reader.system.isHead(victimKey),
          active: reader.writers.has(victimId),
          records: reader.writers._reclaimed.size
        }
      }

      return realRefresh.call(this, opts)
    }
    restoreRefresh = () => {
      reader.writers.refresh = realRefresh
    }

    const realAddUnlocked = reader.writers._addUnlocked
    const realHandoff = reader.writers._handoffReclaimed

    reader.writers._addUnlocked = async function (key, id) {
      const writer = await realAddUnlocked.call(this, key, id)
      if (writer && id === victimId) victimEvents.adds++
      return writer
    }

    reader.writers._handoffReclaimed = function (writer) {
      const result = realHandoff.call(this, writer)
      if (writer && writer.id === victimId) victimEvents.handoffs++
      return result
    }

    restoreWriters = () => {
      reader.writers._addUnlocked = realAddUnlocked
      reader.writers._handoffReclaimed = realHandoff
    }

    const moving = reader.moveTo(checkpoint, { timeout: 5_000 })
    const published = await waitFor(
      'the real fast-forward publication',
      () => ({
        ok: reader.fastForwardTo !== null,
        published: reader.fastForwardTo !== null
      }),
      15_000
    )

    t.ok(published.published, 'the real landing is scheduled by moveTo')
    admission.release()
    admission = null

    const landed = await settleWithin(moving, 20_000, 'the real fast-forward landing')
    t.ok(landed, 'the real fast-forward landed')
    t.is(reader.stats.fastForwards, ffsBefore + 1, 'exactly one real fast-forward completed')

    const boundary = await waitFor(
      'the post-landing reclaiming refresh',
      () => ({ ok: postLanding !== null, postLanding }),
      15_000
    )

    t.alike(
      boundary.postLanding,
      { record: 2, applied: 2, head: false, active: false, records: 1 },
      'the landed checkpoint covers the tail, so the record is only cleaned'
    )

    const cleaned = await waitFor(
      'the normal reconciliation to remove the covered record',
      () => ({
        ok:
          !reader.writers._reclaimed.has(victimId) &&
          !reader.writers.has(victimId) &&
          reader.stats.fastForwards === ffsBefore + 1,
        records: reader.writers._reclaimed.size,
        active: reader.writers.has(victimId),
        adds: victimEvents.adds,
        handoffs: victimEvents.handoffs
      }),
      15_000
    )

    t.is(cleaned.records, 0, 'normal reconciliation removed the covered record')
    t.absent(cleaned.active, 'the victim never re-entered the active map')
    t.is(cleaned.adds, 0, 'the victim writer was never opened for the covered tail')
    t.is(cleaned.handoffs, 0, 'the covered record was never handed off')
    t.is(reader.stats.writersOpened, openedAtLanding, 'the covered cleanup opened no writer at all')

    await quiesce(async () => ({
      ops: (await appliedOperations(reader)).length,
      records: reader.writers._reclaimed.size,
      active: reader.writers.size
    }))
    await reader.update()

    const ops = await appliedOperations(reader)
    const expected = [
      fixture.adminId + '.1',
      fixture.adminId + '.2',
      fixture.adminId + '.3',
      fixture.adminId + '.4',
      fixture.h1Id + '.1',
      fixture.h2Id + '.1',
      fixture.residentId + '.1',
      fixture.sourceId + '.1',
      fixture.residentId + '.2',
      victimId + '.2',
      fixture.residentId + '.3',
      fixture.adminId + '.5'
    ]

    t.alike(ops, expected, 'the complete applied history contains the tail exactly once')
    t.is(await length(reader, fixture.admin.local.key), 5, 'the checkpoint node is applied')
    t.is(await length(reader, fixture.resident.local.key), 3, 'the merged resident tail is applied')
    t.is(await length(reader, fixture.source.local.key), 1, 'the source dependency is applied')
    t.is(await length(reader, victimKey), 2, 'the covered tail stayed applied once')
    t.is(await length(reader, otherVictimKey), 1, 'the other idle head is unchanged')
    t.is(reader.writers._reclaimed.size, 0, 'the ledger is empty after cleanup')
    t.alike(
      decode((await reader.view.get(b4a.from('latest'))).value),
      { checkpoint: 'fast-forward-with-tail' },
      'the checkpoint value is the final applied node'
    )
    t.is(victimEvents.adds, 0, 'no victim writer was opened')
    t.is(victimEvents.handoffs, 0, 'no victim record was handed off')
  } finally {
    if (admission) admission.release()
    if (announcements) announcements.restore()
    if (restoreRefresh) restoreRefresh()
    if (restoreWriters) restoreWriters()
    if (stopDeps) await stopDeps()
    if (stopCheckpoint) await stopCheckpoint()
    if (stopFixture) await stopFixture()
  }
})

test('untrusted-writers - a real topological undo preserves a pressure-reclaimed announced tail', async function (t) {
  // Break caught: a real undo drops the pending reclaimed record, or the
  // reapply/retry leaves a duplicated or missing view entry.
  // A real late node produces a real topological undo after pressure already
  // created a positive reclaimed record. The working view moves through the
  // production undo path; the record and its announced maximum must survive,
  // and the normal reapply and retry must produce the exact history once.
  const fixture = await createReclaimFixture(t, {
    sourceFirst: true,
    mergeOldHeads: true,
    stagger: true
  })
  const reader = await openCappedReader(t, fixture, { fastForward: false })

  const h1Writer = reader.writers.active.get(fixture.h1Id)
  const h2Writer = reader.writers.active.get(fixture.h2Id)
  const undosBefore = reader.stats.undos
  const systemHeadBefore = headToken(reader.system.bee.head())
  const workingHeadBefore = headToken(reader._workingBee.head())
  const systemRootBefore = reader.system.bee.root
  const workingRootBefore = reader._workingBee.root

  t.ok(h1Writer && h2Writer, 'both idle fixture heads are admitted before pressure')
  t.is(undosBefore, 0, 'the source-first boot applied the heads without an undo')
  t.is(reader.stats.fastForwards, 0, 'fast-forward is disabled for this case')

  let admission = armDependencyAdmission(t, reader, fixture.sourceId)
  let stop = connectDependencyPeers(t, fixture, reader)
  let announcements = null
  let restoreApply = null
  let restoreWriters = null
  let releaseApply = null

  const victimEvents = { adds: 0, handoffs: [] }

  try {
    await settleWithin(admission.entered, 15_000, 'pressure admission after reclaim')

    const closed = [h1Writer, h2Writer].filter((writer) => writer.isClosed)
    t.is(closed.length, 1, 'exactly one idle head was reclaimed for the dependency')

    const victim = closed[0]
    const victimId = victim.id
    const victimKey = victim.core.key
    const victimPeer = victim === h1Writer ? fixture.h1 : fixture.h2
    const victimName = victim === h1Writer ? fixture.names[0] : fixture.names[1]
    const otherVictimKey = victimId === fixture.h1Id ? fixture.h2.local.key : fixture.h1.local.key

    t.is(
      reader.writers._reclaimed.get(victimId).length,
      1,
      'the actual eviction started the record at the applied length'
    )
    t.absent(reader.writers.has(victimId), 'the victim session is closed at the reclaim')

    announcements = recordAnnouncements(reader, victimId)
    await victimPeer.append(encode({ from: victimName, n: 2 }))

    const positive = await waitFor(
      'the real positive announcement for the pending tail',
      () => {
        const record = reader.writers._reclaimed.get(victimId)
        return {
          ok: !!(record && record.length === 2) && announcements.seen.some((length) => length >= 2),
          record: record && record.length,
          seen: announcements.seen.slice()
        }
      },
      15_000
    )

    t.is(positive.record, 2, 'the record kept the announced maximum before the undo')

    // No announcer may remain to repair a record the undo path lowers. Fetch
    // every block the reapply and retry need, then disconnect the real peers
    // before releasing the dependency into the actual undo.
    await prefetchCore(
      reader,
      fixture.admin.local.key,
      fixture.admin.local.length,
      'the admin oplog'
    )
    await prefetchCore(
      reader,
      fixture.source.local.key,
      fixture.source.local.length,
      'the source dependency'
    )
    await prefetchCore(
      reader,
      fixture.resident.local.key,
      fixture.resident.local.length,
      'the resident merge'
    )
    await prefetchCore(reader, victimKey, 2, 'the reclaimed tail')
    await prefetchCore(reader, otherVictimKey, 1, 'the other idle head')

    await stop()
    stop = null

    const announcementsAtDisconnect = announcements.seen.length
    const positivesAtDisconnect = announcements.seen.filter((length) => length >= 2).length

    t.is(
      reader.writers._reclaimed.get(victimId).length,
      2,
      'the record still holds the announced maximum with every announcer gone'
    )
    t.absent(reader.writers.has(victimId), 'the victim stayed closed before the undo')
    t.is(reader.stats.fastForwards, 0, 'the undo case never fast-forwards')

    const realApply = reader._handlers.apply
    const entered = Promise.withResolvers()
    releaseApply = Promise.withResolvers()
    let armed = true

    // Delegating apply gate: the production undo has already run and the
    // working view has moved, but the first post-undo batch has not applied.
    reader._handlers.apply = async function (nodes, view, host) {
      if (armed && reader.stats.undos > undosBefore) {
        armed = false

        const record = reader.writers._reclaimed.get(victimId)
        const state = {
          undos: reader.stats.undos,
          system: headToken(reader.system.bee.head()),
          working: headToken(reader._workingBee.head()),
          systemRoot: reader.system.bee.root,
          workingRoot: reader._workingBee.root,
          record: record ? record.length : null,
          active: reader.writers.has(victimId),
          announcements: announcements.seen.length,
          positives: announcements.seen.filter((length) => length >= 2).length
        }

        entered.resolve(state)
        await releaseApply.promise
      }

      return realApply(nodes, view, host)
    }
    restoreApply = () => {
      reader._handlers.apply = realApply
    }

    const realAddUnlocked = reader.writers._addUnlocked
    const realHandoff = reader.writers._handoffReclaimed

    reader.writers._addUnlocked = async function (key, id) {
      const writer = await realAddUnlocked.call(this, key, id)
      if (writer && id === victimId) victimEvents.adds++
      return writer
    }

    reader.writers._handoffReclaimed = function (writer) {
      const record = writer && writer.id === victimId ? this._reclaimed.get(victimId) : null
      const result = realHandoff.call(this, writer)

      if (record) {
        victimEvents.handoffs.push({
          record: record.length,
          queued: this.auto._wakeup.hints.get(victimId),
          announcements: announcements.seen.length,
          positives: announcements.seen.filter((length) => length >= 2).length
        })
      }

      return result
    }

    restoreWriters = () => {
      reader.writers._addUnlocked = realAddUnlocked
      reader.writers._handoffReclaimed = realHandoff
    }

    admission.release()
    admission = null

    const state = await settleWithin(entered.promise, 15_000, 'the apply gate after the real undo')

    t.is(state.undos, undosBefore + 1, 'exactly one real topological undo happened')
    t.not(state.system, systemHeadBefore, 'the actual system head moved through the undo')
    t.not(state.working, workingHeadBefore, 'the actual working view moved through the undo')
    t.not(state.systemRoot, systemRootBefore, 'the real system root changed at the undo')
    t.not(state.workingRoot, workingRootBefore, 'the real working root changed at the undo')
    t.is(state.record, 2, 'the pressure-created positive record survived the undo')
    t.absent(state.active, 'the undo did not reopen the reclaimed victim')
    t.is(
      state.announcements,
      announcementsAtDisconnect,
      'no announcement reached the reader through the undo'
    )
    t.is(
      state.positives,
      positivesAtDisconnect,
      'no positive announcement repaired the record through the undo'
    )

    releaseApply.resolve()
    releaseApply = null

    const recovered = await waitFor(
      'the reapply and retry after the undo',
      async () => {
        const victimLength = await length(reader, victimKey)
        return {
          ok:
            victimLength === 2 &&
            reader.writers._reclaimed.size === 0 &&
            reader.stats.undos === undosBefore + 1,
          victimLength,
          records: reader.writers._reclaimed.size,
          undos: reader.stats.undos
        }
      },
      15_000
    )

    t.is(recovered.victimLength, 2, 'the reclaimed tail applied after the undo')
    t.is(recovered.records, 0, 'the normal retry handed off and removed the record')

    await quiesce(async () => ({
      ops: (await appliedOperations(reader)).length,
      records: reader.writers._reclaimed.size,
      undos: reader.stats.undos
    }))
    await reader.update()

    const ops = await appliedOperations(reader)
    const expected = [
      fixture.adminId + '.1',
      fixture.adminId + '.2',
      fixture.adminId + '.3',
      fixture.adminId + '.4',
      fixture.sourceId + '.1',
      fixture.residentId + '.1',
      fixture.h1Id + '.1',
      fixture.h2Id + '.1',
      fixture.residentId + '.2',
      victimId + '.2'
    ]

    t.alike(ops, expected, 'the complete applied history has no missing or duplicate refs')
    t.is(reader.stats.undos, undosBefore + 1, 'the final history used exactly one real undo')
    t.is(await length(reader, fixture.admin.local.key), 4, 'the admin history is unchanged')
    t.is(await length(reader, fixture.resident.local.key), 2, 'the resident tail is applied')
    t.is(await length(reader, fixture.source.local.key), 1, 'the source dependency is applied')
    t.is(await length(reader, victimKey), 2, 'the reclaimed tail is applied once')
    t.is(await length(reader, otherVictimKey), 1, 'the other idle head is unchanged')
    t.is(reader.writers._reclaimed.size, 0, 'the ledger is empty after the retry')
    t.is(reader.stats.fastForwards, 0, 'the recovery never fast-forwarded')
    t.alike(
      decode((await reader.view.get(b4a.from('latest'))).value),
      { from: victimName, n: 2 },
      'the final view value is the reclaimed tail'
    )
    t.is(
      announcements.seen.length,
      announcementsAtDisconnect,
      'no later announcement arrived at all'
    )
    t.is(
      announcements.seen.filter((length) => length >= 2).length,
      positivesAtDisconnect,
      'no later positive announcement rescued the record'
    )
    t.is(victimEvents.adds, 1, 'the retry opened the victim exactly once')
    const handoff = victimEvents.handoffs.find((entry) => entry.record === 2)
    t.ok(handoff, 'the retry handed off the remembered maximum')
    t.is(handoff.queued, undefined, 'the handoff used the record rather than a queued hint')
    t.is(
      handoff.announcements,
      announcementsAtDisconnect,
      'the handoff happened without a later announcement'
    )
    t.is(
      handoff.positives,
      positivesAtDisconnect,
      'the handoff happened without a later positive announcement'
    )
  } finally {
    if (releaseApply) releaseApply.resolve()
    if (admission) admission.release()
    if (announcements) announcements.restore()
    if (restoreApply) restoreApply()
    if (restoreWriters) restoreWriters()
    if (stop) await stop()
  }
})
