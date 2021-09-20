const Hyperbee = require('hyperbee')
const cenc = require('compact-encoding')

const { AutobeeMessage, AutobeeMessageTypes } = require('./messages')

module.exports = class Autobee {
  constructor (autobase, opts = {}) {
    this.autobase = autobase

    const index = this.autobase.createRebasedIndex({
      ...opts,
      unwrap: true,
      apply: this._apply.bind(this)
    })
    this._writer = new Hyperbee(index, {
      ...opts,
      keyEncoding: 'utf-8',
      prefix: null,
      extension: false
    })
    this._reader = this.bee

    this.prefix = opts.prefix || ''
    if (this.prefix) {
      this._reader = this._writer.sub(this.prefix)
    }

    this._opening = this._open()
    this._opening.catch(noop)
    this.ready = () => this._opening
  }

  _open () {
    return this.autobase.ready()
  }

  async _apply (batch, index) {
    const b = this._writer.batch({ update: false })
    for (const node of batch) {
      const op = AutobeeMessage.decode({ start: 0, end: node.value.length, buffer: node.value })
      // TODO: Handle deletions
      switch (op.type) {
        case AutobeeMessageTypes.Put:
          await b.put(op.key, op.value)
          break
        case AutobeeMessageTypes.Del:
          await b.del(op.key)
          break
        default:
          // Ignore unsupported op types
      }
    }
    return b.flush()
  }

  put (key, value) {
    const op = cenc.encode(AutobeeMessage, {
      type: AutobeeMessageTypes.Put,
      key: this.prefix ? this.prefix + this._writer.sep + key : key,
      value
    })
    return this.autobase.append(op)
  }

  del (key) {
    const op = cenc.encode(AutobeeMessage, {
      type: AutobeeMessageTypes.Del,
      key: this.prefix ? this.prefix + this._writer.sep + key : key
    })
    return this.autobase.append(op)
  }

  async get (key) {
    return this._reader.get(key)
  }

  sub (prefix) {
    return new Autobee(this.autobase, {
      prefix: this.prefix + this._writer.sep + prefix
    })
  }

  createReadStream (...args) {
    return this._reader.createReadStream(...args)
  }
}

function noop () {}
