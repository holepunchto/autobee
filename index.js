const { EventEmitter } = require('events')

const codecs = require('codecs')
const debounceify = require('debounceify')
const Hyperbee = require('hyperbee')

const Autobase = require('autobase')

const { Op } = require('./lib/messages')

class ManifestBase extends EventEmitter {
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

class Input {
  constructor (base, core, opts = {}) {
    this.base = base
    this.core = core
    this.keyEncoding = codecs(opts.keyEncoding || 'binary')
    this.valueEncoding = codecs(opts.valueEncoding || 'binary')
    this._batch = opts.batch
  }

  async _push (op) {
    const record = {
      type: op.type,
      key: this.keyEncoding.encode(op.key),
      value: this.valueEncoding.encode(op.value)
    }
    if (this._batch) return this._batch.push(record)
    return this.base.append(this.core, Op.encode(record), await this.base.latest())
  }

  put (key, value, opts = {}) {
    return this._push({
      type: Op.Type.Put,
      key,
      value
    })
  }

  del (key, opts = {}) {
    return this._push({
      type: Op.Type.Del,
      key
    })
  }

  async flush () {
    if (!this._batch) return
    const tmp = this._batch
    this._batch = null
    for (const record of tmp) {
      record.batch = tmp.length
    }
    const encoded = tmp.map(r => Op.encode(r))
    return this.base.append(this.core, encoded, await this.base.latest())
  }

  batch (opts = {}) {
    return new Input(this.base, this.core, {
      keyEncoding: this.keyEncoding,
      valueEncoding: this.valueEncoding,
      batch: []
    })
  }
}

module.exports = class Autobee extends ManifestBase {
  constructor (manifest, key, opts = {}) {
    super(manifest, key, opts)
    this._batch = null
    this._db = null
  }

  _init (core) {
    this._db = new Hyperbee(this.base.decodeIndex(core, {
      includeInputNodes: false,
      unwrap: true
    }), {
      ...this.opts,
      extension: false
    })
  }

  async _reduce ({ node }) {
    const op = Op.decode(node.value)

    const apply = async (b, op) => {
      switch (op.type) {
        case Op.Type.Put:
          await b.put(op.key, op.value)
          break
        case Op.Type.Del:
          await b.del(op.key, op.value)
          break
        default:
          // Unsupported message types should be gracefully skipped.
          break
      }
    }

    if (op.batch) {
      if (!this._batch) this._batch = []
      this._batch.push(op)
      if (this._batch.length < op.batch) return []
    }

    const b = this._db.batch()
    if (this._batch) {
      for (const op of this._batch) {
        await apply(b, op)
      }
      this._batch = null
    } else {
      await apply(b, op)
    }
    await b.flush()

    return this._db.feed.commit()
  }

  _input () {
    return new Input(this.base, this.localInput)
  }

  _output () {
    return this._db
  }
}
