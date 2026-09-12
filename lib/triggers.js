// writers waiting on a node of another writer, keyed by that writer's id.
// a writer waits on at most one entry at a time, tracked as writer.waiting
module.exports = class Triggers {
  constructor() {
    this.waiting = new Map()
  }

  add(id, length, writer) {
    // a writer only ever waits on one link: drop whatever it waited on before
    if (writer.waiting !== null && writer.waiting.id !== id) this.remove(writer.waiting)

    let w = this.waiting.get(id)

    if (!w) {
      w = []
      this.waiting.set(id, w)
    }

    for (let i = 0; i < w.length; i++) {
      const entry = w[i]
      if (entry.writer !== writer) continue
      entry.length = length
      return entry
    }

    const entry = { index: w.length, id, writer, length }
    w.push(entry)
    return entry
  }

  remove(entry) {
    // writer is nulled on removal, so a removed entry is a noop here
    if (!entry.writer) return

    const w = this.waiting.get(entry.id)
    if (w) this._remove(w, entry)
  }

  has(id) {
    return this.waiting.get(id) !== undefined
  }

  get(id) {
    return this.waiting.get(id) || null
  }

  trigger(id, length) {
    const w = this.waiting.get(id)
    if (!w) return

    // collect first: the walk swap-removes, so nothing may touch the array mid-loop
    const bump = []

    for (let i = w.length - 1; i >= 0; i--) {
      const entry = w[i]
      if (entry.length > length) continue

      bump.push(entry.writer)
      this._remove(w, entry)
    }

    for (const writer of bump) writer.bump()
  }

  _remove(w, entry) {
    const head = w.pop()

    if (head !== entry) {
      w[entry.index] = head
      head.index = entry.index
    }

    entry.writer = null

    if (w.length === 0) {
      this.waiting.delete(entry.id)
    }
  }
}
