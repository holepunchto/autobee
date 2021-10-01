const Hyperbee = require('hyperbee')
const cenc = require('compact-encoding')
const codecs = require('codecs')
const pump = require('pump')
const { Transform } = require('streamx')

const { AutobeeMessage, AutobeeMessageTypes } = require('./lib/messages')

module.exports = class Autobee {
  constructor (autobase, opts = {}) {
    this.autobase = autobase

    const index = opts.index || this.autobase.createRebasedIndex({
      ...opts,
      unwrap: true,
      apply: this._apply.bind(this)
    })
    this._writer = opts._writer || new Hyperbee(index, {
      ...opts,
      keyEncoding: 'binary',
      valueEncoding: 'binary',
      prefix: null,
      extension: false
    })
    this._reader = this._writer
    this._keyEncoding = codecs(opts.keyEncoding || 'binary')
    this._valueEncoding = codecs(opts.valueEncoding || 'binary')

    this.prefix = opts.prefix
    this._prefixBuf = null
    if (this.prefix) {
      this._reader = this._writer.sub(this.prefix)
      this._prefixBuf = Buffer.concat([this._keyEncoding.encode(this.prefix), this._writer.sep])
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

  _encodeKey (key) {
    if (!this.prefix) return this._keyEncoding.encode(key)
    return Buffer.concat([this._prefixBuf, this._keyEncoding.encode(key)])
  }

  _decodeKey (buf) {
    if (!this.prefix) return this._keyEncoding.decode(buf)
    console.log('DECODING BUF:', buf, 'prefix buf:', this._prefixBuf)
    return this._keyEncoding.decode(buf.slice(this._prefixBuf.length))
  }

  async put (key, value) {
    await this.ready()
    const op = cenc.encode(AutobeeMessage, {
      type: AutobeeMessageTypes.Put,
      key: this._encodeKey(key),
      value: this._valueEncoding.encode(value)
    })
    return this.autobase.append(op)
  }

  async del (key) {
    await this.ready()
    const op = cenc.encode(AutobeeMessage, {
      type: AutobeeMessageTypes.Del,
      key: this._encodeKey(key)
    })
    return this.autobase.append(op)
  }

  async get (key) {
    await this.ready()
    return this._reader.get(key)
  }

  sub (prefix) {
    return new Autobee(this.autobase, {
      _writer: this._writer,
      index: this.index,
      keyEncoding: this._keyEncoding,
      valueEncoding: this._valueEncoding,
      prefix: this._encodeKey(prefix)
    })
  }

  createReadStream (opts = {}) {
    if (opts.gt) opts.gt = this._encodeKey(opts.gt)
    if (opts.gte) opts.gte = this._encodeKey(opts.gte)
    if (opts.lt) opts.lt = this._encodeKey(opts.lt)
    if (opts.lte) opts.lte = this._encodeKey(opts.lte)
    return pump(this._reader.createReadStream(opts), new Transform({
      transform: (node, cb) => {
        node.key = this._keyEncoding.decode(node.key)
        node.value = this._valueEncoding.decode(node.value)
        return cb(null, node)
      }
    }))
  }

  createHistoryStream (opts = {}) {
    return pump(this._reader.createHistoryStream(opts), new Transform({
      transform: (node, cb) => {
        node.key = this._decodeKey(node.key)
        node.value = this._valueEncoding.decode(node.value)
        return cb(null, node)
      }
    }))
  }
}

function noop () {}
