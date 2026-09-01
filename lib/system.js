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

class SystemSnapshot {
  constructor(bee) {
    this.bee = bee
  }

  async get(key, { timeout } = {}) {
    const node = await this.bee.get(encoding.encodeSystemWriterKey(key), { timeout })
    return node !== null ? encoding.decodeSystemWriter(node.key, node.value) : null
  }

  async has(link) {
    const node = await this.get(link.key)
    if (!node || node.length < link.length) return false
    return true
  }

  close() {
    return this.bee.close()
  }
}

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
    this.pendingChanged = false
    this._pendingArrays = null
  }

  // clamps weight to max(requested, current). order-independent, so
  // concurrent races converge and honest weights never decrease
  async addWriter(
    key,
    { length = 0, weight = 1, isGenesis = false, coord = null, carrier = -1 } = {}
  ) {
    const info = await this.get(key, { unflushed: true })
    if (length === 0) {
      length = info ? info.length : 0
    }

    const effective = coord && carrier < weight ? Math.max(carrier, 0) : weight
    const grant = coord ? { key: coord.key, length: coord.length, weight: effective } : null
    const pending = effective < weight ? weight : -1

    const current = info ? info.maxWeight : 0
    if (effective <= current) {
      if (info && !info.isRemoved && length <= info.length && !grant && pending === -1) return

      this.update(key, length, -1, -1, false, true, false, false, false, -1, grant, pending)
      return
    }

    const w = isGenesis ? effective : -1
    this.update(key, length, w, effective, isGenesis, true, false, false, false, -1, grant, pending)
  }

  async ackWriter(key, { length = 0 } = {}) {
    if (length === 0) {
      const info = await this.get(key, { unflushed: false })
      length = info ? info.length : 0
    }
    this.update(key, length, -1, -1, false, false, false, true, false, -1, null)
  }

  async removeWriter(key, { length = 0 } = {}) {
    if (length === 0) {
      const info = await this.get(key, { unflushed: true })
      length = info ? info.length : 0
    }
    this.update(key, length, -1, 0, false, false, true, false, false, -1, null)
  }

  addAnchor(key) {
    this.update(key, 0, -1, -1, false, true, false, false, true, -1, null)
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
    this._pendingArrays = null

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
      node.timestamp,
      false
    )
  }

  async canApply(key, optimistic) {
    const id = b4a.toString(key, 'hex')
    const w = this.writers.get(id)
    if (w) return w.added
    const info = await this.get(key)
    return info ? !info.isRemoved : !!optimistic
  }

  snapshot(head = null) {
    const bee =
      head === null
        ? this.bee.snapshot()
        : this.bee.checkout({ length: head.length, key: head.key })
    return new SystemSnapshot(bee)
  }

  async get(key, { unflushed = false, timeout, activeRequests } = {}) {
    const node = await this.bee.get(encoding.encodeSystemWriterKey(key), {
      timeout,
      activeRequests
    })
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
    grant,
    pending = -1
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
        grants: null,
        pending: -1
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
    if (pending > upd.pending) upd.pending = pending
    if (grant) {
      if (upd.grants === null) upd.grants = []
      const dupe = upd.grants.some(
        (g) =>
          g.length === grant.length && g.weight === grant.weight && b4a.equals(g.key, grant.key)
      )
      if (!dupe) upd.grants.push(grant)
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
    if (batch.length === 0) return []

    const oplog = batch[batch.length - 1].key

    const updates = [...this.updates.values()]
    const results = await Promise.all(updates.map((upd) => this._updateWriter(upd, oplog)))
    const grants = await Promise.all(updates.map((upd) => this._updateGrants(upd)))
    const prunes = await Promise.all(updates.map((upd) => this._pruneGrants(upd)))
    const pendings = await this._flushPending(updates)

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

    const putKeys = new Set()
    for (const g of grants) {
      if (!g) continue
      for (const entry of g) {
        w.tryPut(entry.key, entry.value)
        putKeys.add(b4a.toString(entry.key, 'hex'))
      }
    }

    for (const d of prunes) {
      if (!d) continue
      for (const key of d) {
        if (putKeys.has(b4a.toString(key, 'hex'))) continue
        w.tryDelete(key)
      }
    }

    if (pendings) {
      for (const p of pendings) {
        if (p.remove) w.tryDelete(p.key)
        else w.tryPut(p.key, p.value)
      }
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

    this.version = info.version
    this.view = info.view

    await w.flush()

    // Can enable if needed during debuggin
    // asserts.systemFlush(w)

    this.updates.clear()

    if (this.writers.size === 0) return []

    const changes = [...this.writers.values()]

    this.writers.clear()

    return changes
  }

  async _updateGrants(upd) {
    if (!upd.grants) return null

    const puts = []
    for (const grant of upd.grants) {
      const key = encoding.encodeSystemGrantKey(upd.key, grant)
      const node = await this.bee.get(key)
      if (node && encoding.decodeSystemGrant(node.value) >= grant.weight) continue
      puts.push({ key, value: encoding.encodeSystemGrant(grant.weight) })
    }

    return puts.length ? puts : null
  }

  async _pruneGrants(upd) {
    if (!upd.isRemoved && upd.weight === -1) return null

    const deletes = []
    const range = encoding.encodeSystemGrantRange(upd.key)
    for await (const data of this.bee.createReadStream(range)) {
      if (!upd.isRemoved && encoding.decodeSystemGrant(data.value) > upd.weight) continue
      deletes.push(data.key)
    }

    return deletes.length ? deletes : null
  }

  async _flushPending(updates) {
    let relevant = false
    for (const upd of updates) {
      if (upd.pending !== -1 || upd.maxWeight !== -1 || upd.isRemoved) {
        relevant = true
        break
      }
    }
    if (!relevant) return null

    const arrays = await this._loadPendingArrays()
    if (!arrays.size && !updates.some((u) => u.pending !== -1)) return null

    const changed = new Set()

    const remove = (key, ceil) => {
      for (const [w, keys] of arrays) {
        if (w > ceil) continue
        const i = keys.findIndex((k) => b4a.equals(k, key))
        if (i === -1) continue
        keys.splice(i, 1)
        changed.add(w)
      }
    }

    const highest = (key) => {
      let best = 0
      for (const [w, keys] of arrays) {
        if (w <= best) continue
        if (keys.some((k) => b4a.equals(k, key))) best = w
      }
      return best
    }

    for (const upd of updates) {
      if (upd.isRemoved) {
        remove(upd.key, Infinity)
        continue
      }
      if (upd.pending === -1 && upd.maxWeight === -1) continue

      const info = await this.get(upd.key, { unflushed: true })
      const max = info ? info.maxWeight : 0
      remove(upd.key, max)

      if (upd.pending <= max) continue
      const existing = highest(upd.key)
      if (existing >= upd.pending) continue
      if (existing > 0) remove(upd.key, existing)

      let keys = arrays.get(upd.pending)
      if (!keys) {
        keys = []
        arrays.set(upd.pending, keys)
      }
      keys.push(upd.key)
      changed.add(upd.pending)
      this.pendingChanged = true
    }

    if (!changed.size) return null

    const ops = []
    for (const w of changed) {
      const key = encoding.encodeSystemPendingKey(w)
      const keys = arrays.get(w)
      if (keys && keys.length) {
        ops.push({ key, value: encoding.encodeSystemPendingKeys(keys) })
      } else {
        ops.push({ key, remove: true })
        arrays.delete(w)
      }
    }

    return ops
  }

  async _loadPendingArrays({ activeRequests } = {}) {
    if (this._pendingArrays !== null) return this._pendingArrays

    const arrays = new Map()
    const range = encoding.encodeSystemPendingRange()
    for await (const data of this.bee.createReadStream({ ...range, activeRequests })) {
      arrays.set(
        encoding.decodeSystemPendingKey(data.key),
        encoding.decodeSystemPendingKeys(data.value)
      )
    }

    this._pendingArrays = arrays
    return arrays
  }

  // not safe to append to result
  async pendingAtWeight(weight, { activeRequests } = {}) {
    if (this._pendingArrays !== null) return this._pendingArrays.get(weight) || []

    const node = await this.bee.get(encoding.encodeSystemPendingKey(weight), { activeRequests })
    return node ? encoding.decodeSystemPendingKeys(node.value) : []
  }

  async pendingPromotion(key, { activeRequests } = {}) {
    const arrays = await this._loadPendingArrays({ activeRequests })
    let best = 0
    for (const [w, keys] of arrays) {
      if (w <= best) continue
      if (keys.some((k) => b4a.equals(k, key))) best = w
    }
    return best
  }

  async *listPendingPromotions({ activeRequests } = {}) {
    const arrays = await this._loadPendingArrays({ activeRequests })
    for (const [weight, keys] of arrays) {
      for (const key of keys) yield { key, weight }
    }
  }

  async grants(key) {
    const out = []
    for await (const data of this.bee.createReadStream(encoding.encodeSystemGrantRange(key))) {
      const k = encoding.decodeSystemGrantKey(data.key)
      out.push({ key: k.key, length: k.length, weight: encoding.decodeSystemGrant(data.value) })
    }
    return out
  }

  async grantedWeight(key, link) {
    if (!link || !link.length) return 0

    const node = await this.bee.get(encoding.encodeSystemGrantKey(key, link))
    return node ? encoding.decodeSystemGrant(node.value) : 0
  }

  async grantForWeight(key, weight) {
    const grants = await this.grants(key)
    for (let i = grants.length - 1; i >= 0; i--) {
      if (grants[i].weight === weight) return grants[i]
    }
    return null
  }

  async strongestGrant(key) {
    let best = null
    for (const g of await this.grants(key)) {
      if (best === null || g.weight > best.weight) best = g
    }
    return best
  }
}

function getInfo(data) {
  for (const { keys } of data.batch) {
    for (const k of keys) {
      const prefix = k.key[0]

      if (prefix === 0) {
        try {
          return encoding.decodeSystemInfo(k.value)
        } catch {
          return null
        }
      }
    }
  }

  return null
}
