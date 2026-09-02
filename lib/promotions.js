const b4a = require('b4a')
const encoding = require('./encoding.js')

// Owns the two grant-side indexes: one hint per writer (the coordinate of the
// approval that anchored its capability - advisory, never verified against)
// and one pending entry per writer awaiting a stronger approval. The digest in
// the system info records, per weight, the flush at which that tier last
// changed, so a peer can skip the index entirely when there is no new work.
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

  async *list({ activeRequests } = {}) {
    const pending = await this._load({ activeRequests })
    for (const [hex, entry] of pending) {
      yield { key: b4a.from(hex, 'hex'), weight: entry.weight, flushes: entry.flushes }
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
    const weights = new Set()

    for (const upd of updates) {
      const hex = b4a.toString(upd.key, 'hex')
      const existing = pending.get(hex) || null

      if (upd.isRemoved) {
        if (existing) {
          pending.delete(hex)
          weights.add(existing.weight)
          ops.push({ key: encoding.encodeSystemPendingKey(upd.key), remove: true })
        }
        continue
      }
      if (upd.pending === -1 && upd.grant === null) continue

      let anchored = upd.grant ? upd.grant.weight : 0
      const hint = await this.hint(upd.key)
      if (hint && hint.weight > anchored) anchored = hint.weight

      const want = Math.max(existing ? existing.weight : 0, upd.pending)
      if (want > anchored) {
        if (existing && want === existing.weight) continue
        const entry = { weight: want, flushes }
        if (existing) weights.add(existing.weight)
        pending.set(hex, entry)
        weights.add(want)
        ops.push({
          key: encoding.encodeSystemPendingKey(upd.key),
          value: encoding.encodeSystemPending(entry)
        })
        this.changed = true
      } else if (existing) {
        pending.delete(hex)
        weights.add(existing.weight)
        ops.push({ key: encoding.encodeSystemPendingKey(upd.key), remove: true })
      }
    }

    if (!ops.length) return null

    for (const w of weights) {
      while (this.digest.length < w) this.digest.push(0)
      this.digest[w - 1] = flushes
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
