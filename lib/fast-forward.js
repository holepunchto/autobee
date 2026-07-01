const safetyCatch = require('safety-catch')
const b4a = require('b4a')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')

const { decodeBlock } = require('hyperbee2/lib/encoding.js')

const System = require('./system.js')
const { assert } = require('./asserts.js')
const { AUTOBEE_VERSION } = require('./constants.js')
const { getEncoding } = require('../encoding/spec/autobee')

const SystemInfoV1 = getEncoding('@autobase-compat/info-v1')
const SystemInfoV2 = getEncoding('@autobase-compat/info-v2')

const INDEX_VERSION = 1
const [NS_SIGNER_NAMESPACE] = crypto.namespace('autobase', 1)

const EMPTY = b4a.alloc(0)
const DEFAULT_OP_TIMEOUT = 5_000

class FastForward {
  constructor(auto, head, tip, { timeout = DEFAULT_OP_TIMEOUT } = {}) {
    this.auto = auto
    this.system = new System(auto.store.namespace('fast-forward'), null, {
      getEncryptionProvider: this.auto.getSystemEncryption,
      encrypted: this.encrypted
    })

    this.head = head
    this.timeout = timeout
    this.tip = tip || null
    this.destroyed = false
    this.upgrading = null
    this.failed = false
    this.cores = []
  }

  async upgrade() {
    try {
      if (!this.upgrading) this.upgrading = this._upgrade()

      if (!(await this.upgrading)) return null

      return {
        head: this.head,
        tip: this.tip,
        migrate: null
      }
    } catch (err) {
      safetyCatch(err)
      this.failed = true
      return null
    } finally {
      await this.close()
    }
  }

  async _upgrade() {
    await this.system.boot(this.head)

    const promises = []

    // ensure local key is locally available always
    promises.push(this.system.get(this.auto.local.key, { timeout: this.timeout }))

    const view = this.auto.store.get({ key: this.system.view.key, active: true })
    this.cores.push(view)

    promises.push(view.get(this.system.view.length - 1, { timeout: this.timeout }))

    for (const head of this.system.heads) {
      promises.push(this.system.get(head.key, { timeout: this.timeout }))
    }

    await Promise.all(promises)
    if (this.destroyed) return false

    return true
  }

  async close() {
    this.destroyed = true
    if (this.system) await this.system.close()
    for (const core of this.cores) await core.close()
  }
}

// A fast-forward from a legacy (pre-AUTOBEE_VERSION) system head, upgrading its
// encoding in place. Shares the run/apply plumbing with FastForward, so it also
// exposes upgrade()/close() and returns a compatible result shape.
class FastForwardMigration {
  constructor(auto, head, legacyViews, { timeout = DEFAULT_OP_TIMEOUT } = {}) {
    this.auto = auto
    this.head = head
    this.legacyViews = legacyViews
    this.timeout = timeout

    this.store = auto.store.session({ readOnly: true })

    this.cores = []
    this.destroyed = false
    this.failed = false
    this.upgrading = null
  }

  async upgrade() {
    try {
      if (!this.upgrading) this.upgrading = this._upgrade()

      return await this.upgrading
    } catch (err) {
      safetyCatch(err)
      this.failed = true
      return null
    } finally {
      await this.close()
    }
  }

  async _upgrade() {
    const core = this.store.get({ key: this.head.key, encryption: null })
    await core.ready()

    if (this.head.length === -1) {
      this.head.length = await coreLength(core, this.timeout)
      if (!this.head.length) return null
    }

    // setup encryption
    await core.setEncryption(this.auto.getSystemEncryption())

    // Decode hyperbee block using hyperbee2 compat
    const node = decodeBlock(await core.get(this.head.length - 1, { timeout: this.timeout }))
    assert(node.keys.length > 0, 'bad system block')

    // Decode system info from hyperbee block using autobee compat
    const info = decodeLegacySystemInfo(node.keys[0].value)
    if (info.version >= AUTOBEE_VERSION) return null // already current, no migration

    const indexerManifests = await Promise.all(
      info.indexers.map((idx) => this.getCoreManifest(idx.key, idx.length))
    )
    const entropy =
      info.version > 1 && info.entropy ? info.entropy : indexerManifests[0].signers[0].namespace

    const views = new Map()
    const viewProms = []
    for (const name of this.legacyViews) {
      viewProms.push(this.findViewByName(views, indexerManifests, info.views, entropy, name))
    }

    await Promise.all(viewProms)

    return {
      head: this.head,
      tip: null,
      migrate: views
    }
  }

  async close() {
    this.destroyed = true
    for (const core of this.cores) await core.close()
  }

  async getCoreManifest(key, length) {
    const core = this.store.get(key)
    this.cores.push(core)

    await core.ready()

    try {
      if (!core.manifest) await core.get(length - 1, { timeout: this.timeout })
    } catch {
      return null
    }

    const manifest = core.manifest
    await core.close()

    return manifest
  }

  async findViewByName(result, indexerManifests, views, entropy, name) {
    if (indexerManifests.length === 0) return null

    const namespace = deriveNamespace(name, this.auto.key, entropy, this.auto.encryptionKey)

    for (const v of views) {
      const manifest = await this.getCoreManifest(v.key, v.length)
      if (!manifest) continue

      if (manifest.signers.length === 0) continue

      const signer = manifest.signers[0]

      if (b4a.equals(signer.namespace, namespace)) {
        result.set(name, v)
        return
      }
    }
  }
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
      return { version }
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

function coreLength(core, timeout) {
  if (core.length) return core.length

  return new Promise((resolve) => {
    core.on('append', () => resolve(core.length))
    setTimeout(resolve, timeout, 0)
  })
}

module.exports = {
  FastForward,
  FastForwardMigration
}
