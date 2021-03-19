const codecs = require('codecs')
const Hyperbee = require('hyperbee')

const { Op } = require('./lib/messages')

const Omega = require('./omega')

class AutobeeInput {
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
    return new AutobeeInput(this.base, this.core, {
      keyEncoding: this.keyEncoding,
      valueEncoding: this.valueEncoding,
      batch: []
    })
  }
}

module.exports = class Autobee extends Omega {
  constructor (store, manifest, key, opts = {}) {
    super(store, manifest, key, opts)
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

  _input (base, core) {
    return new AutobeeInput(base, core)
  }

  _output () {
    return this._db
  }
}
