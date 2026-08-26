const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const c = require('compact-encoding')

const DEFAULT_ROUND = 30_000

// optimistic nodes still needing a linking node from an established writer
module.exports = class AckTracker {
  constructor({ round = DEFAULT_ROUND, ontimeout = noop } = {}) {
    this.round = round
    this.ontimeout = ontimeout
    this.pending = []
    this.timer = null
  }

  get size() {
    return this.pending.length
  }

  add(key, length, since) {
    for (const p of this.pending) {
      if (!b4a.equals(p.key, key)) continue
      if (length > p.length) p.length = length
      return
    }
    this.pending.push({ key, length, since })
  }

  // any link settles an entry: a peer's ack, a peer's op or our own op.
  settle(node, head) {
    if (this.pending.length === 0) return
    if (b4a.equals(node.key, head.key)) return // self-advance is not a link

    let since = -1

    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i]
      if (!b4a.equals(p.key, head.key)) continue
      if (head.length < p.length) continue
      if (since === -1 || p.since < since) since = p.since
      this.pending.splice(i--, 1)
    }

    // link from an optimistic node inherits the entry, we still need an ack
    if (since !== -1 && node.optimistic) this.add(node.key, node.length, since)

    if (this.pending.length === 0) this._cancel()
  }

  clear() {
    this.pending = []
    this._cancel()
  }

  snapshot() {
    return this.pending.map((p) => ({ ...p }))
  }

  restore(pending) {
    this.pending = pending
    if (this.pending.length === 0) this._cancel()
  }

  // Backoff lottery: in round r a writer participates with probability
  // 2^r / members. Covers ack in cases where few members are online
  delay(localKey, now, members) {
    let due = -1
    for (const p of this.pending) {
      const t = this._due(p, localKey, now, members)
      if (due === -1 || t < due) due = t
    }
    if (due === -1 || due <= now) return 0

    // wake at most one round out - a fresh entry may move the due time in
    this._schedule(Math.min(due - now, this.round))
    return due - now
  }

  // the first round we win the lottery for this entry decides when we pay -
  // if that time already passed unsettled, we are overdue. participation
  // saturates by round log2(members), so the scan is bounded
  _due(p, localKey, now, members) {
    const total = Math.max(members, 1)

    for (let r = 0; ; r++) {
      const [roundProb, roundOffset] = this._hash(p.key, p.length, localKey, r)

      const chance = 2 ** Math.min(r, 32)
      if (chance < total && roundProb % total >= chance) continue

      const t = p.since + r * this.round + (roundOffset % this.round)
      return t < now ? now : t
    }
  }

  _hash(key, length, local, round) {
    const h = crypto.hash([key, c.encode(c.uint, length), local, c.encode(c.uint, round)])
    return [b4a.readUInt32LE(h, 0), b4a.readUInt32LE(h, 4)]
  }

  _schedule(ms) {
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.ontimeout()
    }, ms)
    if (this.timer.unref) this.timer.unref()
  }

  _cancel() {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
  }
}

function noop() {}
