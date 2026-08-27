// autobee's internal drain loop (and test/helpers' sync(), which polls in
// an unawaited background loop once withTimeout's Promise.race abandons it)
// can throw/reject asynchronously outside any awaited chain in the trial
// loop - without this, that surfaces as an opaque top-level crash instead
// of an attributable, dumpable trial failure. Registered once, process-wide;
// trial.js polls consume() once after every step in the action loop.

let pending = null
let armed = false

// Until the first consume() (trial.js calls it right after setup), any
// captured error is a load/setup-time failure that belongs to nobody - eg a
// require() throwing inside trial.js's own module chain, which reaches the
// uncaughtException handler because this file is required first. Stashing
// those silently makes the whole fuzzer exit 0 with zero output; crash loud
// instead.
function capture(err) {
  if (!armed) {
    console.error('fuzz harness failed before the trial loop started:', err)
    process.exit(1)
  }
  pending = err
}

process.on('uncaughtException', capture)
process.on('unhandledRejection', capture)

exports.consume = function consume() {
  armed = true
  if (!pending) return null
  const err = pending
  pending = null
  return err
}
