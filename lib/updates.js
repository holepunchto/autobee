module.exports = class UpdateChanges {
  constructor(auto) {
    this.auto = auto
    this.byName = new Map()
  }

  get(key) {
    return this.byName.get(key)
  }

  track() {
    this.tracking = {
      view: this.auto._workingBee,
      _system: this.auto.system.bee
    }

    for (const k in this.tracking) {
      this.byName.set(k, { from: this.tracking[k].head().length, to: 0 })
    }
  }

  finalise() {
    for (const k in this.tracking) {
      const from = this.byName.get(k).from
      const to = this.tracking[k].head().length
      this.byName.set(k, { to, from })
    }
  }
}
