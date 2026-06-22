const safetyCatch = require('safety-catch')
const b4a = require('b4a')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')

const INDEX_VERSION = 1
const [NS_SIGNER_NAMESPACE] = crypto.namespace('autobase', 1)

const { decodeBlock } = require('hyperbee2/lib/encoding.js')

const { assert, bail } = require('./asserts.js')
const { getEncoding } = require('../encoding/spec/autobee')

const SystemInfoV1 = getEncoding('@autobase-compat/info-v1')
const SystemInfoV2 = getEncoding('@autobase-compat/info-v2')

const DEFAULT_OP_TIMEOUT = 5_000

module.exports = class Migration {
  constructor(auto, head, legacyViews, { timeout = DEFAULT_OP_TIMEOUT } = {}) {
    this.auto = auto
    this.head = head
    this.legacyViews = legacyViews
    this.timeout = timeout

    this.store = auto.store.session({ readOnly: true })

    this.cores = []
    this.destroyed = false
    this.failed = false
    this.running = null
  }

  async run() {
    try {
      if (!this.running) this.running = this._run()

      const result = await this.running
      if (!result) return null

      return result
    } catch (err) {
      safetyCatch(err)
      this.failed = true
      return null
    } finally {
      await this.close()
    }
  }

  async _run() {
    const core = this.store.get({ key: this.head.key, encryption: null })
    await core.ready()

    // setup encryption
    await core.setEncryption(this.auto.getSystemEncryption())

    // Decode hyperbee block using hyperbee2 compat
    const node = decodeBlock(await core.get(this.head.length - 1, { timeout: this.timeout }))
    assert(node.keys.length > 0, 'bad system block')

    // Decode system info from hyperbee block using autobee compat
    const info = decodeLegacySystemInfo(node.keys[0].value)
    if (info.version >= 3) return null

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
      system: this.head,
      views,
      catchup: []
    }
  }

  async close() {
    this.destroyed = true
    for (const core of this.cores) await core.close()
  }

  async getPersistedView(view) {
    const core = this.store.get(view.key)
    this.cores.push(core)

    await core.ready()

    const length = core.length
    await core.close()

    return { key: view.key, length }
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

    return
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

async function findViewByName(store, key, encryptionKey, indexerManifests, views, entropy, name) {
  if (indexerManifests.length === 0) return null

  const namespace = deriveNamespace(name, key, entropy, encryptionKey)

  for (const v of views) {
    const manifest = await getCoreManifest(store, v.key)
    console.log(manifest)
    if (manifest.signers.length === 0) continue

    const signer = manifest.signers[0]

    if (b4a.equals(signer.namespace, namespace)) return v
  }

  return null
}
