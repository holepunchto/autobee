const encoding = require('./encoding.js')
const { AutobeeEncryption } = require('autobee-encryption')
const { decodeBlock } = require('hyperbee2/lib/encoding.js')
const { assert } = require('./asserts.js')

async function checkMigration(store, local, bootstrap) {
  const bootRecord = await local.getUserData('autobase/boot')
  if (!bootRecord) return null

  const encryptionKey = await local.getUserData('autobase/encryption')

  const { key } = encoding.decodeAutobaseBootRecord(bootRecord)
  const core = store.get({ key: key, encryption: null })
  await core.ready()

  await AutobeeEncryption.setSystemEncryption(bootstrap.key, encryptionKey, core)

  const system = await core.get(core.length - 1)

  // Decode hyperbee block using hyperbee2 compat
  const systemBlock = decodeBlock(system)
  assert(systemBlock.keys.length > 0, 'bad system block')

  // Decode system info from hyperbee block using autobee compat
  const info = encoding.decodeSystemInfo(systemBlock.keys[0].value)

  // @todo - kills process silently here
  // dangerous, should wait until after migration is complete
  // to clear - perhaps on next boot if autobee/... are set
  // await Promise.all([local.setUserData('autobase/boot'), local.setUserData('autobase/encryption')])

  const views = []

  for (const view of info.views) {
    const core = store.get({ key: view.key, encryption: null })
    await core.ready()

    await AutobeeEncryption.setSystemEncryption(bootstrap.key, encryptionKey, core)

    // @todo need this?
    // const block = await core.get(core.length - 1)

    views.push(core)
  }

  // info.views[0] is the data
  // info.views[1] is the blobs

  return { encryptionKey, system: { key, length: core.length }, views }
}

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
    previousDrain: 0
  }

  const manifest = keyPair
    ? { version: corestore.manifestVersion, signers: [{ publicKey: keyPair.publicKey }] }
    : null

  if (key) {
    result.key = key

    const bootstrap = corestore.get({ key })
    await bootstrap.ready()

    const localKey = await bootstrap.getUserData('autobee/local')

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

    const migration = await checkMigration(
      corestore,
      result.local,
      result.bootstrap,
      result.encryptionKey
    )

    // system => key, length
    // views => [key, length]
    // encryptionKey => buffer

    if (migration) {
      result.system = migration.system
      result.migration = migration.views
      result.encryptionKey = migration.encryptionKey
    }
  }

  const [systemHead, encryptionKeyBuffer, prevDrainBuffer] = await Promise.all([
    result.local.getUserData('autobee/head'),
    result.local.getUserData('autobee/encryption'),
    result.local.getUserData('autobee/previous-drain')
  ])

  if (systemHead) result.system = encoding.decodeBootRecord(systemHead)
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
