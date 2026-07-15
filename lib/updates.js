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
      this.byName.set(k, { from: this.tracking[k].head(), to: null, shared: null })
    }
  }

  finalise() {
    const floor = this.auto.system.shared

    // flush count at `to` - safe to read live, state is frozen for the hook
    const flushes = this.auto.system.flushes

    for (const k in this.tracking) {
      const from = this.byName.get(k).from
      const to = this.tracking[k].head()

      // deepest state a reorg rewound to this drain
      const shared = floor ? (k === 'view' ? floor.view : floor.system) : from

      this.byName.set(k, { to, from, shared, flushes })
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
