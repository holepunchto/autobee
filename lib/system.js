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

  // clamps weight to max(requested, current). order-independent, so
  // concurrent races converge and honest weights never decrease
  async addWriter(key, { length = 0, weight = 1, isGenesis = false } = {}) {
    const info = await this.get(key, { unflushed: true })
    if (length === 0) {
      length = info ? info.length : 0
    }

    const current = info ? info.maxWeight : 0
    if (weight <= current) {
      if (info && !info.isRemoved && length <= info.length) return

      this.update(key, length, -1, -1, false, true, false, false, false, -1, false)
      return
    }

    const w = isGenesis ? weight : -1
    this.update(key, length, w, weight, isGenesis, true, false, false, false, -1, true)
  }

  async ackWriter(key, { length = 0 } = {}) {
    if (length === 0) {
      const info = await this.get(key, { unflushed: false })
      length = info ? info.length : 0
    }
    this.update(key, length, -1, -1, false, false, false, true, false, -1, false)
  }

  async removeWriter(key, { length = 0 } = {}) {
    if (length === 0) {
      const info = await this.get(key, { unflushed: true })
      length = info ? info.length : 0
    }
    this.update(key, length, -1, 0, false, false, true, false, false, -1, false)
  }

  addAnchor(key, { length = 1 } = {}) {
    this.update(key, length, -1, -1, false, true, false, false, true, -1, false)
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

  async commonAncestor(head) {
    const info = await this.getInfo()

    const snap = this.bee.checkout(head)

    const hist1 = this.bee.createChangesStream()[Symbol.asyncIterator]()
    const hist2 = snap.createChangesStream()[Symbol.asyncIterator]()

    let a = await hist1.next()
    let b = await hist2.next()

    if (!a.value || !b.value) {
      return { flushes: 0, system: EMPTY_HEAD, view: EMPTY_HEAD }
    }

    let l = getInfo(a.value)
    let r = getInfo(b.value)

    while (!a.done || !b.done) {
      if (l.flushes === r.flushes && sameHead(l.view, r.view)) {
        return {
          flushes: l.flushes,
          system: a.value.head,
          view: l.view || EMPTY_HEAD
        }
      }

      if (l.flushes >= r.flushes) {
        a = await hist1.next()
        if (a.value) l = getInfo(a.value)
      }

      if (r.flushes >= l.flushes) {
        b = await hist2.next()
        if (b.value) r = getInfo(b.value)
      }
    }

    return { flushes: 0, system: EMPTY_HEAD, view: EMPTY_HEAD }
  }

  async reset({ timeout } = {}) {
    const info = await this.getInfo({ timeout })

    this.version = info ? info.version : 0
    this.view = info ? info.view : EMPTY_HEAD
    this.heads = info ? info.heads : []
    this.timestamp = info ? info.timestamp : 0
    this.flushes = info ? info.flushes : 0
    this.indexers = info ? info.indexers : null
    this.shared = null
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

    const shared = this.shared
    await this.reset()

    // deepest rewind since last mark - everything at or below it is untouched
    if (shared === null || this.flushes < shared.flushes) {
      this.shared = { flushes: this.flushes, view: this.view || EMPTY_HEAD, system: head }
    } else if (shared) {
      this.shared = shared
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
    this.update(
      node.key,
      node.length,
      node.weight,
      -1,
      false,
      false,
      false,
      false,
      false,
      node.timestamp
    )
  }

  async canApply(key, optimistic) {
    const id = b4a.toString(key, 'hex')
    const w = this.writers.get(id)
    if (w) return w.added
    const info = await this.get(key)
    return info ? !info.isRemoved : !!optimistic
  }

  async get(key, { unflushed = false, timeout } = {}) {
    const node = await this.bee.get(encoding.encodeSystemWriterKey(key), { timeout })
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
        isGenesis: upd.maxWeight !== -1 && !!upd.isGenesis,
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
      info.isGenesis = upd.isGenesis
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

  update(
    key,
    length,
    weight,
    maxWeight,
    isGenesis,
    isAdded,
    isRemoved,
    isAcked,
    isAnchor,
    timestamp,
    needsWitness
  ) {
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
        isGenesis: false,
        isRemoved: false,
        isAdded: false,
        isAcked: false,
        isAnchor: false,
        timestamp: -1,
        needsWitness
      }
      this.updates.set(id, upd)
    }

    // resolved stamps are monotone per writer (resolve floors at prev)
    if (weight !== -1) upd.weight = upd.weight === -1 ? weight : Math.max(upd.weight, weight)
    if (maxWeight !== -1) {
      upd.maxWeight = maxWeight
      upd.isGenesis = isGenesis
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

    if (timestamp !== -1 && upd.timestamp === -1) {
      upd.timestamp = timestamp
    }
    if (needsWitness && !upd.needsWitness) {
      upd.needsWitness = true
    }
  }

  async _updateWriter(upd, oplog) {
    const k = encoding.encodeSystemWriterKey(upd.key)

    const node = await this.bee.get(k)
    const v = node ? encoding.decodeSystemWriter(node.key, node.value) : null

    const prevWeight = v && v.weight !== undefined ? v.weight : 0
    const prevMaxWeight = v && v.maxWeight !== undefined ? v.maxWeight : 0
    const isOplog = b4a.equals(upd.key, oplog)

    const record = {
      version: 4,
      key: upd.key,
      isRemoved: upd.isRemoved ? true : upd.isAdded ? false : v ? v.isRemoved : false,
      isOplog,
      weight: upd.weight !== -1 ? upd.weight : prevWeight,
      maxWeight: upd.maxWeight !== -1 ? upd.maxWeight : prevMaxWeight,
      isGenesis: upd.maxWeight !== -1 ? !!upd.isGenesis : v ? v.isGenesis : false,
      length: Math.max(upd.length, v ? v.length : 0),
      clock: this.flushes,
      isAnchor: upd.isAnchor || (v ? v.isAnchor : false),
      timestamp: isOplog ? upd.timestamp : -1
    }

    return {
      key: k,
      value: encoding.encodeSystemWriter(record),
      add: null,
      remove: record.isRemoved ? encoding.encodeSystemIndexerKey(upd.key) : null,
      maxWeight: record.maxWeight
    }
  }

  async flush(batch, bee) {
    if (batch.length === 0) return { witnessed: [], changed: [] }

    const oplog = batch[batch.length - 1].key

    const updates = [...this.updates.values()]
    const results = await Promise.all(updates.map((upd) => this._updateWriter(upd, oplog)))

    const witnessed = []
    for (let i = 0; i < updates.length; i++) {
      if (updates[i].needsWitness) witnessed.push({ key: updates[i].key, weight: results[i].maxWeight })
    }

    const w = this.bee.write()

    // migrate
    if (this.indexers) {
      for (const { key } of this.indexers) w.tryPut(encoding.encodeSystemIndexerKey(key), EMPTY)
      this.indexers = null
    }

    for (const { key, value, add, remove } of results) {
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

    if (this.writers.size === 0) return { witnessed, changed: [] }

    const changes = [...this.writers.values()]

    this.writers.clear()

    return {
      witnessed,
      changed: changes
    }
  }
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
