const ProtomuxWakeup = require('protomux-wakeup')
const CoreCoupler = require('core-coupler')
const ReadyResource = require('ready-resource')
const b4a = require('b4a')
const safetyCatch = require('safety-catch')

// a peer takes one announce message at a time, keep each one modest
const WAKEUP_BATCH = 128

class WakeupHandler {
  constructor(wakeup, discoveryKey) {
    this.wakeup = wakeup

    this.active = true
    this.discoveryKey = discoveryKey
  }

  onpeeractive(peer, session) {
    this.wakeup._bumpWakeupPeer(peer)
  }

  onlookup(req, peer, session) {
    const wakeup = this.wakeup
    const guard = wakeup._auto._bootOnlineGuard

    // boot may still be restoring the sessionless heads: answer once it has,
    // or an inactive peer is left with the partial view
    if (!guard.opened) {
      guard
        .ready()
        .then(() => wakeup._answerLookup(session, peer))
        .catch(safetyCatch)
      return
    }

    wakeup._answerLookup(session, peer)
  }

  onannounce(wakeup, peer, session) {
    this.wakeup.hint(wakeup)
  }
}

module.exports = class Wakeup extends ReadyResource {
  constructor(auto, opts = {}) {
    super()

    this._auto = auto
    this._owner = !opts.wakeup

    this._protocol = opts.wakeup || new ProtomuxWakeup()
    this._session = null
    this._coupler = null
    this._hints = new Map()

    this._wakeupPeerBound = this._wakeupPeer.bind(this)
  }

  _close() {
    if (this._session) this._session.destroy()
    if (this._owner) this._protocol.destroy()
  }

  get hints() {
    return this._hints
  }

  hint(hints) {
    if (!Array.isArray(hints)) hints = [hints]
    for (const { key, length } of hints) {
      const hex = b4a.toString(key, 'hex')
      const prev = this._hints.get(hex)
      if (!prev || length === -1 || prev < length) this._hints.set(hex, length)
    }
    this._auto.bumpSoon()
  }

  flush() {
    const hints = new Map(this._hints)
    this._hints.clear()
    return hints
  }

  addStream(stream) {
    this._protocol.addStream(stream)
  }

  setCapability(cap, discoveryKey) {
    if (this._session) this._session.destroy()
    this._session = this._protocol.session(cap, new WakeupHandler(this, discoveryKey || null))

    // incase this session has active peers already, bump the coupler
    for (const peer of this._session.peers) {
      if (peer.active) this._bumpWakeupPeer(peer)
    }
  }

  _bumpWakeupPeer(peer) {
    if (this._coupler) this._coupler.update(peer.stream)
    if (!this._session) return

    // the coupler only speaks for live cores, and a reclaimed head has none:
    // a new or reactivated peer hears its coordinates here
    const reclaimed = [...this._auto.writers.reclaimedHeads()]
    if (reclaimed.length === 0) return

    this._announceByStream(this._session, peer.stream, reclaimed)
  }

  _wakeupPeer(stream, cores) {
    if (!this._session) return
    // Don't drop a freshly-coupled local writer that isn't pending at this
    // instant; the peer never learns it otherwise.
    const wakeup = cores && cores.length ? cores : this._getWakeupWriters()
    if (wakeup.length === 0) return
    this._announceByStream(this._session, stream, wakeup)
  }

  _announce(session, peer, heads) {
    this._announceAll(heads, (batch) => session.announce(peer, batch))
  }

  _announceByStream(session, stream, heads) {
    this._announceAll(heads, (batch) => session.announceByStream(stream, batch))
  }

  _announceAll(heads, send) {
    for (let i = 0; i < heads.length; i += WAKEUP_BATCH) {
      send(heads.slice(i, i + WAKEUP_BATCH))
    }
  }

  _answerLookup(session, peer) {
    if (!this._canAnnounce(session, peer)) return

    const heads = this._getWakeupWriters()
    if (heads.length === 0) return
    this._announce(session, peer, heads)
  }

  // boot restores sessionless heads after a peer may already be active: its
  // peer-active bump saw an empty set, so push the restored coordinates once
  announceReclaimed() {
    const session = this._liveSession()
    if (session === null) return

    const heads = [...this._auto.writers.reclaimedHeads()]
    if (heads.length === 0) return

    for (const peer of session.peers) {
      if (!peer.active || !this._canAnnounce(session, peer)) continue
      this._announce(session, peer, heads)
    }
  }

  // a deferred answer or a boot push can run long after its session or peer
  // went away, and a shared protocol keeps the destroyed session object
  _liveSession() {
    if (this.closed || this.closing !== null) return null
    if (this._session === null || this._session.destroyed) return null
    return this._session
  }

  _canAnnounce(session, peer) {
    if (session !== this._liveSession()) return false
    if (!peer || peer.removed) return false

    const channel = peer.channel
    return !!channel && !channel.closed && !channel.destroyed
  }

  _getWakeupWriters() {
    // a reclaimed head has no core to couple, so only the coordinates are left.
    // add() takes those over when a session opens, so the lists cannot overlap
    return [...this._auto.writers.heads(), ...this._auto.writers.reclaimedHeads()]
  }

  recouple() {
    if (this._coupler) this._coupler.destroy()
    const core = this._auto.bootstrap
    this._coupler = new CoreCoupler(core, this._wakeupPeerBound)
  }

  addCore(core) {
    if (!this._coupler) return false
    this._coupler.add(core)
    return true
  }

  removeCore(core) {
    if (!this._coupler) return false
    this._coupler.remove(core)
    return true
  }
}
