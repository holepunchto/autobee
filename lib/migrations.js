const c = require('compact-encoding')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { AutobeeEncryption } = require('autobee-encryption')
const { decodeBlock } = require('hyperbee2/lib/encoding.js')

const encoding = require('./encoding.js')
const { assert, bail } = require('./asserts.js')
const { LEGACY_OPLOG_VERSION } = require('./constants.js')
const { trace, short, head: fmtHead } = require('./debug-log.js')

const { getEncoding } = require('../encoding/spec/autobee')

const SystemInfoV1 = getEncoding('@autobase-compat/info-v1')
const SystemInfoV2 = getEncoding('@autobase-compat/info-v2')

const EMPTY = b4a.alloc(0)
const INDEX_VERSION = 1
const [NS_SIGNER_NAMESPACE] = crypto.namespace('autobase', 1)

// indexer rotations chain legacy systems - how many generations we chase
const MAX_MIGRATE_HOPS = 64

module.exports = {
  MAX_MIGRATE_HOPS,
  checkAutobaseMigration,
  readLegacySystemInfo,
  findNewestSystem,
  resolveLegacyViews,
  inflateLegacyOplog,
  decodeLegacySystemInfo,
  deriveNamespace,
  coreLength
}

// boot-time migration of local legacy autobase storage
async function checkAutobaseMigration(store, local, bootstrap, legacyViews) {
  const bootRecord = await local.getUserData('autobase/boot')
  if (!bootRecord) return null

  const { key, systemLength } = encoding.decodeAutobaseBootRecord(bootRecord)

  trace(null, 'migrate: found a legacy autobase boot record', {
    local: local.key,
    system: { key, length: systemLength }
  })
  const core = store.get({ key: key, encryption: null })
  await core.ready()

  const length = await findLocalSystemLength(core, systemLength)
  assert(length > 0, 'Expected system block to exist locally')

  const system = { key, length }

  // setup encryption
  const encryptionKey = await local.getUserData('autobase/encryption')
  await AutobeeEncryption.setSystemEncryption(bootstrap.key, encryptionKey, core)

  const session = core.session({ name: 'batch' })
  await session.ready()

  let catchup

  try {
    catchup = await getCatchupHeads(session, length)
  } finally {
    await session.close()
  }

  const info = await readLegacySystemInfo(core, length, { wait: false })

  const nodes = await Promise.all(
    catchup.map((n) => getWriterBatch(store, n, bootstrap.key, encryptionKey))
  )

  const indexerManifests = await Promise.all(
    info.indexers.map((idx) => storeCoreManifest(store, idx.key))
  )
  const views = await Promise.all(info.views.map((v) => getPersistedView(store, v)))
  const entropy = legacyEntropy(info, indexerManifests)

  const getManifest = (key) => storeCoreManifest(store, key)

  const mappedViews = new Map()
  for (const name of legacyViews) {
    const v = await findViewByName(
      getManifest,
      bootstrap.key,
      encryptionKey,
      indexerManifests,
      views,
      entropy,
      name
    )

    mappedViews.set(name, v)
  }

  await core.close()

  trace(null, 'migrate: local legacy state resolved', {
    system,
    indexers: info.indexers.length,
    legacyViews: info.views.length,
    mapped: mappedViews,
    unmapped: [...mappedViews.keys()].filter((n) => !mappedViews.get(n)),
    catchupWriters: nodes.length
  })

  return {
    encryptionKey,
    system,
    views: mappedViews,
    catchup: nodes
  }
}

// decode the legacy system info recorded in the system core's block at length
async function readLegacySystemInfo(core, length, opts = null) {
  const block = await core.get(length - 1, opts)
  assert(block !== null, 'Expected system block to exist locally')

  // Decode hyperbee block using hyperbee2 compat
  const node = decodeBlock(block)
  assert(node.keys.length > 0, 'bad system block')

  // Decode system info from hyperbee block using autobee compat
  return decodeLegacySystemInfo(node.keys[0].value)
}

// read each indexer's newest legacy oplog stamp - its digest/checkpoint mark
// the newest legacy system that indexer knows. take the majority vote. an
// indexer that already moved to autobee announces its live autobee state
// instead - keep the newest of those as a direct fast-forward candidate and
// bisect down to its buried legacy stamps so its vote still counts
async function findNewestSystem(ff, info) {
  const tally = new Map()

  let autobee = null

  for (const idx of info.indexers) {
    const core = ff.auto.openCore(idx.key)
    ff.cores.push(core)
    await core.ready()

    const length = await coreLength(core, ff.timeout)

    if (!length || ff.destroyed) {
      trace(ff, 'migrate: indexer oplog length never arrived', { indexer: idx.key })
      continue
    }

    let oplog = await flushHead(ff.auto, { key: idx.key, length }, { timeout: ff.timeout })

    if (oplog === null || !oplog.op.views) {
      trace(ff, 'migrate: indexer head unreadable or carries no system', {
        indexer: idx.key,
        length
      })
      continue
    }

    if (oplog.op.version > LEGACY_OPLOG_VERSION) {
      if (autobee === null || oplog.op.views.flushes > autobee.op.views.flushes) {
        autobee = oplog
      }

      trace(ff, 'migrate: indexer has already moved to autobee', {
        indexer: idx.key,
        length,
        flushes: oplog.op.views.flushes
      })

      const boundary = await findLegacyBoundary(ff, core, idx.length, oplog.length - 1)

      if (!boundary || ff.destroyed) {
        trace(ff, 'migrate: could not bisect the legacy boundary', { indexer: idx.key })
        continue
      }

      trace(ff, 'migrate: bisected legacy/autobee boundary', {
        indexer: idx.key,
        boundary
      })

      oplog = await flushHead(ff.auto, { key: idx.key, length: boundary }, { timeout: ff.timeout })
      if (oplog === null || !oplog.op.views) continue
      if (oplog.op.version > LEGACY_OPLOG_VERSION) continue
    }

    const sys = oplog.op.views.system
    if (!sys || !sys.key) continue

    const hex = b4a.toString(sys.key, 'hex')
    const t = tally.get(hex) || { key: sys.key, votes: 0, length: sys.length }

    t.votes++
    if (sys.length > t.length) t.length = sys.length
    tally.set(hex, t)

    trace(ff, 'migrate: indexer votes for legacy system', {
      indexer: idx.key,
      system: sys
    })
  }

  const majority = (info.indexers.length >> 1) + 1

  let best = null
  for (const t of tally.values()) {
    if (t.votes >= majority && (best === null || t.length > best.length)) best = t
  }

  trace(ff, 'migrate: legacy system vote', {
    indexers: info.indexers.length,
    majority,
    tally: [...tally.values()].map((t) => short(t.key) + '@' + t.length + 'x' + t.votes),
    winner: best === null ? null : fmtHead(best),
    autobee: autobee === null ? null : fmtHead(autobee)
  })

  return { legacy: best === null ? null : best.key, autobee }
}

// map the legacy views recorded in the system info by name
async function resolveLegacyViews(ff, info) {
  const indexerManifests = await Promise.all(
    info.indexers.map((idx) => ffCoreManifest(ff, idx.key, idx.length))
  )

  if (ff.destroyed || indexerManifests.some((m) => m === null)) {
    trace(ff, 'migrate: an indexer manifest could not be read', {
      indexers: info.indexers.length,
      read: indexerManifests.filter((m) => m !== null).length
    })
    return null
  }

  const entropy = legacyEntropy(info, indexerManifests)

  const getManifest = (key, length) => ffCoreManifest(ff, key, length)

  const views = new Map()

  await Promise.all(
    ff.auto.legacyViews.map(async (name) => {
      const v = await findViewByName(
        getManifest,
        ff.auto.key,
        ff.auto.encryptionKey,
        indexerManifests,
        info.views,
        entropy,
        name
      )

      if (v) views.set(name, v)
    })
  )

  if (ff.destroyed) return null

  trace(ff, 'migrate: mapped legacy views by name', {
    wanted: ff.auto.legacyViews,
    mapped: views,
    missing: ff.auto.legacyViews.filter((n) => !views.has(n))
  })

  return views
}

// legacy nodes always inflate, but only indexers carry the digest/checkpoint
// stamps that synthesise system info - callers must check op.views
async function inflateLegacyOplog(buf, core, seq, timeout) {
  const m = encoding.decodeRawOplog(buf)

  const op = {
    version: m.version,
    timestamp: 0,
    links: m.node.heads,
    batch: { start: 0, end: m.node.batch - 1 },
    views: null,
    optimistic: !!m.optimistic,
    value: m.node.value
  }

  if (m.digest === null || m.checkpoint === null || !m.checkpoint.system) {
    // a plain (non-indexer) legacy node - nothing to synthesise a system from
    return op
  }

  const fetches = []

  fetches.push(m.digest.pointer ? core.get(seq - m.digest.pointer, { timeout }) : buf)
  fetches.push(
    m.checkpoint.system.checkpointer
      ? core.get(seq - m.checkpoint.system.checkpointer, { timeout })
      : buf
  )

  const [digestNode, checkpointNode] = await Promise.all(fetches)
  // no caller reads best-effort today, but stay total over a missing block
  if (digestNode === null || checkpointNode === null) {
    trace(null, 'migrate: legacy digest/checkpoint block missing', {
      key: core.key,
      seq,
      digest: digestNode !== null,
      checkpoint: checkpointNode !== null
    })
    return op
  }

  const { digest } = encoding.decodeRawOplog(digestNode)
  const { checkpoint } = encoding.decodeRawOplog(checkpointNode)

  if (!checkpoint.system || !checkpoint.system.checkpoint) return op

  op.views = {
    system: {
      key: digest.key,
      start: 0,
      length: checkpoint.system.checkpoint.length
    },
    flushes: seq
  }

  return op
}

function decodeLegacySystemInfo(buffer) {
  const state = { start: 0, end: buffer.length, buffer }
  const version = c.uint.decode(state)

  state.start--

  switch (version) {
    case 1:
      return SystemInfoV1.decode(state)
    case 2:
      return SystemInfoV2.decode(state)
    default:
      bail('Expected legacy system info')
  }
}

function deriveNamespace(name, bootstrap, entropy, encryptionKey) {
  const encryptionId = crypto.hash(encryptionKey || EMPTY)
  const version = c.encode(c.uint, INDEX_VERSION)

  return crypto.hash([
    NS_SIGNER_NAMESPACE,
    version,
    bootstrap,
    encryptionId,
    entropy,
    b4a.from(name)
  ])
}

// the record's length can run past the signed core into the local batch
// session, and the signed core can carry verified-but-undownloaded blocks -
// scan back for the newest block the signed core actually has locally
async function findLocalSystemLength(core, systemLength) {
  let length = Math.min(core.length, systemLength)
  while (length > 0 && !(await core.has(length - 1))) length--
  return length
}

function coreLength(core, timeout) {
  if (core.length) return core.length

  return new Promise((resolve) => {
    core.on('append', () => resolve(core.length))
    setTimeout(resolve, timeout, 0)
  })
}

// a writer's oplog is a legacy prefix followed by autobee-format nodes -
// bisect for the boundary. lo is a length known to be legacy (the legacy
// system's recorded length for this writer), hi a seq known to be autobee.
// returns the legacy prefix length
async function findLegacyBoundary(ff, core, lo, hi) {
  trace(ff, 'migrate: bisecting for the legacy prefix', { key: core.key, lo, hi })

  while (lo < hi) {
    const mid = (lo + hi) >>> 1

    const block = await core.get(mid, {
      timeout: ff.timeout,
      activeRequests: ff.activeRequests
    })

    if (encoding.decodeRawOplog(block).version > LEGACY_OPLOG_VERSION) hi = mid
    else lo = mid + 1
  }

  return lo
}

function legacyEntropy(info, indexerManifests) {
  return info.version > 1 && info.entropy ? info.entropy : indexerManifests[0].signers[0].namespace
}

async function findViewByName(
  getManifest,
  bootstrap,
  encryptionKey,
  indexerManifests,
  views,
  entropy,
  name
) {
  if (indexerManifests.length === 0) return null

  const namespace = deriveNamespace(name, bootstrap, entropy, encryptionKey)

  for (const v of views) {
    const manifest = await getManifest(v.key, v.length)
    if (!manifest) continue

    if (manifest.signers.length === 0) continue

    const signer = manifest.signers[0]

    if (b4a.equals(signer.namespace, namespace)) {
      trace(null, 'migrate: matched legacy view', { room: bootstrap, name, view: v })
      return v
    }
  }

  trace(null, 'migrate: no legacy view matches this name', {
    room: bootstrap,
    name,
    candidates: views.length
  })

  return null
}

// request-tracked manifest read over replication
async function ffCoreManifest(ff, key, length) {
  const core = ff.auto.store.get(key)
  ff.cores.push(core)

  await core.ready()

  try {
    if (!core.manifest) {
      await core.get(length - 1, {
        timeout: ff.timeout,
        activeRequests: ff.activeRequests
      })
    }
  } catch {
    return null
  }

  return core.manifest
}

// local-storage manifest read
async function storeCoreManifest(store, key) {
  const core = store.get(key)
  await core.ready()

  const manifest = core.manifest
  await core.close()

  return manifest
}

async function getPersistedView(store, view) {
  const core = store.get(view.key)
  await core.ready()

  // core.length can run past what was downloaded - the system's recorded
  // length is the last one we know is local
  const length = Math.min(core.length, view.length)
  await core.close()

  return { key: view.key, length }
}

async function getCatchupHeads(session, from) {
  const seen = new Map()
  const nodes = []

  trace(null, 'migrate: scanning legacy system for catchup heads', {
    key: session.key,
    from,
    to: session.length
  })

  // block 0 is the bee header, never a node
  for (let i = Math.max(from, 1); i < session.length; i++) {
    const node = await session.get(i, { wait: false })
    if (!node) throw new Error('Expect nodes to exist locally')

    const entry = decodeBlock(node).keys[0]
    if (entry.key[0] !== 0x01) continue

    const { key, length } = encoding.decodeSystemWriter(entry.key, entry.value)
    if (!length) continue

    const id = b4a.toString(key, 'hex')
    const current = seen.get(id) || 0

    if (current >= length) continue

    seen.set(id, length)
    nodes.push({ key, length })
  }

  return nodes
}

async function getWriterBatch(store, head, key, encryptionKey, nodes = []) {
  const batch = []

  const core = store.get(head.key)
  await core.ready()

  if (encryptionKey) {
    await core.setEncryption(AutobeeEncryption.getWriterEncryption(key, encryptionKey))
  }

  let seq = head.length - 1
  const block = await core.get(seq--, { wait: false })
  if (!block) throw new Error('Expect writer node to exist locally')

  const node = encoding.decodeOplog(block)

  batch.unshift({ ...head, ...node, from: core })

  while (seq >= 0) {
    const block = await core.get(seq--, { wait: false })
    if (!block) break

    const node = encoding.decodeOplog(block)
    if (!node.batch.end) break

    batch.unshift({ key: head.key, length: seq + 2, from: core, ...node })
  }

  return batch
}

// lazy to avoid the require cycle - fast-forward imports this module
function flushHead(auto, head, opts) {
  const FastForward = require('./fast-forward.js')
  return FastForward.flushHead(auto, head, opts)
}
