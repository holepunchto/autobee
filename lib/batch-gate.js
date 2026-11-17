// EXPERIMENTAL (headBarrier: true): two-phase bulk catch-up. Hold the
// drain while any known writer's data needed for applying - (applied,
// min(hintedLength, core.length)] - is missing locally, then let the
// greedy apply once over complete knowledge instead of churning undos on
// partial knowledge. The gate drives the fetch itself: next()'s read-ahead
// only runs while applying, which is exactly what is being held.
// core.length (signed) bounds the wait so an unverifiable hint cannot
// stall the drain; starting at the applied length keeps the gate correct
// after a fast-forward.
//
// The release is a circuit breaker that fails open: it trips on a stall
// (stallMs without a landed block - sparse arrivals count) or on the
// episode cap (maxHoldMs, which progress does NOT reset), detaches from
// the apply path, and re-closes only once the gated set fully clears -
// re-arming mid-backlog would drip one batch per stall interval. A gate
// is fungible: a fast-forward destroys it and constructs a fresh one.
module.exports = class BatchGate {
  constructor(auto, { enabled = false, stallMs = 10_000, maxHoldMs = stallMs * 6 } = {}) {
    this.auto = auto
    this.enabled = enabled
    this.stallMs = stallMs
    this.maxHoldMs = maxHoldMs

    this._fetches = new Map() // writer -> { start, end, range }
    this._progress = null // { stamp, since, episode }
    this._released = false
    this._timer = null
  }

  // the next applicable batch, or null while the gate holds (or nothing
  // is pending). local appends are never gated.
  async next({ local = false } = {}) {
    if (local || !this.enabled) return this.auto.writers.nextPendingNode({ local })

    if (this._released) {
      const batch = await this.auto.writers.nextPendingNode({ local })
      if (batch !== null) return batch
      // an exhausted flush may be starved, not done - only a clear gated
      // set re-closes the breaker
      if ((await this._collect()) === null) this._reset()
      return null
    }

    if (!(await this._complete())) return null
    return this.auto.writers.nextPendingNode({ local })
  }

  // terminal - a replacement is constructed fresh
  destroy() {
    this._reset()
  }

  async _complete() {
    if (this.auto._interrupting) return true

    const state = await this._collect()
    if (state === null) {
      this._reset()
      return true
    }

    this._prune(state.gated)
    if (this._trip(state.measure)) return true

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

      if (!this._released) this._fetch(w, applied, target)
    }

    if (gated === null) return null
    return { gated, measure: stamp + '#' + present }
  }

  _fetch(w, start, end) {
    const fetch = this._fetches.get(w)
    if (fetch && fetch.end >= end && fetch.start >= start) return

    if (fetch) fetch.range.destroy()
    const range = w.core.download({ start, end })
    // a completed range must re-check the gate even when the writer's own
    // 'download' bump is suppressed (waiting is set)
    range
      .done()
      .then(() => this.auto.bumpSoon())
      .catch(noop)
    this._fetches.set(w, { start, end, range })
  }

  _prune(gated) {
    for (const [w, fetch] of this._fetches) {
      if (gated.has(w)) continue
      fetch.range.destroy()
      this._fetches.delete(w)
    }
  }

  _trip(measure) {
    const now = Date.now()

    if (this._progress === null) {
      this._progress = { stamp: measure, since: now, episode: now }
    } else if (this._progress.stamp !== measure) {
      this._progress.stamp = measure
      this._progress.since = now // progress resets the stall, never the episode
    }

    const stalled = now - this._progress.since
    const held = now - this._progress.episode
    if (stalled < this.stallMs && held < this.maxHoldMs) return false

    this._released = true
    return true
  }

  // a dead-quiet network never bumps the drain - re-check at the deadline
  _wake() {
    if (this._timer !== null) return

    const now = Date.now()
    const delay = Math.min(
      this.stallMs - (now - this._progress.since),
      this.maxHoldMs - (now - this._progress.episode)
    )

    this._timer = setTimeout(
      () => {
        this._timer = null
        this.auto.bumpSoon()
      },
      Math.max(delay, 100)
    )
    if (this._timer.unref) this._timer.unref()
  }

  _reset() {
    if (this._timer !== null) {
      clearTimeout(this._timer)
      this._timer = null
    }
    for (const { range } of this._fetches.values()) range.destroy()
    this._fetches.clear()
    this._progress = null
    this._released = false
  }
}

function noop() {}
