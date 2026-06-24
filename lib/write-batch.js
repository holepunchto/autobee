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

// length is the batch length (blocks written); the end is start + length
function next(bee, start) {
  const h = bee.head()
  return { key: h.key, start, length: h.length - start }
}
