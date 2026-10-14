const rrp = require('resolve-reject-promise')

module.exports = class TaskQueue {
  constructor() {
    this.destroyed = false
    this._tail = Promise.resolve()
    this._waiting = new Set()
  }

  queue(fn) {
    if (this.destroyed) return Promise.resolve()

    const pending = rrp()
    this._waiting.add(pending)

    const task = this._tail.then(() => (this._waiting.delete(pending) ? fn() : undefined))

    this._tail = task.catch(noop)
    task.then(pending.resolve, pending.reject)

    return pending.promise
  }

  flush() {
    return this._tail
  }

  // tasks that have not started are settled without running, the one in
  // flight is left to finish
  destroy() {
    if (this.destroyed) return
    this.destroyed = true

    for (const pending of this._waiting) pending.resolve()
    this._waiting.clear()
  }
}

function noop() {}
