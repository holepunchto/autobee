const c = require('compact-encoding')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { AutobeeEncryption } = require('autobee-encryption')
const { decodeBlock } = require('hyperbee2/lib/encoding.js')

const encoding = require('./encoding.js')
const { assert, bail } = require('./asserts.js')

const { getEncoding } = require('../encoding/spec/autobee')

const SystemInfoV1 = getEncoding('@autobase-compat/info-v1')
const SystemInfoV2 = getEncoding('@autobase-compat/info-v2')

const EMPTY = b4a.alloc(0)
const INDEX_VERSION = 1
const INFO = b4a.from([0x00, 0x00, 0x69, 0x6e, 0x66, 0x6f])
const [NS_SIGNER_NAMESPACE] = crypto.namespace('autobase', 1)

module.exports = {
  getCoreManifest,
  getViewMap,
  checkAutobaseMigration,
  inflateLegacyOplog,
  coreLength
}

// a peer with a sparse copy may not hold block 0, but the recorded tail is the
// block it most likely has, so fetch the manifest through that when known
async function getCoreManifest(store, key, { timeout, wait = true, length = 0 } = {}) {
  const core = store.get(key)
  await core.ready()
  try {
    if (!core.manifest) await core.get(length ? length - 1 : 0, { timeout, wait })
    return core.manifest
  } finally {
    await core.close()
  }
}

// local-only probes: the manifests are expected in storage already (prefetched
// by the reset path), so a violation skips instead of hanging on the network
async function getViewMap(store, bootstrap, encryptionKey, info, legacyViews) {
  const getIndexerManifest = ({ key }) => getCoreManifest(store, key, { wait: false })
  const indexerManifests = await Promise.all(info.indexers.map(getIndexerManifest))
  const entropy = legacyEntropy(info, indexerManifests)
  const mappedViews = new Map()

  for (const name of legacyViews) {
    const v = await findViewByName(
      store,
      bootstrap.key,
      encryptionKey,
      indexerManifests,
      info.views,
      entropy,
      name
    )

    mappedViews.set(name, v)
  }

  return mappedViews
}

// boot-time migration of local legacy autobase storage
async function checkAutobaseMigration(store, local, bootstrap) {
  const bootRecord = await local.getUserData('autobase/boot')
  if (!bootRecord) return null

  const { key, systemLength } = encoding.decodeAutobaseBootRecord(bootRecord)
  const core = store.get({ key: key, encryption: null })
  await core.ready()

  // setup encryption
  const encryptionKey = await local.getUserData('autobase/encryption')
  await AutobeeEncryption.setSystemEncryption(bootstrap.key, encryptionKey, core)

  const length = await findLocalSystemLength(core, systemLength)
  const system = { key, length }

  const session = core.session({ name: 'batch' })
  await session.ready()

  let catchup

  try {
    catchup = await getCatchupHeads(session, length)
  } finally {
    await session.close()
  }

  // nothing reads the info here anymore, but a legacy system that will not
  // decode has to throw for migrateWithFallback pathway
  await readLegacySystemInfo(core, length, { wait: false })

  const nodes = await Promise.all(
    catchup.map((n) => getWriterBatch(store, n, bootstrap.key, encryptionKey))
  )

  await core.close()

  return {
    encryptionKey,
    system,
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

  if (m.digest === null || m.checkpoint === null || !m.checkpoint.system) return op

  const fetches = []

  fetches.push(m.digest.pointer ? core.get(seq - m.digest.pointer, { timeout }) : buf)
  fetches.push(
    m.checkpoint.system.checkpointer
      ? core.get(seq - m.checkpoint.system.checkpointer, { timeout })
      : buf
  )

  const [digestNode, checkpointNode] = await Promise.all(fetches)
  // no caller reads best-effort today, but stay total over a missing block
  if (digestNode === null || checkpointNode === null) return op

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

  while (length > 0) {
    const seq = length - 1
    const node = await core.get(seq, { wait: false })

    if (node) {
      const blk = decodeBlock(node)
      const entry = blk.keys[0]
      if (b4a.equals(entry.key, INFO)) return length
    }

    length--
  }

  assert(false, 'Expected system block to exist locally')
}

function coreLength(core, timeout) {
  if (core.length) return core.length

  return new Promise((resolve) => {
    core.on('append', () => resolve(core.length))
    setTimeout(resolve, timeout, 0)
  })
}

function legacyEntropy(info, indexerManifests) {
  return info.version > 1 && info.entropy ? info.entropy : indexerManifests[0].signers[0].namespace
}

async function findViewByName(
  store,
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
    const manifest = await getCoreManifest(store, v.key, { wait: false })
    if (!manifest) continue

    if (manifest.signers.length === 0) continue

    const signer = manifest.signers[0]

    if (b4a.equals(signer.namespace, namespace)) return v
  }

  return null
}

function getOplog(info, batch) {
  if (batch.length === 1) return batch[0].keys[0]

  const { heads } = encoding.decodeSystemInfo(info.value)

  for (const b of batch) {
    const entry = b.keys[0]
    const w = encoding.decodeSystemWriter(entry.key, entry.value)

    for (const { key } of heads) {
      if (b4a.equals(w.key, key)) return b.keys[0]
    }
  }

  throw new Error('Could not infer oplog node')
}

async function getCatchupHeads(session, from) {
  const seen = new Map()
  const nodes = []

  let batch = []

  // block 0 is the bee header, never a node
  for (let i = Math.max(from, 1); i < session.length; i++) {
    const node = await session.get(i, { wait: false })
    if (!node) throw new Error('Expect nodes to exist locally')

    const blk = decodeBlock(node)
    const entry = blk.keys[0]

    if (b4a.equals(entry.key, INFO)) {
      const oplog = getOplog(entry, batch)
      const { key, length } = encoding.decodeSystemWriter(oplog.key, oplog.value)

      batch = []

      if (!length) continue

      const id = b4a.toString(key, 'hex')
      const current = seen.get(id) || 0

      if (current >= length) continue

      seen.set(id, length)
      nodes.push({ key, length })
      continue
    }

    if (entry.key[0] === 0x01) batch.push(blk)
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
