module.exports = class WriteBatch {
  constructor(view, system) {
    this._view = view
    this._system = system

    this._viewStart = view.context.local.length
    this._systemStart = system.context.local.length

    this.view = null
    this.system = null
  }

  finalize() {
    this.view = next(this._view, this._viewStart)
    this.system = next(this._system, this._systemStart)
  }

  static end(batch) {
    return batch.start + batch.length
  }
}

function next(bee, start) {
  const local = bee.context.local
  const end = local.length
  return { key: local.key, start, length: end - start }
}
