// EXPERIMENTAL batch gate (headBarrier: true): makes bulk catch-up a
// two-phase commit. Phase one holds the drain while any known writer's
// data needed for applying - (applied, min(hintedLength, core.length)] -
// is missing locally, driving the block fetch itself; phase two hands the
// drain the next batch (the existing greedy nextPendingNode) once
// everything the hints promised is present, so the backlog applies once
// over complete knowledge instead of churning undos on partial knowledge.
//
// core.length (signed) bounds the wait, so an unverifiable hint cannot
// stall the drain; starting at the applied length keeps the gate
// fast-forward-correct (blocks below an FF point never arrive). The gate
// must drive the fetch itself: next()'s read-ahead only runs while
// applying, which is exactly what is being held.
//
// The release is a circuit breaker that fails open. It trips on a stall
// (no landed block anywhere in the gated ranges for stallMs - sparse
// arrivals count, via core.count) or on the episode cap (maxHoldMs since
// gating began, which progress does NOT reset - progress a peer can
// manufacture forever must not hold the apply pipeline forever). Tripped,
// the drain applies eagerly, exactly as if the gate were off. The breaker
// re-closes on state, not time: only once the gated set fully clears -
// re-arming mid-backlog would drip one batch per stall interval instead
// of applying eagerly.
module.exports = class BatchGate {
  constructor(auto, { enabled = false, stallMs = 10_000, maxHoldMs = stallMs * 6 } = {}) {
    this.auto = auto
    this.enabled = enabled
    this.stallMs = stallMs
    this.maxHoldMs = maxHoldMs

    this._fetches = new Map() // writer -> { start, end, range }
    this._progress = null // { stamp, since, episode }
    this._released = false // the breaker: tripped = apply eagerly
    this._timer = null
  }

  // the next applicable batch, or null while the gate holds (or nothing
  // is pending). local appends are never gated.
  async next({ local = false } = {}) {
    if (!local && this.enabled && !(await this._complete())) return null
    return this.auto.writers.nextPendingNode({ local })
  }

  destroy() {
    if (this._timer !== null) {
      clearTimeout(this._timer)
      this._timer = null
    }
    this._reset()
  }

  // is everything the hints promised locally present (or the breaker open)?
  async _complete() {
    if (this.auto._interrupting) return true

    const state = await this._collect()

    if (state === null) {
      // nothing missing: end the episode and re-close the breaker
      this._reset()
      return true
    }

    if (this._released) return true

    this._prune(state.gated)
    if (this._trip(state.measure)) return true

    this._wake()
    return false
  }

  // walk every known writer and collect the gated set - who still has
  // announced data missing from the range the apply phase needs - arming
  // the fetch for each as a side effect (unless the breaker is open, when
  // next()'s own read-ahead takes over). Returns null when nothing is
  // missing, else { gated, measure } where measure serialises the gated
  // state: per-writer lines catch set/applied/target changes, the trailing
  // present count catches block arrivals anywhere in the gated ranges, so
  // sparse (post-fast-forward, out-of-order) arrivals register as progress
  async _collect() {
    let gated = null
    let present = 0
    let stamp = ''

    for (const w of this.auto.writers) {
      if (w === this.auto.writers.localWriter || w.isFrozen) continue

      const target = Math.min(w.hintedLength, w.core.length)
      if (target === 0) continue

      // full-prefix fast path - exact for a cold catch-up
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

  // keep a download range open covering (start, end] for a gated writer -
  // the drain is held, so nothing else would request these blocks
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

  // drop fetches for writers no longer gated (closed, satisfied, FF'd past)
  _prune(gated) {
    for (const [w, fetch] of this._fetches) {
      if (gated.has(w)) continue
      fetch.range.destroy()
      this._fetches.delete(w)
    }
  }

  // advance the stall/episode clocks against the gated state and trip the
  // breaker when either deadline is exceeded
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

  // a dead-quiet network never bumps the drain - re-check at whichever
  // deadline comes first
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
    for (const { range } of this._fetches.values()) range.destroy()
    this._fetches.clear()
    this._progress = null
    this._released = false
  }
}

function noop() {}
