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

  // absolute end (signed core length) of a stored { start, length } view batch
  static end(batch) {
    return batch.start + batch.length
  }
}

// ranges are tracked on the local core (what we write + replicate), not the
// linearized head. length is the batch length; the end is start + length
function next(bee, start) {
  const local = bee.context.local
  return { key: local.key, start, length: local.length - start }
}
