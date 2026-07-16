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
      system: this.auto.system.bee
    }

    for (const k in this.tracking) {
      this.byName.set(k, {
        flushes: this.auto.system.flushes,
        from: this.tracking[k].head(),
        to: null,
        shared: null
      })
    }
  }

  finalise() {
    const floor = this.auto.system.shared

    // flush count at `to` - safe to read live, state is frozen for the hook
    const flushes = this.auto.system.flushes

    for (const k in this.tracking) {
      const tracked = this.byName.get(k)
      const startFlushes = tracked.flushes

      tracked.to = this.tracking[k].head()
      tracked.flushes = flushes

      if (floor && floor.flushes < startFlushes) {
        tracked.shared = k === 'view' ? floor.view : floor.system
      } else {
        tracked.shared = tracked.from
      }
    }

    return this.byName
  }

  static from(shared, current) {
    const byName = new Map()
    const flushes = current.flushes

    byName.set('view', { from: shared.view, shared: shared.view, to: current.view, flushes })
    byName.set('system', {
      from: shared.system,
      shared: shared.system,
      to: current.system,
      flushes
    })

    return byName
  }
}
