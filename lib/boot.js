const b4a = require('b4a')
const encoding = require('./encoding.js')
const { checkAutobaseMigration } = require('./migrations.js')

module.exports = async function boot(
  corestore,
  key,
  legacyViews,
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

    result.migration = await migrateWithFallback(
      corestore,
      result.local,
      result.bootstrap,
      legacyViews
    )

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

// the bootstrap pointer names the rotated-to writer, whose legacy boot record
// can be unusable. the namespace local still carries the pre-rotation record,
// which points at the last system core that was actually signed
async function migrateWithFallback(corestore, local, bootstrap, legacyViews) {
  try {
    return await checkAutobaseMigration(corestore, local, bootstrap, legacyViews)
  } catch (err) {
    const prev = corestore.get({ name: 'local', active: false })
    await prev.ready()

    if (b4a.equals(prev.key, local.key)) throw err
    if (!(await prev.getUserData('autobase/boot'))) throw err

    return checkAutobaseMigration(corestore, prev, bootstrap, legacyViews)
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
