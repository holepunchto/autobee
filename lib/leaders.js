const b4a = require('b4a')
const safetyCatch = require('safety-catch')

module.exports = class LeaderSet {
  constructor(auto, onBootCandidate) {
    this.auto = auto
    this.onBootCandidate = onBootCandidate
    this.cores = new Map()
    this.candidates = new Map()
  }

  async add(key) {
    const id = b4a.toString(key, 'hex')
    if (this.cores.has(id)) return

    const core = this.auto.store.get({ key, active: false })
    await core.ready()

    core.on('append', () => this._bump(id, core))
    this.cores.set(id, core)

    if (core.length > 0) this._bump(id, core)
  }

  async delete(key) {
    const id = b4a.toString(key, 'hex')
    const core = this.cores.get(id)
    if (!core) return

    this.cores.delete(id)
    this.candidates.delete(id)
    await core.close()
  }

  _bump(id, core) {
    this._refresh(id, core).catch(safetyCatch)
  }

  candidate(core) {
    return this.auto._getLatestOplogViews(core)
  }

  async _refresh(id, core) {
    const candidate = await this.candidate(core)
    if (!this.cores.has(id)) return

    if (candidate) this.candidates.set(id, candidate)
    else this.candidates.delete(id)

    const best = this._best()
    if (best) this.onBootCandidate(best)
  }

  _best() {
    let best = null
    for (const candidate of this.candidates.values()) {
      if (best === null || candidate.flushes > best.flushes) best = candidate
    }
    return best
  }

  async close() {
    const closing = []
    for (const core of this.cores.values()) closing.push(core.close())
    this.cores.clear()
    this.candidates.clear()
    await Promise.all(closing)
  }
}
