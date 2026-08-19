const b4a = require('b4a')

class TrustedPeers {
  constructor(hooks) {
    this.trusted = new Map()
    this.pending = new Map()
    this.hooks = hooks
  }

  async isTrusted(key, view) {
    const hex = b4a.toString(key, 'hex')
    if (this.trusted.get(hex)) return true

    let promise = this.pending.get(hex)
    if (promise) return promise

    promise = this.hooks.isTrusted
      ? this.hooks.isTrusted(key, view)
      : Promise.resolve(!this.hooks.mostRecentTrusted)
    this.pending.set(hex, promise)

    const trusted = await promise
    if (trusted) this.trusted.set(hex, trusted)

    if (this.pending.get(hex) === promise) this.pending.delete(hex)
    return trusted
  }

  read(trusted) {
    return trusted || null
  }

  mostRecentTrusted(view) {
    if (!this.hooks.mostRecentTrusted) return Promise.resolve(null)
    return this.hooks.mostRecentTrusted(view)
  }

  clear() {
    this.pending.clear()
    this.trusted.clear()
  }
}

module.exports = TrustedPeers
