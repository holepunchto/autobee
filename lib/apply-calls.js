const ID = require('hypercore-id-encoding')

class ApplyCalls {
  constructor(auto) {
    this.auto = auto
    this.applying = null
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

  addWriter(key, { isIndexer = true } = {}) {
    if (typeof key === 'string') key = ID.decode(key)
    return this.auto.system.addWriter(key, { weight: isIndexer ? 2 : 1 })
  }

  ackWriter(key) {
    if (typeof key === 'string') key = ID.decode(key)
    return this.auto.system.ackWriter(key)
  }

  removeWriter(key) {
    if (typeof key === 'string') key = ID.decode(key)
    return this.auto.system.removeWriter(key)
  }

  preferFastForward() {
    // this.auto._preferFastForward()
  }

  interrupt(reason) {
    this.auto.interrupt(reason)
  }

  removeable(key) {
    return true
  }

  createAnchor() {
    return this.auto.createAnchor()
  }
}

module.exports = ApplyCalls
