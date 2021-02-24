const { EventEmitter } = require('events')

const crypto = require('hypercore-crypto')
const sodium = require('sodium-universal')
const debounceify = require('debounceify')
const Autobase = require('autobase')

const INPUT_NAME = '@omega/input'
const OUTPUT_NAME = '@omega/output'

class OmegaState extends EventEmitter {
  constructor (manifest, opts = {}) {
    super()
    this.opts = opts

    this.localInput = manifest.localInput
    this.localOutput = manifest.localOutput
    this.inputs = manifest.inputs
    this.outputs = manifest.outputs
    this.description = manifest.description
    this.base = new Autobase(this.inputs)

    this._init = this._init || opts.init
    this._reduce = this._reduce || opts.reduce
    this._input = this._input || opts.input
    this._output = this._output || opts.output

    // TODO: How to handle append-triggered refreshes?
    this.refresh = debounceify(this._refresh.bind(this))
    if (this.eagerUpdate) {
      this.base.on('input-append', () => {
        this.refresh().catch(err => this.emit('refresh-error', err))
      })
    }
  }

  get input () {
    return this._input ? this._input() : this.localInput
  }

  get output () {
    return this._output ? this._output() : this.localOutput
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
    if (!this.localOutput) return this._remoteRefresh(opts)
    return this._localRefresh(opts)
  }
}

module.exports = class Omega extends EventEmitter {
  constructor (store, manifest, key, opts = {}) {
    super()

    if (key instanceof Object && !Buffer.isBuffer(key)) {
      opts = key
      key = null
    }

    this.key = key
    this.discoveryKey = key ? crypto.discoveryKey(key) : null

    this.store = store
    this.manifest = manifest
    this.opts = opts
    this.state = null

    this.inflated = null
    this.opening = this.ready()
    this.opening.catch(noop)
  }

  get input () {
    return this.state && this.state.input
  }

  get output () {
    return this.state && this.state.output
  }

  _deflate () {
    if (!this.state) throw new Error('Omega is not yet initialized with a manifest')
    const sortedInputs = [...this.manifest.inputs].sort((i1, i2) => Buffer.compare(i1.key, i2.key))
    const sortedOutputs = [...this.manifest.outputs].sort((o1, o2) => Buffer.compare(o1.key, o2.key))
    return JSON.stringify({
      description: this.opts.description,
      inputs: sortedInputs.map(i => i.key.toString('hex')),
      outputs: sortedOutputs.map(o => o.key.toString('hex'))
    })
  }

  async _generateKeys () {
    if (this.key) {
      this.discoveryKey = crypto.discoveryKey(this.key)
    } else {
      await this.inflate(this.manifest)
      this.key = hash(this._deflate())
      this.discoveryKey = crypto.discoveryKey(this.key)
    }
  }

  async ready () {
    if (!this.key && !this.manifest) throw new Error('Either a key or a manifest must be provided')
    await this._generateKeys()
  }

  async inflate (manifest, opts = {}) {
    if (this.state) return
    this.manifest = manifest

    const inputs = []
    const outputs = []
    let localInput = null
    let localOutput = null

    const load = async (key) => {
      if (isCore(key)) {
        await key.ready()
        return key
      }
      key = Buffer.isBuffer(key) ? key : Buffer.from(key, 'hex')
      const core = this.store.get({ key })
      await core.ready()
      return core
    }

    for (const input of manifest.inputs) {
      const core = await load(input)
      if (core.writable) localInput = core
      inputs.push(core)
    }
    for (const output of manifest.outputs) {
      const core = await load(output)
      if (core.writable) localOutput = core
      outputs.push(core)
    }

    this.state = new OmegaState({
      inputs,
      outputs,
      localInput,
      localOutput
    }, {
      input: this._input,
      output: this._output,
      reduce: this._reduce,
      init: this._init,
      ...this.opts
    })
    this.state.on('refresh-error', e => this.emit('refresh-error', e))
  }

  replicate (isInitiator, opts = {}) {
    return this.store.replicate(isInitiator, opts)
  }

  async refresh () {
    if (!this.state) throw new Error('Omega is not yet initialized with a manifest')
    return this.state.refresh()
  }

  static async createLocal (store) {
    const input = store.get({ name: INPUT_NAME })
    const output = store.get({ name: OUTPUT_NAME })
    await Promise.allSettled([input.ready(), output.ready()])
    return {
      input,
      output
    }
  }
}

function hash (input) {
  input = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf-8')
  const output = Buffer.alloc(sodium.crypto_generichash_BYTES)
  sodium.crypto_generichash(output, input)
  return output
}

function isCore (c) {
  return c.get && c.append && c.replicate
}

function noop () { }
