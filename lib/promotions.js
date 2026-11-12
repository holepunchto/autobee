const b4a = require('b4a')
const encoding = require('./encoding.js')

// Owns the two promotion indexes: one hint per writer (the coordinate of the
// approval that anchored its capability - advisory, never verified against)
// and one pending entry per writer awaiting a stronger approval.
//
// An approval clears the entry as soon as it satisfies the request, so the
// index holds exactly the outstanding work. A partial approval leaves the
// entry alone: the request still wants more than the tier that answered could
// give.
//
// digest[w - 1] is true when some request needs an approver of standing w.
// The false is what makes a tier go quiet: once one tier-w peer has anchored
// w, the rest see their tier is finished instead of all offering in turn. A
// flag is enough because a satisfied request leaves the index entirely, so
// there is no "have I already seen this" watermark to keep.
module.exports = class Promotions {
  constructor(bee) {
    this.bee = bee
    this.digest = []
    this.changed = false
    this._pending = null
  }

  reset(info) {
    this.digest = info && info.pending ? info.pending : []
    this._pending = null
  }

  async hint(key, { activeRequests } = {}) {
    const node = await this.bee.get(encoding.encodeSystemGrantKey(key), { activeRequests })
    return node ? encoding.decodeSystemGrantHint(node.value) : null
  }

  async pending(key, { activeRequests } = {}) {
    if (this._pending !== null) {
      const entry = this._pending.get(b4a.toString(key, 'hex'))
      return entry ? entry.weight : 0
    }

    const node = await this.bee.get(encoding.encodeSystemPendingKey(key), { activeRequests })
    return node ? encoding.decodeSystemPending(node.value).weight : 0
  }

  // the level a writer has already anchored is exactly what its hint records,
  // so it is read from there rather than mirrored into the pending entry
  async anchored(key, { activeRequests } = {}) {
    const hint = await this.hint(key, { activeRequests })
    return hint ? hint.weight : 0
  }

  async *list({ activeRequests } = {}) {
    const pending = await this._load({ activeRequests })
    for (const [hex, entry] of pending) {
      yield { key: b4a.from(hex, 'hex'), weight: entry.weight }
    }
  }

  async updateHint(upd) {
    if (!upd.grant && !upd.isRemoved) return null

    const key = encoding.encodeSystemGrantKey(upd.key)
    const node = await this.bee.get(key)

    if (upd.isRemoved) return node ? { key, remove: true } : null

    const existing = node ? encoding.decodeSystemGrantHint(node.value) : null
    if (existing && existing.weight >= upd.grant.weight) return null

    return { key, value: encoding.encodeSystemGrantHint(upd.grant) }
  }

  // grouped and sequential on purpose: the entries are shared state, so
  // per-update parallelism would interleave at the awaits. Only the hint reads
  // run in parallel, up front: they all see the pre-write state, so they are
  // independent of each other and of the entry updates below
  async flushPending(updates) {
    let relevant = false
    for (const upd of updates) {
      if (upd.pending !== -1 || upd.grant !== null || upd.isRemoved) {
        relevant = true
        break
      }
    }
    if (!relevant) return null

    const pending = await this._load()
    if (!pending.size && !updates.some((u) => u.pending !== -1)) return null

    const levels = await this._fillAnchored(pending, updates)

    const ops = []
    const anchoredBy = new Map()

    for (const upd of updates) {
      const hex = b4a.toString(upd.key, 'hex')
      const existing = pending.get(hex) || null

      if (upd.isRemoved) {
        if (existing) {
          pending.delete(hex)
          ops.push({ key: encoding.encodeSystemPendingKey(upd.key), remove: true })
        }
        continue
      }
      if (upd.pending === -1 && upd.grant === null) continue

      // the hint is still pre-write here, so this is the level already anchored
      // before whatever this update confers
      const prev = existing ? existing.anchored : levels.get(hex)
      const anchored = upd.grant && upd.grant.weight > prev ? upd.grant.weight : prev
      anchoredBy.set(hex, anchored)

      const want = Math.max(existing ? existing.weight : 0, upd.pending)

      if (want > anchored) {
        if (existing && want === existing.weight) {
          existing.anchored = anchored
          continue
        }
        const entry = { weight: want, anchored }
        pending.set(hex, entry)
        ops.push({
          key: encoding.encodeSystemPendingKey(upd.key),
          value: encoding.encodeSystemPending(entry)
        })
        this.changed = true
      } else if (existing) {
        // satisfied - the approval covered everything the request asked for
        pending.delete(hex)
        ops.push({ key: encoding.encodeSystemPendingKey(upd.key), remove: true })
      }
    }

    // the flags depend on the anchored level, not just on which entries exist -
    // an approval that partially serves a request writes no entry at all, and
    // its tier still has to go quiet
    //
    // the anchored level is cached on the in-memory entry: hints only change through
    // the updates passed in here (system.flush writes them in the same batch), which
    // refresh it via anchoredBy, and reset() drops the whole map on ff/undo
    const open = new Set()
    for (const [hex, entry] of pending) {
      if (anchoredBy.has(hex)) entry.anchored = anchoredBy.get(hex)
      for (let w = entry.anchored + 1; w <= entry.weight; w++) open.add(w)
    }

    let max = 0
    for (const w of open) if (w > max) max = w

    this.digest = []
    for (let w = 1; w <= max; w++) this.digest.push(open.has(w))

    return ops.length ? ops : null
  }

  // reads, in parallel, the anchored level of every entry not cached yet (the
  // cold fill after a load/reset) and of every updated writer without an entry,
  // caching it on the entries. Returns the levels by hex for the update loop
  async _fillAnchored(pending, updates) {
    const missing = new Set()
    for (const [hex, entry] of pending) {
      if (entry.anchored === null) missing.add(hex)
    }
    for (const upd of updates) {
      if (upd.isRemoved || (upd.pending === -1 && upd.grant === null)) continue
      const hex = b4a.toString(upd.key, 'hex')
      if (!pending.has(hex)) missing.add(hex)
    }

    const levels = new Map()
    if (missing.size === 0) return levels

    const keys = [...missing]
    const results = await Promise.all(keys.map((hex) => this.anchored(b4a.from(hex, 'hex'))))

    for (let i = 0; i < keys.length; i++) {
      levels.set(keys[i], results[i])
      const entry = pending.get(keys[i])
      if (entry) entry.anchored = results[i]
    }

    return levels
  }

  async _load({ activeRequests } = {}) {
    if (this._pending !== null) return this._pending

    const pending = new Map()
    const range = encoding.encodeSystemPendingRange()
    for await (const data of this.bee.createReadStream({ ...range, activeRequests })) {
      // the anchored level is filled in lazily, by _fillAnchored
      const { weight } = encoding.decodeSystemPending(data.value)
      pending.set(b4a.toString(encoding.decodeSystemPendingKey(data.key), 'hex'), {
        weight,
        anchored: null
      })
    }

    this._pending = pending
    return pending
  }
}
