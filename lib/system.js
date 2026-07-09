const Hyperbee = require('hyperbee2')
const b4a = require('b4a')

const { AUTOBEE_VERSION } = require('./constants')
const encoding = require('./encoding.js')
const topo = require('./topo.js')

const INFO_KEY = b4a.from([0])
const INFO_LEGACY_KEY = b4a.concat([b4a.from([0, 0]), b4a.from('info')])
const INDEXER_GTE = b4a.from([2])
const INDEXER_LT = b4a.from([3])
const EMPTY_HEAD = { length: 0, key: null }
const EMPTY = b4a.from([])

module.exports = class Systembee {
  constructor(store, name, opts = {}) {
    this.name = name // for debuggin
    this.store = store
    this.bee = new Hyperbee(store, opts)
    this.view = null
    this.heads = []
    this.version = 0
    this.timestamp = 0
    this.flushes = 0
    this.indexers = null // legacy
    this.updates = new Map()
    this.writers = new Map()
    this.encrypted = opts.encrypted === true
    // per-writer high-water mark for ackedWeight, deliberately NOT cleared by
    // reset() (unlike updates/writers) - a reorg's undo() rolls this.bee back
    // to an earlier snapshot, which can be from before some other writer's
    // node credited this one. that credit is a fact this peer has already
    // witnessed and must not un-learn just because the bee pointer moved -
    // otherwise replaying forward re-derives the pre-credit ackedWeight,
    // which can retrigger the very reorg that rolled back, forever. see
    // ackedWeight()/_updateWriter().
    this.ackedWeights = new Map()
  }

  async addWriter(key, { length = 0, weight = 1 } = {}) {
    if (length === 0) {
      const info = await this.get(key, { unflushed: false })
      length = info ? info.length : 0
    }
    // genesis is the trust anchor - nothing exists yet to corroborate it, so it
    // bypasses the ack mechanic and is fully acked at whatever weight it's added
    // at. every other writer keeps whatever it already earned (capped to the new
    // weight) and has to be corroborated by another already-acked writer linking
    // to it before the new weight counts for sorting - see addNode/ackWeight.
    const ackedWeight = this.isGenesis() ? weight : Math.min(weight, await this.ackedWeight(key))
    this.update(key, length, weight, ackedWeight, false, true, false)
  }

  async ackWriter(key, { length = 0 } = {}) {
    if (length === 0) {
      const info = await this.get(key, { unflushed: false })
      length = info ? info.length : 0
    }
    this.update(key, length, 0, 0, false, false, true)
  }

  async removeWriter(key, { length = 0 } = {}) {
    if (length === 0) {
      const info = await this.get(key, { unflushed: true })
      length = info ? info.length : 0
    }
    this.update(key, length, 0, 0, true, false, false)
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

    if (this.version > AUTOBEE_VERSION) {
      throw new Error('Autobee signals newer version than locally supported')
    }
  }

  bootRecord() {
    const system = this.bee.head()
    return system.length ? system : null
  }

  async close() {
    await this.bee.close()
    await this.store.close()
  }

  async undo(head) {
    this.bee.move(head)
    await this.reset()
    return this.view || EMPTY_HEAD
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
        // node causally supersedes another writer's head - an objective,
        // order-independent DAG fact once replicated - so it's usable to
        // corroborate that writer's weight, credited at node's own (already
        // acked) weight so a not-yet-acked writer can't vouch above its own level
        if (!b4a.equals(h.key, node.key)) this.ackWeight(h.key, node.weight)
      }
    }

    // Can enable if needed during debuggin
    // asserts.heads(heads, node)

    this.heads.push({ key: node.key, length: node.length })
    if (node.timestamp > this.timestamp) this.timestamp = node.timestamp // TODO: support smoothing

    this.update(node.key, node.length, 0, 0, false, false, false)
  }

  // bump a writer's ackedWeight - merged/capped against the persisted record at
  // flush time in _updateWriter, same as length already is
  ackWeight(key, credited) {
    const id = b4a.toString(key, 'hex')
    const upd = this.updates.get(id)

    if (!upd) {
      this.updates.set(id, {
        version: 4,
        key,
        length: 0,
        weight: 0,
        ackedWeight: credited,
        clock: 0,
        isRemoved: false,
        isAdded: false,
        isAcked: false,
        isOplog: false
      })
      return
    }

    if (credited > upd.ackedWeight) upd.ackedWeight = credited
  }

  async canApply(key, optimistic) {
    const id = b4a.toString(key, 'hex')
    const w = this.writers.get(id)
    if (w) return w.added
    const info = await this.get(key)
    return info ? !info.isRemoved : !!optimistic
  }

  async ackedWeight(key) {
    const id = b4a.toString(key, 'hex')
    const upd = this.updates.get(id)

    let value
    // an upd created purely to track length (eg by addNode, before an
    // addWriter call in the same batch has had a chance to run) has a bogus
    // placeholder ackedWeight of 0 - only trust it once an actual add/remove
    // has resolved it this batch, otherwise fall through to persisted
    if (upd && (upd.isAdded || upd.isRemoved)) value = upd.ackedWeight
    else {
      const info = await this.get(key)
      value = info ? info.ackedWeight : 0
    }

    const watermark = this.ackedWeights.get(id) || 0
    return value > watermark ? value : watermark
  }

  async get(key, { unflushed = false } = {}) {
    const node = await this.bee.get(encodeWriterKey(key))
    const info = node !== null ? encoding.decodeSystemWriter(node.key, node.value) : null
    if (!unflushed) return info

    const upd = this.updates.get(b4a.toString(key, 'hex'))
    if (!upd) return info
    if (!info) return upd

    if (upd.isAdded) info.isAdded = true
    if (upd.isRemoved) info.isRemoved = true
    if (upd.isIndexer) info.isIndexer = true
    if (upd.isAcked) info.isAcked = true
    if (upd.isOplog) info.isOplog = true

    // length only ever advances - a pending update (eg a bare ackWeight bump,
    // which has no real length of its own) must not regress it below whatever's
    // already persisted
    if (upd.length > info.length) info.length = upd.length

    return info
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

  update(key, length, weight, ackedWeight, isRemoved, isAdded, isAcked) {
    const id = b4a.toString(key, 'hex')

    let upd = this.updates.get(id)

    if (isAdded) {
      this.writers.set(id, { key, added: true })
    } else if (isRemoved) {
      this.writers.set(id, { key, added: false })
    }

    if (!upd) {
      upd = {
        version: 4,
        key,
        length,
        weight,
        ackedWeight,
        clock: 0,
        isRemoved,
        isAdded,
        isAcked,
        isOplog: false
      }
      this.updates.set(id, upd)
      return
    }

    if (isAdded) {
      upd.weight = weight
      upd.ackedWeight = ackedWeight
      upd.isAdded = true
      upd.isRemoved = false
    }
    if (isRemoved) {
      upd.weight = 0
      upd.ackedWeight = 0
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
    const changed = upd.isAdded || upd.isRemoved
    const k = encodeWriterKey(upd.key)

    // always merge length/ackedWeight against whatever's persisted, even for
    // an add/remove - both are monotonic (length only grows, ackedWeight only
    // grows until capped by weight below), so this is always safe. crucial
    // for ackedWeight specifically: replaying an old self-referential
    // addWriter node (via a reorg sweeping it up again) must never regress a
    // corroboration some other, later-processed-but-earlier-in-history node
    // already earned it - only weight/isRemoved are exclusive to an actual
    // unchanged read (an explicit add/remove must be free to override those)
    const node = await this.bee.get(k)
    const v = node ? encoding.decodeSystemWriter(node.key, node.value) : null

    if (v) {
      if (!changed) {
        upd.weight = v.weight
        upd.isRemoved = v.isRemoved
      }

      if (v.ackedWeight > upd.ackedWeight) upd.ackedWeight = v.ackedWeight
      if (v.length > upd.length) upd.length = v.length
    }

    // enforce this peer's own high-water mark too (see constructor) - a
    // reorg can have rolled this.bee back to before some earlier-flushed
    // ackedWeight, and the merge above only sees whatever THAT rolled-back
    // snapshot holds, not what this peer already knows independently
    const id = b4a.toString(upd.key, 'hex')
    const watermark = this.ackedWeights.get(id) || 0
    if (watermark > upd.ackedWeight) upd.ackedWeight = watermark

    if (upd.ackedWeight > upd.weight) upd.ackedWeight = upd.weight

    if (upd.ackedWeight > watermark) this.ackedWeights.set(id, upd.ackedWeight)

    upd.clock = this.flushes

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

    const promises = []
    for (const upd of this.updates.values()) {
      promises.push(this._updateWriter(upd, oplog))
    }

    const w = this.bee.write()

    // migrate
    if (this.indexers) {
      for (const { key } of this.indexers) w.tryPut(encodeIndexerWriterKey(key), EMPTY)
      this.indexers = null
    }

    for (const [key, value, add, remove] of await Promise.all(promises)) {
      w.tryPut(key, value)
      if (add) w.tryPut(add, EMPTY)
      if (remove) w.tryDelete(remove)
    }

    this.flushes++

    const info = {
      version: AUTOBEE_VERSION,
      view: bee.head(),
      heads: this.heads,
      timestamp: this.timestamp,
      flushes: this.flushes,
      indexers: null, // legacy
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
  const buf = b4a.allocUnsafe(34)
  buf[0] = 1
  buf[1] = 0
  buf.set(key, 2)
  return buf
}

function encodeIndexerWriterKey(key) {
  const buf = b4a.allocUnsafe(33)
  buf[0] = 2
  buf.set(key, 1)
  return buf
}
