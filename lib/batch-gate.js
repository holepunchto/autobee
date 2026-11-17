// EXPERIMENTAL (headBarrier: true): two-phase bulk catch-up. Hold the
// drain while any known writer's data needed for applying - (applied,
// min(hintedLength, core.length)] - is missing locally, then let the
// greedy apply once over complete knowledge instead of churning undos on
// partial knowledge. The gate drives the fetch itself: next()'s read-ahead
// only runs while applying, which is exactly what is being held.
// core.length (signed) bounds the wait so an unverifiable hint cannot
// stall the drain.
//
// Each hold is an Episode with two deadlines: a stall (stallMs without a
// landed block - sparse arrivals count) and a hard cap (maxHoldMs, which
// progress does NOT reset). Either trips it into flushing: the drain
// applies everything available with no per-batch gate work while
// background collects keep the fetch fresh. Exhausting the flush ends the
// episode and anything still missing gates a fresh one, so sustained
// overload degrades to alternating hold/flush, never an unbounded hold.
//
// The gate is long-lived so ranges survive episode boundaries; a
// fast-forward invalidates both and replaces the gate wholesale.
class Episode {
  constructor(stallMs, maxHoldMs) {
    this.stallMs = stallMs
    this.maxHoldMs = maxHoldMs
    this.flushing = false
    this.stamp = null
    this.since = 0
    this.start = Date.now()
  }

  observe(measure) {
    const now = Date.now()

    if (this.stamp !== measure) {
      this.stamp = measure
      this.since = now // progress resets the stall, never the episode start
    }

    if (now - this.since >= this.stallMs || now - this.start >= this.maxHoldMs) {
      this.flushing = true
    }

    return this.flushing
  }

  remaining() {
    const now = Date.now()
    return Math.min(this.stallMs - (now - this.since), this.maxHoldMs - (now - this.start))
  }
}

module.exports = class BatchGate {
  constructor(auto, { enabled = false, stallMs = 10_000, maxHoldMs = stallMs * 6 } = {}) {
    this.auto = auto
    this.enabled = enabled
    this.stallMs = stallMs
    this.maxHoldMs = maxHoldMs
    this.destroyed = false

    this._episode = null
    this._fetches = new Map() // writer -> { end, range }
    this._collecting = null // in-flight background collect
    this._waker = null // hold: deadline re-check
  }

  // the next applicable batch, or null while the gate holds (or nothing
  // is pending). local appends are never gated.
  async next({ local = false } = {}) {
    if (local || !this.enabled) return this.auto.writers.nextPendingNode({ local })

    if (this._episode !== null && this._episode.flushing) {
      const batch = await this.auto.writers.nextPendingNode({ local })
      if (batch !== null) {
        this._tryCollect()
        return batch
      }
      // an exhausted flush may be starved, not done - the episode is over
      // either way, and anything still missing gates a fresh one below
      this._episode = null
    }

    if (await this._complete()) return this.auto.writers.nextPendingNode({ local })
    return null
  }

  // terminal - a replacement is constructed fresh
  destroy() {
    this.destroyed = true
    this._reset()
  }

  async _complete() {
    if (this.auto._interrupting) return true

    // never walk concurrently with a background collect - racing _fetch
    // calls double-create and leak ranges
    if (this._collecting !== null) await this._collecting

    const state = await this._collect()
    if (state === null) {
      this._reset()
      return true
    }

    this._prune(state.gated)

    if (this._episode === null) this._episode = new Episode(this.stallMs, this.maxHoldMs)
    if (this._episode.observe(state.measure)) {
      this._clearWaker()
      return true
    }

    this._wake()
    return false
  }

  // the writers with announced data missing from the range the apply phase
  // needs, or null if none. measure serialises the gated state: per-writer
  // lines catch set/applied/target changes, the trailing present count
  // catches block arrivals anywhere in the ranges (sparse included)
  async _collect() {
    let gated = null
    let present = 0
    let stamp = ''

    for (const w of this.auto.writers) {
      if (w === this.auto.writers.localWriter || w.isFrozen) continue

      const target = Math.min(w.hintedLength, w.core.length)
      if (target === 0) continue
      if (w.core.contiguousLength >= target) continue

      const info = await this.auto.system.get(w.core.key)
      const applied = info ? info.length : 0
      if (target <= applied) continue

      const have = await w.core.count(applied, target)
      if (have >= target - applied) continue

      if (gated === null) gated = new Set()
      gated.add(w)
      present += have
      stamp += w.id + ':' + applied + ':' + target + '\n'

      this._fetch(w, applied, target)
    }

    if (gated === null) return null
    return { gated, measure: stamp + '#' + present }
  }

  // only a grown target recreates a range: a stale start is harmless
  // (blocks below applied are already present) and fast-forwards, the one
  // real retarget, replace the whole gate
  _fetch(w, start, end) {
    if (this.destroyed) return

    const fetch = this._fetches.get(w)
    if (fetch && fetch.end >= end) return

    if (fetch) fetch.range.destroy()
    const range = w.core.download({ start, end })
    // a completed range must re-check the gate even when the writer's own
    // 'download' bump is suppressed (waiting is set)
    range
      .done()
      .then(() => this.auto.bumpSoon())
      .catch(noop)
    this._fetches.set(w, { end, range })
  }

  _prune(gated) {
    for (const [w, fetch] of this._fetches) {
      if (gated.has(w)) continue
      fetch.range.destroy()
      this._fetches.delete(w)
    }
  }

  // fetch upkeep off the apply path while a flush runs. coalesced, and the
  // result is discarded: background collects may see torn state, so they
  // must only arm ranges (idempotent) - clocks and prune stay foreground
  _tryCollect() {
    if (this._collecting !== null) return

    this._collecting = this._collect()
      .catch(noop)
      .finally(() => {
        this._collecting = null
      })
  }

  // a dead-quiet network never bumps the drain - re-check at the deadline
  _wake() {
    if (this._waker !== null) return

    this._waker = setTimeout(
      () => {
        this._waker = null
        this.auto.bumpSoon()
      },
      Math.max(this._episode.remaining(), 100)
    )
    if (this._waker.unref) this._waker.unref()
  }

  _clearWaker() {
    if (this._waker === null) return
    clearTimeout(this._waker)
    this._waker = null
  }

  _reset() {
    this._clearWaker()
    for (const { range } of this._fetches.values()) range.destroy()
    this._fetches.clear()
    this._episode = null
  }
}

function noop() {}
