const AutobeeWakeup = require('autobee-wakeup')

// Every local and wire producer calls the wakeup instance's hint(), so this is
// the earliest supported observation point. Capture the announcement before the
// base class can coalesce it with a later unknown length, then delegate once.
module.exports = class LocalWakeup extends AutobeeWakeup {
  hint(hints) {
    if (this._auto.writers) this._auto.writers.captureReclaimedAnnouncements(hints)
    return super.hint(hints)
  }
}
