const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const c = require('compact-encoding')

const DEFAULT_BACKOFF_TARGET = 200
const DEFAULT_MAX_BACKOFF = 10 * 60 * 1000

// optimistic nodes still needing a linking node from an established writer
module.exports = class AckTracker {
  constructor({
    target = DEFAULT_BACKOFF_TARGET,
    max = DEFAULT_MAX_BACKOFF,
    ontimeout = noop
  } = {}) {
    this.target = target
    this.max = max
    this.ontimeout = ontimeout
    this.pending = []
    this.delayUntil = 0
    this.timer = null
  }

  get size() {
    return this.pending.length
  }

  add(key, length) {
    for (const p of this.pending) {
      if (!b4a.equals(p.key, key)) continue
      if (length > p.length) p.length = length
      return
    }
    this.pending.push({ key, length })
  }

  // any link settles an entry: a peer's ack, a peer's op or our own op
  settle(node, head) {
    if (this.pending.length === 0) return
    if (b4a.equals(node.key, head.key)) return // self-advance is not a link

    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i]
      if (!b4a.equals(p.key, head.key)) continue
      if (head.length < p.length) continue
      this.pending.splice(i--, 1)
    }

    if (this.pending.length === 0) {
      this.delayUntil = 0
      this._cancel()
    }
  }

  clear() {
    this.pending = []
    this.delayUntil = 0
    this._cancel()
  }

  snapshot() {
    return this.pending.map((p) => ({ ...p }))
  }

  restore(pending) {
    this.pending = pending
    if (this.pending.length === 0) this._cancel()
  }

  // remaining hold-off in ms, or 0 when the ack should be appended now.
  // deterministic per entry so one writer acks for everyone: whoever draws
  // shortest appends, the rest observe the link and stand down
  delay(localKey, now, members) {
    const window = Math.max(members, 1) * this.target

    let min = -1
    for (const p of this.pending) {
      const h = crypto.hash([p.key, c.encode(c.uint, p.length), localKey])
      const draw = c.decode(c.uint32, h) % window
      if (min === -1 || draw < min) min = draw
    }
    if (min === -1) return 0

    const until = now + min
    if (this.delayUntil === 0 || until < this.delayUntil) this.delayUntil = until

    const remaining = this.delayUntil - now
    if (remaining <= 0) {
      this.delayUntil = 0
      return 0
    }

    if (remaining <= this.max) this._schedule(remaining)
    return remaining
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
