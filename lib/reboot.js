const safetyCatch = require('safety-catch')
const b4a = require('b4a')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')

const { decodeBlock } = require('hyperbee2/lib/encoding.js')

const System = require('./system.js')
const { assert } = require('./asserts.js')
const { LEGACY_AUTOBASE_VERSION } = require('./constants.js')
const { getEncoding } = require('../encoding/spec/autobee')

const SystemInfoV1 = getEncoding('@autobase-compat/info-v1')
const SystemInfoV2 = getEncoding('@autobase-compat/info-v2')

const INDEX_VERSION = 1
const [NS_SIGNER_NAMESPACE] = crypto.namespace('autobase', 1)

const EMPTY = b4a.alloc(0)
const DEFAULT_OP_TIMEOUT = 5_000

module.exports = class Reboot {
  constructor(auto, head, tip, { timeout = DEFAULT_OP_TIMEOUT } = {}) {
    this.auto = auto
    this.system = new System(auto.store.namespace('reboot'), null, {
      getEncryptionProvider: this.auto.getSystemEncryption,
      encrypted: this.encrypted
    })

    // length -1 marks an uninitialised head: we know the key but not the length
    this.head = { key: head.key, length: head.length ?? 0 }
    this.timeout = timeout
    this.tip = tip || null
    this.destroyed = false
    this.running = null
    this.failed = false
    this.cores = []
  }

  async run() {
    try {
      if (!this.running) this.running = this._run()

      return await this.running
    } catch (err) {
      safetyCatch(err)
      this.failed = true
      return null
    } finally {
      await this.close()
    }
  }

  async _run() {
    // an uninitialised head has an unknown length: wait for the core to catch up
    if (!this.head.length) {
      this.head.length = await this._resolveLength()
    }

    // zero-length boot is unsupported
    if (!this.head.length) return null

    await this.system.boot(this.head, { timeout: this.timeout })

    // a legacy system needs migrating rather than a plain fast-forward
    if (this.system.version <= LEGACY_AUTOBASE_VERSION) {
      // already migrated, don't migrate again
      if (this.auto.system.version > LEGACY_AUTOBASE_VERSION) return null
      return this._migrate()
    }

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
    if (this.destroyed) return null

    return {
      head: this.head,
      tip: this.tip,
      migrate: null
    }
  }

  // Upgrade a legacy (pre-AUTOBEE_VERSION) system in place. The system already
  // booted above (coerced to the current struct), but the original v1/v2 struct
  // is needed to recover the indexers/views/entropy, so decode the raw block.
  async _migrate() {
    const core = this.auto.store.get({ key: this.head.key, encryption: null })
    this.cores.push(core)
    await core.ready()

    // setup encryption
    await core.setEncryption(this.auto.getSystemEncryption())

    // Decode hyperbee block using hyperbee2 compat
    const node = decodeBlock(await core.get(this.head.length - 1, { timeout: this.timeout }))
    assert(node.keys.length > 0, 'bad system block')

    // Decode system info from hyperbee block using autobee compat
    const info = decodeLegacySystemInfo(node.keys[0].value)

    const indexerManifests = await Promise.all(
      info.indexers.map((idx) => this.getCoreManifest(idx.key, idx.length))
    )
    const entropy =
      info.version > 1 && info.entropy ? info.entropy : indexerManifests[0].signers[0].namespace

    const views = new Map()
    const viewProms = []

    for (const name of this.auto.legacyViews) {
      viewProms.push(this.findViewByName(views, indexerManifests, info.views, entropy, name))
    }

    await Promise.all(viewProms)
    if (this.destroyed) return null

    return {
      head: this.head,
      tip: null,
      migrate: views
    }
  }

  async _resolveLength() {
    const core = this.auto.store.get({ key: this.head.key })
    this.cores.push(core)

    await core.ready()

    return coreLength(core, this.timeout)
  }

  async getCoreManifest(key, length) {
    const core = this.auto.store.get(key)
    this.cores.push(core)

    await core.ready()

    try {
      if (!core.manifest) await core.get(length - 1, { timeout: this.timeout })
    } catch {
      return null
    }

    return core.manifest
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

  async close() {
    this.destroyed = true
    if (this.system) await this.system.close()
    for (const core of this.cores) await core.close()
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

function coreLength(core, timeout) {
  if (core.length) return core.length

  return new Promise((resolve) => {
    core.on('append', () => resolve(core.length))
    setTimeout(resolve, timeout, 0)
  })
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
