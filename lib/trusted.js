const b4a = require('b4a')

class TrustedPeers {
  constructor(auto, hooks) {
    this.trusted = new Map()
    this.pending = new Map()
    this.auto = auto
    this.hooks = hooks
  }

  async isTrusted(key, reference) {
    const hex = b4a.toString(key, 'hex')
    if (this.trusted.get(hex)) return true

    // bootstrap
    if (this.auto.system.isGenesis() && b4a.equals(key, this.auto.key)) {
      return true
    }

    // legacy handling
    if (this.auto.system.indexers) {
      for (const idx of this.auto.system.indexers) {
        if (b4a.equals(key, idx.key)) return true
      }
    }

    let promise = this.pending.get(hex)
    if (promise) return promise

    promise = this.hooks.isTrusted
      ? this.hooks.isTrusted(key, reference)
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

  mostRecentTrusted(target, reference) {
    if (!this.hooks.mostRecentTrusted) return Promise.resolve(null)
    return this.hooks.mostRecentTrusted(target, reference)
  }

  clear() {
    this.pending.clear()
    this.trusted.clear()
  }
}

module.exports = TrustedPeers
