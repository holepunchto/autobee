const SignalPromise = require('signal-promise')

module.exports = class AppendBatch {
  constructor(bee) {
    this.bee = bee
    this.blocks = []
    this.closed = false
    this.flushing = false
    this._flushed = null
  }

  async _acquire() {
    while (this.bee.activeBatch !== null && this.bee.activeBatch !== this) {
      await this.bee.activeBatch.flushed()
    }
    this.bee.activeBatch = this
  }

  async append(value) {
    if (this.bee.opened === false) await this.bee.ready()
    if (this.bee._advancing !== null) await this.bee.updating()

    if (this.closed) throw new Error('Batch is closed')
    if (this.bee.activeBatch !== this) await this._acquire()
    if (this.closed) throw new Error('Batch is closed')

    this.blocks.push(value)
    return this.bee.local.length + this.blocks.length
  }

  async flush() {
    if (this.closed) throw new Error('Batch is closed')
    if (this.flushing) return this.flushed()
    this.flushing = true
    if (this.blocks.length) await this.bee.append(this.blocks)
    return this.close()
  }

  flushed() {
    if (this.closed) return Promise.resolve()
    if (this._flushed) return this._flushed.wait()
    this._flushed = new SignalPromise()
    return this._flushed.wait()
  }

  close() {
    if (this.bee.activeBatch !== this) return
    this.bee.activeBatch = null
    this.closed = true
    if (this._flushed) this._flushed.notify(null)
  }
}
