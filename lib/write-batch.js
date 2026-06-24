module.exports = class WriteBatch {
  constructor(view, system) {
    this._view = view
    this._system = system

    this._viewStart = view.head().length
    this._systemStart = system.head().length

    this.view = null
    this.system = null
  }

  finalize() {
    this.view = next(this._view, this._viewStart)
    this.system = next(this._system, this._systemStart)
  }
}

function next(bee, start) {
  const h = bee.head()
  return { key: h.key, start, end: h.length }
}
