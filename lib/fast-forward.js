const b4a = require('b4a')
const Signal = require('signal-promise')
const Hypercore = require('hypercore')
const safetyCatch = require('safety-catch')
const encoding = require('./encoding.js')
const System = require('./system.js')
const { LEGACY_AUTOBASE_VERSION, MAPPED_AUTOBEE_VERSION } = require('./constants.js')

const MIN_FF_GAP = 16

class WriterFastForward {
  constructor(writers, key, id) {
    this.writers = writers
    this.key = key
    this.id = id
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
    this.activeRequests = []
    this.view = null
    this.warmupView = null
    this.warmupClosing = Promise.resolve()

    this.inflating = null
    this.inflatingFlushes = 0
    this.inflatingForced = false
    this.inflatingStale = false
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

  // a new move: what was inflated and the run in flight are for an older request
  restart() {
    this.inflated = null
    if (this.inflating === null) return

    this.inflatingStale = true
    this.cancel()
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

    // a forced request replaces an unforced run, it does not join it
    const joinable = this.inflating !== null && !this.inflatingStale

    if (joinable && (this.inflatingForced || !force)) {
      if (flushes - this.inflatingFlushes < MIN_FF_GAP) return this.inflating

      // a run already a gap ahead finishes first, it ranks again when done
      if (this.inflatingFlushes - system >= MIN_FF_GAP) return this.inflating
    }

    if (!rewind && flushes < system - landingSlack(auto)) return Promise.resolve(null)

    // any landing is a way out of a system that still has to be remapped
    const skipGap = !auto.system.isGenesis() && auto.system.version < MAPPED_AUTOBEE_VERSION

    if (!force && !skipGap && flushes - system < MIN_FF_GAP) return Promise.resolve(null)

    if (this.inflating !== null) this.cancel()

    this.inflatingFlushes = flushes
    this.inflatingForced = force
    this.inflatingStale = false
    this.inflating = this._inflate(head, force)

    return this.inflating
  }

  async _inflate(head, force) {
    // still the previous run at this point, we are assigned once we return
    const prev = this.inflating
    if (prev !== null) await prev

    let result = null

    try {
      result = await this._run(head, force)
    } catch (err) {
      safetyCatch(err)
    } finally {
      await this._closeWarmupView()
    }

    if (this.inflatingFlushes !== head.op.views.flushes) return null
    this.inflating = null

    if (this.inflatingStale) {
      this.inflatingStale = false
      return null
    }

    if (result === null || this.isClosed) return null

    this.inflated = result

    this.writers.auto.bumpSoon()
    this.writers.rankFastForwards()

    return result
  }

  async _run(head, force) {
    const auto = this.writers.auto
    const sys = head.op.views.system
    const target = { key: sys.key, length: sys.start + sys.length }

    if (this.system === null) {
      // 'reboot' is a storage namespace, renaming it derives a different core on disk
      this.system = new System(auto, auto.store.namespace('reboot'), {
        getEncryptionProvider: auto.getSystemEncryption
      })
    }

    // every read of this run goes on the array as it is now, a cancel swaps it
    const system = this.system
    const activeRequests = this.activeRequests

    await system.boot(target, { activeRequests })
    if (this.inflatingFlushes !== head.op.views.flushes) return null

    // a legacy autobase system boots through the explicit boot path only
    if (system.version <= LEGACY_AUTOBASE_VERSION) return null

    // an unmapped system is only landed on when forced, the remap will carry us
    if (
      system.version < MAPPED_AUTOBEE_VERSION &&
      !force &&
      !auto._remapFailed &&
      !auto.system.isGenesis()
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
    const view = system.view.length ? this._openView(system.view.key) : null

    if (view !== null) {
      promises.push(view.get(system.view.length - 1, { activeRequests }))
    }

    for (const h of system.heads) {
      promises.push(system.get(h.key, { activeRequests }))
    }

    await Promise.all(promises)
    if (this.inflatingFlushes !== head.op.views.flushes) return null

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

  _openView(key) {
    if (this.view !== null && !b4a.equals(this.view.key, key)) {
      this.view.close().catch(safetyCatch)
      this.view = null
    }

    if (this.view === null) this.view = this.writers.auto.store.get({ key, active: true })

    return this.view
  }

  cancel() {
    Hypercore.destroyRequests(this.activeRequests)
    this.activeRequests = []
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

  // syncing a block may teach us a newer length, hence the loop
  // fetches the head in the background, never throws
  async refresh() {
    try {
      if (this.core === null) await this._openCore()

      if (this.core === null) return

      while (!this.isClosed) {
        const length = Math.max(this.hinted, this.core.length)
        if (length <= this.fetched) return
        this.fetched = length

        const block = await this.core.get(length - 1)
        if (this.isClosed) return

        this._onblock(length, block)
      }
    } catch (err) {
      safetyCatch(err)
    }
  }

  _onblock(length, block) {
    if (length > this.loaded) this.loaded = length
    this.signal.notify()

    if (length <= this.length) return

    const op = encoding.decodeOplog(block)
    if (op.views === null) return

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
      if (this.inflating !== null) {
        const inflating = this.inflating
        this.inflating = null
        this.cancel()
        await inflating
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
