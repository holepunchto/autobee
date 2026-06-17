const c = require('compact-encoding')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { AutobeeEncryption } = require('autobee-encryption')
const { decodeBlock } = require('hyperbee2/lib/encoding.js')

const encoding = require('./encoding.js')
const { assert, bail } = require('./asserts.js')
const SystemView = require('./system.js')

const { getEncoding } = require('../encoding/spec/autobee')

const SystemInfoV1 = getEncoding('@autobase-compat/info-v1')
const SystemInfoV2 = getEncoding('@autobase-compat/info-v2')

const EMPTY = b4a.alloc(0)
const INDEX_VERSION = 1
const [NS_SIGNER_NAMESPACE] = crypto.namespace('autobase', 1)

module.exports = async function boot(
  corestore,
  key,
  { encrypt, encryptionKey, keyPair, exclusive = true } = {}
) {
  const result = {
    key: null,
    local: null,
    bootstrap: null,
    encryptionKey: null,
    system: null,
    flushes: null,
    previousDrain: 0,
    migration: null
  }

  const manifest = keyPair
    ? { version: corestore.manifestVersion, signers: [{ publicKey: keyPair.publicKey }] }
    : null

  if (key) {
    result.key = key

    const bootstrap = corestore.get({ key })
    await bootstrap.ready()

    const localKey = await getLocalKey(bootstrap)

    if (keyPair) {
      result.local = corestore.get({
        keyPair,
        active: false,
        exclusive,
        manifest
      })
    } else {
      if (bootstrap.writable && !localKey) {
        result.local = bootstrap.session({
          active: false,
          exclusive
        })
      } else {
        const local = localKey
          ? corestore.get({
              key: localKey,
              active: false,
              exclusive
            })
          : corestore.get({
              name: 'local',
              active: false,
              exclusive
            })

        await local.ready()
        result.local = local
      }
    }

    result.bootstrap = bootstrap
  } else {
    result.local = keyPair
      ? corestore.get({
          keyPair,
          manifest,
          active: false,
          exclusive
        })
      : corestore.get({
          name: 'local',
          active: false,
          exclusive
        })
    await result.local.ready()

    const key = await result.local.getUserData('referrer')
    if (key) {
      result.key = key
      result.bootstrap = corestore.get({ key, active: false })
      await result.bootstrap.ready()
    } else {
      result.key = result.local.key
      result.bootstrap = result.local.session({ active: false })
      await result.bootstrap.setUserData('autobee/local', result.local.key)
    }
  }

  if (key || keyPair) {
    await result.bootstrap.setUserData('referrer', result.key)
    await result.bootstrap.setUserData('autobee/local', result.local.key)
    await result.local.setUserData('referrer', result.key)

    result.migration = await checkAutobaseMigration(corestore, result.local, result.bootstrap)

    if (result.migration) {
      await result.local.setUserData(
        'autobee/head',
        encoding.encodeBootRecord(result.migration.system)
      )
      await result.local.setUserData('autobee/encryption', result.migration.encryptionKey)
    }
  }

  const [systemHead, encryptionKeyBuffer, prevDrainBuffer] = await Promise.all([
    result.local.getUserData('autobee/head'),
    result.local.getUserData('autobee/encryption'),
    result.local.getUserData('autobee/previous-drain')
  ])

  if (result.system === null && systemHead) {
    result.system = encoding.decodeBootRecord(systemHead)
  }

  if (encryptionKeyBuffer) result.encryptionKey = encryptionKeyBuffer
  if (prevDrainBuffer) result.previousDrain = encoding.decodePreviousDrain(prevDrainBuffer)

  if (!result.encryptionKey && (encryptionKey || encrypt)) {
    if (!encryptionKey) {
      encryptionKey = (await corestore.createKeyPair('autobee/encryption')).secretKey.subarray(
        0,
        32
      )
    }

    await result.local.setUserData('autobee/encryption', encryptionKey)
    result.encryptionKey = encryptionKey
  }

  return result
}

async function checkAutobaseMigration(store, local, bootstrap) {
  const bootRecord = await local.getUserData('autobase/boot')
  if (!bootRecord) return null

  const { key } = encoding.decodeAutobaseBootRecord(bootRecord)
  const core = store.get({ key: key, encryption: null })
  await core.ready()

  const system = { key, length: core.length }

  // setup encryption
  const encryptionKey = await local.getUserData('autobase/encryption')
  await AutobeeEncryption.setSystemEncryption(bootstrap.key, encryptionKey, core)

  const catchup = await getCatchupHeads(core)
  const nodes = await Promise.all(catchup.map(n => getWriterBatch(store, n, bootstrap.key, encryptionKey)))

  // Decode hyperbee block using hyperbee2 compat
  const node = decodeBlock(await core.get(core.length - 1))
  assert(node.keys.length > 0, 'bad system block')

  // Decode system info from hyperbee block using autobee compat
  const info = decodeLegacySystemInfo(node.keys[0].value)

  const indexerManifests = await Promise.all(
    info.indexers.map((idx) => getCoreManifest(store, idx.key))
  )
  const views = await Promise.all(info.views.map((v) => getPersistedView(store, v)))
  const entropy =
    info.version > 1 && info.entropy ? info.entropy : indexerManifests[0].signers[0].namespace

  return {
    encryptionKey,
    system,
    views,
    catchup: nodes,
    findViewByName: findViewByName.bind(
      null,
      store,
      bootstrap.key,
      encryptionKey,
      indexerManifests,
      views,
      entropy
    )
  }
}

async function getLocalKey(bootstrap) {
  const [legacy, current] = await Promise.all([
    bootstrap.getUserData('autobase/local'),
    bootstrap.getUserData('autobee/local')
  ])

  if (current) return current
  return legacy
}

async function getPersistedView(store, view) {
  const core = store.get(view.key)
  await core.ready()

  const length = core.length
  await core.close()

  return { key: view.key, length }
}

async function getCatchupHeads(core) {
  const session = core.session({ name: 'batch' }) 
  await session.ready()

  const nodes = []
  for (let i = core.length; i < session.length; i++) {
    const node = await session.get(i, { wait: false })
    if (!node) throw new Error('Expect nodes to exist locally')

    const entry = decodeBlock(node).keys[0] 
    if (entry.key[0] !== 0x01) continue

    const { key, length } = encoding.decodeSystemWriter(entry.key, entry.value)
    nodes.push({ key, length })
  }

  return nodes
}

async function getWriterBatch(store, head, key, encryptionKey, nodes = []) {
  const batch = []

  const core = store.get(head.key)
  await core.ready()

  await core.setEncryption(AutobeeEncryption.getWriterEncryption(key, encryptionKey))

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

async function getCoreManifest(store, key) {
  const core = store.get(key)
  await core.ready()

  const manifest = core.manifest
  await core.close()

  return manifest
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

async function findViewByName(store, key, encryptionKey, indexerManifests, views, entropy, name) {
  if (indexerManifests.length === 0) return null

  const namespace = deriveNamespace(name, key, entropy, encryptionKey)

  for (const v of views) {
    const manifest = await getCoreManifest(store, v.key)
    if (manifest.signers.length === 0) continue

    const signer = manifest.signers[0]

    if (b4a.equals(signer.namespace, namespace)) return v
  }

  return null
}
