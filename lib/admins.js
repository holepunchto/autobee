const b4a = require('b4a')

module.exports = class AdminSet {
  constructor(store) {
    this.store = store
    this.cores = new Map()
  }

  async add(key) {
    const id = b4a.toString(key, 'hex')
    if (this.cores.has(id)) return

    const core = this.store.get({ key, active: false })
    await core.ready()

    core.on('append', this._onappend.bind(this, core))
    this.cores.set(id, core)
  }

  async delete(key) {
    const id = b4a.toString(key, 'hex')
    const core = this.cores.get(id)
    if (!core) return

    this.cores.delete(id)
    await core.close()
  }

  _onappend(core) {}

  async close() {
    const closing = []
    for (const core of this.cores.values()) closing.push(core.close())
    this.cores.clear()
    await Promise.all(closing)
  }
}
