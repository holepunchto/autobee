const ProtomuxWakeup = require('protomux-wakeup')
const CoreCoupler = require('core-coupler')
const ReadyResource = require('ready-resource')
const b4a = require('b4a')

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
    const wakeup = this.wakeup._getWakeupWriters()
    if (wakeup.length === 0) return
    session.announce(peer, wakeup)
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

    this._needsWakeupRequest = false
    this._needsWakeup = true
    this._needsWakeupHeads = true
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
  }

  _wakeupPeer(stream, cores) {
    if (!this._session) return
    // Don't drop a freshly-coupled local writer that isn't pending at this
    // instant; the peer never learns it otherwise.
    const wakeup = cores && cores.length ? cores : this._getWakeupWriters()
    if (wakeup.length === 0) return
    this._session.announceByStream(stream, wakeup)
  }

  _getWakeupWriters() {
    return [...this._auto.writers.cores()]
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
