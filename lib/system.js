const Hyperbee = require('hyperbee2')
const b4a = require('b4a')

const { AUTOBEE_VERSION } = require('./constants')
const asserts = require('./asserts.js')
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
    this.shared = null
    this.encrypted = opts.encrypted === true
  }

  // grants clamp to max(requested, current): max is order-independent, so
  // concurrent grant races converge and honest claims never decrease.
  // referrer null = genesis bootstrap (trust anchor), removal the only way down
  async addWriter(key, { length = 0, weight = 1, referrer = null } = {}) {
    const info = await this.get(key, { unflushed: true })
    if (length === 0) {
      length = info ? info.length : 0
    }

    const current = info ? info.maxWeight : 0
    if (weight <= current) {
      // keep the original referrer stamp so existing claims stay backable
      this.update(key, length, -1, -1, null, true, false, false, false)
      return
    }

    this.update(key, length, -1, weight, referrer, true, false, false, false)
  }

  async ackWriter(key, { length = 0 } = {}) {
    if (length === 0) {
      const info = await this.get(key, { unflushed: false })
      length = info ? info.length : 0
    }
    this.update(key, length, -1, -1, null, false, false, true, false)
  }

  async removeWriter(key, { length = 0 } = {}) {
    if (length === 0) {
      const info = await this.get(key, { unflushed: true })
      length = info ? info.length : 0
    }
    this.update(key, length, -1, 0, null, false, true, false, false)
  }

  addAnchor(key, { length = 1 } = {}) {
    this.update(key, length, -1, -1, null, true, false, false, true)
  }

  isGenesis() {
    return this.bee.head() === null || this.bee.head().length === 0
  }

  async boot(view, { timeout } = {}) {
    await this.bee.ready()
    this.bee.move(view)
    await this.reset({ timeout })
  }

  async getInfo({ timeout } = {}) {
    const node = await this.bee.get(INFO_KEY, { timeout })
    if (node) return encoding.decodeSystemInfo(node.value)
    const legacy = await this.bee.get(INFO_LEGACY_KEY, { timeout })
    if (legacy) return encoding.decodeSystemInfo(legacy.value)
    return null
  }

  async *getIndexers() {
    for await (const data of this.bee.createReadStream({ gte: INDEXER_GTE, lt: INDEXER_LT })) {
      const key = data.key.subarray(1)
      yield key
    }
  }

  async changesFrom({ flushes, view }) {
    // this.view is only refreshed on reset - read the latest flush's info
    const info = await this.getInfo()

    const current = {
      view: info ? info.view : EMPTY_HEAD,
      system: this.bee.head(),
      flushes: info ? info.flushes : 0
    }

    // up to date only if the head matches too - flushes can re-converge to an
    // equal count after a rewind with different state
    if (current.flushes === flushes && sameHead(current.view, view)) return null

    if (current.flushes >= flushes) {
      const snap = this.bee.snapshot()

      try {
        for await (const data of snap.createChangesStream()) {
          if (topo.isLegacyFlush(data)) break

          const info = getInfo(data)
          if (info.flushes < flushes) break

          if (info.flushes === flushes) {
            // view cores are append-only, so key+length pins content exactly -
            // a pre-shutdown reorg or FF at this flush count fails this check
            if (!sameHead(info.view || EMPTY_HEAD, view)) break

            return {
              shared: { flushes, view: info.view || EMPTY_HEAD, system: data.head },
              current
            }
          }
        }
      } finally {
        await snap.close()
      }
    }

    // trigger full sync
    return {
      shared: { flushes: 0, view: EMPTY_HEAD, system: EMPTY_HEAD },
      current
    }
  }

  async reset({ timeout } = {}) {
    const info = await this.getInfo({ timeout })

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

    // deepest rewind since last mark - everything at or below it is untouched
    if (this.shared === null || this.flushes < this.shared.flushes) {
      this.shared = { flushes: this.flushes, view: this.view || EMPTY_HEAD, system: head }
    }

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
      }
    }

    // Can enable if needed during debuggin
    // asserts.heads(heads, node)

    this.heads.push({ key: node.key, length: node.length })
    if (node.timestamp > this.timestamp) this.timestamp = node.timestamp // TODO: support smoothing

    // resolved sort weight, re-stamped on every reapplication - this is what
    // topo reads back out of the changes stream
    this.update(node.key, node.length, node.weight, -1, null, false, false, false, false)
  }

  async canApply(key, optimistic) {
    const id = b4a.toString(key, 'hex')
    const w = this.writers.get(id)
    if (w) return w.added
    const info = await this.get(key)
    return info ? !info.isRemoved : !!optimistic
  }

  async get(key, { unflushed = false, timeout } = {}) {
    const node = await this.bee.get(encodeWriterKey(key), { timeout })
    const info = node !== null ? encoding.decodeSystemWriter(node.key, node.value) : null
    if (!unflushed) return info

    const upd = this.updates.get(b4a.toString(key, 'hex'))
    if (!upd) return info

    if (!info) {
      return {
        version: 4,
        key: upd.key,
        isRemoved: upd.isRemoved,
        isOplog: false,
        weight: upd.weight === -1 ? 0 : upd.weight,
        maxWeight: upd.maxWeight === -1 ? 0 : upd.maxWeight,
        length: upd.length,
        clock: 0,
        isAdded: upd.isAdded,
        isAcked: upd.isAcked,
        isAnchor: upd.isAnchor
      }
    }

    if (upd.isAdded) info.isAdded = true
    if (upd.isRemoved) info.isRemoved = true
    if (upd.isAcked) info.isAcked = true
    if (upd.isAnchor) info.isAnchor = true
    if (upd.maxWeight !== -1) {
      // a unique referrer ensures the update is written even if maxWeight
      // is unchanged, needed as it may be referenced by a claim
      info.referrer = upd.referrer
      info.maxWeight = upd.maxWeight
    }
    if (upd.weight !== -1) info.weight = upd.weight

    // length only ever advances
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

  update(key, length, weight, maxWeight, referrer, isAdded, isRemoved, isAcked, isAnchor) {
    const id = b4a.toString(key, 'hex')

    if (isAdded) {
      this.writers.set(id, { key, added: true, isAnchor: !!isAnchor })
    } else if (isRemoved) {
      this.writers.set(id, { key, added: false, isAnchor: !!isAnchor })
    }

    let upd = this.updates.get(id)

    if (!upd) {
      upd = {
        key,
        length: 0,
        weight: -1,
        maxWeight: -1,
        referrer: null,
        isRemoved: false,
        isAdded: false,
        isAcked: false,
        isAnchor: false
      }
      this.updates.set(id, upd)
    }

    if (weight !== -1) upd.weight = weight
    if (maxWeight !== -1) {
      upd.maxWeight = maxWeight
      upd.referrer = referrer
    }
    if (isAnchor) upd.isAnchor = true
    if (isAdded) {
      upd.isAdded = true
      upd.isRemoved = false
    }
    if (isRemoved) {
      upd.isRemoved = true
      upd.isAdded = false
    }
    if (isAcked) {
      upd.isAcked = true
    }
    if (length > upd.length) {
      upd.length = length
    }
  }

  async _updateWriter(upd, oplog) {
    const k = encodeWriterKey(upd.key)

    const node = await this.bee.get(k)
    const v = node ? encoding.decodeSystemWriter(node.key, node.value) : null

    const prevWeight = v && v.weight !== undefined ? v.weight : 0
    const prevMaxWeight = v && v.maxWeight !== undefined ? v.maxWeight : 0
    // per-field merge: each field is written only by its own path (weight by
    // addNode, maxWeight/referrer by grant ops), the rest carries forward
    const record = {
      version: 4,
      key: upd.key,
      isRemoved: upd.isRemoved ? true : upd.isAdded ? false : v ? v.isRemoved : false,
      isOplog: b4a.equals(upd.key, oplog),
      weight: upd.weight !== -1 ? upd.weight : prevWeight,
      maxWeight: upd.maxWeight !== -1 ? upd.maxWeight : prevMaxWeight,
      referrer: upd.maxWeight !== -1 ? upd.referrer : v ? v.referrer : null,
      length: Math.max(upd.length, v ? v.length : 0),
      clock: this.flushes,
      isAnchor: upd.isAnchor || (v ? v.isAnchor : false)
    }

    return [
      k,
      encoding.encodeSystemWriter(record),
      null,
      record.isRemoved ? encodeIndexerWriterKey(upd.key) : null
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

function getInfo(data) {
  for (const { keys } of data.batch) {
    for (const k of keys) {
      const prefix = k.key[0]

      if (prefix === 0) {
        return encoding.decodeSystemInfo(k.value)
      }
    }
  }

  asserts.bail('Bad system node')
}

function sameHead(a, b) {
  if (!a || !b || a.length !== b.length) return false
  if (!a.key || !b.key) return a.key === b.key
  return b4a.equals(a.key, b.key)
}
