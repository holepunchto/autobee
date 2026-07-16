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

  get clock() {
    return this.auto.system.flushes
  }

  get genesis() {
    return this.auto.system.isGenesis()
  }

  addWriter(key, { isIndexer = true, weight = isIndexer ? 2 : 1 } = {}) {
    if (typeof key === 'string') key = ID.decode(key)
    // claim validation later matches a claim's referrer against this stamp
    const referrer = this.applying ? nodeRef(this.applying[this.applying.length - 1]) : null
    return this.auto.system.addWriter(key, { weight, referrer })
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

  createAnchor(key, length) {
    return this.auto.createAnchor(key, length)
  }
}

module.exports = ApplyCalls

function nodeRef(node) {
  return { key: node.key, length: node.length }
}
