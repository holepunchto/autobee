module.exports = class UpdateChanges {
  constructor(auto) {
    this.auto = auto
    this.byName = new Map()
    this.flushes = 0
    this.undone = false
  }

  get(key) {
    return this.byName.get(key)
  }

  track() {
    this.tracking = {
      view: this.auto._workingBee,
      system: this.auto.system.bee
    }

    this.flushes = this.auto.system.flushes
    this.undone = false

    for (const k in this.tracking) {
      this.byName.set(k, {
        flushes: this.auto.system.flushes,
        from: this.tracking[k].head(),
        to: null,
        incremental: false
      })
    }
  }

  undo(flushes) {
    if (flushes < this.flushes) this.undone = true
  }

  finalise(fastForward) {
    // flush count at `to` - safe to read live, state is frozen for the hook
    const flushes = this.auto.system.flushes

    for (const k in this.tracking) {
      const tracked = this.byName.get(k)

      tracked.to = this.tracking[k].head()
      tracked.flushes = flushes
      tracked.incremental = !fastForward && !this.undone
    }

    return this.byName
  }
}
