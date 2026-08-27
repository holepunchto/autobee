// Failure dump: a complete, self-contained snapshot of a failing trial,
// written automatically the moment any oracle (or a thrown error) fails.
// The dump alone is enough to re-run the reference-order checks with zero
// I/O and zero timing - see replay-dump.js.

const fs = require('fs')
const path = require('path')

const FAILURES_DIR = path.join(__dirname, 'failures')

exports.dumpFailure = dumpFailure

function dumpFailure({ trial, config, seed, storageDir, actionLog, failures, replays, error }) {
  fs.mkdirSync(FAILURES_DIR, { recursive: true })

  const label = `${new Date().toISOString().replace(/[:.]/g, '-')}-seed${seed}`
  const file = path.join(FAILURES_DIR, `${label}.json`)

  const payload = {
    label,
    trial,
    seed,
    config,
    storageDir, // ON DISK, NOT DELETED - inspect the raw corestore state here
    error: error ? { message: error.message, stack: error.stack } : null,
    failures: failures || [],
    actionLog: actionLog || [],
    peers: (replays || []).map((r) => ({
      name: r.name,
      records: r.records,
      nodes: r.nodes, // reference/order.js node shape - feed straight to order()/explain()
      error: r.error || null // set when THIS peer's replay could not be collected (crash path)
    }))
  }

  fs.writeFileSync(file, JSON.stringify(payload, null, 2))
  return file
}
