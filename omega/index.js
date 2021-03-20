const { EventEmitter } = require('events')
const debounceify = require('debounceify')
const Autobase = require('autobase')

const { Manifest: ManifestEncoding, User: UserEncoding } = require('./lib/messages')

const INPUT_NAME = '@omega/input'
const OUTPUT_NAME = '@omega/output'

class User {
  constructor (data) {
    this._data = Buffer.isBuffer(data) ? UserEncoding.fullDecode(data) : data
    this._inflated = null
  }

  get input () {
    return this._inflated && this._inflated.input
  }

  get output () {
    return this._inflated && this._inflated.output
  }

  encode () {
    return UserEncoding.fullEncode(this.deflate())
  }

  deflate () {
    return {
      input: isCore(this._data.input) ? this._data.input.key : this._data.input,
      output: isCore(this._data.output) ? this._data.output.key : this._data.output
    }
  }

  inflate (store) {
    // TODO: If inflating can only happen once, `store` should probably be a constructor arg.
    if (this._inflated) return this._inflated
    this._inflated = {
      input: isCore(this._data.input) ? this._data.input : store.get({ key: this._data.input }),
      output: isCore(this._data.output) ? this._data.output : store.get({ key: this._data.output })
    }
    return this._inflated
  }
}

class Manifest {
  constructor (data) {
    this._data = Buffer.isBuffer(data) ? ManifestEncoding.fullDecode(data) : data
    this._inflated = null
    if (this._data.users) {
      this._data.users = this._data.users.map(u => (u instanceof User) ? u : new User(u))
    }
  }

  get inputs () {
    return this._inflated && this._inflated.users.map(u => u.input)
  }

  get outputs () {
    return this._inflated && this._inflated.users.map(u => u.output)
  }

  get users () {
    return this._inflated && this._inflated.users
  }

  encode () {
    return ManifestEncoding.fullEncode(this.deflate())
  }

  deflate () {
    return {
      users: this._data.users.map(u => u.deflate())
    }
  }

  inflate (store) {
    // TODO: If inflating can only happen once, `store` should probably be a constructor arg.
    if (this._inflated) return this._inflated
    this._inflated = {
      users: this._data.users.map(u => {
        if (!(u instanceof User)) u = new User(u)
        u.inflate(store)
        return u
      })
    }
    return this._inflated
  }
}

class DefaultInput {
  constructor (base, core) {
    this.base = base
    this.core = core
  }

  async append (block, links) {
    return this.base.append(this.core, block, links)
  }
}

module.exports = class Omega extends EventEmitter {
  constructor (corestore, manifest, user, opts = {}) {
    super()
    this.corestore = corestore
    this.manifest = (manifest instanceof Manifest) ? manifest : new Manifest(manifest)
    this.user = user ? (user instanceof User) ? user : new User(user) : null
    // Set when opened.
    this.base = null

    this._init = this._init || opts.init
    this._reduce = this._reduce || opts.reduce
    this._input = this._input || opts.input
    this._output = this._output || opts.output

    this.opened = false
    this.opening = this._open()
    this.opening.catch(noop)

    // TODO: How to handle append-triggered refreshes?
    this.refresh = debounceify(this._refresh.bind(this))
    if (this.eagerUpdate) {
      this.base.on('input-append', () => {
        this.refresh().catch(err => this.emit('refresh-error', err))
      })
    }
  }

  ready () {
    return this.opening
  }

  get input () {
    return this._input ? this._input(this.base, this.user?.input) : new DefaultInput(this.base, this.user?.input)
  }

  get output () {
    return this._output ? this._output(this.base, this.user?.output) : this.base.decodeIndex(this.user?.output, { includeInputNodes: false, unwrap: true })
  }

  async _open () {
    if (this.user) await this.user.inflate(this.corestore)
    await this.manifest.inflate(this.corestore)
    this.base = new Autobase(this.manifest.inputs)
  }

  async _remoteRefresh (opts) {
    const result = await this.base.remoteRebase(this.manifest.outputs, opts)
    const stats = { ...result, output: undefined }
    return {
      stats,
      output: this.base.decodeIndex(result.index, opts)
    }
  }

  async _localRefresh (opts) {
    const stats = await this.base.localRebase(this.user.output, opts)
    return {
      stats,
      output: this.base.decodeIndex(this.user.output, opts)
    }
  }

  async _refresh (opts = {}) {
    opts = {
      ...opts,
      includeInputNodes: true,
      unwrap: false,
      reduce: this._reduce && this._reduce.bind(this),
      init: this._init && this._init.bind(this)
    }
    if (!this.user) return this._remoteRefresh(opts)
    return this._localRefresh(opts)
  }

  replicate (isInitiator, opts = {}) {
    return this.corestore.replicate(isInitiator, opts)
  }

  static async createUser (store) {
    const user = new User({
      input: store.get({ name: INPUT_NAME }),
      output: store.get({ name: OUTPUT_NAME })
    })
    await user.inflate(store)
    await Promise.allSettled([user.input.ready(), user.output.ready()])
    return user
  }
}

function isCore (c) {
  return c && c.get && c.append && c.replicate
}

function noop () { }
