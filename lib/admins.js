const b4a = require('b4a')
const safetyCatch = require('safety-catch')

module.exports = class AdminSet {
  constructor(auto) {
    this.auto = auto
    this.cores = new Map()
  }

  async add(key) {
    const id = b4a.toString(key, 'hex')
    if (this.cores.has(id)) return

    const core = this.auto.store.get({ key, active: false })
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

  _onappend(core) {
    this.auto._rebootFromHead({ key: core.key, length: core.length }, null).catch(safetyCatch)
  }

  async close() {
    const closing = []
    for (const core of this.cores.values()) closing.push(core.close())
    this.cores.clear()
    await Promise.all(closing)
  }
}
