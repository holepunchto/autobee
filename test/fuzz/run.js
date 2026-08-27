#!/usr/bin/env node
// Runs fuzz trials back to back, forever (or until FUZZ_TRIALS is hit), and
// stops the instant one fails - a failing trial's storage is retained and
// its full state dumped to test/fuzz/failures/, then the process exits
// non-zero. See README.md for the failure workflow and env vars.
//
//   node test/fuzz/run.js
//   FUZZ_SEED=12345 FUZZ_TRIALS=1 FUZZ_VERBOSE=1 node test/fuzz/run.js

const { runTrial } = require('./trial.js')
const { makeRunRoot } = require('./util.js')

const config = {
  transport: process.env.FUZZ_TRANSPORT === 'real' ? 'real' : 'sim',
  maxWriters: envInt('FUZZ_MAX_WRITERS', 6),
  maxWeight: envInt('FUZZ_MAX_WEIGHT', 3),
  syncEvery: envInt('FUZZ_SYNC_EVERY', 5),
  syncTimeoutMs: envInt('FUZZ_SYNC_TIMEOUT_MS', 20000),
  actionTimeoutMs: envInt('FUZZ_ACTION_TIMEOUT_MS', 60000),
  maxDriftMs: envInt('FUZZ_MAX_DRIFT_MS', 0),
  zeroClock: !!process.env.FUZZ_ZERO_CLOCK,
  minSteps: envInt('FUZZ_MIN_STEPS', envInt('FUZZ_STEPS', 80)),
  maxSteps: envInt('FUZZ_MAX_STEPS', envInt('FUZZ_STEPS', 200)),
  verbose: !!process.env.FUZZ_VERBOSE
}

const baseSeed = envInt('FUZZ_SEED', (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0)
const maxTrials = envInt('FUZZ_TRIALS', 0) // 0 = run forever
const logEvery = envInt('FUZZ_LOG_EVERY', 20)

console.log(
  `autobee fuzzer: baseSeed=${baseSeed} trials=${maxTrials || 'infinite'} transport=${config.transport} ` +
    `steps=${config.minSteps}-${config.maxSteps} maxWriters=${config.maxWriters} ` +
    `drift=${config.maxDriftMs}ms zeroClock=${config.zeroClock}`
)

let stopping = false

// the event loop draining mid-trial is the silent-exit signature: some await
// never settles and nothing holds the loop open, so node exits 0 with no
// output and the run just stops testing. name the phase and dump peer state.
process.on('beforeExit', () => {
  if (!global.__FUZZ_PHASE) return
  console.error('EVENT LOOP DRAINED mid-trial, phase=' + global.__FUZZ_PHASE)
  if (global.__FUZZ_DIAG) {
    try {
      console.error(global.__FUZZ_DIAG())
    } catch (err) {
      console.error('(diagnostics unavailable: ' + err.message + ')')
    }
  }
})
let currentTrialDir = null

process.on('SIGINT', async () => {
  if (stopping) process.exit(130) // second Ctrl-C: don't wait
  stopping = true
  console.log('\nstopping after the current trial (Ctrl-C again to force)...')
  // best-effort: if we're between trials there's nothing to clean; if a
  // trial is mid-flight it'll finish (or fail-and-dump) on its own and this
  // flag stops the loop from starting another one
})

async function main() {
  const runRoot = makeRunRoot()
  console.log(`run root: ${runRoot}`)

  const start = Date.now()
  let completed = 0
  let totalSteps = 0

  for (let trial = 0; !stopping && (maxTrials === 0 || trial < maxTrials); trial++) {
    currentTrialDir = null
    const seed = (baseSeed + trial) >>> 0

    const result = await runTrial(config, trial, seed, runRoot)
    currentTrialDir = result.storageDir || null

    if (!result.ok) {
      console.log(`\n---- TRIAL ${trial} FAILED (seed=${seed}) ----`)
      for (const f of result.failures) {
        console.log(`[${f.kind}]`)
        console.log(f.message)
        console.log('')
      }
      if (result.error) {
        console.log('thrown error:', result.error.stack || result.error.message)
      }
      console.log(`dump written to: ${result.dumpFile}`)
      console.log(`storage retained at: ${result.storageDir}`)
      const determinism =
        config.transport === 'sim'
          ? '(transport=sim: this replays byte-for-byte deterministically - action schedule AND\n' +
            'delivery order both derive from the seed, no real sockets/timers involved)'
          : '(transport=real: the action schedule replays deterministically, but real socket/timer\n' +
            'interleaving does not - this is a strong hint, not a guarantee. FUZZ_TRANSPORT=sim\n' +
            'replays this exact schedule with fully deterministic delivery instead)'

      console.log(
        `\nreplay this trial with:\n` +
          `  FUZZ_SEED=${seed} FUZZ_TRIALS=1 FUZZ_MIN_STEPS=${result.steps} FUZZ_MAX_STEPS=${result.steps} ` +
          `FUZZ_TRANSPORT=${config.transport} FUZZ_VERBOSE=1 node test/fuzz/run.js\n` +
          `${determinism}\n` +
          `\nre-check the dump against the reference order with:\n` +
          `  node test/fuzz/replay-dump.js ${result.dumpFile}`
      )
      // force-exit rather than let the event loop drain naturally: a
      // sync-timeout failure means test/helpers' sync() is still polling in
      // the background forever (Promise.race in withTimeout abandons the
      // loser instead of cancelling it), which would otherwise keep the
      // process alive indefinitely even after everything relevant is dumped
      process.exit(1)
    }

    completed++
    totalSteps += result.steps

    if (completed % logEvery === 0) {
      const elapsed = (Date.now() - start) / 1000
      console.log(
        `${completed} trials clean | ${totalSteps} total actions | ` +
          `${elapsed.toFixed(0)}s elapsed | ${(elapsed / completed).toFixed(2)}s/trial`
      )
    }
  }

  console.log(`\nstopped after ${completed} clean trials.`)

  // clean stop (SIGINT) leaves no trial in flight to clean up - each trial
  // GCs its own storage on success, and we only reach here between trials.
  // force-exit for the same reason as the failure path: nothing should be
  // pending at this point, but a stray listener/timer shouldn't be able to
  // wedge the process open after we've decided we're done
  process.exit(0)
}

main().catch((err) => {
  console.error('fuzzer harness error (not a fuzz finding):', err)
  if (currentTrialDir) console.error(`last trial storage: ${currentTrialDir}`)
  process.exit(1)
})

function envInt(name, fallback) {
  const v = process.env[name]
  return v ? Number(v) : fallback
}
