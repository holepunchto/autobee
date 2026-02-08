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

  async addWriter(key, { indexer = true, isIndexer = indexer } = {}) {
    if (typeof key === 'string') key = ID.decode(key)
    this.auto.system.addWriter(key, { isIndexer })
  }

  async ackWriter(key) {
    if (typeof key === 'string') key = ID.decode(key)
    await this.auto.system.ack(key)
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
