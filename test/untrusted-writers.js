const test = require('brittle')
const crypto = require('hypercore-crypto')
const ID = require('hypercore-id-encoding')
const b4a = require('b4a')
const encoding = require('../lib/encoding.js')
const WriterFastForward = require('../lib/fast-forward.js')
const Wakeup = require('../lib/wakeup.js')
const ProtomuxWakeup = require('protomux-wakeup')
const ReadyGuard = require('ready-guard')
const { ActiveWriters } = require('../lib/writers.js')
const { MAPPED_AUTOBEE_VERSION } = require('../lib/constants.js')
const { WriterEncryption } = require('../lib/encryption.js')
const {
  create,
  replicate,
  replicateAndSync,
  sync,
  same,
  encode,
  decode,
  waitFor
} = require('./helpers')

function randomWriters(n) {
  const keys = []
  for (let i = 0; i < n; i++) keys.push(crypto.keyPair().publicKey)
  return keys
}

// a writer core that follows the run's encryption mode
function writerCore(auto, name) {
  const encryption = auto.encryptionKey ? new WriterEncryption(auto) : null
  return auto.store.get({ name, encryption })
}

// the smallest oplog a writer needs for the drain, links and payload as given
function oplog(links = [], value = encode({ msg: 'node' })) {
  return {
    version: encoding.OPLOG_VERSION,
    timestamp: Date.now(),
    links,
    batch: { start: 0, end: 0 },
    views: null,
    trusted: null,
    witness: null,
    approvals: null,
    optimistic: false,
    value,
    hash: null,
    weightHint: 0,
    drift: 0
  }
}

async function length(auto, key) {
  const info = await auto.system.get(key)
  return info ? info.length : 0
}

const hex = (key) => b4a.toString(key, 'hex')
const coreId = (key) => hex(crypto.discoveryKey(key))

// does the store hold a CoreTracker session for this key? Corestore maps by
// discovery key, not by public key
function opened(auto, key) {
  return auto.store.cores.map.has(coreId(key))
}

// streams closed by the test and by teardown, whichever comes first
function connect(t, ...autos) {
  const stop = replicate(...autos)
  let closed = false

  const done = async () => {
    if (closed) return
    closed = true
    await stop()
  }

  t.teardown(done)
  return done
}

// an untrusted reader at its cap: one idle head, and a resident head that will
// link a dependency the cap refuses. the resident may be trusted, so its next
// flush leaves a fast-forward head a small gap ahead, and the idle head may be
// held in head discovery, so the only safe slot is busy when the refusal lands
async function idleHeadRoom(
  t,
  {
    trustResident = false,
    delayDiscovery = false,
    delayTrust = false,
    watcher = false,
    headTips = 1,
    late = false
  } = {}
) {
  const admin = await create(t)
  const head = await create(t, admin.key)
  const resident = await create(t, admin.key)
  const source = await create(t, admin.key)
  const target = delayTrust ? await create(t, admin.key) : null
  const lateWriter = late ? await create(t, admin.key) : null

  const writers = target === null ? [head, resident, source] : [head, resident, source, target]
  if (lateWriter !== null) writers.push(lateWriter)
  for (const w of writers) {
    await admin.append(encode({ addWriter: ID.encode(w.local.key) }))
  }
  if (lateWriter !== null) await admin.append(encode({ from: 'admin', n: 0 }))
  await replicateAndSync(admin, ...writers)

  // a branch the reader never sees until its first node is injected late. the
  // same resolved weight and an earlier timestamp force a real undo on delivery
  if (lateWriter !== null) {
    await lateWriter.append(encode({ from: 'late', n: 1 }))
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  // at the shared history: knows the membership, never the branches below.
  // the cap keeps it from opening a branch while it learns who the writers are
  const peer = watcher ? await create(t, admin.key, { isTrusted: () => false }) : null
  if (peer !== null) {
    peer.writers.maxUntrustedWriters = 2
    await replicateAndSync(admin, peer)
    peer.writers.maxUntrustedWriters = 8
  }

  // isolated branches, so the head is still a logical head when the resident moves on
  await head.append(encode({ from: 'head', n: 1 }))
  for (let i = 2; i <= headTips; i++) await head.append(encode({ from: 'head', n: i }))
  await resident.append(encode({ from: 'resident', n: 1 }))
  await source.append(encode({ from: 'source', n: 1 }))

  const storage = await t.tmp()
  const seed = await create(t, admin.key, {
    storage,
    isTrusted: () => false,
    mostRecentTrusted: () => null
  })

  // boot on both heads before the resident learns the source
  await replicateAndSync(admin, resident, seed)
  await replicateAndSync(admin, head, seed)
  await seed.close()

  let release = null
  const discoveryGate = new Promise((resolve) => (release = resolve))

  let releaseTrust = null
  const trustGate = new Promise((resolve) => (releaseTrust = resolve))
  let armed = false
  let started = null
  const trustStarted = new Promise((resolve) => (started = resolve))

  const reader = await create(t, admin.key, {
    storage,
    isTrusted(key) {
      if (trustResident && b4a.equals(key, resident.local.key)) return true

      // the stamp lookup held past the refresh that would reclaim its author
      if (delayTrust && armed && target !== null && b4a.equals(key, target.local.key)) {
        if (started !== null) {
          started()
          started = null
        }

        return trustGate.then(() => true)
      }

      return false
    },
    mostRecentTrusted(target, reference) {
      if (target === null || reference === null) return null
      return delayDiscovery ? discoveryGate.then(() => null) : null
    }
  })

  await reader.update()

  // the local writer plus the two persisted heads
  reader.writers.maxUntrustedWriters = reader.writers.size

  // the resident learns the source, so its next node links the source
  await replicateAndSync(resident, source)
  await resident.append(encode({ from: 'resident', n: 2 }))

  const pending = encoding.decodeOplog(await resident.local.get(1))
  const headKey = head.local.key
  const residentKey = resident.local.key
  const sourceKey = source.local.key

  if (delayDiscovery) {
    await waitFor(
      () => {
        const w = reader.writers.get(headKey)
        return w !== null && w.discovery !== null
      },
      { timeout: 5000, interval: 5 }
    )
  }

  return {
    admin,
    head,
    resident,
    source,
    target,
    late: lateWriter,
    reader,
    storage,
    watcher: peer,
    pending,
    trustStarted,
    armTrust() {
      armed = true
    },
    releaseTrust: () => releaseTrust(),
    release: () => release()
  }
}

function refusedSource(reader, key) {
  for (const entries of reader.writers.triggers.waiting.values()) {
    for (const entry of entries) {
      if (entry.refused && entry.id === hex(key)) return true
    }
  }

  return false
}

// the best candidate's head when it is ahead of what we applied
function aheadHead(reader) {
  for (const ff of reader.writers.fastForwards.values()) {
    if (ff.head !== null && ff.head.op.views.flushes > reader.system.flushes) return ff
  }

  return null
}

// the trust lookup hands the candidate its head read once it resolves. wait
// for that read, or for the writer vouching for it to be gone
function waitForCandidate(reader, headKey) {
  return waitFor(
    () => {
      const w = reader.writers.get(headKey)
      if (w === null) return true

      const ff = w.fastForward
      if (ff === null) return w.evaluating === 0

      return ff.isClosed || ff.head !== null || ff.reads.size > 0
    },
    { timeout: 5000, interval: 5 }
  )
}

// what a lookup would answer with, right now
function advertisedHeads(auto) {
  return [...auto._wakeup._getWakeupWriters()]
}

function advertisedIds(auto) {
  return advertisedHeads(auto).map(({ key }) => b4a.toHex(key))
}

// reopen with the cap already set when boot decides what it may rehydrate.
// the instance exists before ready, so a peer may connect while it boots, and
// the watch catches a core loaded even if it is closed again before ready
function reopenAtCap(t, storage, key, cap) {
  let auto = null
  const loaded = new Set()

  const ready = create(t, key, {
    storage,
    isTrusted() {
      if (auto !== null && auto.writers !== null) auto.writers.maxUntrustedWriters = cap
      return false
    },
    open(view, instance) {
      auto = instance
      auto.store.watch((core) => loaded.add(hex(core.discoveryKey)))
      return view
    }
  })

  return { auto, ready, loaded }
}

// did replication and the drain get the writer applied, or did the peer never
// hear of it
async function applied(auto, key, target) {
  try {
    await waitFor(async () => (await length(auto, key)) === target, {
      timeout: 5000,
      interval: 25
    })
    return true
  } catch {
    return false
  }
}

// the idle head has no progress to lose, so a refused dependency takes its slot
// once no fast-forward can carry us past the cap. no update() polling: the
// reader has to get there from replication and its own drain
async function starveIdleHead(t, opts) {
  const { admin, head, resident, source, late, reader, storage, watcher, pending, release } =
    await idleHeadRoom(t, opts)
  const cap = reader.writers.maxUntrustedWriters
  const headKey = head.local.key
  const headLength = head.local.length
  const residentKey = resident.local.key
  const sourceKey = source.local.key

  t.is(reader.writers.size, cap, 'the reader booted at its cap')
  t.is(await reader.isLocalTrusted(), false, 'the reader is untrusted')

  const headWriter = reader.writers.get(headKey)
  const residentWriter = reader.writers.get(residentKey)

  t.ok(headWriter && headWriter.isHead && headWriter.isIdle(), 'the idle head is applied and idle')
  t.ok(residentWriter && residentWriter.isHead, 'the resident head is applied')
  t.is(await length(reader, headKey), headLength, 'the idle head is in the applied system')
  t.is(await length(reader, residentKey), 1, 'the resident head is in the applied system')
  t.is(await length(reader, sourceKey), 0, 'the source dependency is not applied')
  t.absent(reader.writers.get(sourceKey), 'the source dependency is untracked')

  if (opts.clearPrefix > 0) {
    await headWriter.core.clear(0, opts.clearPrefix)
    t.is(headWriter.core.contiguousLength, 0, 'the head has a historical hole')
    t.ok(await headWriter.core.has(opts.clearPrefix, headLength), 'its exact tip is still held')
  }

  const sourceLink = pending.links.find((link) => b4a.equals(link.key, sourceKey))
  t.ok(sourceLink && sourceLink.length === 1, 'the resident node links the source head')

  const stop = connect(t, admin, head, resident, source, reader)

  await waitFor(() => refusedSource(reader, sourceKey), { timeout: 5000, interval: 25 })
  t.pass('the full cap refused the source dependency')

  let ahead = null
  let aheadFlushes = 0

  if (opts.trustResident) {
    await waitFor(() => aheadHead(reader) !== null, { timeout: 5000, interval: 25 })

    ahead = aheadHead(reader)
    aheadFlushes = ahead.head.op.views.flushes

    t.ok(
      aheadFlushes - reader.system.flushes < WriterFastForward.MIN_GAP,
      'the head is inside the gap'
    )
    t.is(ahead.inflating, null, 'no inflation is running')
    t.is(ahead.inflated, null, 'nothing is ready to land')
    t.is(reader.writers.nextFastForward(), null, 'no fast-forward can land')
  }

  release()

  await waitFor(
    async () => {
      return (await length(reader, sourceKey)) === 1 && (await length(reader, residentKey)) === 2
    },
    { timeout: 5000, interval: 25 }
  )

  t.is(await length(reader, sourceKey), 1, 'the source dependency applied')
  t.is(await length(reader, residentKey), 2, 'the resident node applied')
  t.alike(
    decode((await reader.view.get(b4a.from('latest'))).value),
    { from: 'resident', n: 2 },
    'the view holds the resident value'
  )
  t.is(await length(reader, headKey), headLength, 'the idle head stayed applied')
  t.ok(reader.system.isHead(headKey), 'the idle head is still a logical head')
  t.absent(reader.writers.get(headKey), 'the reclaimed head has no Writer session')
  t.ok(reader.writers.size <= cap, 'the cap is respected')
  t.is(reader.stats.fastForwards, 0, 'no fast-forward landed')
  t.is(await reader.isLocalTrusted(), false, 'the reader stayed untrusted')

  if (ahead !== null) {
    t.ok(reader.system.flushes >= aheadFlushes, 'the system moved past the ahead head')
  }

  await stop()

  return { admin, head, resident, source, late, reader, storage, watcher, pending }
}

// an untrusted mirror at its cap: a filler holds the last slot, and the
// dependent waits on a dependency the cap would not let it track
async function atCap(t, validDependency) {
  const auto = await create(t, { isTrusted: () => false })
  auto.writers.maxUntrustedWriters = 1

  await auto.append(encode({ msg: 'init' }))

  const dependency = writerCore(auto, 'dependency')
  await dependency.ready()
  await dependency.append(
    validDependency ? encoding.encodeOplog(oplog()) : b4a.from('not a valid oplog entry')
  )

  const dependent = writerCore(auto, 'dependent')
  await dependent.ready()
  await dependent.append(encoding.encodeOplog(oplog([{ key: dependency.key, length: 1 }])))

  // recorded while nothing may be tracked, so the mirror has to wait for both
  await auto.append(encode({ addWriter: ID.encode(dependency.key) }))
  await auto.append(encode({ addWriter: ID.encode(dependent.key) }))

  auto.writers.maxUntrustedWriters = 3

  const fillerCore = writerCore(auto, 'filler')
  await fillerCore.ready()

  // a writer gc will find idle, and gc never closes it before it does
  auto.writers.track(fillerCore.key)
  await auto.writers.drain()

  const w = auto.writers.track(dependent.key)
  await auto.writers.drain()

  t.ok(auto.writers.get(fillerCore.key), 'no speculative eviction at the cap')
  t.absent(auto.writers.get(dependency.key), 'the dependency was refused at the cap')
  t.is(auto.writers.size, 3, 'the mirror tracks all it may')
  t.is(w.waiting.id, b4a.toString(dependency.key, 'hex'), 'the dependent waits on it')
  t.is(w.waiting.length, 1, 'at the required length')

  return { auto, dependency, dependent, w, filler: auto.writers.get(fillerCore.key) }
}

test('untrusted-writers - a refused dependency is retried once gc frees room', async function (t) {
  const { auto, dependency, dependent, filler } = await atCap(t, true)

  await auto.writers.refresh()

  t.absent(auto.writers.get(filler.key), 'gc closed the idle writer')

  const d = auto.writers.get(dependency.key)
  t.ok(d, 'the refused dependency was retried')
  t.is(d.linkedLength, 1, 'linked at the required length')
  t.is(d.announcedLength, 0, 'without another announcement')
  t.ok(auto.writers.size <= auto.writers.maxUntrustedWriters, 'the cap is respected')

  await auto.update()

  t.is(await length(auto, dependent.key), 1, 'the dependent applied once its link arrived')
})

// the membership wait is discovery, not a dependency: refresh has to hand it
// back as an announcement
function recordWaits(writers) {
  const added = []
  const add = writers.triggers.add.bind(writers.triggers)

  writers.triggers.add = (id, length, writer) => {
    const entry = add(id, length, writer)
    added.push(entry)
    return entry
  }

  return added
}

// a real chain at cap 4: the resident links a newcomer the reader has not
// admitted, and the newcomer's own first node links the dependency carrying
// its grant. the grant writer is no head of any branch the reader is connected
// to, so only the membership wait can bring it back
async function membershipChain(t) {
  const admin = await create(t)
  const resident = await create(t, admin.key)
  const idle = await create(t, admin.key)
  const dependency = await create(t, admin.key)
  const newcomer = await create(t, admin.key)

  for (const w of [resident, idle, dependency]) {
    await admin.append(encode({ addWriter: ID.encode(w.local.key) }))
  }
  await replicateAndSync(admin, resident, idle, dependency)

  // the branches share the history and nothing else
  await resident.append(encode({ from: 'resident', n: 1 }))
  await idle.append(encode({ from: 'idle', n: 1 }))

  // boot storage holds the history and the idle branch, not the grant. the
  // admin is left out so it learns neither branch
  const storage = await t.tmp()
  const seed = await create(t, admin.key, { storage, isTrusted: () => false })
  await replicateAndSync(resident, seed)
  await replicateAndSync(idle, seed)
  await seed.close()

  // the grant is in the dependency's chain, not the admin's
  const newcomerKey = newcomer.local.key
  const dependencyKey = dependency.local.key

  await dependency.append(encode({ addWriter: ID.encode(newcomerKey) }))
  await replicateAndSync(admin, dependency)

  // the newcomer learns it is a writer, then links the dependency
  await replicateAndSync(admin, newcomer)
  await waitFor(async () => (await length(newcomer, dependencyKey)) === 1)
  await newcomer.append(encode({ from: 'newcomer', n: 1 }))

  // the resident catches up on the newcomer, then links it
  await replicateAndSync(admin, resident)
  await replicateAndSync(resident, newcomer)
  await waitFor(async () => (await length(resident, newcomerKey)) === 1)
  await resident.append(encode({ from: 'resident', n: 2 }))

  const reader = await create(t, admin.key, { storage, isTrusted: () => false })
  await reader.update()

  const cap = 4
  reader.writers.maxUntrustedWriters = cap

  t.is(reader.writers.size, 3, 'the local writer and the two persisted branches')
  t.is(reader.writers.maxUntrustedWriters, cap, 'the cap is four')
  t.absent(reader.writers.get(dependencyKey), 'the grant writer is untracked')
  t.absent(reader.writers.get(newcomerKey), 'the newcomer is untracked')

  const first = encoding.decodeOplog(await newcomer.local.get(0))
  t.ok(
    first.links.some((link) => b4a.equals(link.key, dependencyKey) && link.length === 1),
    'the newcomer links the grant writer'
  )

  return { admin, resident, idle, dependency, newcomer, reader, cap }
}

test('untrusted-writers - a refused membership grant is retried once gc frees room', async function (t) {
  const { resident, idle, dependency, newcomer, reader, cap } = await membershipChain(t)

  const residentKey = resident.local.key
  const idleKey = idle.local.key
  const dependencyKey = dependency.local.key
  const newcomerKey = newcomer.local.key

  const waits = recordWaits(reader.writers)

  // only the branch linking the newcomer and the newcomer itself: neither can
  // announce the grant writer, so only the membership wait can reach it
  const stop = connect(t, resident, newcomer, reader)

  await waitFor(async () => (await length(reader, residentKey)) === 2, {
    timeout: 5000,
    interval: 25
  })

  const grant = waits.filter((entry) => entry.id === hex(dependencyKey))
  t.is(grant.length, 1, 'the membership wait was the way to the grant writer')
  t.ok(grant[0].announce, 'the wait was discovery, not a dependency link')

  t.is(await length(reader, dependencyKey), 1, 'the grant writer applied')
  t.is(await length(reader, newcomerKey), 1, 'the newcomer applied once its grant arrived')
  t.alike(
    decode((await reader.view.get(b4a.from('latest'))).value),
    { from: 'resident', n: 2 },
    'the linked branch applied'
  )
  t.is(reader.writers.maxUntrustedWriters, cap, 'the cap was not raised')
  t.ok(reader.writers.size <= cap, 'the cap is respected')
  t.absent(reader.writers.get(idleKey), 'the idle head made room')
  t.ok(reader.system.isHead(idleKey), 'the idle head is still a logical head')
  t.is(await reader.isLocalTrusted(), false, 'the reader stayed untrusted')
  t.is(reader.stats.fastForwards, 0, 'no fast-forward was needed')

  await stop()
})

test('untrusted-writers - every refused membership prerequisite is retried', async function (t) {
  const auto = await create(t, { isTrusted: () => false })

  // keep the members untracked while they are added
  auto.writers.maxUntrustedWriters = 1
  await auto.append(encode({ msg: 'init' }))

  const newcomer = writerCore(auto, 'newcomer')
  await newcomer.ready()

  const first = writerCore(auto, 'first')
  await first.ready()
  await first.append(encoding.encodeOplog(oplog()))

  const grant = writerCore(auto, 'grant')
  await grant.ready()
  await grant.append(
    encoding.encodeOplog(oplog([], encode({ addWriter: ID.encode(newcomer.key) })))
  )

  // the grant writer is a member, so it applies when admitted. first is not,
  // so it can never apply and wake the newcomer
  await auto.append(encode({ addWriter: ID.encode(grant.key) }))
  await newcomer.append(
    encoding.encodeOplog(
      oplog([
        { key: first.key, length: 1 },
        { key: grant.key, length: 1 }
      ])
    )
  )

  const f1 = writerCore(auto, 'f1')
  const f2 = writerCore(auto, 'f2')
  await f1.ready()
  await f2.ready()

  auto.writers.maxUntrustedWriters = 4
  auto.writers.track(f1.key)
  auto.writers.track(f2.key)
  await auto.writers.drain()

  const w = auto.writers.track(newcomer.key)
  w.linkedLength = 1
  w.addPending()
  await auto.writers.drain()

  t.is(w.prerequisites.length, 2, 'both missing prerequisites are remembered')
  t.ok(
    w.prerequisites.every((entry) => entry.refused && entry.announce),
    'both are refused discovery, not one ordered wait'
  )
  t.absent(auto.writers.get(first.key), 'the cap refused the first prerequisite')
  t.absent(auto.writers.get(grant.key), 'the cap refused the second, which carries the grant')

  await auto.writers.refresh()

  t.ok(auto.writers.get(first.key), 'the first prerequisite took a slot')
  t.ok(auto.writers.get(grant.key), 'the second was not lost behind it')
  t.is(auto.writers.get(grant.key).announcedLength, 1, 'the grant carrier was announced')
  t.ok(auto.writers.size <= auto.writers.maxUntrustedWriters, 'the cap is respected')

  // the admitted grant really grants: the newcomer is in the system and only
  // then reads its node, leaving the unreachable link as an ordinary wait
  await auto.update()

  const granted = await auto.system.get(newcomer.key)
  t.ok(granted && granted.isAdded !== false, 'the grant reached the system')
  t.is(await length(auto, grant.key), 1, 'the grant writer applied')
  t.ok(w.isAdded, 'the newcomer is a writer')
  t.absent(w.prerequisites, 'its discovery was handed over')
  t.is(w.waiting && w.waiting.id, hex(first.key), 'the newcomer waits on the unreachable link')
  t.ok(w.waiting && !w.waiting.announce, 'as an ordinary dependency, not discovery')
  t.is(auto.writers.get(grant.key).linkedLength, 0, 'the grant carrier was only announced')
  t.is(auto.writers.get(first.key).linkedLength, 1, 'the first link was taken as a dependency')
})

test('untrusted-writers - a wakeup admits a refused dependency that gc then leaves closed', async function (t) {
  const { auto, dependency, filler, w } = await atCap(t, false)

  // the close drops the filler from the cap before it finishes, so a wakeup in
  // that window admits the dependency the cap just refused
  const closing = filler.close()
  auto.writers.wakeup(dependency.key, 1)
  await closing

  t.ok(auto.writers.get(dependency.key), 'the wakeup admitted the dependency')

  await auto.writers.drain()
  t.ok(auto.writers.get(dependency.key).isFrozen, 'the dependency froze on its invalid block')

  await auto.writers.refresh()

  t.absent(auto.writers.get(dependency.key), 'the frozen dependency was closed, not reopened')
  t.ok(w.waiting, 'the dependent still waits on the missing dependency')
})

test('untrusted-writers - a frozen discovery is not reopened', async function (t) {
  const auto = await create(t, { isTrusted: () => false })
  await auto.append(encode({ msg: 'init' }))

  const newcomer = writerCore(auto, 'newcomer')
  await newcomer.ready()

  const dependency = writerCore(auto, 'dependency')
  await dependency.ready()
  await dependency.append(b4a.from('not a valid oplog entry'))

  await newcomer.append(encoding.encodeOplog(oplog([{ key: dependency.key, length: 1 }])))

  const filler = writerCore(auto, 'filler')
  await filler.ready()

  auto.writers.maxUntrustedWriters = 3
  auto.writers.track(filler.key)
  await auto.writers.drain()

  const w = auto.writers.track(newcomer.key)
  w.linkedLength = 1
  w.addPending()
  await auto.writers.drain()

  t.is(w.prerequisites.length, 1, 'the missing prerequisite is discovery')
  t.ok(w.prerequisites[0].announce, 'announced, not linked')

  await auto.writers.refresh()

  const d = auto.writers.get(dependency.key)
  t.ok(d, 'the refused discovery was admitted')

  await auto.update()
  t.ok(d.isFrozen, 'it froze on its invalid block')

  await auto.writers.refresh()
  t.absent(auto.writers.get(dependency.key), 'the frozen candidate was closed')

  w.addPending()
  await auto.update()
  t.absent(auto.writers.get(dependency.key), 're-evaluation did not reopen it')
})

test('untrusted-writers - an untrusted peer drops new writers past the limit', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key, { isTrusted: () => false })
  auto2.writers.maxUntrustedWriters = 3
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
  const auto2 = await create(t, auto1.key)
  auto2.writers.maxUntrustedWriters = 2

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

  // trust nothing at first so the mirror applies rather than fast-forwards
  let trustAdmin = false
  const mirror = await create(t, admin.key, {
    isTrusted: (key) => trustAdmin && b4a.equals(key, admin.local.key)
  })
  // the local writer and the admin leave no safe slot for the writers the
  // admin's next node links, so the mirror stalls instead of applying it
  mirror.writers.maxUntrustedWriters = 2

  let done = connect(t, admin, mirror)

  for (let i = 0; i < 5; i++) {
    await mirror.update()
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  t.ok(mirror.writers.size <= 2, 'the mirror is at its limit')
  t.ok((await length(mirror, admin.local.key)) < admin.local.length, 'and stalled behind the admin')

  const moved = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no fast-forward')), 10_000)
    mirror.once('move-to', () => {
      clearTimeout(timer)
      resolve()
    })
  })

  // present a real eligible head: catch the admin up while the mirror cannot
  // see it, so the fast-forward is the way across, not another apply
  await done()

  trustAdmin = true
  for (let i = 0; i < 40; i++) await admin.append(encode({ value: 'fix ' + i }))

  done = connect(t, admin, mirror)

  await t.execution(moved, 'the mirror fast-forwarded')
  t.ok(mirror.stats.fastForwards >= 1, 'the mirror landed on the head')

  await sync(admin, mirror)

  t.ok(await same(admin, mirror), 'the mirror converged on the admin')

  await done()
})

test('untrusted-writers - a discovery that finds no head retries the refused dependency', async function (t) {
  await starveIdleHead(t, { trustResident: false, delayDiscovery: true })
})

test('untrusted-writers - a small-gap head and a slow discovery do not starve the cap', async function (t) {
  await starveIdleHead(t, { trustResident: true, delayDiscovery: true })
})

// the reader reclaimed its only copy of an independent branch and kept it
// applied, so it has to be able to say the head exists without holding a
// session for it - every remote is disconnected now and the watcher only
// stopped at the shared history before the branches
test('untrusted-writers - a new peer applies a reclaimed head', async function (t) {
  const { head, reader, watcher } = await starveIdleHead(t, {
    trustResident: false,
    delayDiscovery: true,
    watcher: true
  })

  const cap = reader.writers.maxUntrustedWriters
  const headKey = head.local.key
  const headId = b4a.toHex(headKey)
  const headLength = head.local.length

  t.is(await length(reader, headKey), headLength, 'the reader kept the reclaimed branch')
  t.ok(reader.system.isHead(headKey), 'the branch is still a logical head')
  t.absent(reader.writers.get(headKey), 'the reader holds no session for it')
  t.ok(reader.writers.size <= cap, 'the reader is within its cap')

  const advertised = advertisedHeads(reader).find(({ key }) => b4a.toHex(key) === headId)
  t.is(advertised && advertised.length, headLength, 'a lookup names the head at its applied length')

  // the watcher stopped at the shared history: the membership and nothing of
  // the branches, and no session left to find one with
  t.is(await length(watcher, headKey), 0, 'the watcher has no branch yet')
  t.absent(opened(watcher, headKey), 'the watcher never opened the branch')

  const stop = connect(t, reader, watcher)

  // the only peer left is the reader, so whatever the watcher gets it serves
  t.ok(await applied(watcher, headKey, headLength), 'the watcher found the reclaimed head')
  t.ok(watcher.system.isHead(headKey), 'the watcher applied the reclaimed head')
  t.ok(watcher.writers.get(headKey), 'the watcher downloaded it')
  t.absent(reader.writers.get(headKey), 'the reader still has no session for it')
  t.ok(reader.writers.size <= cap, 'the reader stayed within its cap')
  t.is(
    advertisedIds(reader).filter((id) => id === headId).length,
    1,
    'the reclaimed head is advertised once'
  )

  await stop()
})

// a restart leaves the reclaimed map empty. boot wakes every known head, but
// the cap refuses most of them, so a head only storage holds has no session to
// announce it. a peer connected before ready still has to apply it from this
// sole copy, without a later hint or lookup
test('untrusted-writers - a peer connected before boot applies a reclaimed head', async function (t) {
  const { admin, head, reader, storage } = await starveIdleHead(t, {
    trustResident: false,
    delayDiscovery: true
  })

  const headKey = head.local.key
  const headLength = head.local.length
  const headId = b4a.toHex(headKey)
  const cap = 1

  t.absent(reader.writers.get(headKey), 'the head was reclaimed before the restart')
  await reader.close()

  // a fresh observer with the shared history and none of the branches
  const observer = await create(t, admin.key, { isTrusted: () => false })
  observer.writers.maxUntrustedWriters = 2
  await replicateAndSync(admin, observer)
  observer.writers.maxUntrustedWriters = 8

  t.is(await length(observer, headKey), 0, 'the observer never saw the branch')
  t.absent(opened(observer, headKey), 'the observer never opened it')

  const { auto: reopened, ready, loaded } = reopenAtCap(t, storage, admin.key, cap)

  // hold the storage read that restores the sessionless heads so the observer
  // is active, and has heard the peer-active bump, before boot restores them
  let release
  const held = new Promise((resolve) => {
    release = resolve
  })
  const getInfos = reopened.store.storage.getInfos.bind(reopened.store.storage)
  reopened.store.storage.getInfos = async (...args) => {
    await held
    return getInfos(...args)
  }

  const stop = connect(t, reopened, observer)

  await waitFor(() => {
    const session = reopened._wakeup._session
    return session !== null && session.peers.some((peer) => peer.active)
  })

  t.absent(reopened._bootOnlineGuard.opened, 'boot has not finished advertising yet')
  t.is(await length(observer, headKey), 0, 'the active observer has no branch before the restore')

  release()
  await ready
  await reopened.flush()

  t.is(reopened.writers.maxUntrustedWriters, cap, 'the cap was set before boot')
  t.is(reopened.writers.size, 1, 'boot only opened the local writer')
  t.absent(reopened.writers.get(headKey), 'boot did not reopen the reclaimed head')
  t.absent(loaded.has(coreId(headKey)), 'boot opened no core session for it')
  t.ok(reopened.system.isHead(headKey), 'the reclaimed head is still applied')
  t.is(await length(reopened, headKey), headLength, 'at its applied length')

  const advertised = advertisedHeads(reopened).find(({ key }) => b4a.toHex(key) === headId)
  t.is(advertised && advertised.length, headLength, 'the restarted reader advertises it')

  // no manual hint or lookup: the peer connected before boot has to hear it
  t.ok(await applied(observer, headKey, headLength), 'the observer applies it from the sole copy')
  t.ok(observer.system.isHead(headKey), 'the observer applied the head')
  t.absent(reopened.writers.get(headKey), 'the restarted reader still has no session')
  t.is(reopened.writers.size, 1, 'the cap is enforced')

  await stop()
})

// boot may only speak for a head it can serve: whole contiguous local blocks,
// not a length the core merely knows about: boot takes the contiguous fast
// path, or reads the exact tip block over a historical hole
test('untrusted-writers - boot restores only locally held heads', async function (t) {
  const held = crypto.keyPair().publicKey
  const partial = crypto.keyPair().publicKey
  const sparse = crypto.keyPair().publicKey
  const metadata = crypto.keyPair().publicKey
  const missing = crypto.keyPair().publicKey
  const calls = []
  const reads = []
  const closed = []

  const auto = {
    local: { key: crypto.keyPair().publicKey },
    system: {
      heads: [
        { key: held, length: 2 },
        { key: partial, length: 2 },
        { key: sparse, length: 2 },
        { key: metadata, length: 2 },
        { key: missing, length: 1 }
      ]
    },
    store: {
      storage: {
        getInfos(keys) {
          calls.push(keys)
          return [
            { hints: { contiguousLength: 2 }, head: { length: 2 } },
            { hints: { contiguousLength: 1 }, head: { length: 2 } },
            { hints: { contiguousLength: 0 }, head: { length: 2 } },
            { hints: { contiguousLength: 0 }, head: { length: 2 } },
            null
          ]
        },
        resumeCore(discoveryKey) {
          return {
            read() {
              return {
                getBlock(index) {
                  reads.push({ id: b4a.toHex(discoveryKey), index })
                  const found = b4a.equals(discoveryKey, crypto.discoveryKey(sparse))
                  return found ? b4a.from('tip') : null
                },
                tryFlush() {}
              }
            },
            close() {
              closed.push(b4a.toHex(discoveryKey))
            }
          }
        }
      }
    },
    emit() {}
  }

  const writers = new ActiveWriters(auto)
  await writers.restoreInactiveHeads()

  const probes = [
    { id: coreId(partial), index: 1 },
    { id: coreId(sparse), index: 1 },
    { id: coreId(metadata), index: 1 }
  ]

  t.is(calls.length, 1, 'one metadata query')
  t.is(calls[0].length, 5, 'every inactive head was asked about')
  t.alike(reads, probes, 'only heads without a whole prefix read their exact tip block')
  t.alike(
    closed,
    probes.map((probe) => probe.id),
    'every storage handle was closed'
  )
  t.alike(
    [...writers.reclaimedHeads()],
    [
      { key: held, length: 2 },
      { key: sparse, length: 2 }
    ],
    'a whole head and an exact sparse tip are restored, never metadata'
  )
})

// a head whose blocks below its exact tip were cleared still has that tip on
// disk: reclamation and a capped restart may speak for the coordinate, while a
// metadata-only length is never advertised
test('untrusted-writers - a sparse head keeps its exact tip discoverable', async function (t) {
  const { admin, head, reader, storage } = await starveIdleHead(t, {
    trustResident: false,
    delayDiscovery: true,
    headTips: 2,
    clearPrefix: 1
  })

  const headKey = head.local.key
  const headId = b4a.toHex(headKey)
  const headLength = head.local.length
  const cap = 1

  t.is(reader.writers.reclaimed.get(headId)?.length, headLength, 'the exact tip was retained')
  t.absent(reader.writers.get(headKey), 'no session was opened to retain it')

  const advertised = advertisedHeads(reader).find(({ key }) => b4a.toHex(key) === headId)
  t.is(advertised && advertised.length, headLength, 'the sparse tip is advertised')

  await reader.close()

  const { auto: reopened, ready, loaded } = reopenAtCap(t, storage, admin.key, cap)
  await ready
  await reopened.flush()

  t.is(reopened.writers.maxUntrustedWriters, cap, 'the cap was set before boot')
  t.absent(reopened.writers.get(headKey), 'boot did not open a Writer for the sparse head')
  t.absent(loaded.has(coreId(headKey)), 'boot opened no core session either')
  t.is(reopened.writers.reclaimed.get(headId)?.length, headLength, 'the exact tip was restored')
  t.ok(advertisedIds(reopened).includes(headId), 'the restarted reader advertises it')
  t.is(await length(reopened, headKey), headLength, 'at its exact tip')
})

// the observer has only the shared prefix, the source holds only the suffix
// above a historical hole. the exact tip has to be discoverable and servable
// without opening the source's sparse branch as a Writer
test('untrusted-writers - a sparse exact tip serves an observer with the prefix', async function (t) {
  const admin = await create(t)
  const head = await create(t, admin.key)
  const resident = await create(t, admin.key)

  await admin.append(encode({ addWriter: ID.encode(head.local.key) }))
  await admin.append(encode({ addWriter: ID.encode(resident.local.key) }))
  await replicateAndSync(admin, head, resident)

  await head.append(encode({ from: 'head', n: 1 }))
  await replicateAndSync(admin, head, resident)

  const key = b4a.from(head.local.key)
  const headId = b4a.toHex(key)
  const prefix = head.local.length
  t.is(prefix, 1, 'the observer shares a one-block prefix')

  // merge the prefix before the branch moves on, so the observer never has the tip
  await admin.append(encode({ from: 'admin', common: true }))
  await replicateAndSync(admin, head, resident)

  const observer = await create(t, admin.key, {
    isTrusted: () => false,
    mostRecentTrusted: () => null
  })
  await replicateAndSync(admin, observer)
  t.is(await length(observer, key), prefix, 'the observer applied only the prefix')
  t.absent(observer.system.isHead(key), 'the prefix is no longer a head for it')

  await head.append(encode({ from: 'head', n: 2 }))
  await resident.append(encode({ from: 'resident', n: 1 }))
  const tip = head.local.length

  const storage = await t.tmp()
  const source = await create(t, admin.key, {
    storage,
    isTrusted: () => false,
    mostRecentTrusted: () => null
  })
  await replicateAndSync(admin, resident, source)
  await replicateAndSync(admin, head, source)

  const held = source.writers.get(key)
  t.ok(held, 'the source tracked the branch')
  t.is(await length(source, key), tip, 'the source applied the tip')
  t.ok(source.system.isHead(key), 'the tip is a logical head for the source')

  // only the shared prefix goes: the exact suffix is still held and servable
  await held.core.clear(0, prefix)
  t.absent(await held.core.has(0, prefix), 'the prefix is gone')
  t.ok(await held.core.has(prefix, tip), 'the exact suffix is held')

  const bootstrap = b4a.from(admin.key)
  await source.close()
  await admin.close()
  await head.close()
  await resident.close()

  const { auto: reopened, ready, loaded } = reopenAtCap(t, storage, bootstrap, 1)
  await ready
  await reopened.flush()

  t.is(reopened.writers.maxUntrustedWriters, 1, 'the source restarted at its cap')
  t.absent(reopened.writers.get(key), 'the sparse head was not rehydrated as a Writer')
  t.absent(loaded.has(coreId(key)), 'boot opened no core session for it')
  t.is(await length(reopened, key), tip, 'at its exact tip')
  t.ok(advertisedIds(reopened).includes(headId), 'the exact tip is advertised')

  const stop = connect(t, reopened, observer)

  t.ok(await applied(observer, key, tip), 'the observer discovered and applied the sparse tip')
  t.ok(observer.system.isHead(key), 'the tip is a logical head for the observer')
  t.ok(observer.writers.get(key), 'the observer downloaded the branch')
  t.absent(reopened.writers.get(key), 'the source never opened a Writer for it')
  t.ok(reopened.writers.size <= 1, 'the source stayed within its cap')

  await stop()
})

// undo replay takes a head out of system.heads for a few turns. a lookup in
// that window may not speak for it, but must not delete the retained
// coordinate: replay restores the head, and discovery has to return with it
test('untrusted-writers - an undo lookup does not discard a reclaimed head', async function (t) {
  const { head, late, reader } = await starveIdleHead(t, {
    trustResident: false,
    delayDiscovery: true,
    late: true
  })

  await reader.updated()

  const headKey = head.local.key
  const headId = hex(headKey)
  const headLength = head.local.length
  const cap = reader.writers.maxUntrustedWriters

  t.ok(reader.writers.reclaimed.has(headId), 'the head was reclaimed')
  t.is(reader.writers.get(headKey), null, 'the head has no session')

  let mid = null
  const previousUndos = reader.stats.undos
  const undo = reader.system.undo.bind(reader.system)
  reader.system.undo = async function (to) {
    const view = await undo(to)
    if (mid === null && reader.stats.undos > previousUndos) {
      // a real lookup while the system is at the undone heads
      mid = {
        advertised: advertisedIds(reader),
        retained: reader.writers.reclaimed.has(headId)
      }
    }
    return view
  }

  // deliver the signed blocks only, no wakeup, then hint so the reader admits
  // the stale branch. its earlier timestamp reorders what is already applied
  const raw = reader.store.get({ key: late.local.key })
  await raw.ready()
  const stopRaw = replicate(late.local, raw)
  await raw.get(0, { timeout: 4000 })
  await stopRaw()
  await raw.close()
  reader.hintWakeup({ key: late.local.key, length: 1 })

  await waitFor(() => mid !== null, { timeout: 7000, interval: 25 })
  t.absent(mid.advertised.includes(headId), 'the undone head is not advertised')
  t.ok(mid.retained, 'the lookup kept the retained coordinate')

  await waitFor(
    async () => {
      return (
        (await length(reader, headKey)) === headLength &&
        (await length(reader, late.local.key)) === 1 &&
        reader.system.isHead(headKey)
      )
    },
    { timeout: 7000, interval: 25 }
  )
  await reader.update()

  t.ok(reader.stats.undos > previousUndos, 'the delivery really undid the system')
  t.ok(reader.system.isHead(headKey), 'replay restored the logical head')
  t.ok(reader.writers.reclaimed.has(headId), 'the retained coordinate survived the replay')
  t.is(reader.writers.reclaimed.get(headId).length, headLength, 'at its exact length')
  t.ok(advertisedIds(reader).includes(headId), 'discovery returned after replay')
  t.is(reader.writers.get(headKey), null, 'replay did not reopen a session for it')
  t.ok(reader.writers.size <= cap, 'the cap is respected')
})

test('untrusted-writers - announce frames stay bounded', function (t) {
  const heads = []
  for (let i = 0; i < 10_000; i++) heads.push({ key: crypto.keyPair().publicKey, length: i + 1 })

  const frames = []
  const wakeup = Object.create(Wakeup.prototype)
  wakeup._session = {
    announce(peer, frame) {
      frames.push(frame)
    },
    announceByStream(stream, frame) {
      frames.push(frame)
    }
  }

  const lengths = heads.map((head) => head.length)

  wakeup._announce(wakeup._session, {}, heads)
  t.alike(
    frames.flat().map((head) => head.length),
    lengths,
    'a lookup delivers every head in order'
  )
  t.ok(
    frames.every((frame) => frame.length <= 128),
    'lookup frames are bounded'
  )

  frames.length = 0
  wakeup._announceByStream(wakeup._session, {}, heads)
  t.alike(
    frames.flat().map((head) => head.length),
    lengths,
    'a push delivers every head in order'
  )
  t.ok(
    frames.every((frame) => frame.length <= 128),
    'push frames are bounded'
  )
})

// a peer that is already connected and inactive gets no peer-active announce:
// the lookup handler alone has to answer for a reclaimed head
test('untrusted-writers - a lookup advertises a reclaimed head', async function (t) {
  const { head, resident, reader, watcher } = await starveIdleHead(t, {
    trustResident: false,
    delayDiscovery: true,
    watcher: true
  })

  const headKey = head.local.key
  const headLength = head.local.length
  const residentKey = resident.local.key

  t.is(await length(watcher, headKey), 0, 'the watcher has no branch yet')
  t.absent(opened(watcher, headKey), 'the watcher never opened the branch')

  // inactive when the stream opens, so the reader never fires onpeeractive
  watcher._wakeup._session.inactive()

  const stop = connect(t, reader, watcher)

  await waitFor(async () => (await length(watcher, residentKey)) === 2, {
    timeout: 5000,
    interval: 25
  })

  t.is(await length(watcher, headKey), 0, 'no peer-active announce revealed it')

  // the real lookup a peer sends after it moves
  watcher._requestWakeup()

  t.ok(await applied(watcher, headKey, headLength), 'the lookup led to the reclaimed head')
  t.ok(watcher.system.isHead(headKey), 'the lookup produced the head')

  watcher._wakeup._session.active()
  await stop()
})

// once a newer node links the branch the head is no longer current: its
// coordinates must stop being offered even though the reader still holds it
test('untrusted-writers - a merged reclaimed head is not advertised', async function (t) {
  const { head, resident, reader } = await starveIdleHead(t, {
    trustResident: false,
    delayDiscovery: true
  })

  const headKey = head.local.key
  const headId = b4a.toHex(headKey)
  const headLength = head.local.length
  const residentKey = resident.local.key

  t.ok(advertisedIds(reader).includes(headId), 'the reclaimed head is advertised')

  // the resident catches up on the branch, then links it: one head remains
  let stop = connect(t, resident, head)
  await waitFor(async () => (await length(resident, headKey)) === headLength, {
    timeout: 5000,
    interval: 25
  })
  await resident.append(encode({ from: 'resident', n: 3 }))
  await stop()

  stop = connect(t, resident, reader)
  await waitFor(async () => (await length(reader, residentKey)) === 3, {
    timeout: 5000,
    interval: 25
  })
  await stop()

  t.absent(reader.system.isHead(headKey), 'the head merged into the resident')
  t.is(await length(reader, headKey), headLength, 'the reader still holds the branch')

  await reader.updated()
  t.absent(
    reader.writers.reclaimed?.has(headId),
    'the merged head is dropped from the retained heads'
  )
  t.absent(advertisedIds(reader).includes(headId), 'the merged head is discarded')

  const ids = advertisedIds(reader)
  t.is(new Set(ids).size, ids.length, 'no head is advertised twice')
})

test('untrusted-writers - a delayed trusted lookup protects the head vouching for it', async function (t) {
  const room = await idleHeadRoom(t, { delayTrust: true })
  const { admin, head, resident, source, target, reader, pending } = room
  const headKey = head.local.key
  const sourceKey = source.local.key
  const targetKey = target.local.key
  const cap = reader.writers.maxUntrustedWriters

  t.ok(pending.links.length > 0, 'the resident node links a dependency')

  // the resident is kept away until the head is already vouching for the stamp
  const stop = connect(t, admin, head, target, reader)

  // the head's next node stamps a trusted branch well past the fast-forward gap,
  // without linking the resident so both stay logical heads at the cap
  for (let i = 0; i < 40; i++) await target.append(encode({ from: 'target', n: i }))

  const stamped = oplog()
  stamped.trusted = [{ key: targetKey, length: target.local.length }]
  stamped.value = encode({ from: 'head', n: 2 })

  room.armTrust()
  await head.local.append(encoding.encodeOplog(stamped))

  await t.execution(room.trustStarted, 'the head looked up the stamped key')
  await waitFor(() => reader.writers.get(headKey).length >= 2, { timeout: 5000, interval: 25 })

  // the resident now brings the dependency the cap has to refuse. its refresh
  // is the real retry, and it lands while the trusted lookup is still pending
  const stopMore = connect(t, resident, source, reader)

  await waitFor(() => refusedSource(reader, sourceKey) || !reader.writers.get(headKey), {
    timeout: 5000,
    interval: 5
  })

  t.ok(refusedSource(reader, sourceKey), 'the full cap refused the resident dependency')
  t.ok(reader.writers.get(headKey), 'the head evaluating its trusted stamp was not reclaimed')
  t.is(reader.writers.size, cap, 'the cap is still full')

  room.releaseTrust()

  await waitFor(() => reader.stats.fastForwards >= 1, { timeout: 10_000, interval: 25 })
  t.is(await length(reader, targetKey), target.local.length, 'the stamped head landed')
  t.ok(reader.writers.get(headKey), 'the vouching head is still tracked')

  await stopMore()
  await stop()
})

// an untrusted reader at its cap with a head vouching for a trusted candidate.
// the target is tracked inside the cap but its blocks are out of reach, so the
// read stays pending and the vouching head is the only idle victim a refusal
// retry can take
async function candidateAtCap(t, ahead) {
  const room = await idleHeadRoom(t, { delayTrust: true })
  const { admin, head, resident, source, target, reader, pending } = room
  const headKey = head.local.key
  const sourceKey = source.local.key
  const targetKey = target.local.key

  t.ok(pending.links.length > 0, 'the resident node links a dependency')

  if (ahead > 0) {
    for (let i = 0; i < ahead; i++) await target.append(encode({ from: 'target', n: i }))
  } else {
    // a data block without views: the candidate finds no head to land on
    await target.local.append(encoding.encodeOplog(oplog()))
  }

  // a target without a head yet cannot serve the block it announced past what
  // it holds, so its slot is not a victim either
  const announced = ahead > 0 ? target.local.length : target.local.length + 1

  reader.writers.maxUntrustedWriters++
  reader.writers.track(targetKey).announce(announced)
  reader.writers.maxUntrustedWriters = reader.writers.size

  const cap = reader.writers.maxUntrustedWriters
  connect(t, admin, head, reader)

  const stamped = oplog()
  stamped.trusted = [{ key: targetKey, length: target.local.length }]
  stamped.value = encode({ from: 'head', n: 2 })

  room.armTrust()
  await head.local.append(encoding.encodeOplog(stamped))

  await t.execution(room.trustStarted, 'the head looked up the stamped key')
  await waitFor(() => reader.writers.get(headKey).length >= 2, { timeout: 5000, interval: 25 })

  // the dependency the cap has to refuse lands while the trust lookup is pending
  connect(t, resident, source, reader)

  await waitFor(() => refusedSource(reader, sourceKey), { timeout: 5000, interval: 25 })

  t.is(reader.writers.size, cap, 'the full cap refused the resident dependency')
  t.ok(reader.writers.get(targetKey), 'the pending target still holds its slot')

  room.releaseTrust()

  return { ...room, headKey, sourceKey, targetKey, cap }
}

// the stamp lookup resolves before the candidate read does. the head is still
// the only ref when the refusal retry looks for a slot
test('untrusted-writers - a trusted candidate read keeps the head vouching for it', async function (t) {
  const room = await candidateAtCap(t, 40)
  const { target, reader, headKey, sourceKey, targetKey, cap } = room

  // the lookup resolves and the hint starts the head read, which the absent
  // target cannot serve
  await waitForCandidate(reader, headKey)

  // the exact scan a refusal retry runs. it must not take the vouching head
  await reader.writers.refresh()

  const voucher = reader.writers.get(headKey)
  const candidate = voucher === null ? null : voucher.fastForward

  t.ok(voucher, 'the head vouching for the candidate was not reclaimed')
  t.ok(candidate !== null && candidate.reads.size > 0, 'the candidate is still reading its head')
  t.is(candidate === null ? undefined : candidate.head, null, 'the head block has not arrived')
  t.ok(refusedSource(reader, sourceKey), 'the refused dependency still waits')
  t.absent(reader.writers.get(sourceKey), 'nothing was admitted above the cap')

  // the target arrives: the head read lands into an inflation and then a landing
  connect(t, target, reader)

  await waitFor(() => reader.stats.fastForwards >= 1, { timeout: 10_000, interval: 25 })

  t.is(await length(reader, targetKey), target.local.length, 'the stamped head landed')
  t.is(candidate === null ? undefined : candidate.reads.size, 0, 'no read is left pending')
  t.ok(reader.writers.get(headKey), 'the vouching head is still tracked')
  t.ok(reader.writers.size <= cap, 'the cap is respected')
})

// a read that finds no head leaves nothing to land on, so the head it vouched
// for is reclaimable again and the refused dependency takes the slot
test('untrusted-writers - a candidate read with no head frees its voucher', async function (t) {
  const room = await candidateAtCap(t, 0)
  const { target, reader, headKey, sourceKey, cap } = room

  await waitForCandidate(reader, headKey)

  await reader.writers.refresh()

  const voucher = reader.writers.get(headKey)
  const candidate = voucher === null ? null : voucher.fastForward

  t.ok(voucher, 'the reading candidate keeps its vouching head')
  t.ok(candidate !== null && candidate.reads.size > 0, 'the candidate is still reading its head')

  // the target arrives with a data block, so the read settles without a head
  connect(t, target, reader)

  await waitFor(() => candidate === null || candidate.reads.size === 0, {
    timeout: 5000,
    interval: 25
  })

  t.is(candidate === null ? undefined : candidate.head, null, 'the read found no head')

  await waitFor(async () => (await length(reader, sourceKey)) === 1, {
    timeout: 5000,
    interval: 25
  })

  t.is(await length(reader, sourceKey), 1, 'the refused dependency took the freed slot')
  t.absent(reader.writers.get(headKey), 'the settled read freed its voucher')
  t.ok(reader.writers.size <= cap, 'the cap is respected')
})

// an untrusted reader at its cap: the local writer plus idle external heads
async function idleHeadsAtCap(t, count = 1) {
  const admin = await create(t)
  const trustedHead = () => ({ key: admin.local.key, length: admin.local.length })
  const heads = []

  for (let i = 0; i < count; i++) {
    heads.push(await create(t, admin.key, { mostRecentTrusted: trustedHead }))
  }

  // both heads branch from the last membership node, so neither links the other
  for (const head of heads) await admin.append(encode({ addWriter: ID.encode(head.local.key) }))
  await replicateAndSync(admin, ...heads)

  for (let i = 0; i < heads.length; i++) {
    await heads[i].append(encode({ from: 'head', n: i + 1 }))
  }

  await replicateAndSync(admin, ...heads)

  const reader = await create(t, admin.key, {
    isTrusted: (key) => b4a.equals(key, admin.local.key),
    mostRecentTrusted: trustedHead
  })

  await replicateAndSync(admin, ...heads, reader)
  await reader.update()

  reader.writers.maxUntrustedWriters = reader.writers.size

  const tracked = heads.map((head) => reader.writers.get(head.local.key))
  t.ok(
    tracked.every((w) => w !== null && w.isHead && w.isIdle()),
    'the reader holds the idle heads at its cap'
  )
  t.is(reader.writers.size, count + 1, 'the cap is the local writer and the idle heads')

  await Promise.all(tracked.map((w) => waitFor(() => w.latestLength >= w.length)))

  const headKeys = heads.map((head) => head.local.key)
  return { reader, headKeys, headKey: headKeys[0] }
}

// a refused, still-live dependency for the given slot
function refuse(writers, key) {
  const entry = writers.triggers.add(b4a.toHex(key), 1, writers.localWriter)
  entry.refused = true
  return entry
}

test('untrusted-writers - only fast-forward work keeps an idle slot', async function (t) {
  const { reader, headKey } = await idleHeadsAtCap(t)
  const dependency = writerCore(reader, 'dependency')
  await dependency.ready()
  await dependency.append(encoding.encodeOplog(oplog()))

  const writers = reader.writers
  const cap = writers.maxUntrustedWriters
  const entry = refuse(writers, dependency.key)
  const dependencyKey = dependency.key
  const ff = writers.refFastForward(crypto.keyPair().publicKey)

  // a head inside the gap never inflates, so the run in flight is the guard
  ff.head = { key: ff.key, length: 1, op: { views: { flushes: reader.system.flushes + 1 } } }

  ff.inflating = {}
  await writers.refresh()
  t.ok(writers.get(headKey), 'an in-flight fast-forward keeps the idle head')
  t.ok(entry.refused, 'the refused dependency waits for it')

  ff.inflating = null
  ff.inflated = {
    head: null,
    length: 1,
    flushes: reader.system.flushes + WriterFastForward.MIN_GAP,
    version: MAPPED_AUTOBEE_VERSION
  }

  t.is(writers.nextFastForward(), ff, 'the candidate is ready to land')
  await writers.refresh()
  t.ok(writers.get(headKey), 'a ready fast-forward keeps the idle head')
  t.ok(entry.refused, 'the refused dependency still waits')

  ff.inflated = null

  await writers.refresh()

  const admitted = writers.get(dependencyKey)

  t.ok(admitted, 'without fast-forward work the dependency takes the slot')
  t.absent(writers.get(headKey), 'the idle head was reclaimed')
  t.is(writers.size, cap, 'the cap is respected')

  writers.triggers.remove(entry)
  await reader.updated()
  if (admitted !== null) await admitted.close()
  writers.unrefFastForward(ff)
})

// two idle heads at the cap: the one popped first is the last ref to a
// candidate still reading its head, the other is a free slot. an inflation
// that lands nothing may still hand the refusal the free head, and the scan
// has to keep popping for it instead of dropping it on the protected one
test('untrusted-writers - a refusal retry takes the next idle head', async function (t) {
  const { reader, headKeys } = await idleHeadsAtCap(t, 2)
  const writers = reader.writers
  const dependency = writerCore(reader, 'dependency')
  await dependency.ready()
  await dependency.append(encoding.encodeOplog(oplog()))

  const protectedHead = writers.get(headKeys[0])
  const freeHead = writers.get(headKeys[1])

  // pop() takes the last entry, so the protected head has to go last
  writers.active.delete(protectedHead.id)
  writers.active.set(protectedHead.id, protectedHead)

  const ff = writers.refFastForward(crypto.keyPair().publicKey)
  ff.length = 1
  ff.reads.add({ length: 2 })
  protectedHead.fastForward = ff

  refuse(writers, dependency.key)
  t.is(writers.size, writers.maxUntrustedWriters, 'at the cap with a refused dependency')

  // the run leaves nothing to land while the candidate still reads its head
  ff.inflating = { cancelled: false, head: null }
  t.absent(ff.oninflated(ff.inflating, null), 'the run gave no landing')

  await waitFor(() => writers.get(dependency.key) !== null)

  t.ok(writers.get(dependency.key), 'the refusal retried onto the free head')
  t.ok(writers.get(protectedHead.key), 'the head vouching for a pending read stayed')
  t.absent(writers.get(freeHead.key), 'the free head made the room')
  t.is(writers.size, writers.maxUntrustedWriters, 'the cap is respected')
  t.is(ff.reads.size, 1, 'the candidate still has a read in flight')

  ff.reads.clear()
  writers.unrefFastForward(ff)
})

// the released owner is not a head, so a refusal scan finds no idle-head
// victim. settling the read is the only event that lets gc take it and hand
// the slot to the refused dependency
test('untrusted-writers - a settled read frees a non-head owner for a refusal', async function (t) {
  const { auto, filler, dependency, dependent, w } = await atCap(t, true)
  const writers = auto.writers
  const ff = writers.refFastForward(crypto.keyPair().publicKey)
  const block = encoding.encodeOplog(oplog())
  const entry = w.waiting

  let settle = null
  let requested = null

  // a head read the remote has not served yet
  ff.core = {
    length: 1,
    get(index) {
      requested = index
      return new Promise((resolve) => (settle = resolve))
    },
    close() {}
  }
  ff.hinted = 2
  filler.fastForward = ff

  const read = ff.refresh()

  await waitFor(() => settle !== null)
  t.is(requested, 1, 'the candidate is reading the head it has not got')

  // the read is the owner's only ref: gc keeps the slot, and the scan has no
  // idle head to add to the cap
  await writers.refresh()

  t.ok(writers.get(filler.key), 'the reading owner keeps its slot')
  t.absent(writers.get(dependency.key), 'the refusal still waits at the cap')

  // the read settles without a head. nobody refreshes or updates by hand: the
  // settle itself has to let the auto hand the freed slot to the refusal
  settle(block)
  await read

  await waitFor(() => !entry.refused)

  t.absent(entry.refused, 'the settled read handed the slot to the refusal')
  t.absent(writers.get(filler.key), 'the released non-head owner made the room')
  t.absent(ff.needsOwner(), 'the settled read holds nothing')
  t.ok(writers.size <= writers.maxUntrustedWriters, 'the cap is respected')

  await waitFor(async () => (await length(auto, dependent.key)) === 1)

  t.is(await length(auto, dependent.key), 1, 'the dependent applied without a rescue')

  writers.unrefFastForward(ff)
})

// a non-head writer is the last ref to a candidate. gc keeps it while the run
// is pending or the result can land, and lets go of a stale one
test('untrusted-writers - a pending or ready fast-forward keeps its non-head owner', async function (t) {
  const { auto, filler, dependency } = await atCap(t, true)
  const writers = auto.writers
  const ff = writers.refFastForward(crypto.keyPair().publicKey)

  filler.fastForward = ff
  ff.inflating = {}

  await writers.refresh()

  t.ok(writers.get(filler.key), 'the owner of a run in flight is kept')
  t.absent(writers.get(dependency.key), 'the refused dependency still waits')

  ff.inflating = null
  ff.inflated = {
    head: null,
    length: 1,
    flushes: auto.system.flushes + WriterFastForward.MIN_GAP,
    version: MAPPED_AUTOBEE_VERSION
  }

  await writers.refresh()

  t.ok(writers.get(filler.key), 'the owner of a ready landing is kept')

  ff.inflated.flushes = auto.system.flushes

  await writers.refresh()

  t.absent(writers.get(filler.key), 'a stale completed fast-forward pins nobody')
  t.ok(writers.get(dependency.key), 'the freed slot goes to the refused dependency')
  t.ok(ff.isClosed, 'the last ref was released')
})

// two writers may vouch for the same candidate. keeping one ref is enough
test('untrusted-writers - one owner of a fast-forward survives gc', async function (t) {
  const { auto, filler } = await atCap(t, true)
  const writers = auto.writers
  const spare = writerCore(auto, 'spare')
  await spare.ready()

  writers.maxUntrustedWriters++
  const w = writers.track(spare.key)
  writers.maxUntrustedWriters = writers.size
  await writers.drain()

  const ff = writers.refFastForward(crypto.keyPair().publicKey)
  writers.refFastForward(ff.key)

  filler.fastForward = ff
  w.fastForward = ff
  ff.inflating = {}

  await writers.refresh()

  const owners = [...writers.active.values()].filter((w) => w.fastForward === ff)
  t.is(owners.length, 1, 'only the last owner is pinned')
  t.is(ff.refs, 1, 'the candidate keeps its last ref')
  t.absent(ff.isClosed, 'the candidate is not closed')

  ff.inflating = null
})

// overlapping reads: an unreplaced older one keeps the owner, a read the
// newest accepted head has made obsolete does not
test('untrusted-writers - a superseded read stops pinning its owner', async function (t) {
  const { auto, filler, dependency } = await atCap(t, true)
  const writers = auto.writers
  const ff = writers.refFastForward(crypto.keyPair().publicKey)
  const older = { length: 1 }
  const newer = { length: 3 }

  filler.fastForward = ff
  ff.reads.add(older)
  ff.reads.add(newer)

  await writers.refresh()
  t.ok(writers.get(filler.key), 'pending reads keep their owner')

  ff.reads.delete(newer)
  await writers.refresh()
  t.ok(writers.get(filler.key), 'a newer read without views keeps the older one')

  ff.length = 3
  await writers.refresh()
  t.absent(writers.get(filler.key), 'the superseded read no longer pins')
  t.ok(writers.get(dependency.key), 'the refused dependency takes the slot')
})

test('untrusted-writers - reclaim protects the local writer and hinted heads', async function (t) {
  const local = await create(t, { isTrusted: () => false })
  await local.append(encode({ msg: 'local head' }))
  await local.update()

  const localKey = local.local.key
  local.writers.maxUntrustedWriters = local.writers.size

  const localDependency = writerCore(local, 'dependency')
  await localDependency.ready()
  await localDependency.append(encoding.encodeOplog(oplog()))

  const localEntry = refuse(local.writers, localDependency.key)

  await local.writers.refresh()

  t.ok(localEntry.refused, 'the local writer is never a victim')
  t.ok(local.writers.get(localKey), 'the local writer stays')

  local.writers.triggers.remove(localEntry)

  const { reader, headKey } = await idleHeadsAtCap(t)
  const writers = reader.writers
  const dependency = writerCore(reader, 'dependency')
  await dependency.ready()
  await dependency.append(encoding.encodeOplog(oplog()))

  const entry = refuse(writers, dependency.key)
  const dependencyKey = dependency.key
  const headId = b4a.toHex(headKey)

  writers.auto._wakeup.hints.set(headId, 2)

  await writers.refresh()

  t.ok(entry.refused, 'a queued hint keeps the head')
  t.ok(writers.get(headKey), 'the hinted head was not evicted')

  writers.auto._wakeup.hints.delete(headId)

  await writers.refresh()

  const admitted = writers.get(dependencyKey)

  t.ok(admitted, 'the dependency takes the slot once the hint is taken')
  t.absent(writers.get(headKey), 'the idle head was evicted')
  t.ok(writers.get(reader.local.key), 'the local writer was not evicted')

  writers.triggers.remove(entry)
  await reader.updated()
  if (admitted !== null) await admitted.close()
})

// a lookup deferred on boot keeps its session and peer. if either is gone by
// the time boot resolves, the shared protocol must not speak from it
test('untrusted-writers - a deferred lookup does not outlive its session', async function (t) {
  const settle = () => new Promise((resolve) => setImmediate(resolve))
  const key = crypto.keyPair().publicKey
  const protocol = new ProtomuxWakeup()
  t.teardown(() => protocol.destroy())

  function deferred() {
    const guard = new ReadyGuard()
    const head = { key, length: 1 }
    const auto = {
      _bootOnlineGuard: guard,
      writers: {
        heads: () => [head],
        reclaimedHeads: () => []
      }
    }

    const wakeup = new Wakeup(auto, { wakeup: protocol })
    wakeup.setCapability(key, null)

    const session = wakeup._session
    const sent = []
    session.announce = (peer, frame) => sent.push(...frame)

    const peer = {
      active: true,
      removed: false,
      topic: session.topic,
      wireInfo: { send() {} },
      channel: {
        closed: false,
        destroyed: false,
        close() {
          this.closed = true
        }
      }
    }
    session.peers.push(peer)
    session.handlers.onlookup({}, peer, session)

    return { wakeup, guard, session, peer, sent }
  }

  // boot resolves while the lookup is still live: it has to be answered
  {
    const { wakeup, guard, sent } = deferred()
    guard.exit()
    await settle()
    t.is(sent.length, 1, 'a live deferred lookup answers')
    await wakeup.close()
  }

  // the owner closed while the lookup waited on boot
  {
    const { wakeup, guard, session, sent } = deferred()
    await wakeup.close()
    guard.exit()
    await settle()
    t.ok(session.destroyed, 'the close destroyed the session')
    t.is(sent.length, 0, 'the closed wakeup did not answer')
  }

  // the capability session was replaced while the lookup waited on boot
  {
    const { wakeup, guard, session, sent } = deferred()
    wakeup.setCapability(key, null)
    guard.exit()
    await settle()
    t.ok(session.destroyed, 'the replacement destroyed the session')
    t.is(sent.length, 0, 'the replaced session did not answer')
    await wakeup.close()
  }

  // the peer disconnected while the lookup waited on boot
  {
    const { wakeup, guard, peer, sent } = deferred()
    peer.channel.closed = true
    guard.exit()
    await settle()
    t.is(sent.length, 0, 'the disconnected peer did not get an answer')
    await wakeup.close()
  }
})

test('untrusted-writers - a closed wakeup does not push restored heads', async function (t) {
  const key = crypto.keyPair().publicKey
  const protocol = new ProtomuxWakeup()
  t.teardown(() => protocol.destroy())

  const head = { key, length: 1 }
  const auto = {
    _bootOnlineGuard: new ReadyGuard(),
    writers: {
      heads: () => [head],
      reclaimedHeads: () => [head]
    }
  }

  const wakeup = new Wakeup(auto, { wakeup: protocol })
  wakeup.setCapability(key, null)

  const session = wakeup._session
  const sent = []
  session.announce = (peer, frame) => sent.push(...frame)
  session.peers.push({
    active: true,
    removed: false,
    topic: session.topic,
    wireInfo: { send() {} },
    channel: {
      closed: false,
      destroyed: false,
      close() {
        this.closed = true
      }
    }
  })

  await wakeup.close()
  wakeup.announceReclaimed()

  t.is(sent.length, 0, 'the closed wakeup pushed nothing')
})
