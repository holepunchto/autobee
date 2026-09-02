const b4a = require('b4a')
const encoding = require('./encoding.js')

// Owns the two promotion indexes: one hint per writer (the coordinate of the
// approval that anchored its capability - advisory, never verified against)
// and one pending entry per writer awaiting a stronger approval. The level
// already anchored is not stored twice: it is exactly the hint's weight, so
// the tiers that can still serve a request are read from there.
//
// digest[w - 1] is the flush at which the set of requests a peer of standing w
// could serve last changed, or 0 when no request needs a tier-w approver. The
// zero matters: once one tier-w peer has anchored w, every other tier-w peer
// must see that its tier is finished, or all of them keep offering their own
// approval while the request waits for someone stronger.
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
      yield {
        key: b4a.from(hex, 'hex'),
        weight: entry.weight,
        flushes: entry.flushes
      }
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

  // grouped and sequential on purpose: the entries and the digest are shared
  // state, so per-update parallelism would interleave at the awaits
  async flushPending(updates, flushes) {
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

    const ops = []
    const touched = new Set()
    const anchoredBy = new Map()

    const tiers = (anchored, weight) => {
      for (let w = anchored + 1; w <= weight; w++) touched.add(w)
    }

    for (const upd of updates) {
      const hex = b4a.toString(upd.key, 'hex')
      const existing = pending.get(hex) || null

      // the hint is still pre-write here, so this is the level already anchored
      // before whatever this update confers
      const prev = await this.anchored(upd.key)

      if (upd.isRemoved) {
        if (existing) {
          pending.delete(hex)
          tiers(prev, existing.weight)
          ops.push({ key: encoding.encodeSystemPendingKey(upd.key), remove: true })
        }
        continue
      }
      if (upd.pending === -1 && upd.grant === null) continue

      const anchored = upd.grant && upd.grant.weight > prev ? upd.grant.weight : prev
      anchoredBy.set(hex, anchored)

      const want = Math.max(existing ? existing.weight : 0, upd.pending)
      if (want > anchored) {
        if (existing && want === existing.weight && anchored === prev) continue
        const entry = { weight: want, flushes }
        tiers(prev, existing ? existing.weight : 0)
        pending.set(hex, entry)
        tiers(anchored, want)
        ops.push({
          key: encoding.encodeSystemPendingKey(upd.key),
          value: encoding.encodeSystemPending(entry)
        })
        this.changed = true
      } else if (existing) {
        pending.delete(hex)
        tiers(prev, existing.weight)
        ops.push({ key: encoding.encodeSystemPendingKey(upd.key), remove: true })
      }
    }

    if (!ops.length) return null

    const open = new Set()
    for (const [hex, entry] of pending) {
      const anchored = anchoredBy.has(hex)
        ? anchoredBy.get(hex)
        : await this.anchored(b4a.from(hex, 'hex'))
      for (let w = anchored + 1; w <= entry.weight; w++) open.add(w)
    }

    let max = this.digest.length
    for (const w of touched) if (w > max) max = w
    for (const w of open) if (w > max) max = w

    for (let w = 1; w <= max; w++) {
      while (this.digest.length < w) this.digest.push(0)
      if (!open.has(w)) this.digest[w - 1] = 0
      else if (touched.has(w)) this.digest[w - 1] = flushes
    }

    return ops
  }

  async _load({ activeRequests } = {}) {
    if (this._pending !== null) return this._pending

    const pending = new Map()
    const range = encoding.encodeSystemPendingRange()
    for await (const data of this.bee.createReadStream({ ...range, activeRequests })) {
      pending.set(
        b4a.toString(encoding.decodeSystemPendingKey(data.key), 'hex'),
        encoding.decodeSystemPending(data.value)
      )
    }

    this._pending = pending
    return pending
  }
}
