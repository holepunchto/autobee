const safetyCatch = require('safety-catch')

const System = require('./system.js')

const DEFAULT_OP_TIMEOUT = 5_000

module.exports = class FastForward {
  constructor(auto, head, { timeout = DEFAULT_OP_TIMEOUT } = {}) {
    this.auto = auto
    this.system = new System(auto.store.namespace('ff'), null, {
      getEncryptionProvider: () => this.auto._getEncryptionProvider(),
      encrypted: this.encrypted
    })

    this.head = head
    this.timeout = timeout
    this.destroyed = false
    this.upgrading = null
    this.failed = false
    this.cores = []
  }

  async upgrade() {
    try {
      if (!this.upgrading) this.upgrading = this._upgrade()

      if (!(await this.upgrading)) return null

      return this.head
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
