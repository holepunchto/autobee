const ID = require('hypercore-id-encoding')

class ApplyCalls {
  constructor(auto) {
    this.auto = auto
  }

  get id() {
    return this.auto.id
  }

  get key() {
    return this.auto.key
  }

  get discoveryKey() {
    return this.auto.discoveryKey
  }

  get name() {
    return this.auto.name
  }

  get genesis() {
    return this.auto.system.isGenesis()
  }

  async addWriter(key, { isIndexer = true } = {}) {
    if (typeof key === 'string') key = ID.decode(key)
    this.auto.system.addWriter(key, { isIndexer })
  }

  async ackWriter(key) {
    if (typeof key === 'string') key = ID.decode(key)
    this.auto.system.ackWriter(key)
  }

  async removeWriter(key) {
    if (typeof key === 'string') key = ID.decode(key)
    this.auto.system.removeWriter(key)
  }

  preferFastForward() {
    // this.auto._preferFastForward()
  }

  interrupt(reason) {
    throw new Error('TODO')
    // this.auto._interrupt(reason)
  }

  removeable(key) {
    return true
  }

  async createAnchor() {
    throw new Error('TODO')
  }
}

module.exports = ApplyCalls
