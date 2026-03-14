const Hyperbee = require('hyperbee2')
const b4a = require('b4a')
const encoding = require('./encoding.js')
const topo = require('./topo.js')

const VERSION = 4 // TODO: check with base

const INFO_KEY = b4a.from([0])
const INFO_LEGACY_KEY = b4a.concat([b4a.from([0]), b4a.from('info')])
const INDEXER_GTE = b4a.from([2])
const INDEXER_LT = b4a.from([3])
const EMPTY_HEAD = { length: 0, key: null }
const EMPTY = b4a.from([])

module.exports = class Systembee {
  constructor(store, name) {
    this.name = name // for debuggin
    this.store = store
    this.bee = new Hyperbee(store)
    this.view = null
    this.heads = []
    this.version = 0
    this.timestamp = 0
    this.flushes = 0
    this.indexers = null // legacy
    this.updates = new Map()
    this.writers = new Map()
  }

  openCore(key) {
    return this.store.get(key)
  }

  addWriter(key, { length = 0, isIndexer = false } = {}) {
    this.update(key, length, isIndexer, false, true, false)
  }

  ackWriter(key, { length = 0 } = {}) {
    this.update(key, length, false, false, false, true)
  }

  removeWriter(key, { length = 0 } = {}) {
    this.update(key, length, false, true, false, false)
  }

  isGenesis() {
    return this.bee.head() === null || this.bee.head().length === 0
  }

  async boot(view) {
    await this.bee.ready()
    this.bee.move(view)
    await this.reset()
  }

  async getInfo() {
    const node = await this.bee.get(INFO_KEY)
    if (node) return encoding.decodeSystemInfo(node.value)
    const legacy = await this.bee.get(INFO_LEGACY_KEY)
    if (legacy) return encoding.decodeSystemInfo(legacy.value)
    return null
  }

  async *getIndexers() {
    for await (const data of this.bee.createReadStream({ gte: INDEXER_GTE, lt: INDEXER_LT })) {
      const key = data.key.subarray(1)
      yield key
    }
  }

  async reset() {
    const info = await this.getInfo()

    this.version = info ? info.version : 0
    this.view = info ? info.view : EMPTY_HEAD
    this.heads = info ? info.heads : []
    this.timestamp = info ? info.timestamp : 0
    this.flushes = info ? info.flushes : 0
    this.indexers = info ? info.indexers : null
    this.updates.clear()
    this.writers.clear()

    if (this.version > VERSION) {
      throw new Error('Autobee signals newer version than locally supported')
    }
  }

  async close() {
    await this.bee.close()
    await this.store.close()
  }

  async prepare(batch) {
    const node = batch[0]

    if (topo.isLinkingAll(node, this.heads)) {
      return { undo: null, view: null, tip: [batch] }
    }

    const t = await topo.sort(this, batch)

    if (t.undo) {
      this.bee.move(t.undo)
      await this.reset()
      t.view = this.view || EMPTY_HEAD
    }

    return t
  }

  getLinks(key) {
    const links = []
    for (const h of this.heads) {
      if (key && b4a.equals(h.key, key)) continue
      links.push(h)
    }
    return links
  }

  addNode(node) {
    for (let i = 0; i < this.heads.length; i++) {
      const h = this.heads[i]
      if (topo.isLinking(node, h)) {
        this.heads.splice(i--, 1)
      }
    }

    // Can enable if needed during debuggin
    // asserts.heads(heads, node)

    this.heads.push({ key: node.key, length: node.length })
    if (node.timestamp > this.timestamp) this.timestamp = node.timestamp // TODO: support smoothing

    this.update(node.key, node.length, false, false, false, false)
  }

  async canApply(key, optimistic) {
    const id = b4a.toString(key, 'hex')
    const w = this.writers.get(id)
    if (w) return w.added
    const info = await this.get(key)
    return info ? !info.isRemoved : optimistic
  }

  async get(key) {
    const node = await this.bee.get(encodeWriterKey(key))
    if (node === null) return null
    return encoding.decodeSystemWriter(node.key, node.value)
  }

  async *list() {
    for await (const data of this.bee.createReadStream()) {
      if (data.key[0] === 1) {
        yield encoding.decodeSystemWriter(data.key, data.value)
      }
    }
  }

  async has(link) {
    // fast path
    for (let i = 0; i < this.heads.length; i++) {
      const h = this.heads[i]
      if (b4a.equals(h.key, link.key)) return h.length >= link.length
    }

    const node = await this.get(link.key)
    if (!node || node.length < link.length) return false
    return true
  }

  update(key, length, isIndexer, isRemoved, isAdded, isAcked) {
    const id = b4a.toString(key, 'hex')

    let upd = this.updates.get(id)

    if (isAdded) {
      this.writers.set(id, { key, added: true })
    } else if (isRemoved) {
      this.writers.set(id, { key, added: false })
    }

    if (!upd) {
      upd = { key, length, isIndexer, isRemoved, isAdded, isAcked, isOplog: false }
      this.updates.set(id, upd)
      return
    }

    if (isAdded) {
      upd.isIndexer = isIndexer
      upd.isRemoved = false
    }
    if (isRemoved) {
      upd.isIndexer = false
      upd.isRemoved = true
    }
    if (isAcked) {
      upd.isAcked = true
    }
    if (length > upd.length) {
      upd.length = length
    }
  }

  async _updateWriter(upd, oplog) {
    const changed = upd.isRemoved || upd.isAdded
    const k = encodeWriterKey(upd.key)

    if (upd.isAcked || !changed) {
      const node = await this.bee.get(k)
      const v = node ? encoding.decodeSystemWriter(node.key, node.value) : null

      if (v) {
        if (!changed) {
          upd.isIndexer = v.isIndexer
          upd.isRemoved = v.isRemoved
        }

        if (v.length > upd.length) upd.length = v.length
      }
    }

    // TODO: we can optimise this a bit, if the above node hasnt changed, do not set this
    // less writes, but future thing
    upd.isOplog = b4a.equals(upd.key, oplog)

    return [
      k,
      encoding.encodeSystemWriter(upd),
      upd.isIndexer && upd.isAdded ? encodeIndexerWriterKey(upd.key) : null,
      upd.isRemoved ? encodeIndexerWriterKey(upd.key) : null
    ]
  }

  async flush(batch, bee) {
    if (batch.length === 0) return []

    const oplog = batch[batch.length - 1].key

    for (const node of batch) this.addNode(node)

    const promises = []
    for (const upd of this.updates.values()) {
      promises.push(this._updateWriter(upd, oplog))
    }

    const w = this.bee.write()

    // migrate
    if (this.indexers) {
      for (const key of this.indexers) w.tryPut(encodeIndexerWriterKey(key), EMPTY)
      this.indexers = null
    }

    for (const [key, value, add, remove] of await Promise.all(promises)) {
      w.tryPut(key, value)
      if (add) w.tryPut(add, EMPTY)
      if (remove) w.tryDelete(remove)
    }

    this.flushes++

    const info = {
      version: VERSION,
      view: bee.head(),
      heads: this.heads,
      timestamp: this.timestamp,
      flushes: this.flushes,
      indexers: null // legacy
    }

    w.tryPut(INFO_KEY, encoding.encodeSystemInfo(info))

    await w.flush()

    // Can enable if needed during debuggin
    // asserts.systemFlush(w)

    this.updates.clear()

    if (this.writers.size === 0) return []

    const changes = [...this.writers.values()]

    this.writers.clear()
    return changes
  }
}

function encodeWriterKey(key) {
  const buf = b4a.allocUnsafe(33)
  buf[0] = 1
  buf.set(key, 1)
  return buf
}

function encodeIndexerWriterKey(key) {
  const buf = b4a.allocUnsafe(33)
  buf[0] = 2
  buf.set(key, 1)
  return buf
}
