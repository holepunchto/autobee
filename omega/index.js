const { EventEmitter } = require('events')

const debounceify = require('debounceify')
const Autobase = require('autobase')

module.exports = class Omega extends EventEmitter {
  constructor (manifest, key, opts = {}) {
    super()

    if (typeof key === 'object' && !Buffer.isBuffer(key)) {
      opts = key
      key = null
    }

    this.key = key
    this.opts = opts
    this.localInput = manifest.localInput
    this.localOutput = manifest.localOutput
    this.inputs = manifest.inputs
    this.outputs = manifest.outputs
    this.description = manifest.description
    this.opts = opts

    this.base = new Autobase(this.inputs)

    // TODO: How to handle append-triggered refreshes?
    this.refresh = debounceify(this._refresh.bind(this))
    this.base.on('input-append', () => {
      this.refresh().catch(err => this.emit('rebase-error', err))
    })
  }

  get input () {
    return this._input ? this._input(this.localInput, this.opts) : this.localInput
  }

  get output () {
    return this._output ? this._output(this.localOutput, this.opts) : this.localOutput
  }

  async _remoteRefresh (opts) {
    const result = await this.base.remoteRebase(this.outputs, opts)
    const stats = { ...result, output: undefined }
    return {
      stats,
      output: this.base.decodeIndex(result.index, opts)
    }
  }

  async _localRefresh (opts) {
    const stats = await this.base.localRebase(this.localOutput, opts)
    return {
      stats,
      output: this.base.decodeIndex(this.localOutput, opts)
    }
  }

  async _refresh (opts = {}) {
    opts = {
      ...opts,
      includeInputNodes: true,
      unwrap: false,
      reduce: this._reduce.bind(this),
      init: this._init.bind(this)
    }
    if (this.outputs.length > 1) return this._remoteRefresh(opts)
    return this._localRefresh(opts)
  }
}
