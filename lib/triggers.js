module.exports = class Triggers {
  constructor() {
    this.waiting = new Map()
  }

  add(id, length, writer) {
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

    for (let i = w.length - 1; i >= 0; i--) {
      const entry = w[i]
      if (entry.length > length) continue

      const writer = entry.writer
      this._remove(w, entry)
      writer.bump()
    }
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
