// A single trial: fresh writer pool, a bounded random walk of actions,
// oracle checks every sync round. Returns a result object; never throws for
// an ordinary fuzz failure (oracle mismatch, sync timeout, a thrown action
// error) - those are all captured and dumped. Only a bug in the harness
// itself (storage, wiring) should escape as a real throw.

const { createState, actions, syncRound } = require('./model.js')
const { runOracle, collectReplays } = require('./oracle.js')
const { dumpFailure } = require('./dump.js')
const { makeTrialDir, writerStorageFactory, gcTrial, makeRng, weightedPick } = require('./util.js')
const asyncErrors = require('./async-errors.js')
const { createRealTransport, createSimTransport } = require('./transport.js')

// crash-path oplog gather budget, per peer. Deliberately NOT tied to
// config.syncTimeoutMs: a tiny sync timeout is a legitimate stress config,
// and it must not also strangle the post-mortem replay() collection - the
// dump is worth 30s/peer even when the trial itself raced at 1ms.
const REPLAY_TIMEOUT_MS = 30000

exports.runTrial = runTrial

// A hung await inside a trial used to kill the fuzzer SILENTLY: nothing
// rejects and nothing throws, so once the loop has no pending handles node
// exits 0 with no output. The watchdog keeps a timer pending (the loop can
// never drain mid-trial) and turns a hang into an attributable, dumpable
// failure the run can move past. FUZZ_NO_WATCHDOG=1 to study a raw stall.
function watchdog(promise, ms, label) {
  if (process.env.FUZZ_NO_WATCHDOG) return promise

  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} did not settle within ${ms}ms - hang`)
      err.code = 'FUZZ_WATCHDOG'
      reject(err)
    }, ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// what every peer's drain loop looks like at the moment of a hang
function hangDiagnostics(state) {
  if (!state) return '(no state)'
  const out = []
  for (const { auto, name } of state.pool) {
    out.push(
      `  ${name.slice(0, 3)} opened=${auto.opened ? 1 : 0} bumping=${auto.bumping}` +
        ` draining=${auto._draining ? 'Y' : 'n'} pendingWriters=${auto.writers.pending.length}` +
        ` localLen=${auto.local.length}`
    )
    for (const w of auto.writers.active.values()) {
      out.push(
        `     w=${w.id.slice(0, 8)} added=${w.isAdded ? 1 : 0} removed=${w.isRemoved ? 1 : 0}` +
          ` frozen=${w.isFrozen ? 1 : 0} isPending=${w.isPending ? 1 : 0}` +
          ` waiting=${w.waiting ? 'Y' : 'n'} coreLen=${w.core.length}` +
          ` pending=${w.pending ? w.pending.length : 'null'} processed=${w.processed}`
      )
    }
  }
  return out.join('\n')
}

// config: { maxWriters, maxWeight, syncEvery, syncTimeoutMs, maxDriftMs,
//           zeroClock, minSteps, maxSteps, verbose, transport }
// config.transport: 'sim' (replication-simulator, seeded/deterministic
// delivery, no real IO) or 'real' (actual corestore replication streams +
// wall-clock polling) - see transport.js.
async function runTrial(config, trial, seed, runRoot) {
  const rng = makeRng(seed)
  const steps = rng.int(config.minSteps, config.maxSteps)

  const trialDir = makeTrialDir(runRoot, trial)
  const nextStorage = writerStorageFactory(trialDir)
  const transport = config.transport === 'real' ? createRealTransport() : createSimTransport(seed)

  const actionLog = []
  const log = (msg) => {
    actionLog.push(msg)
    if (config.verbose) console.log(msg)
  }

  const teardowns = []
  const harness = {
    tick: 0,
    teardown(fn) {
      teardowns.push(fn)
    }
  }

  async function closeAll() {
    const fns = teardowns.splice(0)
    for (const fn of fns) {
      try {
        await fn()
      } catch {}
    }
    try {
      await transport.destroy()
    } catch {}
  }

  async function fail(failures, error, replays) {
    if (!replays) {
      // crash path: the oracle never ran, so pull the full oplog straight
      // off every peer that can still produce one. bestEffort means one
      // broken/wedged writer costs us only ITS replay (recorded as a
      // per-peer error in the dump), never the whole gather - and the
      // timeout stops a replay() against a dead transport from hanging the
      // fuzzer on top of the original failure.
      try {
        replays = await collectReplays(state ? state.pool : [], {
          bestEffort: true,
          timeoutMs: REPLAY_TIMEOUT_MS
        })
      } catch {
        replays = [] // nothing salvageable at all - keep the action log
      }
    }

    const dumpFile = dumpFailure({
      trial,
      config,
      seed,
      storageDir: trialDir,
      actionLog,
      failures,
      replays,
      error
    })

    await closeAll()
    return { ok: false, trial, seed, steps, failures, error, dumpFile, storageDir: trialDir }
  }

  let state
  try {
    global.__FUZZ_PHASE = `trial ${trial}: createState`
    state = await watchdog(
      createState(config, rng, harness, nextStorage, log, transport),
      config.actionTimeoutMs,
      'createState'
    )
    global.__FUZZ_DIAG = () => hangDiagnostics(state)
  } catch (err) {
    return fail([{ kind: 'setup-error', message: `createState threw: ${err.stack}` }], err)
  }

  asyncErrors.consume() // drop anything left over from a previous trial

  let timeouts = 0

  for (let i = 0; i < steps; i++) {
    const action = weightedPick(rng, actions)

    try {
      global.__FUZZ_PHASE = `trial ${trial} step ${i} (${action.name})`
      await watchdog(action.run(state), config.actionTimeoutMs, `step ${i} (${action.name})`)
    } catch (err) {
      if (err.code === 'FUZZ_WATCHDOG') {
        return fail(
          [{ kind: 'action-hang', message: err.message + '\n' + hangDiagnostics(state) }],
          err
        )
      }
      // a drain outside a sync window can need another writer's oplog block;
      // the drain state is preserved, so the next syncRound finishes it - and
      // if the data is genuinely unreachable that round reports sync-timeout
      if (err.code === 'REQUEST_TIMEOUT' || err.code === 'REQUEST_CANCELLED') {
        timeouts++
      } else {
        return fail(
          [{ kind: 'action-error', message: `step ${i} (${action.name}) threw: ${err.stack}` }],
          err
        )
      }
    }

    let stray = asyncErrors.consume()
    if (stray && (stray.code === 'REQUEST_TIMEOUT' || stray.code === 'REQUEST_CANCELLED')) {
      timeouts++
      stray = null
    }
    if (stray) {
      return fail(
        [
          {
            kind: 'async-error',
            message: `stray error after step ${i} (${action.name}): ${stray.stack}`
          }
        ],
        stray
      )
    }

    if ((i + 1) % config.syncEvery === 0) {
      try {
        global.__FUZZ_PHASE = `trial ${trial} step ${i}: syncRound`
        await watchdog(syncRound(state), config.syncTimeoutMs * 3, `syncRound at step ${i}`)
      } catch (err) {
        return fail([{ kind: 'sync-timeout', message: err.message }], err)
      }

      let oracle
      try {
        oracle = await watchdog(runOracle(state.pool, config), config.actionTimeoutMs, 'oracle')
      } catch (err) {
        // strict-mode oracle blew up (a replay()/system.get threw) - that IS
        // the failure; fail() re-gathers best-effort so the dump still gets
        // every readable peer's oplog
        return fail([{ kind: 'oracle-error', message: `oracle threw: ${err.stack}` }], err)
      }

      const { failures, replays } = oracle
      if (failures.length) return fail(failures, undefined, replays)
    }
  }

  try {
    global.__FUZZ_PHASE = `trial ${trial}: final syncRound`
    await watchdog(syncRound(state), config.syncTimeoutMs * 3, 'final syncRound')
  } catch (err) {
    return fail([{ kind: 'sync-timeout', message: err.message }], err)
  }

  let oracle
  try {
    global.__FUZZ_PHASE = `trial ${trial}: final oracle`
    oracle = await watchdog(runOracle(state.pool, config), config.actionTimeoutMs, 'final oracle')
  } catch (err) {
    return fail([{ kind: 'oracle-error', message: `oracle threw: ${err.stack}` }], err)
  }

  const { failures, replays } = oracle
  if (failures.length) return fail(failures, undefined, replays)

  global.__FUZZ_PHASE = null
  await closeAll()
  gcTrial(trialDir)

  return { ok: true, trial, seed, steps, writers: state.pool.length }
}
