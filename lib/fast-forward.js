const b4a = require('b4a')
const Signal = require('signal-promise')
const Hypercore = require('hypercore')
const safetyCatch = require('safety-catch')
const encoding = require('./encoding.js')
const System = require('./system.js')
const { LEGACY_AUTOBASE_VERSION, MAPPED_AUTOBEE_VERSION } = require('./constants.js')

const MIN_FF_GAP = 16

// one attempt at a head. it owns its reads and its warmup view, so cancelling
// it reaches nothing a later run started
class Inflation {
  constructor(ff, head, force) {
    this.ff = ff
    this.head = head
    this.flushes = head.op.views.flushes
    this.force = force
    this.cancelled = false
    this.activeRequests = []
    this.warmupView = null
    this.warmupClosing = Promise.resolve()
    this.promise = null
  }

  start(prev) {
    this.promise = this._start(prev)
    return this.promise
  }

  async _start(prev) {
    // runs share the system and the view, one at a time
    if (prev !== null) await prev.promise

    let result = null

    try {
      // cancelled while it waited its turn: it never reads
      if (!this.cancelled) result = await this._run()
    } catch (err) {
      safetyCatch(err)
    } finally {
      await this._closeWarmupView()
    }

    return this.ff.oninflated(this, result)
  }

  async _run() {
    const auto = this.ff.writers.auto
    const head = this.head
    const force = this.force
    const sys = head.op.views.system
    const target = { key: sys.key, length: sys.start + sys.length }

    // every read is our own, and none starts once we are cancelled
    const system = this.ff.openSystem()
    const activeRequests = this.activeRequests

    await system.boot(target, { activeRequests })
    if (this.cancelled) return null

    // a legacy autobase system is never landed on
    if (system.version <= LEGACY_AUTOBASE_VERSION) return null

    // an unmapped system is not landed on from the new generation, while the
    // remap commits, or for less than a gap
    if (
      system.version < MAPPED_AUTOBEE_VERSION &&
      !force &&
      !auto.system.isGenesis() &&
      (auto.remapped || auto.committing || system.flushes - auto.system.flushes < MIN_FF_GAP)
    ) {
      return null
    }

    const promises = []

    if (auto._warmup && system.view.length) {
      this.warmupView = auto.openView(system.view)
      promises.push(auto._warmup(this.warmupView.view))
    }

    promises.push(system.get(auto.local.key, { activeRequests }))

    // a legacy system without the designated view migrates onto an empty view
    const view = system.view.length ? this.ff.openView(system.view.key) : null

    if (view !== null) {
      promises.push(view.get(system.view.length - 1, { activeRequests }))
    }

    for (const h of system.heads) {
      promises.push(system.get(h.key, { activeRequests }))
    }

    await Promise.all(promises)
    if (this.cancelled) return null

    // conservative: what we land on must be held whole, by us or a connected peer
    if (!force && auto._conservativeFF) {
      if (!isContiguous(system.bee.core, target.length)) return null
      if (view !== null && !isContiguous(view, system.view.length)) return null
    }

    return {
      head: target,
      length: head.length,
      flushes: system.flushes,
      version: system.version
    }
  }

  cancel() {
    this.cancelled = true
    Hypercore.destroyRequests(this.activeRequests)
    this._closeWarmupView()
  }

  // a cancel starts the close, the run it failed waits for the same one
  _closeWarmupView() {
    if (this.warmupView === null) return this.warmupClosing

    const view = this.warmupView
    this.warmupView = null
    this.warmupClosing = view.close().catch(safetyCatch)

    return this.warmupClosing
  }
}

class WriterFastForward {
  constructor(writers, key, id, exact) {
    this.writers = writers
    this.key = key
    this.id = id
    // a move: the head at or right past this length. 0 tracks the newest head
    this.exact = exact
    this.refs = 0
    this.core = null
    this.hinted = 0
    this.fetched = 0
    this.loaded = 0
    this.signal = new Signal()
    this.length = 0
    this.head = null
    this.isClosed = false

    this.system = null
    this.view = null

    // the run in flight, at most one is not cancelled
    this.inflating = null
    this.inflated = null
  }

  static MIN_GAP = MIN_FF_GAP

  // keeps the writer alive: a writer that is gone means the head is outdated
  hint(length) {
    // by getting any length we usually get the best one
    if (length < 1) length = 1
    if (length <= this.hinted) return

    this.hinted = length

    this.writers.add(this.key).announce(length)
    this.refresh()
  }

  async wait(length) {
    if (length < 1) length = 1

    while (!this.isClosed && this.loaded < length) await this.signal.wait()
  }

  inflateBackground(opts) {
    this.inflate(opts).catch(safetyCatch)
  }

  inflate({ force = false, rewind = false } = {}) {
    if (this.head === null || this.isClosed) return Promise.resolve(null)

    const auto = this.writers.auto
    const head = this.head
    const flushes = head.op.views.flushes
    const system = auto.system.flushes

    if (this.inflated !== null && flushes - this.inflated.flushes < MIN_FF_GAP) {
      return Promise.resolve(this.inflated)
    }

    const prev = this.inflating

    // a cancelled run is not joined, and a forced request replaces an unforced run
    if (prev !== null && !prev.cancelled && (prev.force || !force)) {
      if (flushes - prev.flushes < MIN_FF_GAP) return prev.promise

      // a run already a gap ahead finishes first, it ranks again when done
      if (prev.flushes - system >= MIN_FF_GAP) return prev.promise
    }

    if (!rewind && flushes < system - landingSlack(auto)) return Promise.resolve(null)

    // any landing is a way out of a system that still has to be remapped
    const skipGap = !auto.system.isGenesis() && auto.system.version < MAPPED_AUTOBEE_VERSION

    if (!force && !skipGap && flushes - system < MIN_FF_GAP) return Promise.resolve(null)

    if (prev !== null) prev.cancel()

    this.inflating = new Inflation(this, head, force)

    return this.inflating.start(prev)
  }

  // the system is shared by the runs, one at a time
  openSystem() {
    if (this.system === null) {
      const auto = this.writers.auto

      // 'reboot' is a storage namespace, renaming it derives a different core on disk
      this.system = new System(auto, auto.store.namespace('reboot'), {
        getEncryptionProvider: auto.getSystemEncryption
      })
    }

    return this.system
  }

  oninflated(run, result) {
    // replaced meanwhile, the handle is no longer ours
    if (this.inflating === run) this.inflating = null

    if (run.cancelled || this.isClosed) return null

    if (result === null) {
      // a head that came in meanwhile joined this run, it gets its own
      if (this.head !== run.head) this.writers.rankFastForwards()
      // no landing came: a dependency refused while this ran may take a slot now
      this.writers.retryRefused()
      return null
    }

    this.inflated = result

    this.writers.auto.bumpSoon()
    this.writers.rankFastForwards()

    return result
  }

  openView(key) {
    if (this.view !== null && !b4a.equals(this.view.key, key)) {
      this.view.close().catch(safetyCatch)
      this.view = null
    }

    if (this.view === null) this.view = this.writers.auto.store.get({ key, active: true })

    return this.view
  }

  cancel() {
    if (this.inflating !== null) this.inflating.cancel()
  }

  // syncing a block may teach us a newer length, hence the loop
  // fetches the head in the background, never throws
  async refresh() {
    try {
      if (this.core === null) await this._openCore()

      if (this.core === null) return

      while (!this.isClosed) {
        const length = this.exact > 0 ? this.exact : Math.max(this.hinted, this.core.length)
        if (length <= this.fetched) return
        this.fetched = length

        const block = await this.core.get(length - 1)
        if (this.isClosed) return

        this._onblock(length, block)
      }
    } catch (err) {
      safetyCatch(err)
      // a head that does not decode never will
      if (!this.isClosed) await this.close()
    }
  }

  _onblock(length, block) {
    if (length > this.loaded) this.loaded = length
    this.signal.notify()

    if (length <= this.length) return

    const op = encoding.decodeOplog(block)

    if (op.views === null) {
      // a move takes the first head at or past its length
      if (this.exact > 0) this.exact = length + 1
      return
    }

    this.length = length
    this.head = { key: this.key, length, op }

    this.writers.rankFastForwards()
  }

  async _openCore() {
    const core = await this.writers.add(this.key).session({ active: true })
    if (core === null) return

    if (this.core !== null || this.isClosed) {
      await core.close()
      return
    }

    this.core = core
  }

  async close() {
    this.isClosed = true
    this.head = null
    this.inflated = null
    this.signal.notify()

    try {
      // the run clears itself, and one that still waits its turn never reads
      if (this.inflating !== null) {
        const run = this.inflating
        run.cancel()
        await run.promise
      }

      if (this.system !== null) await this.system.close()
      if (this.view !== null) await this.view.close()
      if (this.core !== null) await this.core.close()
    } catch (err) {
      safetyCatch(err)
    }
  }
}

function landingSlack(auto) {
  if (auto.system.isGenesis() || auto.system.version >= MAPPED_AUTOBEE_VERSION) return 0
  return MIN_FF_GAP
}

function isContiguous(core, length) {
  return core.contiguousLength >= length || core.remoteContiguousLength >= length
}

module.exports = WriterFastForward
