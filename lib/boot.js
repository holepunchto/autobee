const c = require('compact-encoding')
const { AutobeeEncryption } = require('autobee-encryption')
const { decodeBlock } = require('hyperbee2/lib/encoding.js')

const encoding = require('./encoding.js')
const { assert, bail } = require('./asserts.js')

const { getEncoding } = require('../encoding/spec/autobee')

const SystemInfoV1 = getEncoding('@autobase-compat/info-v1')
const SystemInfoV2 = getEncoding('@autobase-compat/info-v2')

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

  // Decode hyperbee block using hyperbee2 compat
  const node = decodeBlock(await core.get(core.length - 1))
  assert(node.keys.length > 0, 'bad system block')

  // Decode system info from hyperbee block using autobee compat
  const info = decodeLegacySystemInfo(node.keys[0].value)

  const views = await Promise.all(info.views.map((v) => getPersistedView(store, v)))

  return {
    encryptionKey,
    system,
    views
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
