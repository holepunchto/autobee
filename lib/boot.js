const encoding = require('./encoding.js')

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
    flushes: null
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
  }

  const [systemHead, encryptionKeyBuffer] = await Promise.all([
    result.local.getUserData('autobee/head'),
    result.local.getUserData('autobee/encryption')
  ])

  if (systemHead) result.system = encoding.decodeBootRecord(systemHead)
  if (encryptionKeyBuffer) {
    result.encryptionKey = encryptionKeyBuffer
  }

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
