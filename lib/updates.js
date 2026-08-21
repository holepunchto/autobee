const b4a = require('b4a')

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
        incremental: false
      })
    }
  }

  finalise() {
    // flush count at `to` - safe to read live, state is frozen for the hook
    const flushes = this.auto.system.flushes

    for (const k in this.tracking) {
      const tracked = this.byName.get(k)
      const startFlushes = tracked.flushes

      tracked.to = this.tracking[k].head()
      tracked.flushes = flushes
    }

    return this.byName
  }

  static from(prev, current) {
    if (
      prev.flushes === current.flushes &&
      prev.system.length === current.system.length &&
      (prev.system.key === current.system.key ||
        (prev.system.key &&
          current.system.key &&
          b4a.equals(prev.system.key, current.system.key)))
    ) {
      return null
    }

    const byName = new Map()
    const flushes = current.flushes

    byName.set('view', { from: prev.view, to: current.view, flushes })
    byName.set('system', {
      from: prev.system,
      to: current.system,
      flushes,
      incremental: false
    })

    return byName
  }
}
