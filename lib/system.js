const Hyperbee = require('hyperbee2')
const Promotions = require('./promotions.js')
const sodium = require('sodium-native')
const c = require('compact-encoding')
const b4a = require('b4a')

const { getViewMap, getCoreManifest } = require('./migrations.js')

const { AUTOBEE_VERSION, LEGACY_AUTOBASE_VERSION } = require('./constants')
const encoding = require('./encoding.js')
const topo = require('./topo.js')

const INFO_KEY = b4a.from([0])
const INFO_LEGACY_KEY = b4a.concat([b4a.from([0, 0]), b4a.from('info')])
const EMPTY_HEAD = { length: 0, key: null }
const EMPTY = b4a.from([])

const HASH = c.fixed(sodium.crypto_shorthash_BYTES)
const HASH_KEY = b4a.from('autobee-orderkey') // crypto_shorthash_KEYBYTES
const HASH_SEED = b4a.alloc(sodium.crypto_shorthash_BYTES)

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
  constructor(auto, store, opts = {}) {
    this.auto = auto
    this.store = store
    this.bee = new Hyperbee(store, opts)
    this.view = null
    this.heads = []
    this.hash = null
    this.migration = null
    this.version = 0
    this.timestamp = 0
    this.flushes = 0
    this.updates = new Map()
    this.writers = new Map()
    this.encrypted = opts.encrypted === true
    this.indexers = null
    this.promotions = new Promotions(this.bee)
  }

  get name() {
    return this.auto.name
  }

  async addWriter(
    key,
    { length = 0, weight = 1, isGenesis = false, coord = null, carrier = -1, anchor = false } = {}
  ) {
    const info = await this.get(key, { unflushed: true })
    if (length === 0) {
      length = info ? info.length : 0
    }

    const effective = coord && carrier < weight ? Math.max(carrier, 0) : weight
    const hint =
      anchor && coord ? { key: coord.key, length: coord.length, weight: effective } : null
    const pending = coord && !isGenesis ? weight : -1

    const current = info ? info.maxWeight : 0
    if (effective <= current) {
      // isAdded is false only when nothing has recorded the add yet - skipping
      // the update then leaves the writer undiscoverable, never announced
      const added = info && info.isAdded !== false
      if (added && !info.isRemoved && length <= info.length && !hint && pending === -1) return

      this.update(key, length, -1, -1, false, true, false, -1, hint, pending)
      return
    }

    const w = isGenesis ? effective : -1
    this.update(key, length, w, effective, isGenesis, true, false, -1, hint, pending)
  }

  async ackWriter(key, { length = 0 } = {}) {
    const info = await this.get(key, { unflushed: true })
    if (length === 0) {
      length = info ? info.length : 0
    }
    // called for every optimistic node once applied. not granted (unknown,
    // ack-only or removed): keep the op (record its length) but record the
    // writer as removed - it is not writable and only its optimistic ops reach apply
    const w = this.writers.get(b4a.toString(key, 'hex'))
    const granted = w ? w.added : info !== null && info.isAdded !== false && !info.isRemoved
    this.update(key, length, -1, -1, false, false, !granted, -1, null)
  }

  async removeWriter(key, { length = 0 } = {}) {
    if (length === 0) {
      const info = await this.get(key, { unflushed: true })
      length = info ? info.length : 0
    }
    this.update(key, length, -1, 0, false, false, true, -1, null)
  }

  addAnchor(key) {
    this.update(key, 0, -1, -1, false, true, false, -1, null)
  }

  isGenesis() {
    return this.bee.head() === null || this.bee.head().length === 0
  }

  isHead(key) {
    for (const head of this.heads) {
      if (b4a.equals(head.key, key)) return true
    }
    return false
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

  async reset({ timeout } = {}) {
    const info = await this.getInfo({ timeout })

    this.version = info ? info.version : 0
    this.view = info ? info.view : EMPTY_HEAD
    this.migration = null
    this.heads = info ? info.heads : []
    this.hash = info ? info.hash : null
    this.timestamp = info ? info.timestamp : 0
    this.flushes = info ? info.flushes : 0

    if (this.version <= LEGACY_AUTOBASE_VERSION) {
      // ~~~ good enough estimation
      this.flushes = Math.floor(this.bee.core.length / 2)
      this.view = await this._migrate(info, { timeout })
      this.indexers = info ? info.indexers : null
    } else {
      this.indexers = null
    }

    this.updates.clear()
    this.writers.clear()
    this.promotions.reset(info)

    if (this.version > AUTOBEE_VERSION) {
      throw new Error('Autobee signals newer version than locally supported')
    }
  }

  async _migrate(info, { timeout } = {}) {
    if (!info) return EMPTY_HEAD
    const a = this.auto

    const toManifests = ({ key, length }) => getCoreManifest(a.store, key, { timeout, length })
    const promises = [...info.indexers.map(toManifests), ...info.views.map(toManifests)]

    await Promise.all(promises)

    const views = await getViewMap(a.store, a.bootstrap, a.encryptionKey, info, a.legacyViews)

    // the handler only runs once the head is locked in - see auto._runMigration
    this.migration = { views, head: this.bee.head() }

    // only the designated view may become the autobee view: the view bee decrypts
    // with the key for its own name, so any other legacy view reads as garbage
    const name = a.legacyViews.length ? a.legacyViews[0] : null
    return (name && views.get(name)) || EMPTY_HEAD
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

    this.hash = advanceHash(this.hash, node)

    // resolved sort weight, re-stamped on every reapplication - this is what
    // topo reads back out of the changes stream
    this.update(node.key, node.length, node.weight, -1, false, false, false, node.timestamp, null)
  }

  async canApply(key, optimistic) {
    // an optimistic node always reaches apply, whether its writer is unknown,
    // acked or removed - it is self-verifying, apply decides what it does
    if (optimistic) return true
    const id = b4a.toString(key, 'hex')
    const w = this.writers.get(id)
    if (w) return w.added
    const info = await this.get(key)
    return info ? !info.isRemoved : false
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
        isAdded: upd.isAdded
      }
    }

    if (upd.isAdded) info.isAdded = true
    if (upd.isRemoved) info.isRemoved = true
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
    timestamp,
    grant,
    pending = -1
  ) {
    const id = b4a.toString(key, 'hex')

    if (isAdded) {
      this.writers.set(id, { key, added: true })
    } else if (isRemoved) {
      this.writers.set(id, { key, added: false })
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
        timestamp: 0,
        grant: null,
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
    if (isAdded) {
      upd.isAdded = true
      upd.isRemoved = false
    }
    if (isRemoved) {
      upd.isRemoved = true
      upd.isAdded = false
    }
    if (length > upd.length) {
      upd.length = length
    }

    if (timestamp > -1) {
      upd.timestamp = timestamp
    }
    if (pending > upd.pending) upd.pending = pending
    if (grant && (upd.grant === null || grant.weight > upd.grant.weight)) {
      upd.grant = grant
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
      version: 5,
      key: upd.key,
      isRemoved: upd.isRemoved ? true : upd.isAdded ? false : v ? v.isRemoved : false,
      isOplog,
      isGenesis: upd.maxWeight !== -1 ? !!upd.isGenesis : v ? v.isGenesis : false,
      weight: upd.weight !== -1 ? upd.weight : prevWeight,
      maxWeight: upd.maxWeight !== -1 ? upd.maxWeight : prevMaxWeight,
      length: Math.max(upd.length, v ? v.length : 0),
      timestamp: isOplog ? upd.timestamp : 0
    }

    return {
      key: k,
      value: encoding.encodeSystemWriter(record),
      add: null,
      remove: null,
      maxWeight: record.maxWeight
    }
  }

  async flush(batch, bee) {
    if (batch.length === 0) return []

    const oplog = batch[batch.length - 1].key

    const updates = [...this.updates.values()]
    const results = await Promise.all(updates.map((upd) => this._flushUpdate(upd, oplog)))
    const pendings = await this.promotions.flushPending(updates)

    const w = this.bee.write()

    for (const { writer } of results) {
      w.tryPut(writer.key, writer.value)
      if (writer.add) w.tryPut(writer.add, EMPTY)
      if (writer.remove) w.tryDelete(writer.remove)
    }

    for (const { grant } of results) {
      if (!grant) continue
      if (grant.remove) w.tryDelete(grant.key)
      else w.tryPut(grant.key, grant.value)
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
      indexers: null, // legacy
      pending: this.promotions.digest,
      hash: this.hash
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

  async _flushUpdate(upd, oplog) {
    const [writer, grant] = await Promise.all([
      this._updateWriter(upd, oplog),
      this.promotions.updateHint(upd)
    ])

    return { writer, grant }
  }

  pendingPromotion(key, opts) {
    return this.promotions.pending(key, opts)
  }

  listPendingPromotions(opts) {
    return this.promotions.list(opts)
  }

  grantHint(key, opts) {
    return this.promotions.hint(key, opts)
  }
}

function advanceHash(prev, node) {
  const state = { start: 0, end: 0, buffer: null }

  HASH.preencode(state, prev || HASH_SEED)
  c.fixed32.preencode(state, node.key)
  c.uint.preencode(state, node.length)
  c.uint.preencode(state, node.weight)

  state.buffer = b4a.allocUnsafe(state.end)

  HASH.encode(state, prev || HASH_SEED)
  c.fixed32.encode(state, node.key)
  c.uint.encode(state, node.length)
  c.uint.encode(state, node.weight)

  const hash = b4a.allocUnsafe(sodium.crypto_shorthash_BYTES)
  sodium.crypto_shorthash(hash, state.buffer, HASH_KEY)

  return hash
}
