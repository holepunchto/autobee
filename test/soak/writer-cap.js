#!/usr/bin/env node
// Opt-in, seeded many-writer reclamation soak.
//
//   SOAK_PROFILE=smoke SOAK_SEED=381 SOAK_DURATION_MS=60000 npm run test:writer-cap-soak
//   SOAK_PROFILE=soak SOAK_SEED=381 npm run test:writer-cap-soak
//   SOAK_PROFILE=saturation npm run test:writer-cap-soak
//
// The product is frozen: this file owns test peers, topology, appends and
// observations only. It never edits or monkey-patches production modules. The
// delegating counters below observe real admissions, evictions and handoffs;
// they do not fabricate ledger records or influence scheduling.

const fs = require('fs')
const path = require('path')
const b4a = require('b4a')
const Corestore = require('corestore')
const Autobee = require('../../index.js')
const encoding = require('../../lib/encoding.js')
const { makeRng } = require('../fuzz/util.js')
const {
  resolveConfig,
  createOperationLedger,
  verifyFinalState,
  verifyApplicationState,
  verifyPhaseCoverage,
  verifySaturation,
  OracleError,
  PhaseError,
  SaturationError,
  sleep,
  withTimeout,
  waitFor,
  quiesce,
  createRing,
  createRunRoot,
  removeRunRoot,
  readAppliedHistory,
  readLengths,
  serialize
} = require('./helpers.js')

const CLOCK = b4a.from('clock')
const LATEST = b4a.from('latest')

// Private marker for the one recoverable cutoff: a *workload* append refused
// because its round crossed the churn cutoff. It stays a PhaseError for every
// direct caller. Only a round boundary may turn it into an orderly stop; every
// other PhaseError (payload/meta, merge deadline, recovery, coverage) still
// propagates unchanged.
class WorkloadCutoff extends PhaseError {}

class SoakRunner {
  constructor(config) {
    this.config = config
    this.seed = config.seed
    this.rng = makeRng(config.seed)
    this.root = null
    this.ledger = createOperationLedger()
    this.ring = createRing(120)
    this.events = freshEvents()
    this.identityKeys = []
    this.authored = new Set()
    this.liveLeaves = new Map()
    this.identityCohorts = []
    this.activeIdentities = []
    this.phase = 'init'
    this.actionIndex = 0
    this.failure = null
    this.failing = false
    this.boundsViolations = []
    this.asyncError = null
    this.watchdog = null
    this.recoveryWatchdog = null
    this.recoveryWatchdogFired = false
    this.recoveryWatchdogError = null
    this.sampler = null
    this.activeStart = null
    this.activeDeadline = null
    this.churnDeadline = null
    this.mergeDeadline = null
    this.recoveryDeadline = null
    this.churnEndedAt = null
    this.mergeStartedAt = null
    this.mergeCompletedAt = null
    this.failureExitMs = config.cleanupAllowanceMs + 10000
    this.failureExitTimer = null
    this.lifecycle = 'running'
    this.saturationReclaimProof = null
    this.pressureFlushGate = null
    this.pressureProofActive = false
    this.pressureFlushArmedEvictions = 0
    this.pressureVictimId = null
    this.readerManualCalls = { update: 0, add: 0, wakeup: 0, hint: 0 }
    this.victims = new Map()
    this.leaves = new Map()
    this.saturationRecord = null
    this.saturationHiddenId = null
    this.admin = null
    this.hub = null
    this.reference = null
    this.reader = null
    this.links = new Links(this)
    this.coverage = {
      allIdentitiesAuthored: false,
      actualEvictions: 0,
      reservedRecords: 0,
      dependencyEvictions: 0,
      refusedPositiveTails: 0,
      recoveredPositiveTails: 0,
      victimRetryAdmissions: 0,
      victimRetryHandoffs: 0,
      victimRetryHandoffLength2: 0,
      victimHandoffLength2: 0,
      victimNonRetryAdmissions: 0,
      victimPositiveAdvancesAfterIsolation: 0,
      victimFreshIngressAfterIsolation: 0,
      victimMaxLossAfterIsolation: 0,
      victimQueuedRestoresAfterIsolation: 0,
      victimIsolationBaselineLength: null,
      victimAnnouncerIsolated: false,
      handoffs: 0,
      deniedWakeups: 0,
      partitions: 0,
      reconnects: 0,
      readerRestart: false,
      readerRestartLedgerEmpty: false,
      writerRestart: false,
      writerRestartSameIdentity: false,
      settledCheckpoints: 0,
      converged: false,
      appendsStarted: 0,
      lateAppendCompletions: 0,
      mergeAppendsStartedInCloseout: 0,
      mergeAppendsCompletedAfterChurn: 0,
      phases: []
    }
    this.samples = []
    this.mutationNote = 'delegating test-side observers only; production files untouched'
  }

  // -------------------------------------------------------------------------
  // lifecycle

  async run() {
    this.startWatchdog()
    this.installAsyncErrorHandlers()

    try {
      this.root = createRunRoot()
      this.log('config', {
        config: this.config,
        replay: this.config.replay,
        root: this.root,
        note: this.mutationNote
      })

      if (this.config.saturation) await this.runSaturation()
      else await this.runSoak()

      await this.finishSuccessfulRun()
      return 0
    } catch (err) {
      this.armFailureExit()
      await this.handleFailure(err)
      return 1
    }
  }

  now() {
    return Date.now()
  }

  startWatchdog() {
    this.watchdog = setTimeout(() => {
      this.forceFailure(
        new Error('overall soak watchdog expired after ' + this.config.totalAllowanceMs + 'ms')
      )
    }, this.config.totalAllowanceMs)
    // Deliberately referenced. Setup, saturation and every other non-terminal
    // phase may await a ready/update/append promise after the sampler's and
    // recovery watchdog's timers have been unref'd or not yet armed. An unref'd
    // overall guard would let Node exit 0 with no terminal failure when no
    // other handle is live. It is cleared only by successful completion or by
    // the bounded failure path in handleFailure().
  }

  startRecoveryWatchdog() {
    if (this.recoveryDeadline === null) {
      throw new Error('cannot arm the recovery watchdog without an absolute recovery deadline')
    }
    if (this.recoveryWatchdog !== null) {
      throw new Error('the recovery watchdog is already armed')
    }

    this.recoveryWatchdogFired = false
    this.recoveryWatchdogError = null
    const delayMs = Math.max(0, this.recoveryDeadline - this.now())

    // This watchdog is deliberately referenced. If a signed final merge
    // append, a premerge preparation read or an unlink/close is stuck, no
    // other handle may keep the event loop alive; the process must reach the
    // absolute recovery deadline and enter the ordinary failure path instead
    // of exiting naturally or waiting for the overall watchdog's setup slack.
    // It never tries to cancel the underlying operation.
    this.recoveryWatchdog = setTimeout(() => {
      this.recoveryWatchdog = null
      this.recoveryWatchdogFired = true
      const err = new PhaseError(
        'shared recovery watchdog expired at ' +
          this.recoveryDeadline +
          'ms (churn cutoff + ' +
          this.config.drainAllowanceMs +
          'ms drain allowance)'
      )
      this.recoveryWatchdogError = err
      this.log('recovery-watchdog-fired', { recoveryDeadline: this.recoveryDeadline })
      this.forceFailure(err)
    }, delayMs)

    this.log('recovery-watchdog-armed', {
      recoveryDeadline: this.recoveryDeadline,
      delayMs
    })
  }

  disarmRecoveryWatchdog() {
    // A fired guard is latched. Late completion may not clear it, satisfy it
    // or turn it into a successful run.
    if (this.recoveryWatchdogFired) return false
    if (this.recoveryWatchdog === null) return false

    clearTimeout(this.recoveryWatchdog)
    this.recoveryWatchdog = null
    return true
  }

  assertRecoveryWatchdogDidNotFire(where) {
    if (!this.recoveryWatchdogFired) return

    throw new PhaseError(
      where +
        ' cannot complete: the shared recovery watchdog already fired' +
        (this.recoveryWatchdogError ? ' (' + this.recoveryWatchdogError.message + ')' : '')
    )
  }

  installAsyncErrorHandlers() {
    process.on('uncaughtException', (err) => {
      this.asyncError = err
      this.forceFailure(err)
    })
    process.on('unhandledRejection', (err) => {
      this.asyncError = err
      this.forceFailure(err)
    })
  }

  forceFailure(err) {
    if (this.failing || this.lifecycle === 'done') return

    // Failure keeps a bounded forced termination: handleFailure releases the
    // gates and runs a best-effort cleanup, and this outer timer guarantees
    // the process cannot hang on a broken stream or store.
    const forced = setTimeout(() => {
      console.error('forced termination after bounded failure cleanup')
      process.exit(1)
    }, this.config.cleanupAllowanceMs + 10000)
    forced.unref()

    void this.handleFailure(err)
      .catch((failure) => {
        console.error('failure handler failed: ' + String(failure))
      })
      .finally(() => {
        clearTimeout(forced)
        process.exit(1)
      })
  }

  armFailureExit() {
    if (this.failureExitTimer) return

    // Ordinary failure gets the same bounded termination as the async/watchdog
    // path. A close deadline or a retained handle must not keep the process
    // alive forever after handleFailure has done its best-effort cleanup.
    const timer = setTimeout(() => {
      console.error('forced termination after bounded failure cleanup')
      process.exit(1)
    }, this.failureExitMs)
    timer.unref()
    this.failureExitTimer = timer
  }

  releasePressureFlushGate() {
    const gate = this.pressureFlushGate
    this.pressureFlushGate = null
    if (gate && !gate.resolved) gate.resolve()
    return !!gate
  }

  async handleFailure(err) {
    if (this.failing) return
    this.failing = true
    this.failure = err
    this.armFailureExit()

    if (this.watchdog) {
      clearTimeout(this.watchdog)
      this.watchdog = null
    }
    if (this.recoveryWatchdog) {
      clearTimeout(this.recoveryWatchdog)
      this.recoveryWatchdog = null
    }
    // The flush gate must be released before any diagnostic read/await: a
    // held hint flush otherwise blocks the reader drain and the cleanup that
    // follows it.
    this.releasePressureFlushGate()
    this.stopSampler()

    let snapshot = null
    try {
      snapshot = await withTimeout(this.failureSnapshot(), 5000, 'diagnostic snapshot timed out')
    } catch (snapshotError) {
      snapshot = { error: String(snapshotError) }
    }

    console.error(
      JSON.stringify({
        kind: 'soak-failure',
        seed: this.seed,
        profile: this.config.profile,
        replay: this.config.replay,
        phase: this.phase,
        actionIndex: this.actionIndex,
        root: this.root,
        ring: this.ring.snapshot(),
        coverage: this.coverage,
        events: summarizeEvents(this.events),
        snapshot,
        boundsViolations: this.boundsViolations.slice(0, 20),
        error: {
          name: err && err.name ? err.name : 'Error',
          message: err && err.message ? err.message : String(err),
          stack: err && err.stack ? err.stack : null
        }
      })
    )

    if (this.root) {
      console.error('soak data retained at ' + this.root)
      console.error('replay: ' + this.config.replay)
    }

    try {
      await withTimeout(
        this.cleanup({ retainRoot: true, bestEffort: true }),
        this.config.cleanupAllowanceMs,
        'cleanup deadline exceeded'
      )
    } catch (cleanupError) {
      console.error('cleanup after failure failed: ' + String(cleanupError))
    }
  }

  async finishSuccessfulRun() {
    this.lifecycle = 'finishing'
    this.phase = 'closed'
    this.throwIfAsyncError()
    this.assertRecoveryWatchdogDidNotFire('successful completion')
    if (this.failing) throw new Error('run failed before successful completion')

    // Recovery is complete; cleanup is independently bounded below. Disarm
    // before entering it so a slow but valid cleanup cannot trip the recovery
    // deadline, while a fired guard stays latched and can never be cleared.
    this.disarmRecoveryWatchdog()

    // Cleanup keeps the owned root until every close, bounds and async-error
    // check has passed. A stream error racing this path therefore cannot make
    // the runner print ok:true or delete the root of a failed run.
    await withTimeout(
      this.cleanup({ retainRoot: true, bestEffort: false }),
      this.config.cleanupAllowanceMs,
      'successful cleanup exceeded its deadline'
    )

    this.throwIfAsyncError()
    if (this.failing) throw new Error('run failed during successful cleanup')
    if (this.closeErrors.length > 0) {
      throw new Error('orderly close failed: ' + this.closeErrors.join(' | '))
    }
    if (this.boundsViolations.length > 0) {
      throw new Error('bounds violations observed: ' + this.boundsViolations.join(' | '))
    }

    if (this.watchdog) {
      clearTimeout(this.watchdog)
      this.watchdog = null
    }
    this.stopSampler()
    this.takeSample('after-close', { final: true })

    const summary = summarizeSamples(this.samples)
    const result = {
      kind: this.config.saturation ? 'saturation-result' : 'soak-result',
      ok: true,
      profile: this.config.profile,
      seed: this.seed,
      replay: this.config.replay,
      durationMs: this.config.durationMs,
      writerCount: this.config.writerCount,
      readerCap: this.config.readerCap,
      maxReclaimedWriters: this.config.maxReclaimedWriters,
      expectedOperations: this.ledger.expected.size,
      acknowledgedWriters: this.ledger.ack.size,
      authoredIdentities: this.authored.size,
      counters: summarizeEvents(this.events),
      resources: summary,
      samples: this.samples.length,
      storageRemoved: false
    }

    if (!this.config.saturation) {
      result.timing = {
        activeStart: this.activeStart,
        churnDeadline: this.churnDeadline,
        mergeDeadline: this.mergeDeadline,
        recoveryDeadline: this.recoveryDeadline,
        churnEndedAt: this.churnEndedAt,
        churnElapsedMs:
          this.churnEndedAt === null || this.activeStart === null
            ? null
            : this.churnEndedAt - this.activeStart,
        mergeStartedAt: this.mergeStartedAt,
        mergeCompletedAt: this.mergeCompletedAt,
        mergeCloseoutElapsedMs:
          this.mergeCompletedAt === null ? null : this.mergeCompletedAt - this.churnDeadline
      }
    }

    if (this.config.saturation) {
      result.expectedStalled = true
      result.record = this.saturationRecord
      result.reclaimAttempt = this.saturationReclaimProof
      result.note =
        'intentionally stalled by the one-record metadata budget; this is not a global convergence claim'
    } else {
      result.coverage = this.coverage
    }

    result.streamErrors = this.links.errors.slice(0, 20)

    if (this.root) {
      if (!removeRunRoot(this.root)) {
        throw new Error('refusing to remove an unowned soak directory: ' + this.root)
      }
      this.root = null
      result.storageRemoved = true
    }

    this.lifecycle = 'done'
    console.log(JSON.stringify(result, null, 2))
  }

  async cleanup({ retainRoot, bestEffort }) {
    // Release a held hint flush before any teardown await can depend on the
    // reader drain. This is idempotent with the pressure phase's own finally.
    this.releasePressureFlushGate()

    this.closeErrors = this.closeErrors || []
    this.stopSampler()

    const pending = []

    for (const [index, leaf] of [...this.liveLeaves]) {
      const label = this.leaves.get(index)
      if (label) pending.push(this.links.unlink(label).catch((err) => this.recordClose(err)))
      pending.push(
        withTimeout(leaf.close(), 20000, 'leaf close timed out')
          .catch((err) => this.recordClose(err))
          .finally(() => this.liveLeaves.delete(index))
      )
    }
    this.leaves.clear()

    pending.push(this.links.closeAll().catch((err) => this.recordClose(err)))

    for (const auto of [this.reader, this.reference, this.hub, this.admin]) {
      if (!auto) continue
      pending.push(
        withTimeout(auto.close(), 20000, 'store close timed out').catch((err) =>
          this.recordClose(err)
        )
      )
    }

    const settled = await Promise.allSettled(pending)
    for (const entry of settled) {
      if (entry.status === 'rejected') this.recordClose(entry.reason)
    }

    this.reader = null
    this.reference = null
    this.hub = null
    this.admin = null

    if (this.closeErrors.length > 0 && !bestEffort) {
      const errors = this.closeErrors.slice()
      this.closeErrors = []
      throw new Error('close errors: ' + errors.join(' | '))
    }

    if (!retainRoot && this.root) {
      if (!removeRunRoot(this.root)) {
        throw new Error('refusing to remove an unowned soak directory: ' + this.root)
      }
      this.root = null
    }
  }

  recordClose(err) {
    if (!err) return
    const text = String((err && err.message) || err)
    // Only genuinely idempotent already-closed reports are noise. A close
    // deadline or a stream that never closed is a real teardown failure.
    if (/already closed|resource is closed|store is closed/i.test(text)) return
    this.closeErrors = this.closeErrors || []
    if (!this.closeErrors.includes(text)) this.closeErrors.push(text)
  }

  // -------------------------------------------------------------------------
  // logging / instrumentation

  log(kind, extra = {}) {
    console.log(
      JSON.stringify({
        kind,
        t: Date.now(),
        phase: this.phase,
        actionIndex: this.actionIndex,
        seed: this.seed,
        ...extra
      })
    )
  }

  recordPhase(name) {
    if (!this.coverage.phases.includes(name)) this.coverage.phases.push(name)
  }

  action(kind, fn, extra = {}) {
    const index = this.actionIndex++
    this.ring.push({ index, kind, phase: this.phase, at: Date.now(), ...extra })
    this.checkBounds()

    try {
      return fn()
    } catch (err) {
      err.soakAction = { index, kind, phase: this.phase, extra }
      throw err
    }
  }

  wait(label, fn, timeout, interval = 50) {
    return waitFor(
      () => {
        this.throwIfAsyncError()
        this.checkBounds()
        return fn()
      },
      { label, timeout, interval }
    )
  }

  actionWait(label, fn, timeout, interval = 50) {
    return this.wait(label, fn, timeout, interval)
  }

  throwIfAsyncError() {
    if (this.asyncError) {
      const err = this.asyncError
      this.asyncError = null
      throw err
    }
  }

  assertAppendAllowed(label, payloads = [], meta = {}) {
    if (this.activeDeadline === null) return

    const now = this.now()
    const kinds = payloads.map((payload) => payload && payload.op)
    const finalMergePayload = kinds.length > 0 && kinds.every((kind) => kind === 'final-merge')
    const labelledFinalMerge = meta && meta.kind === 'final-merge'

    // The allowance belongs to the payload, not a caller-chosen label. A
    // workload append cannot borrow the final merge's closeout window.
    if (finalMergePayload !== labelledFinalMerge) {
      throw new PhaseError(
        'append "' +
          label +
          '" has payload kind ' +
          JSON.stringify(kinds) +
          ' but metadata kind ' +
          JSON.stringify(meta && meta.kind) +
          '; the final-merge label and payload must agree'
      )
    }

    if (now < this.activeDeadline) return

    if (!finalMergePayload) {
      throw new WorkloadCutoff(
        'refusing to start workload append "' +
          label +
          '" at ' +
          now +
          'ms, at/after the churn cutoff (active deadline) ' +
          this.activeDeadline +
          'ms'
      )
    }

    if (this.mergeDeadline === null || now >= this.mergeDeadline) {
      throw new PhaseError(
        'refusing to start final merge "' +
          label +
          '" at ' +
          now +
          'ms, at/after the merge closeout deadline ' +
          this.mergeDeadline +
          'ms'
      )
    }
  }

  // One absolute post-churn deadline covers the merge closeout, its
  // propagation, the leaf closes, the settled checkpoints and the final
  // recovery. It starts at the churn cutoff, so an exhausted drain allowance
  // can never be refreshed by a later phase.
  recoveryRemaining(label) {
    const remaining =
      this.recoveryDeadline === null ? Number.POSITIVE_INFINITY : this.recoveryDeadline - this.now()

    if (remaining <= 0) {
      throw new PhaseError(
        label +
          ' cannot run: the shared post-churn recovery deadline (' +
          this.recoveryDeadline +
          'ms = churn cutoff + ' +
          this.config.drainAllowanceMs +
          'ms drain allowance) is already spent'
      )
    }

    return remaining
  }

  recoveryBound(label, ownMs) {
    return Math.min(ownMs, this.recoveryRemaining(label))
  }

  recoveryAwait(label, promise) {
    const remaining = this.recoveryRemaining(label)
    if (!Number.isFinite(remaining)) return promise

    return withTimeout(
      promise,
      remaining,
      label +
        ' did not settle inside the shared post-churn recovery deadline (' +
        this.recoveryDeadline +
        'ms)'
    )
  }

  noteVictimBaselineLoss() {
    if (!this.pressureProofActive) return
    if (this.events.victimBaselineLossObserved) return

    this.events.victimBaselineLossObserved = true
    this.events.victimMaxLossAfterIsolation = 1
    this.log('victim-baseline-loss', {
      victim: this.pressureVictimId ? this.pressureVictimId.slice(0, 16) : null,
      baseline: this.events.victimIsolationBaselineLength,
      note: 'the remembered positive maximum dropped below the isolation baseline'
    })
  }

  checkVictimIsolationBaseline() {
    if (!this.pressureProofActive) return true

    const baseline = this.events.victimIsolationBaselineLength
    if (!Number.isSafeInteger(baseline) || !this.reader) return true

    const record = this.reader.writers._reclaimed.get(this.pressureVictimId)
    if (!record) {
      // A missing record is only legitimate once the handoff admitted the
      // victim; before that it means the remembered obligation disappeared.
      if (this.reader.writers.has(this.pressureVictimId)) return true
      this.noteVictimBaselineLoss()
      return false
    }

    if (record.length < baseline) {
      this.noteVictimBaselineLoss()
      return false
    }

    return true
  }

  beginVictimIsolation(victimId) {
    const record = this.reader.writers._reclaimed.get(victimId)
    if (!record) {
      throw new PhaseError('cannot establish the isolation baseline: victim record is missing')
    }

    this.events.victimIsolationBaselineLength = record.length
    this.events.victimIsolatedAt = this.events.victimWakeupCalls
    this.events.victimFreshIngressAfterIsolation = 0
    this.events.victimMaxLossAfterIsolation = 0
    this.events.victimQueuedRestoresAfterIsolation = 0
    this.events.victimBaselineLossObserved = false
    this.pressureProofActive = true
  }

  finishVictimIsolationProof() {
    this.checkVictimIsolationBaseline()
    this.pressureProofActive = false

    this.coverage.victimPositiveAdvancesAfterIsolation =
      this.events.victimFreshIngressAfterIsolation
    this.coverage.victimMaxLossAfterIsolation = this.events.victimMaxLossAfterIsolation
    this.coverage.victimQueuedRestoresAfterIsolation =
      this.events.victimQueuedRestoresAfterIsolation
    this.coverage.victimIsolationBaselineLength = this.events.victimIsolationBaselineLength

    this.log('victim-isolation-proof', {
      victim: this.pressureVictimId ? this.pressureVictimId.slice(0, 16) : null,
      baseline: this.events.victimIsolationBaselineLength,
      freshIngress: this.events.victimFreshIngressAfterIsolation,
      maxLoss: this.events.victimMaxLossAfterIsolation,
      queuedRestores: this.events.victimQueuedRestoresAfterIsolation
    })
  }

  checkBounds() {
    if (this.boundsViolations.length === 0) return

    const first = this.boundsViolations[0]
    this.boundsViolations = []
    throw new Error('configured bound violated: ' + first)
  }

  recordBoundViolation(message) {
    if (this.boundsViolations.length < 20) this.boundsViolations.push(message)
    this.log('bound-violation', { message })
  }

  instrumentReader(reader) {
    const writers = reader.writers
    const events = this.events
    const self = this

    const reclaim = writers._reclaimOne.bind(writers)
    writers._reclaimOne = async function (dependencies) {
      const before = {
        active: writers.active.size,
        records: writers._reclaimed.size,
        budget: writers.maxReclaimedWriters,
        cap: writers.maxUntrustedWriters,
        at: self.now()
      }
      const dependencySnapshot = (dependencies || []).map((dependency) => ({
        id: b4a.toString(dependency.key, 'hex'),
        length: dependency.length
      }))

      const victim = await reclaim(dependencies)

      if (victim) {
        const record = writers._reclaimed.get(victim.id)
        events.evictions++
        events.lastEviction = {
          id: victim.id,
          key: b4a.toString(victim.core.key, 'hex'),
          recordLength: record ? record.length : null,
          at: self.now()
        }
        events.records.set(victim.id, record ? record.length : 0)
        self.log('actual-eviction', { victim: events.lastEviction })
        self.takeSample('eviction', {
          eventVictim: victim.id.slice(0, 16),
          eventRecordLength: record ? record.length : null
        })
      }

      // The production path refused at the metadata budget before looking at
      // any writer. Record the real null result and, without updating or
      // rescuing anything, prove that a fully eligible idle alternative was
      // present under the same read-only checks the product uses.
      if (victim === null && before.records >= before.budget) {
        const probe = await self.probeReclaimEligibility(writers, dependencies || [])
        const after = {
          active: writers.active.size,
          records: writers._reclaimed.size,
          at: self.now()
        }
        const attempt = {
          at: before.at,
          dependencies: dependencySnapshot,
          before,
          after,
          victim: null,
          demand: probe.demand,
          eligible: probe.eligible,
          rejected: probe.rejected.slice(0, 8)
        }
        events.reclaimAttempts.push(attempt)
        if (events.reclaimAttempts.length > 20) events.reclaimAttempts.shift()
        self.log('reclaim-refused-by-budget', {
          active: before.active,
          records: before.records,
          budget: before.budget,
          dependencies: dependencySnapshot,
          eligible: probe.eligible.map((candidate) => candidate.id.slice(0, 16)),
          rejected: probe.rejected.length
        })
      }

      self.checkBoundaries('reclaim')
      return victim
    }

    const retry = writers._retryReclaimedUnlocked.bind(writers)
    writers._retryReclaimedUnlocked = async function () {
      writers._retryDepth = (writers._retryDepth || 0) + 1
      try {
        return await retry()
      } finally {
        writers._retryDepth--
      }
    }

    const add = writers._addUnlocked.bind(writers)
    writers._addUnlocked = async function (key, id) {
      const existing = writers.active.get(id)
      const record = writers._reclaimed.get(id)
      const sizeBefore = writers.active.size
      const result = await add(key, id)
      const retryContext = (writers._retryDepth || 0) > 0

      if (result && !existing) {
        events.admissions++
        events.opened.set(id, (events.opened.get(id) || 0) + 1)
        if (retryContext) events.retryAdmissions++
        if (self.pressureVictimId === id) {
          events.victimOpened++
          if (retryContext) events.victimRetryAdmissions++
          else events.victimNonRetryAdmissions++
        }
      }

      if (!result && !existing && record) {
        events.deniedWakeups++
        if (sizeBefore >= self.config.readerCap) events.deniedByCap++
      }

      self.checkBoundaries('admission')
      return result
    }

    const handoff = writers._handoffReclaimed.bind(writers)
    writers._handoffReclaimed = function (writer) {
      const record = writer ? writers._reclaimed.get(writer.id) : null
      const retryContext = (writers._retryDepth || 0) > 0
      const advanced = handoff(writer)

      if (advanced && writer) {
        const length = record ? record.length : null
        events.handoffs++
        events.lastHandoff = { id: writer.id, length, at: self.now() }
        if (self.pressureVictimId === writer.id) {
          events.victimHandoffs++
          if (length === 2) events.victimHandoffLength2++
          if (retryContext) {
            events.victimRetryHandoffs++
            if (length === 2) events.victimRetryHandoffLength2++
          }
          events.lastVictimHandoff = {
            id: writer.id,
            length,
            retryContext,
            at: self.now()
          }
        }
        self.takeSample('handoff', {
          eventVictim: writer.id.slice(0, 16),
          eventRecordLength: length
        })
      }

      return advanced
    }

    const wakeup = writers.wakeup.bind(writers)
    writers.wakeup = async function (key, length) {
      const id = b4a.toString(key, 'hex')
      const record = writers._reclaimed.get(id)
      const activeBefore = writers.active.size
      const hasBefore = writers.active.has(id)

      if (record && !hasBefore && Number.isSafeInteger(length) && length > 0) {
        events.positiveAnnouncements++
        if (length > record.length) events.positiveAdvances++
        if (activeBefore >= self.config.readerCap) events.refusedPositive++
        if (self.pressureVictimId === id && length >= 2) events.victimPositiveAnnouncements++
      }

      if (self.pressureVictimId === id) {
        events.victimWakeupCalls++
        if (events.victimIsolatedAt !== null) events.victimWakeupsAfterIsolation++
      }

      const result = await wakeup(key, length)

      if (
        record &&
        !hasBefore &&
        Number.isSafeInteger(length) &&
        length >= 2 &&
        activeBefore >= self.config.readerCap
      ) {
        events.deniedPositiveTail++
      }

      return result
    }

    // The pressure proof pauses the reader's next hint flush after the real
    // eviction. While paused the cap is still full, so a victim's positive tail
    // is captured by the real ingress path and then actually refused before any
    // slot can free. This is a delegating gate; it never changes the result.
    const flushWakeup = reader._flushWakeup.bind(reader)
    reader._flushWakeup = async function () {
      const gate = self.pressureFlushGate
      if (gate && !gate.resolved && self.events.evictions > self.pressureFlushArmedEvictions) {
        gate.reached = true
        await gate.promise
      }
      return flushWakeup()
    }

    // The raw hint hook in lib/wakeup.js calls this method synchronously before
    // the base class can coalesce or wake anything. Track that raw phase so the
    // later flush/direct wakeup captures cannot be mistaken for fresh ingress.
    let rawCaptureDepth = 0
    const captureAnnouncements = writers.captureReclaimedAnnouncements.bind(writers)
    writers.captureReclaimedAnnouncements = function (hints) {
      rawCaptureDepth++
      try {
        return captureAnnouncements(hints)
      } finally {
        rawCaptureDepth--
      }
    }

    const capture = writers._captureReclaimedHint.bind(writers)
    writers._captureReclaimedHint = function (id, length) {
      const record = writers._reclaimed.get(id)
      const before = record ? record.length : 0
      const raw = rawCaptureDepth > 0
      const baseline = events.victimIsolationBaselineLength

      capture(id, length)

      const after = record ? record.length : 0
      if (after <= before) return

      events.capturedPositive++
      events.lastCapture = { id, before, after, raw, at: Date.now() }

      if (!self.pressureProofActive || self.pressureVictimId !== id) return

      if (Number.isSafeInteger(baseline) && before < baseline) {
        self.noteVictimBaselineLoss()
      }

      // A raw positive capture that raises the remembered maximum after
      // isolation is fresh ingress, including one that merely restores a
      // maximum that had already been lost. A same-length queued duplicate
      // leaves the record unchanged and is not counted.
      if (raw) {
        events.victimFreshIngressAfterIsolation++
        events.victimPositiveAdvancesAfterIsolation = events.victimFreshIngressAfterIsolation
      } else if (Number.isSafeInteger(baseline) && before < baseline) {
        events.victimQueuedRestoresAfterIsolation++
      }
    }
  }

  // Read-only equivalent of the product's idle-candidate checks, used only to
  // explain a real budget refusal. It never calls update() (which could stage
  // or rescue work); applied lengths come from the real system view, and every
  // candidate is revalidated after that awaited read.
  async probeReclaimEligibility(writers, dependencies) {
    const reserved = new Set(dependencies.map((dependency) => b4a.toString(dependency.key, 'hex')))
    const demand = []

    for (const dependency of dependencies) {
      const id = b4a.toString(dependency.key, 'hex')
      const info = await writers.auto.system.get(dependency.key)
      const applied = info ? info.length : 0
      demand.push({
        id,
        length: dependency.length,
        applied,
        satisfied: applied >= dependency.length
      })
    }

    const candidates = []
    for (const w of writers.active.values()) {
      const candidate = {
        id: w.id,
        applied: null,
        core: w.core.length,
        hinted: w.hintedLength,
        revalidated: false
      }
      const reject = (reason) => {
        candidate.reason = reason
        candidates.push(candidate)
      }

      if (w === writers.localWriter) {
        reject('local')
        continue
      }
      if (reserved.has(w.id)) {
        reject('reserved-dependency')
        continue
      }
      if (!w.isAttached) {
        reject('detached')
        continue
      }
      if (w.isClosed) {
        reject('closed')
        continue
      }
      if (writers.active.get(w.id) !== w) {
        reject('identity')
        continue
      }
      if (w.isFrozen) {
        reject('frozen')
        continue
      }
      if (!writers._isIdleCandidate(w)) {
        reject('not-idle')
        continue
      }
      if (!writers.auto.system.isHead(w.core.key)) {
        reject('not-head')
        continue
      }

      const info = await writers.auto.system.get(w.core.key)
      const applied = info ? info.length : 0
      candidate.applied = applied

      if (applied < w.core.length) {
        reject('behind-live')
        continue
      }
      if (applied < w.hintedLength) {
        reject('behind-hint')
        continue
      }

      // Revalidate the whole decision after the awaited applied read.
      if (writers.active.get(w.id) !== w || !w.isAttached || w.isClosed) {
        reject('changed-after-await')
        continue
      }
      if (w.isFrozen) {
        reject('frozen-after-await')
        continue
      }
      if (!writers.auto.system.isHead(w.core.key)) {
        reject('not-head-after-await')
        continue
      }
      if (!writers._isIdleCandidate(w)) {
        reject('not-idle-after-await')
        continue
      }
      if (applied < w.core.length || applied < w.hintedLength) {
        reject('behind-after-await')
        continue
      }
      if (writers._hasQueuedAnnouncement(w.id, applied)) {
        reject('queued-announcement')
        continue
      }

      candidate.revalidated = true
      candidates.push(candidate)
    }

    return {
      demand,
      eligible: candidates.filter((candidate) => candidate.revalidated),
      rejected: candidates.filter((candidate) => !candidate.revalidated)
    }
  }

  checkBoundaries(where) {
    const reader = this.reader
    if (!reader) return

    if (reader.writers.active.size > this.config.readerCap) {
      this.recordBoundViolation(
        where +
          ': reader active sessions ' +
          reader.writers.active.size +
          ' exceed cap ' +
          this.config.readerCap
      )
    }

    if (reader.writers._reclaimed.size > this.config.maxReclaimedWriters) {
      this.recordBoundViolation(
        where +
          ': reader reclaimed records ' +
          reader.writers._reclaimed.size +
          ' exceed budget ' +
          this.config.maxReclaimedWriters
      )
    }

    if (this.liveLeaves.size > this.config.leafBound) {
      this.recordBoundViolation(
        where +
          ': live leaf stores ' +
          this.liveLeaves.size +
          ' exceed bound ' +
          this.config.leafBound
      )
    }

    const maxEdges = 3 + this.config.leafBound + 1
    if (this.links.size > maxEdges) {
      this.recordBoundViolation(
        where + ': live replication edges ' + this.links.size + ' exceed bound ' + maxEdges
      )
    }
  }

  // -------------------------------------------------------------------------
  // peers, apply, appends

  makeAuto(name, storage, key, options = {}) {
    const store = new Corestore(storage, {
      manifestVersion: 2
    })
    const auto = new Autobee(store, key, {
      bootstrapWeight: 3,
      ackThreshold: Infinity,
      optimistic: false,
      maxUntrustedWriters: 1024,
      apply: (nodes, view, host) => this.apply(nodes, view, host),
      name,
      ...options
    })
    auto._soakStorage = storage
    return auto
  }

  async apply(nodes, view, host) {
    const writes = []

    for (const node of nodes) {
      let data
      try {
        data = JSON.parse(b4a.toString(node.value))
      } catch {
        throw new Error(
          'soak apply received an undecodable value at ' +
            b4a.toString(node.key, 'hex') +
            '.' +
            node.length
        )
      }

      if (data.addWriter) {
        host.addWriter(data.addWriter, { weight: data.weight === undefined ? 1 : data.weight })
      }
      if (data.removeWriter) host.removeWriter(data.removeWriter)

      writes.push(data)
    }

    if (writes.length === 0) return

    const clock = await view.get(CLOCK)
    let index = clock ? Number(b4a.toString(clock.value)) : -1
    const batch = view.write()

    for (let i = 0; i < nodes.length; i++) {
      index++
      batch.tryPut(CLOCK, b4a.from(String(index)))
      batch.tryPut(LATEST, nodes[i].value)
      batch.tryPut(
        b4a.from('#' + String(index).padStart(6, '0')),
        b4a.from(b4a.toString(nodes[i].key, 'hex') + '.' + nodes[i].length)
      )
    }

    await batch.flush()
  }

  async appendBatch(author, label, payloads, meta = {}) {
    // This is the only append entry point. The gate is synchronous at call
    // time, so a caller that just returned from an awaited update/prepare is
    // checked before it can start the append. The closeout allowance is
    // derived from the actual payload kind, never from a caller label alone.
    this.assertAppendAllowed(label, payloads, meta)
    const startedAt = this.now()
    const deadline = this.activeDeadline
    const isFinalMerge = meta.kind === 'final-merge'

    if (isFinalMerge) this.mergeStartedAt = startedAt
    if (isFinalMerge && deadline !== null && startedAt >= deadline) {
      this.coverage.mergeAppendsStartedInCloseout++
      this.log('merge-closeout-start', {
        label,
        at: startedAt,
        churnDeadline: deadline,
        mergeDeadline: this.mergeDeadline
      })
    }

    const key = b4a.toString(author.local.key, 'hex')
    const start = author.local.length
    const encoded = payloads.map((payload) => b4a.from(JSON.stringify(payload)))

    this.coverage.appendsStarted++
    await author.append(encoded)

    const completedAt = this.now()
    const end = author.local.length
    if (end !== start + encoded.length) {
      throw new Error(
        'append acknowledgement mismatch for ' +
          label +
          ': expected ' +
          (start + encoded.length) +
          ', local length ' +
          end
      )
    }

    if (isFinalMerge) this.mergeCompletedAt = completedAt

    if (deadline !== null && completedAt >= deadline) {
      if (isFinalMerge) {
        this.coverage.mergeAppendsCompletedAfterChurn++
        this.log('merge-completed-in-closeout', {
          label,
          startedAt,
          completedAt,
          churnDeadline: deadline,
          mergeDeadline: this.mergeDeadline,
          note: 'final administrative merge started in the bounded closeout'
        })
      } else {
        this.coverage.lateAppendCompletions++
        this.log('append-completed-after-deadline', {
          label,
          startedAt,
          completedAt,
          deadline,
          note: 'started inside the workload window; completion drained past the cutoff'
        })
      }
    }

    for (let i = 0; i < encoded.length; i++) {
      this.ledger.record(key, start + i + 1, {
        ...meta,
        author: label,
        length: start + i + 1,
        seq: start + i + 1,
        startedAt,
        completedAt
      })
    }

    if (meta.identityIndex !== undefined) this.authored.add(meta.identityIndex)

    this.ring.push({
      index: this.actionIndex++,
      kind: 'append',
      phase: this.phase,
      at: completedAt,
      label,
      key,
      from: start + 1,
      to: end,
      op: meta.kind,
      startedAt,
      completedAt,
      startedBeforeDeadline: deadline === null || startedAt < deadline,
      finalMerge: isFinalMerge
    })

    this.checkBoundaries('append')
    return { key, start, end, count: encoded.length, startedAt, completedAt }
  }

  // -------------------------------------------------------------------------
  // soak orchestration

  async runSoak() {
    this.phase = 'setup'
    this.originalStart = Date.now()
    this.startSampler()

    await this.setupPeers()
    await this.setupIdentities()
    await this.startReader()
    await this.waitForAdminSync('setup')

    this.recordPhase('identity-setup')
    this.recordPhase('reader-start')

    this.log('setup-complete', {
      elapsedMs: Date.now() - this.originalStart,
      identities: this.identityKeys.length,
      authored: this.authored.size
    })

    const activeStart = this.now()
    this.startActiveWindow(activeStart)
    this.startRecoveryWatchdog()
    this.log('active-window', {
      activeStart,
      activeDeadline: this.activeDeadline,
      churnDeadline: this.churnDeadline,
      mergeDeadline: this.mergeDeadline,
      recoveryDeadline: this.recoveryDeadline,
      durationMs: this.config.durationMs,
      mergeCloseoutMs: this.config.mergeCloseoutMs,
      drainAllowanceMs: this.config.drainAllowanceMs
    })

    await this.runPressurePhase()

    const remaining = this.activeDeadline - this.now()
    if (remaining <= 0) {
      throw new PhaseError(
        'pressure phase consumed the whole active duration; no regular cohort could run'
      )
    }

    await this.runRegularCohorts()

    this.assertAllIdentitiesAuthored()

    // Only now, after every active append (including the final merge) has been
    // started or refused by the gate, does recovery switch to the bounded drain.
    this.phase = 'drain'
    this.stopSampler()
    this.startSampler()
    this.log('final-drain', {
      expected: this.ledger.expected.size,
      active: this.reader.writers.size,
      lateAppendCompletions: this.coverage.lateAppendCompletions,
      mergeAppendsStartedInCloseout: this.coverage.mergeAppendsStartedInCloseout,
      mergeAppendsCompletedAfterChurn: this.coverage.mergeAppendsCompletedAfterChurn,
      activeStart: this.activeStart,
      churnDeadline: this.churnDeadline,
      mergeDeadline: this.mergeDeadline,
      recoveryDeadline: this.recoveryDeadline,
      recoveryRemainingMs: this.recoveryDeadline - this.now(),
      churnEndedAt: this.churnEndedAt,
      churnElapsedMs:
        this.churnEndedAt === null || this.activeStart === null
          ? null
          : this.churnEndedAt - this.activeStart,
      mergeStartedAt: this.mergeStartedAt,
      mergeCompletedAt: this.mergeCompletedAt,
      mergeCloseoutElapsedMs:
        this.mergeCompletedAt === null ? null : this.mergeCompletedAt - this.churnDeadline
    })

    await this.finalRecovery()
    this.assertRecoveryWatchdogDidNotFire('final recovery')
    this.coverage.converged = true
    this.disarmRecoveryWatchdog()
    verifyPhaseCoverage(this.coverage)
  }

  startActiveWindow(activeStart) {
    this.activeStart = activeStart
    this.activeDeadline = activeStart + this.config.durationMs
    this.churnDeadline = this.activeDeadline
    this.mergeDeadline = this.activeDeadline + this.config.mergeCloseoutMs
    // Absolute end of the single shared post-churn drain allowance. The merge
    // closeout keeps its own earlier hard deadline inside it.
    this.recoveryDeadline = this.activeDeadline + this.config.drainAllowanceMs
    this.churnEndedAt = null
    this.mergeStartedAt = null
    this.mergeCompletedAt = null
  }

  async setupPeers() {
    this.admin = this.makeAuto('admin', path.join(this.root, 'admin'), null, {
      maxUntrustedWriters: 1024
    })
    await this.admin.ready()
    this.baseKey = this.admin.key
    this.adminKey = b4a.from(this.admin.local.key)
    this.adminKeyHex = b4a.toString(this.adminKey, 'hex')

    this.hub = this.makeAuto('hub', path.join(this.root, 'hub'), this.baseKey, {
      maxUntrustedWriters: 1024
    })
    await this.hub.ready()

    this.reference = this.makeAuto('reference', path.join(this.root, 'reference'), this.baseKey, {
      maxUntrustedWriters: 1024
    })
    await this.reference.ready()

    this.links.link(this.admin, this.hub, 'admin-hub')
    this.links.link(this.hub, this.reference, 'hub-reference')

    this.log('peers-ready', {
      admin: this.adminKeyHex.slice(0, 16),
      base: b4a.toString(this.baseKey, 'hex').slice(0, 16)
    })
  }

  readerOptions(name) {
    return {
      name,
      isTrusted: (key) => b4a.equals(key, this.adminKey),
      mostRecentTrusted: () => ({ key: this.adminKey, length: this.admin.local.length }),
      maxUntrustedWriters: this.config.readerCap,
      maxReclaimedWriters: this.config.maxReclaimedWriters,
      fastForward: false
    }
  }

  async startReader() {
    const storage = path.join(this.root, 'reader')
    this.reader = this.makeAuto('reader', storage, this.baseKey, this.readerOptions('reader'))
    await this.reader.ready()
    this.instrumentReader(this.reader)
    this.links.link(this.hub, this.reader, 'hub-reader')

    await this.wait(
      'reader applies the admin grant history',
      async () => {
        const info = await this.reader.system.get(this.adminKey)
        return {
          ok: !!info && info.length >= this.admin.local.length,
          admin: info ? info.length : 0,
          expected: this.admin.local.length
        }
      },
      60000
    )
  }

  async waitForAdminSync(label) {
    await this.wait(
      'hub/reference apply the admin grant history (' + label + ')',
      async () => {
        const hub = await this.hub.system.get(this.adminKey)
        const ref = await this.reference.system.get(this.adminKey)
        return {
          ok:
            !!hub &&
            hub.length >= this.admin.local.length &&
            !!ref &&
            ref.length >= this.admin.local.length,
          hub: hub ? hub.length : 0,
          reference: ref ? ref.length : 0,
          expected: this.admin.local.length
        }
      },
      60000
    )
  }

  async setupIdentities() {
    const cohortSize = this.config.pressureCohortSize
    const deadline = Date.now() + this.config.setupAllowanceMs

    for (let start = 0; start < this.config.writerCount; start += cohortSize) {
      const end = Math.min(start + cohortSize, this.config.writerCount)
      const indices = range(start, end)
      this.phase = 'setup-identities-' + start

      const leaves = await Promise.all(
        indices.map(async (index) => {
          const leaf = await this.openIdentity(index, { hubLink: true })
          return leaf
        })
      )

      const payloads = leaves.map((leaf) => ({
        addWriter: leaf.local.id,
        weight: 1,
        grant: true,
        soaksSetup: true
      }))
      await this.appendBatch(this.admin, 'admin', payloads, { kind: 'grant' })

      for (let i = 0; i < leaves.length; i++) {
        const leaf = leaves[i]
        const left = deadline - Date.now()
        if (left <= 0) {
          throw new Error('identity setup allowance exhausted before writer became writable')
        }
        await this.wait(
          'identity ' + indices[i] + ' writable',
          async () => {
            await leaf.update()
            return { ok: leaf.writable, index: indices[i] }
          },
          left
        )
      }

      for (let i = 0; i < leaves.length; i++) {
        await this.closeLeaf(indices[i])
      }

      this.log('identity-cohort-ready', {
        from: start,
        to: end - 1,
        grants: this.admin.local.length,
        elapsedMs: Date.now() - this.originalStart
      })
    }

    await this.waitForAdminSync('identity-setup')
    await this.wait(
      'hub knows every configured identity',
      async () => {
        const lengths = await readLengths(
          this.hub,
          this.identityKeys.map((key) => b4a.toString(key, 'hex'))
        )
        const missing = []
        for (let i = 0; i < this.identityKeys.length; i++) {
          const key = b4a.toString(this.identityKeys[i], 'hex')
          if (!lengths.has(key)) missing.push(i)
        }
        return { ok: missing.length === 0, missing: missing.slice(0, 8) }
      },
      60000
    )
  }

  async openIdentity(index, { hubLink }) {
    const storage = path.join(this.root, 'w' + String(index).padStart(3, '0'))
    const leaf = this.makeAuto('w' + index, storage, this.baseKey, {
      maxUntrustedWriters: 1024
    })
    await leaf.ready()

    const expected = this.identityKeys[index]
    if (expected && !b4a.equals(expected, leaf.local.key)) {
      throw new Error(
        'identity ' + index + ' reopened with a different local key; refusing to recreate it'
      )
    }
    if (!expected) this.identityKeys[index] = b4a.from(leaf.local.key)

    leaf._soakIndex = index
    this.liveLeaves.set(index, leaf)
    this.checkBoundaries('leaf-open')

    if (hubLink) {
      this.links.link(leaf, this.hub, 'hub-w' + index)
      this.leaves.set(index, 'hub-w' + index)
    }

    return leaf
  }

  async closeLeaf(index, { timeoutMs = 20000 } = {}) {
    const leaf = this.liveLeaves.get(index)
    if (!leaf) return

    const label = this.leaves.get(index)
    if (label) await this.links.unlink(label)
    this.leaves.delete(index)

    // A caller computes its own bound before this method starts, but unlink
    // can consume most or all of it. Recompute from the absolute recovery
    // deadline after unlink so the close cannot spend a stale allowance.
    const closeTimeoutMs =
      this.recoveryDeadline === null
        ? timeoutMs
        : Math.min(timeoutMs, this.recoveryRemaining('leaf ' + index + ' close'))

    await withTimeout(leaf.close(), closeTimeoutMs, 'leaf close timed out')
    this.liveLeaves.delete(index)
  }

  async runPressurePhase() {
    this.phase = 'pressure'
    this.recordPhase('pressure-eviction')
    const cap = this.config.readerCap
    const pressureIndices = range(0, cap)
    const victimIndices = pressureIndices.slice(1, cap - 1)
    const residentIndex = pressureIndices[0]
    const sourceIndex = pressureIndices[cap - 1]

    this.log('pressure-start', {
      resident: residentIndex,
      victims: victimIndices,
      source: sourceIndex,
      cap
    })

    const resident = await this.openIdentity(residentIndex, { hubLink: true })

    // Let the resident apply the current trusted head first. Its first block
    // then merges that grant head, so the trusted admin session is no longer a
    // logical head and releases its slot before the untrusted pressure fill.
    await this.wait(
      'resident applies the current trusted admin head',
      async () => {
        await resident.update()
        const info = await resident.system.get(this.adminKey)
        return {
          ok: !!info && info.length >= this.admin.local.length && resident.writable,
          applied: info ? info.length : 0,
          expected: this.admin.local.length
        }
      },
      30000
    )

    await this.appendBatch(
      resident,
      'w' + residentIndex,
      [
        {
          op: 'pressure-resident-head',
          resident: residentIndex,
          seq: 1,
          nonce: this.rng.int(1, 1e9)
        }
      ],
      { kind: 'pressure-head', identityIndex: residentIndex }
    )

    await this.wait(
      'reader merges the admin head and admits the resident head',
      async () => {
        const info = await this.reader.system.get(resident.local.key)
        const adminActive = this.reader.writers.has(this.adminKeyHex)
        return {
          ok:
            this.reader.writers.has(b4a.toString(resident.local.key, 'hex')) &&
            !!info &&
            info.length >= 1 &&
            this.reader.writers.active.size === 2 &&
            !adminActive,
          active: this.reader.writers.active.size,
          adminActive,
          applied: info ? info.length : 0
        }
      },
      45000
    )

    const victims = []
    for (const index of victimIndices) {
      const victim = await this.openIdentity(index, { hubLink: false })
      await victim.update()
      await this.appendBatch(
        victim,
        'w' + index,
        [
          {
            op: 'pressure-victim-head',
            victim: index,
            seq: 1,
            nonce: this.rng.int(1, 1e9)
          }
        ],
        { kind: 'pressure-head', identityIndex: index }
      )
      this.links.link(victim, this.hub, 'hub-w' + index)
      this.leaves.set(index, 'hub-w' + index)
      victims.push(victim)
      this.victims.set(b4a.toString(victim.local.key, 'hex'), victim)

      await this.wait(
        'reader admits idle victim ' + index,
        async () => {
          const info = await this.reader.system.get(victim.local.key)
          return {
            ok:
              this.reader.writers.has(b4a.toString(victim.local.key, 'hex')) &&
              !!info &&
              info.length >= 1,
            active: this.reader.writers.active.size,
            applied: info ? info.length : 0
          }
        },
        30000
      )
    }

    await this.wait(
      'reader session cap is fully occupied by idle logical heads',
      () => {
        const active = this.reader.writers.active.size
        const idle = [...this.reader.writers.active.values()].filter(
          (writer) => writer !== this.reader.writers.localWriter && !writer.isPending
        )
        return {
          ok: active === cap && idle.length === cap - 1,
          active,
          idle: idle.length,
          cap
        }
      },
      30000
    )
    this.takeSample('cap-full', { eventCap: cap, eventIdleVictims: cap - 2 })

    const source = await this.openIdentity(sourceIndex, { hubLink: false })
    await source.update()
    await this.appendBatch(
      source,
      'w' + sourceIndex,
      [{ op: 'pressure-source', source: sourceIndex, seq: 1, nonce: this.rng.int(1, 1e9) }],
      { kind: 'pressure-source', identityIndex: sourceIndex }
    )
    this.links.link(source, resident, 'source-resident-' + sourceIndex)
    this.leaves.set(sourceIndex, 'source-resident-' + sourceIndex)

    await this.wait(
      'resident applies the hidden source head',
      async () => {
        const info = await resident.system.get(source.local.key)
        return { ok: !!info && info.length >= 1, applied: info ? info.length : 0 }
      },
      30000
    )

    const flushGate = createGate()
    this.pressureFlushGate = flushGate
    this.pressureFlushArmedEvictions = this.events.evictions
    const beforeEvictions = this.events.evictions
    let victimRecord = null
    let victimLeaf = null
    let proofError = null

    try {
      // R@2 links the hidden source as a real dependency. The reader first has
      // to evict an idle head to admit the source. The hint-flush gate below
      // pauses the drain after that eviction, while the cap is still full.
      await this.appendBatch(
        resident,
        'w' + residentIndex,
        [
          {
            op: 'pressure-resident',
            resident: residentIndex,
            seq: 2,
            nonce: this.rng.int(1, 1e9)
          }
        ],
        { kind: 'pressure-resident', identityIndex: residentIndex }
      )

      const evicted = await this.wait(
        'a real pressure eviction reserves a record',
        () => {
          const records = [...this.reader.writers._reclaimed.entries()]
          return {
            ok: this.events.evictions > beforeEvictions && records.length >= 1,
            evictions: this.events.evictions,
            records: records.map(([id, record]) => ({ id, length: record.length }))
          }
        },
        30000
      )

      victimRecord = evicted.records[0]
      if (!victimRecord) throw new Error('the pressure eviction did not reserve a record')

      this.pressureVictimId = victimRecord.id
      victimLeaf = this.victims.get(victimRecord.id)
      if (!victimLeaf) {
        throw new Error(
          'the evicted id ' + victimRecord.id + ' is not one of the live idle victim leaves'
        )
      }

      await this.wait(
        'the post-eviction hint flush is held while the cap is full',
        () => ({ ok: flushGate.reached === true, reached: flushGate.reached === true }),
        15000
      )

      const activeBefore = this.reader.writers.active.size
      if (activeBefore !== cap) {
        throw new Error(
          'reader cap moved during the pressure proof: ' + activeBefore + ' != ' + cap
        )
      }
      if (this.reader.writers.has(victimRecord.id)) {
        throw new Error('the evicted victim session is still admitted')
      }

      this.coverage.actualEvictions++
      this.coverage.reservedRecords++
      this.coverage.dependencyEvictions++

      await this.appendBatch(
        victimLeaf,
        'w' + victimLeaf._soakIndex,
        [
          {
            op: 'victim-tail',
            victim: victimLeaf._soakIndex,
            seq: 2,
            nonce: this.rng.int(1, 1e9)
          }
        ],
        { kind: 'victim-tail', identityIndex: victimLeaf._soakIndex }
      )

      await this.wait(
        'the refused positive tail is captured as a length-2 obligation',
        () => {
          const record = this.reader.writers._reclaimed.get(victimRecord.id)
          return {
            ok:
              !!record &&
              record.length === 2 &&
              !this.reader.writers.has(victimRecord.id) &&
              this.events.capturedPositive >= 1,
            length: record ? record.length : null,
            captured: this.events.capturedPositive,
            active: this.reader.writers.active.size
          }
        },
        30000
      )

      // Isolate the actual announcer before the flush gate opens. The remembered
      // length-2 obligation is already captured; set the baseline now, before
      // any coalescing or wakeup can run, and enforce it throughout the proof.
      // The edge is reconnected after proof.
      this.beginVictimIsolation(victimRecord.id)
      const victimLabel = 'hub-w' + victimLeaf._soakIndex
      if (this.links.has(victimLabel)) {
        await this.links.unlink(victimLabel)
        this.leaves.delete(victimLeaf._soakIndex)
      }
      this.coverage.victimAnnouncerIsolated = true
      this.log('pressure-victim-isolated', {
        victim: victimRecord.id.slice(0, 16),
        baseline: this.events.victimIsolationBaselineLength,
        wakeupCalls: this.events.victimWakeupCalls,
        isolated: !this.links.has(victimLabel)
      })

      this.readerManualCalls.finalRetryStart = Date.now()
    } catch (err) {
      proofError = err
    } finally {
      this.releasePressureFlushGate()
      flushGate.resolve()
    }

    if (proofError) throw proofError

    const recovered = await this.wait(
      'the refused tail is refused again and then autonomously retried',
      async () => {
        const baselineBefore = this.checkVictimIsolationBaseline()
        const info = await this.reader.system.get(b4a.from(victimRecord.id, 'hex'))
        const baselineAfter = this.checkVictimIsolationBaseline()
        const record = this.reader.writers._reclaimed.get(victimRecord.id)
        const active = this.reader.writers.has(victimRecord.id)
        return {
          ok:
            baselineBefore &&
            baselineAfter &&
            !!info &&
            info.length === 2 &&
            !record &&
            active &&
            this.events.deniedPositiveTail >= 1 &&
            this.events.victimRetryAdmissions >= 1 &&
            this.events.victimRetryHandoffs >= 1 &&
            this.events.victimRetryHandoffLength2 >= 1 &&
            this.events.victimNonRetryAdmissions === 0 &&
            this.events.victimFreshIngressAfterIsolation === 0 &&
            this.events.victimMaxLossAfterIsolation === 0,
          applied: info ? info.length : 0,
          record: record ? record.length : null,
          active,
          denied: this.events.deniedPositiveTail,
          handoffs: this.events.victimHandoffs,
          opened: this.events.victimOpened,
          retryAdmissions: this.events.victimRetryAdmissions,
          nonRetryAdmissions: this.events.victimNonRetryAdmissions,
          retryHandoffs: this.events.victimRetryHandoffs,
          retryHandoffLength2: this.events.victimRetryHandoffLength2,
          wakeupsAfterIsolation: this.events.victimWakeupsAfterIsolation,
          freshIngressAfterIsolation: this.events.victimFreshIngressAfterIsolation,
          maxLossAfterIsolation: this.events.victimMaxLossAfterIsolation,
          queuedRestoresAfterIsolation: this.events.victimQueuedRestoresAfterIsolation,
          retryDepth: this.reader.writers._retryDepth || 0
        }
      },
      45000
    )

    this.finishVictimIsolationProof()
    this.coverage.recoveredPositiveTails++
    this.coverage.handoffs += recovered.handoffs
    this.coverage.victimRetryAdmissions = this.events.victimRetryAdmissions
    this.coverage.victimRetryHandoffs = this.events.victimRetryHandoffs
    this.coverage.victimRetryHandoffLength2 = this.events.victimRetryHandoffLength2
    this.coverage.victimHandoffLength2 = this.events.victimHandoffLength2
    this.coverage.victimNonRetryAdmissions = this.events.victimNonRetryAdmissions
    this.recordPhase('positive-tail-retry')
    this.coverage.refusedPositiveTails++
    this.coverage.deniedWakeups += this.events.deniedByCap

    const reconnectedLabel = 'hub-w' + victimLeaf._soakIndex
    if (!this.links.has(reconnectedLabel)) {
      this.links.link(victimLeaf, this.hub, reconnectedLabel)
      this.leaves.set(victimLeaf._soakIndex, reconnectedLabel)
      this.log('pressure-victim-reconnected', {
        victim: victimRecord.id.slice(0, 16),
        note: 'reconnected only after the autonomous retry proof'
      })
    }

    const victimKeyHex = b4a.toString(b4a.from(victimRecord.id, 'hex'), 'hex')
    const victimRef = victimKeyHex + '.2'
    const residentRef = b4a.toString(resident.local.key, 'hex') + '.2'
    const sourceRef = b4a.toString(source.local.key, 'hex') + '.1'

    await this.wait(
      'the applied view contains the recovered pressure proofs',
      async () => {
        const history = await readAppliedHistory(this.reader)
        return {
          ok:
            history.includes(victimRef) &&
            history.includes(residentRef) &&
            history.includes(sourceRef),
          entries: history.length
        }
      },
      30000
    )

    this.log('pressure-proof', {
      victim: victimRecord.id.slice(0, 16),
      recordLength: 2,
      denied: this.events.deniedPositiveTail,
      handoffs: this.events.victimHandoffs,
      retryHandoffs: this.events.victimRetryHandoffs,
      retryHandoffLength2: this.events.victimRetryHandoffLength2,
      retryAdmissions: this.events.victimRetryAdmissions,
      nonRetryAdmissions: this.events.victimNonRetryAdmissions,
      wakeupsAfterIsolation: this.events.victimWakeupsAfterIsolation,
      positiveAdvancesAfterIsolation: this.events.victimPositiveAdvancesAfterIsolation,
      refs: { victimRef, residentRef, sourceRef }
    })

    for (const index of pressureIndices) {
      await this.closeLeaf(index)
    }

    await this.wait(
      'hub and reference receive every pressure-cohort tail',
      async () => {
        const keys = pressureIndices.map((i) => this.identityKeys[i])
        const hubLengths = await readLengths(this.hub, keys)
        const refLengths = await readLengths(this.reference, keys)
        const missing = []
        for (const key of keys) {
          const hex = b4a.toString(key, 'hex')
          const ack = this.ledger.ack.get(hex) || 0
          if ((hubLengths.get(hex) || 0) < ack) missing.push('hub ' + hex.slice(0, 8))
          if ((refLengths.get(hex) || 0) < ack) missing.push('ref ' + hex.slice(0, 8))
        }
        return { ok: missing.length === 0, missing: missing.slice(0, 8) }
      },
      60000
    )

    await this.checkpoint('pressure')
  }

  async runRegularCohorts() {
    this.recordPhase('cohort-churn')
    const indices = range(this.config.pressureCohortSize, this.config.writerCount)
    const cohortSize = this.config.regularCohortSize
    const cohorts = []
    for (let start = 0; start < indices.length; start += cohortSize) {
      cohorts.push(indices.slice(start, start + cohortSize))
    }

    if (cohorts.length === 0) {
      throw new PhaseError('no regular identities remain after the pressure cohort')
    }

    const churnDeadline = this.churnDeadline
    const initialRemaining = churnDeadline - this.now()
    if (initialRemaining < cohorts.length * 1000) {
      throw new PhaseError(
        'active duration is too short for ' +
          cohorts.length +
          ' regular cohorts after the pressure phase; choose a longer SOAK_DURATION_MS'
      )
    }

    let readerRestartDone = false
    let writerRestartDone = false
    let readerPartitionDone = false

    for (let i = 0; i < cohorts.length; i++) {
      const last = i === cohorts.length - 1
      const cohortsLeft = cohorts.length - i
      const remaining = churnDeadline - this.now()
      const fair = Math.floor(remaining / cohortsLeft)
      // Recompute every slice from what is actually left. The last slice churns
      // to the full configured cutoff; its final administrative merge may then
      // use the bounded closeout.
      const cohortEnd = last
        ? churnDeadline
        : Math.min(churnDeadline, this.now() + Math.max(2000, fair))
      if (!last && cohortEnd - this.now() < 2000) {
        throw new PhaseError('regular cohort ' + i + ' has no active window left')
      }

      const plan = {
        isLast: last,
        readerRestart: !readerRestartDone,
        writerRestart: !writerRestartDone,
        readerPartition: !readerPartitionDone,
        writerPartition: true
      }

      const result = await this.runCohort(i, cohorts[i], cohortEnd, plan)
      if (result.readerRestartDone) readerRestartDone = true
      if (result.writerRestartDone) writerRestartDone = true
      if (result.readerPartitionDone) readerPartitionDone = true
    }

    if (!this.coverage.readerRestart) throw new PhaseError('reader restart phase did not run')
    if (!this.coverage.writerRestart) throw new PhaseError('writer restart phase did not run')
    if (!this.coverage.partitions) throw new PhaseError('partition phase did not run')
    if (!this.coverage.reconnects) throw new PhaseError('reconnect phase did not run')
  }

  async runCohort(number, indices, endAt, plan) {
    this.phase = 'cohort-' + number
    this.log('cohort-start', { number, indices, endAt, plan })

    const leaves = await Promise.all(
      indices.map((index) => this.openIdentity(index, { hubLink: true }))
    )

    for (let i = 0; i < leaves.length; i++) {
      const leaf = leaves[i]
      await this.wait(
        'cohort writer ' + indices[i] + ' writable',
        async () => {
          await leaf.update()
          return { ok: leaf.writable, index: indices[i] }
        },
        60000
      )
    }

    if (Date.now() >= endAt) {
      // The configured duration is the full workload period. The last cohort
      // may not author its first round after that period just to keep the
      // schedule alive; an exhausted schedule fails clearly instead.
      throw new PhaseError(
        'cohort ' +
          number +
          (plan.isLast ? ' (final)' : '') +
          ' opened after its workload window ended; choose a longer SOAK_DURATION_MS'
      )
    }

    const started = Date.now()
    const total = Math.max(1, endAt - started)
    let round = 0
    let readerRestartDone = false
    let writerRestartDone = false
    let readerPartitionDone = false
    let writerPartitionDone = false

    // Every configured identity must actually author at least one accepted
    // operation before a slice can end. A first round that expires partway has
    // not met that obligation, so a stop there is never a graceful close.
    const firstRound = await this.authorCohortRound(leaves, indices, number, ++round)
    if (firstRound && firstRound.stopped) {
      this.cutoffStopAllowed(firstRound, number, indices, plan)
    }

    const steps = [
      { at: 0.3, kind: 'reader-restart' },
      { at: 0.45, kind: 'writer-partition' },
      { at: 0.6, kind: 'writer-restart' },
      { at: 0.75, kind: 'reader-partition' }
    ]

    while (Date.now() < endAt) {
      this.phase = 'cohort-' + number
      const elapsed = (Date.now() - started) / total

      for (const step of steps) {
        if (
          step.kind === 'reader-restart' &&
          plan.readerRestart &&
          !readerRestartDone &&
          elapsed >= step.at
        ) {
          await this.restartReader()
          readerRestartDone = true
          break
        }
        if (
          step.kind === 'writer-partition' &&
          plan.writerPartition &&
          !writerPartitionDone &&
          elapsed >= step.at
        ) {
          await this.partitionWriterEdge(leaves)
          this.coverage.partitions++
          this.coverage.reconnects++
          writerPartitionDone = true
          break
        }
        if (
          step.kind === 'writer-restart' &&
          plan.writerRestart &&
          !writerRestartDone &&
          elapsed >= step.at
        ) {
          await this.restartWriter(leaves, indices)
          writerRestartDone = true
          break
        }
        if (
          step.kind === 'reader-partition' &&
          plan.readerPartition &&
          !readerPartitionDone &&
          elapsed >= step.at
        ) {
          await this.partitionReaderEdge()
          readerPartitionDone = true
          break
        }
      }

      if (this.asyncError) this.throwIfAsyncError()
      this.checkBounds()
      if (Date.now() >= endAt) break

      const roundResult = await this.authorCohortRound(leaves, indices, number, ++round)
      if (this.cutoffStopAllowed(roundResult, number, indices, plan)) break
      // Keep a real active workload for the whole slice without growing the
      // applied history so fast that later cohort boots pay minutes of replay.
      const pause =
        round <= 3
          ? Math.min(250, Math.max(20, this.rng.int(40, 200)))
          : Math.min(4000, Math.max(2000, this.rng.int(2000, 3500)))
      await sleep(pause)
    }

    if (plan.isLast) {
      this.churnEndedAt = Date.now()
      this.log('churn-window-elapsed', {
        number,
        activeStart: this.activeStart,
        churnDeadline: this.churnDeadline,
        churnElapsedMs: this.activeStart === null ? null : this.churnEndedAt - this.activeStart,
        configuredDurationMs: this.config.durationMs
      })
    }

    if (!writerRestartDone && plan.writerRestart) {
      await this.restartWriter(leaves, indices)
      writerRestartDone = true
    }
    if (!readerPartitionDone && plan.readerPartition) {
      await this.partitionReaderEdge()
      readerPartitionDone = true
    }
    if (!writerPartitionDone && plan.writerPartition) {
      await this.partitionWriterEdge(leaves)
      this.coverage.partitions++
      this.coverage.reconnects++
      writerPartitionDone = true
    }

    // Stop active workload before the close/merge barrier. This stays a cohort
    // close phase even for the last cohort: workload appends are gated by the
    // churn cutoff, and only the final administrative merge may use the
    // explicitly bounded closeout.
    this.phase = 'cohort-' + number + '-close'
    await this.wait(
      'hub receives the cohort tail lengths',
      async () => {
        const keys = indices.map((i) => this.identityKeys[i])
        const lengths = await readLengths(this.hub, keys)
        const missing = []
        for (const key of keys) {
          const hex = b4a.toString(key, 'hex')
          const ack = this.ledger.ack.get(hex) || 0
          if ((lengths.get(hex) || 0) < ack) missing.push(hex.slice(0, 8))
        }
        return { ok: missing.length === 0, missing: missing.slice(0, 8) }
      },
      30000
    )

    const closer = leaves[0]
    await this.wait(
      'cohort closer observes every hub head',
      async () => {
        await closer.update()
        const heads = this.hub.system.heads
        const missing = []
        for (const head of heads) {
          const info = await closer.system.get(head.key)
          if (!info || info.length < head.length) {
            missing.push(b4a.toString(head.key, 'hex').slice(0, 8))
          }
        }
        return { ok: missing.length === 0, missing: missing.slice(0, 8), heads: heads.length }
      },
      60000
    )

    // Awaited update/prepare above may have crossed the churn cutoff. Check
    // again synchronously, using the actual payload kind: workload merges must
    // start before the cutoff, and only the final administrative merge may use
    // the bounded closeout. Data recovery starts only after that merge.
    const mergePayload = [
      {
        op: plan.isLast ? 'final-merge' : 'cohort-close',
        cohort: number,
        closer: indices[0],
        final: plan.isLast,
        nonce: this.rng.int(1, 1e9)
      }
    ]
    const mergeMeta = {
      kind: plan.isLast ? 'final-merge' : 'cohort-close',
      identityIndex: indices[0]
    }
    this.assertAppendAllowed('cohort-' + number + '-merge', mergePayload, mergeMeta)

    await this.appendBatch(closer, 'w' + indices[0], mergePayload, mergeMeta)

    // The merge closeout, its propagation, the leaf closes and the checkpoint
    // all spend the same absolute post-churn drain allowance. Each await is
    // bounded by what is actually left of it, not by a fresh phase budget.
    const propagationLabel = 'cohort ' + number + ' merge propagation'
    await this.recoveryAwait(
      propagationLabel,
      this.wait(
        'hub and reference receive the cohort merge',
        async () => {
          const keys = indices.map((i) => this.identityKeys[i])
          const hubLengths = await readLengths(this.hub, keys)
          const refLengths = await readLengths(this.reference, keys)
          const missing = []
          for (const key of keys) {
            const hex = b4a.toString(key, 'hex')
            const ack = this.ledger.ack.get(hex) || 0
            if ((hubLengths.get(hex) || 0) < ack) missing.push('hub ' + hex.slice(0, 8))
            if ((refLengths.get(hex) || 0) < ack) missing.push('ref ' + hex.slice(0, 8))
          }
          return { ok: missing.length === 0, missing: missing.slice(0, 8) }
        },
        this.recoveryBound(propagationLabel, 60000)
      )
    )

    for (const index of indices) {
      const closeLabel = 'closing cohort ' + number + ' leaves'
      await this.closeLeaf(index, { timeoutMs: this.recoveryBound(closeLabel, 20000) })
    }

    await this.checkpoint('cohort-' + number)

    this.log('cohort-complete', {
      number,
      rounds: round,
      authored: this.authored.size,
      elapsedMs: Date.now() - started
    })

    return { readerRestartDone, writerRestartDone, readerPartitionDone }
  }

  // A stopped round reports the fact to its caller instead of throwing. The
  // caller alone decides whether the existing closeout may follow. Update and
  // append failures, acknowledgement mismatches and every other PhaseError
  // still propagate from here.
  async authorCohortRound(leaves, indices, number, round) {
    for (let i = 0; i < leaves.length; i++) {
      const leaf = leaves[i]
      await leaf.update()

      try {
        this.assertAppendAllowed('cohort-' + number + '-round-' + round)
        await this.appendBatch(
          leaf,
          'w' + indices[i],
          [
            {
              op: 'cohort',
              cohort: number,
              writer: indices[i],
              round,
              nonce: this.rng.int(1, 1e9)
            }
          ],
          { kind: 'churn', identityIndex: indices[i] }
        )
      } catch (err) {
        // Covers both the caller-side check and the synchronous appendBatch
        // re-check, closing the guard-to-guard timing gap without softening
        // any other failure.
        if (!(err instanceof WorkloadCutoff)) throw err
        return { completed: false, stopped: true, round, authored: i }
      }
    }

    return { completed: true, stopped: false, round, authored: leaves.length }
  }

  // Only the final cohort may convert a cutoff stop into the existing bounded
  // final merge/checkpoint closeout. A non-final cohort that exhausts the
  // global workload would otherwise silently waive the cohorts still to run,
  // and a partial first round would waive mandatory identity coverage.
  cutoffStopAllowed(result, number, indices, plan) {
    if (!result || !result.stopped) return false

    if (!plan.isLast) {
      throw new PhaseError(
        'cohort ' +
          number +
          ' stopped at the churn cutoff before the final cohort; the remaining regular cohorts cannot be waived'
      )
    }

    if (result.round === 1 && result.authored < indices.length) {
      throw new PhaseError(
        'cohort ' +
          number +
          ' first workload round stopped at the churn cutoff before every configured identity authored; a partial first round is not a graceful stop'
      )
    }

    return true
  }

  // -------------------------------------------------------------------------
  // real reconnects/restarts

  async restartReader() {
    this.phase = 'reader-restart'
    const old = this.reader
    const oldKey = b4a.from(old.local.key)

    await this.links.unlink('hub-reader')
    await withTimeout(old.close(), 30000, 'reader close timed out')

    if (old.writers._reclaimed.size !== 0) {
      throw new Error('reader close did not clear the in-memory reclaimed ledger')
    }

    const replacement = this.makeAuto(
      'reader-restart',
      path.join(this.root, 'reader'),
      this.baseKey,
      this.readerOptions('reader-restart')
    )
    await replacement.ready()
    this.instrumentReader(replacement)

    if (!b4a.equals(replacement.local.key, oldKey)) {
      throw new Error('reader restart recreated a different local identity')
    }
    if (replacement.writers._reclaimed.size !== 0) {
      throw new Error('reopened reader did not start with an empty reclaimed ledger')
    }

    this.reader = replacement
    this.links.link(this.hub, this.reader, 'hub-reader')

    await this.wait(
      'restarted reader applies the current trusted head',
      async () => {
        const info = await this.reader.system.get(this.adminKey)
        return {
          ok: !!info && info.length >= this.admin.local.length,
          applied: info ? info.length : 0
        }
      },
      60000
    )

    this.coverage.readerRestart = true
    this.coverage.readerRestartLedgerEmpty = true
    this.recordPhase('reader-restart')
    this.log('reader-restarted', { key: b4a.toString(oldKey, 'hex').slice(0, 16) })
  }

  async restartWriter(leaves, indices) {
    this.phase = 'writer-restart'
    let target = leaves.length - 1
    if (target === 0) target = 1
    if (target < 0) throw new PhaseError('no writer is available to restart')

    const index = indices[target]
    const old = leaves[target]
    const oldKey = b4a.from(old.local.key)

    await this.links.unlink('hub-w' + index)
    await withTimeout(old.close(), 30000, 'writer close timed out')
    this.liveLeaves.delete(index)
    this.leaves.delete(index)

    const replacement = await this.openIdentity(index, { hubLink: true })

    if (!b4a.equals(replacement.local.key, oldKey)) {
      throw new Error('writer restart recreated a different identity')
    }

    await this.wait(
      'restarted writer is writable again',
      async () => {
        await replacement.update()
        return { ok: replacement.writable, index }
      },
      60000
    )

    leaves[target] = replacement
    this.coverage.writerRestart = true
    this.coverage.writerRestartSameIdentity = true
    this.recordPhase('writer-restart')
    this.log('writer-restarted', { index, key: b4a.toString(oldKey, 'hex').slice(0, 16) })
    return leaves
  }

  async partitionWriterEdge(leaves) {
    this.phase = 'partition-writer'
    const candidate = leaves.length > 1 ? this.rng.int(1, leaves.length - 1) : 0
    const index = leaves[candidate]._soakIndex
    const label = 'hub-w' + index
    if (!this.links.has(label)) return

    await this.links.unlink(label)
    await sleep(Math.min(1500, Math.max(250, this.rng.int(300, 1200))))
    this.links.link(leaves[candidate], this.hub, label)
    this.log('writer-edge-reconnected', { candidate, index })
  }

  async partitionReaderEdge() {
    this.phase = 'partition-reader'
    if (!this.links.has('hub-reader')) return

    await this.links.unlink('hub-reader')
    const started = Date.now()
    await sleep(Math.min(1500, Math.max(250, this.rng.int(300, 1200))))

    this.checkBoundaries('reader-partition')
    if (this.reader.writers.active.size > this.config.readerCap) {
      throw new Error('reader active sessions exceeded the cap during the partition')
    }
    if (this.reader.writers._reclaimed.size > this.config.maxReclaimedWriters) {
      throw new Error('reader ledger exceeded its budget during the partition')
    }

    this.links.link(this.hub, this.reader, 'hub-reader')
    this.coverage.partitions++
    this.coverage.reconnects++
    this.recordPhase('partition-reconnect')
    this.log('reader-edge-reconnected', { partitionedMs: Date.now() - started })
  }

  // -------------------------------------------------------------------------
  // final oracle

  async finalRecovery() {
    // This phase spends whatever is left of the single absolute post-churn
    // deadline armed at the churn cutoff. It never starts a fresh drain
    // allowance, even when the merge, propagation, leaf closes or a checkpoint
    // already used part (or all) of it.
    const deadline = this.recoveryDeadline
    let last = null

    this.assertRecoveryWatchdogDidNotFire('final recovery')
    this.recoveryRemaining('final recovery')

    while (this.now() < deadline) {
      this.throwIfAsyncError()
      this.checkBounds()

      last = await withTimeout(
        this.tryVerify(),
        this.recoveryRemaining('final recovery verification'),
        'final recovery verification did not settle inside the shared post-churn recovery deadline'
      )

      if (last.ok) {
        const stable = await withTimeout(
          sleep(250).then(() => this.tryVerify()),
          this.recoveryRemaining('final recovery stability check'),
          'final recovery stability check did not settle inside the shared post-churn recovery deadline'
        )
        if (stable.ok) {
          // A verification that settled after the absolute deadline must never
          // be declared as a pass, even though its own reads succeeded.
          this.assertRecoveryWatchdogDidNotFire('final recovery')
          this.recoveryRemaining('final recovery')
          this.coverage.converged = true
          this.coverage.settledCheckpoints++
          this.recordPhase('final-recovery')
          this.log('final-recovery', { entries: stable.entries })
          return stable
        }
      }

      await sleep(200)
    }

    throw new OracleError(
      'final recovery did not converge before the shared post-churn recovery deadline: ' +
        serialize(last)
    )
  }

  async checkpoint(label) {
    const ownDeadline = this.now() + 45000
    const deadline =
      this.recoveryDeadline === null ? ownDeadline : Math.min(ownDeadline, this.recoveryDeadline)
    let last = null

    while (this.now() < deadline) {
      this.throwIfAsyncError()
      this.checkBounds()
      last = await withTimeout(
        this.tryVerify(),
        Math.max(1, deadline - this.now()),
        'settled checkpoint ' + label + ' verification did not settle before its deadline'
      )

      if (last.ok) {
        // Recheck the absolute recovery deadline after the await: a checkpoint
        // that settled late cannot declare a pass from spent allowance.
        this.recoveryRemaining('settled checkpoint ' + label)
        this.coverage.settledCheckpoints++
        this.recordPhase('settled-checkpoint')
        this.log('checkpoint', { label, entries: last.entries })
        return last
      }

      await sleep(100)
    }

    throw new OracleError('settled checkpoint ' + label + ' failed: ' + serialize(last))
  }

  async tryVerify() {
    const identities = [...this.identityKeys, this.adminKey]
    const referenceHistory = await readAppliedHistory(this.reference)
    const readerHistory = await readAppliedHistory(this.reader)
    const referenceLengths = await readLengths(this.reference, identities)
    const readerLengths = await readLengths(this.reader, identities)
    const referenceLatest = await this.reference.view.get(LATEST)
    const readerLatest = await this.reader.view.get(LATEST)
    const referenceClock = await this.reference.view.get(CLOCK)
    const readerClock = await this.reader.view.get(CLOCK)

    let verification = null
    let applicationState = null
    let verificationError = null
    try {
      verification = verifyFinalState({
        ledger: this.ledger,
        reference: { history: referenceHistory, lengths: referenceLengths },
        reader: { history: readerHistory, lengths: readerLengths },
        identities: identities.map((key) => b4a.toString(key, 'hex'))
      })
      applicationState = verifyApplicationState({
        referenceLatest,
        readerLatest,
        referenceClock,
        readerClock,
        entries: verification.entries
      })
    } catch (err) {
      verificationError = err
      applicationState = null
    }

    return {
      ok: verificationError === null,
      entries: referenceHistory.length,
      referenceEntries: referenceHistory.length,
      readerEntries: readerHistory.length,
      expected: this.ledger.expected.size,
      verification,
      applicationState,
      error: verificationError ? verificationError.message : null,
      readerActive: this.reader.writers.active.size,
      readerRecords: this.reader.writers._reclaimed.size
    }
  }

  assertAllIdentitiesAuthored() {
    const missing = []
    for (let i = 0; i < this.config.writerCount; i++) {
      if (!this.authored.has(i)) missing.push(i)
    }

    if (missing.length > 0) {
      throw new PhaseError(
        'configured identities never authored an operation: ' + missing.join(',')
      )
    }

    this.coverage.allIdentitiesAuthored = true
    this.log('identities-authored', { count: this.authored.size })
  }

  // -------------------------------------------------------------------------
  // saturation

  async runSaturation() {
    this.phase = 'saturation'
    this.originalStart = Date.now()
    this.startSampler()

    await this.setupPeers()
    await this.setupSaturationIdentities()

    this.reader = this.makeAuto(
      'saturation-reader',
      path.join(this.root, 'reader'),
      this.baseKey,
      this.readerOptions('saturation-reader')
    )
    await this.reader.ready()
    this.instrumentReader(this.reader)
    this.links.link(this.hub, this.reader, 'hub-reader')
    await this.waitForSaturationReader()

    const cap = this.config.readerCap
    const residentIndex = 0
    const victimIndices = [1, 2]
    const sourceIndex = 3
    const lateIndex = 4
    const lateSourceIndex = 5

    // R is admitted first, then disconnected from the hub so R@2 can be authored
    // without learning the victims' heads. That keeps the evicted victim a
    // logical head, so its record is retained rather than cleaned as merged.
    const resident = await this.openIdentity(residentIndex, { hubLink: true })
    await this.wait(
      'saturation resident applies the trusted admin head',
      async () => {
        await resident.update()
        const info = await resident.system.get(this.adminKey)
        return { ok: !!info && info.length >= this.admin.local.length && resident.writable }
      },
      30000
    )

    await this.appendBatch(
      resident,
      'w' + residentIndex,
      [{ op: 'saturation-resident-head', seq: 1, nonce: this.rng.int(1, 1e9) }],
      { kind: 'saturation-head', identityIndex: residentIndex }
    )

    await this.wait(
      'saturation resident merges admin and is admitted',
      () => ({
        ok:
          this.reader.writers.has(b4a.toString(resident.local.key, 'hex')) &&
          this.reader.writers.active.size === 2 &&
          !this.reader.writers.has(this.adminKeyHex)
      }),
      45000
    )

    await this.links.unlink('hub-w' + residentIndex)

    const source = await this.openIdentity(sourceIndex, { hubLink: false })
    await this.appendBatch(
      source,
      'w' + sourceIndex,
      [{ op: 'saturation-source', seq: 1, nonce: this.rng.int(1, 1e9) }],
      { kind: 'saturation-source', identityIndex: sourceIndex }
    )
    this.links.link(source, resident, 'source-resident-' + sourceIndex)
    this.leaves.set(sourceIndex, 'source-resident-' + sourceIndex)
    await this.wait(
      'saturation resident sees the hidden source',
      async () => {
        const info = await resident.system.get(source.local.key)
        return { ok: !!info && info.length >= 1 }
      },
      30000
    )

    await this.appendBatch(
      resident,
      'w' + residentIndex,
      [{ op: 'saturation-resident', seq: 2, nonce: this.rng.int(1, 1e9) }],
      { kind: 'saturation-resident', identityIndex: residentIndex }
    )

    const victims = []
    for (const index of victimIndices) {
      const victim = await this.openIdentity(index, { hubLink: true })
      await this.appendBatch(
        victim,
        'w' + index,
        [{ op: 'saturation-victim', seq: 1, nonce: this.rng.int(1, 1e9) }],
        { kind: 'saturation-victim', identityIndex: index }
      )
      victims.push(victim)
      await this.wait(
        'saturation victim admitted ' + index,
        () => ({ ok: this.reader.writers.has(b4a.toString(victim.local.key, 'hex')) }),
        30000
      )
    }

    await this.wait(
      'saturation cap is full with idle heads',
      () => ({
        ok: this.reader.writers.active.size === cap,
        active: this.reader.writers.active.size,
        cap
      }),
      30000
    )
    this.takeSample('cap-full', { eventCap: cap })

    this.links.link(resident, this.hub, 'hub-w' + residentIndex)
    this.leaves.set(residentIndex, 'hub-w' + residentIndex)
    await this.wait(
      'a real pressure eviction fills the one-record metadata budget',
      () => {
        const records = [...this.reader.writers._reclaimed.entries()]
        return {
          ok: this.events.evictions >= 1 && records.length === 1,
          evictions: this.events.evictions,
          records: records.map(([id, record]) => ({ id, length: record.length }))
        }
      },
      30000
    )

    const record = [...this.reader.writers._reclaimed.entries()][0]
    if (!record) throw new SaturationError('no record was reserved by the actual eviction')
    this.saturationRecord = { id: record[0], length: record[1].length }
    this.pressureVictimId = record[0]

    await this.wait(
      'the saturated resident applies and the source dependency settles',
      async () => {
        const residentInfo = await this.reader.system.get(resident.local.key)
        const sourceInfo = await this.reader.system.get(source.local.key)
        const active = this.reader.writers.active.size
        return {
          ok: !!residentInfo && residentInfo.length === 2 && !!sourceInfo && active <= cap,
          resident: residentInfo ? residentInfo.length : 0,
          source: sourceInfo ? sourceInfo.length : 0,
          active
        }
      },
      45000
    )

    await this.wait(
      'the retained obligation names the still-open idle victim',
      async () => {
        const current = this.reader.writers._reclaimed.get(this.saturationRecord.id)
        const eligibility = await this.saturationEligibility(victims)
        return {
          ok:
            !!current &&
            current.length === this.saturationRecord.length &&
            eligibility.eligibleVictims.length >= 1 &&
            !this.reader.writers.has(this.saturationRecord.id),
          length: current ? current.length : null,
          idle: eligibility.eligibleVictims.map((candidate) => candidate.id.slice(0, 8)),
          rejected: eligibility.probe.rejected.length
        }
      },
      30000
    )

    // Fill the remaining external slot with a live idle head. G is admitted as
    // a head; it then links a hidden H. The metadata budget is already full,
    // so the otherwise idle active heads must not be evicted.
    const late = await this.openIdentity(lateIndex, { hubLink: true })
    await this.appendBatch(
      late,
      'w' + lateIndex,
      [{ op: 'saturation-late-head', seq: 1, nonce: this.rng.int(1, 1e9) }],
      { kind: 'saturation-late-head', identityIndex: lateIndex }
    )
    await this.wait(
      'saturation late head admitted',
      () => ({
        ok: this.reader.writers.has(b4a.toString(late.local.key, 'hex')),
        active: this.reader.writers.active.size
      }),
      30000
    )

    const hidden = await this.openIdentity(lateSourceIndex, { hubLink: false })
    await this.appendBatch(
      hidden,
      'w' + lateSourceIndex,
      [{ op: 'saturation-hidden-source', seq: 1, nonce: this.rng.int(1, 1e9) }],
      { kind: 'saturation-hidden-source', identityIndex: lateSourceIndex }
    )
    this.links.link(hidden, late, 'source-resident-' + lateSourceIndex)
    this.leaves.set(lateSourceIndex, 'source-resident-' + lateSourceIndex)
    this.saturationHiddenId = b4a.toString(hidden.local.key, 'hex')
    await this.wait(
      'saturation late head sees the hidden source',
      async () => {
        const info = await late.system.get(hidden.local.key)
        return { ok: !!info && info.length >= 1 }
      },
      30000
    )

    const beforeChurn = this.events.evictions
    await this.appendBatch(
      late,
      'w' + lateIndex,
      [{ op: 'saturation-late-resident', seq: 2, nonce: this.rng.int(1, 1e9) }],
      { kind: 'saturation-late-resident', identityIndex: lateIndex }
    )

    await this.wait(
      'the budget-blocked dependency is actually pending',
      async () => {
        const lateWriter = this.reader.writers.active.get(b4a.toString(late.local.key, 'hex'))
        const info = await this.reader.system.get(late.local.key)
        return {
          ok:
            !!lateWriter &&
            lateWriter.isPending === true &&
            lateWriter.core.length === 2 &&
            lateWriter.hintedLength === 2 &&
            !!info &&
            info.length === 1 &&
            !this.reader.writers.has(this.saturationHiddenId) &&
            this.reader.writers._reclaimed.size === 1,
          pending: !!lateWriter && lateWriter.isPending,
          core: lateWriter ? lateWriter.core.length : 0,
          hinted: lateWriter ? lateWriter.hintedLength : 0,
          applied: info ? info.length : 0,
          active: this.reader.writers.active.size
        }
      },
      30000
    )

    // Prove the stalled node is a real, locally decoded block whose link names
    // the hidden key at the exact missing length. Only then can the budget
    // refusal be attributed to the metadata ledger rather than to absent data.
    const lateWriter = this.reader.writers.active.get(b4a.toString(late.local.key, 'hex'))
    const residentBlock = await lateWriter.core.get(1, { wait: false })
    if (!residentBlock) {
      throw new SaturationError(
        'the resident R@2 block is not locally available without waiting; the fixture did not stage a decodable demand'
      )
    }

    let residentOplog
    try {
      residentOplog = encoding.decodeOplog(residentBlock)
    } catch (err) {
      throw new SaturationError(
        'the locally available resident R@2 block could not be decoded: ' + String(err)
      )
    }

    const decodedLink = (residentOplog.links || []).find((entry) =>
      b4a.equals(entry.key, hidden.local.key)
    )
    if (!decodedLink) {
      throw new SaturationError(
        'the decoded resident R@2 block has no link to the hidden dependency key'
      )
    }
    if (decodedLink.length !== 1) {
      throw new SaturationError(
        'the decoded resident link names length ' +
          decodedLink.length +
          ', expected the missing hidden length 1'
      )
    }

    await this.wait(
      'a fully eligible idle victim exists before the budget refusal',
      async () => {
        const eligibility = await this.saturationEligibility(victims)
        return {
          ok: eligibility.eligibleVictims.length >= 1,
          eligible: eligibility.eligibleVictims.map((candidate) => candidate.id.slice(0, 8)),
          rejected: eligibility.probe.rejected.slice(0, 6)
        }
      },
      30000
    )

    let attemptState
    try {
      attemptState = await this.wait(
        'a real dependency reclaim is refused at the full metadata budget',
        () => {
          const attempts = this.events.reclaimAttempts.filter((attempt) => {
            if (attempt.victim !== null) return false
            if (attempt.before.records !== this.config.maxReclaimedWriters) return false
            if (attempt.before.active !== cap) return false
            if (
              !attempt.dependencies.some(
                (entry) => entry.id === this.saturationHiddenId && entry.length === 1
              )
            ) {
              return false
            }
            if (
              !attempt.demand.some(
                (entry) =>
                  entry.id === this.saturationHiddenId && entry.length === 1 && !entry.satisfied
              )
            ) {
              return false
            }
            return attempt.eligible.length >= 1
          })
          return {
            ok: attempts.length > 0,
            attempts: this.events.reclaimAttempts.slice(-3)
          }
        },
        30000
      )
    } catch (err) {
      throw new SaturationError(
        'no real budget-refused dependency reclaim attempt was observed; fixture diagnosis: ' +
          serialize({
            attempts: this.events.reclaimAttempts.slice(-5),
            demands: this.reader.writers
              ._dependencyDemands()
              .map((entry) => ({ id: b4a.toString(entry.key, 'hex'), length: entry.length })),
            active: this.reader.writers.active.size,
            records: this.reader.writers._reclaimed.size
          })
      )
    }

    const attempt = attemptState.attempts[attemptState.attempts.length - 1]
    const attemptDemand = attempt.demand.find(
      (entry) => entry.id === this.saturationHiddenId && entry.length === 1
    )
    if (!attemptDemand || attemptDemand.satisfied) {
      throw new SaturationError(
        'the recorded reclaim attempt did not carry the unsatisfied hidden dependency demand'
      )
    }

    const victimIds = new Set(victims.map((victim) => b4a.toString(victim.local.key, 'hex')))
    const eligibleVictims = attempt.eligible.filter((candidate) => victimIds.has(candidate.id))
    if (eligibleVictims.length === 0) {
      throw new SaturationError(
        'the budget refusal had no fully eligible idle victim; eligible alternatives were ' +
          serialize(attempt.eligible) +
          ' and rejected candidates were ' +
          serialize(attempt.rejected)
      )
    }

    this.saturationReclaimProof = {
      victim: attempt.victim,
      recordsAtAttempt: attempt.before.records,
      budget: attempt.before.budget,
      activeAtAttempt: attempt.before.active,
      cap,
      demand: {
        id: attemptDemand.id,
        length: attemptDemand.length,
        applied: attemptDemand.applied,
        satisfied: false
      },
      link: { id: this.saturationHiddenId, length: decodedLink.length },
      blockAvailable: true,
      eligible: eligibleVictims.map((candidate) => ({
        id: candidate.id,
        applied: candidate.applied,
        core: candidate.core,
        hinted: candidate.hinted,
        revalidated: candidate.revalidated
      })),
      eligibleCount: attempt.eligible.length,
      rejectedCount: attempt.rejected.length
    }
    this.log('saturation-budget-refusal-proof', {
      proof: this.saturationReclaimProof
    })

    const quietBefore = await quiesce(() => this.saturationQuietSnapshot(victims), {
      stable: 1000,
      timeout: 10000
    })
    await sleep(this.config.saturationQuietMs)
    const quietAfter = await this.saturationQuietSnapshot(victims)

    const recordSamples = this.samples.map((sample) => sample.records || 0)
    recordSamples.push(this.reader.writers._reclaimed.size)

    const lateApplied = await this.reader.system.get(late.local.key)
    const verdict = verifySaturation({
      budget: this.config.maxReclaimedWriters,
      cap: this.config.readerCap,
      evictions: this.events.evictions,
      records: this.reader.writers._reclaimed.size,
      recordId: this.saturationRecord.id,
      recordLength: this.saturationRecord.length,
      reclaimAttempt: this.saturationReclaimProof,
      idleVictimOpen: quietAfter.idleVictimOpen,
      dependencyDelivered:
        (lateApplied ? lateApplied.length : 0) >= 2 ||
        this.reader.writers.has(this.saturationHiddenId),
      expectedStalled: true,
      recordSamples,
      quietBefore,
      quietAfter
    })

    if (this.events.evictions !== beforeChurn) {
      throw new SaturationError('a second eviction occurred despite the full metadata budget')
    }

    this.log('saturation-verdict', {
      verdict,
      record: this.saturationRecord,
      quietBefore,
      quietAfter
    })

    for (const index of [
      residentIndex,
      ...victimIndices,
      sourceIndex,
      lateIndex,
      lateSourceIndex
    ]) {
      await this.closeLeaf(index)
    }

    this.phase = 'saturation-closed'
  }

  async saturationEligibility(victims) {
    const victimIds = new Set(victims.map((victim) => b4a.toString(victim.local.key, 'hex')))
    const probe = await this.probeReclaimEligibility(this.reader.writers, [])
    return {
      probe,
      eligibleVictims: probe.eligible.filter((candidate) => victimIds.has(candidate.id))
    }
  }

  async saturationQuietSnapshot(victims) {
    const writer = this.reader.writers
    const eligibility = await this.saturationEligibility(victims)
    const record = this.saturationRecord
      ? writer._reclaimed.get(this.saturationRecord.id)
      : undefined

    return {
      records: writer._reclaimed.size,
      recordId: record ? this.saturationRecord.id : null,
      recordLength: record ? record.length : null,
      evictions: this.events.evictions,
      active: writer.active.size,
      open: this.reader.stats.writersOpened,
      closed: this.reader.stats.writersClosed,
      drains: this.reader.stats.drains,
      flushes: this.reader.system.flushes,
      idleVictimOpen: eligibility.eligibleVictims.length >= 1,
      eligibleVictims: eligibility.eligibleVictims.length,
      targetActive: writer.has(this.saturationHiddenId || '')
    }
  }

  async setupSaturationIdentities() {
    const deadline = Date.now() + this.config.setupAllowanceMs
    const indices = range(0, this.config.writerCount)
    const leaves = await Promise.all(
      indices.map((index) => this.openIdentity(index, { hubLink: true }))
    )

    const payloads = leaves.map((leaf) => ({
      addWriter: leaf.local.id,
      weight: 1,
      grant: true,
      soaksSetup: true
    }))
    await this.appendBatch(this.admin, 'admin', payloads, { kind: 'grant' })

    for (let i = 0; i < leaves.length; i++) {
      const left = deadline - Date.now()
      if (left <= 0) throw new Error('saturation identity setup allowance exhausted')
      await this.wait(
        'saturation identity ' + indices[i] + ' writable',
        async () => {
          await leaves[i].update()
          return { ok: leaves[i].writable }
        },
        left
      )
    }

    for (const index of indices) await this.closeLeaf(index)
    await this.waitForAdminSync('saturation-setup')
  }

  async waitForSaturationReader() {
    await this.wait(
      'saturation reader applies the grant history',
      async () => {
        const info = await this.reader.system.get(this.adminKey)
        return { ok: !!info && info.length >= this.admin.local.length }
      },
      60000
    )
  }

  // -------------------------------------------------------------------------
  // sampling

  startSampler() {
    if (this.sampler) return
    this.sampler = {
      lastCpu: process.cpuUsage(),
      lastTime: Date.now(),
      lagExpected: performance.now() + 100,
      lagMax: 0,
      lagTimer: null,
      sampleTimer: null
    }

    this.sampler.lagTimer = setInterval(() => {
      const now = performance.now()
      const lag = Math.max(0, now - this.sampler.lagExpected)
      this.sampler.lagMax = Math.max(this.sampler.lagMax, lag)
      this.sampler.lagExpected = now + 100
    }, 100)
    this.sampler.lagTimer.unref()

    this.sampler.sampleTimer = setInterval(() => {
      try {
        this.takeSample('sample')
      } catch (err) {
        this.boundsViolations.push('sampler failed: ' + String(err))
      }
    }, this.config.sampleIntervalMs)
    this.sampler.sampleTimer.unref()

    this.takeSample('sample', { first: true })
  }

  stopSampler() {
    if (!this.sampler) return
    clearInterval(this.sampler.lagTimer)
    clearInterval(this.sampler.sampleTimer)
    this.sampler = null
  }

  takeSample(kind, extra = {}) {
    const now = Date.now()
    const memory = process.memoryUsage()
    const cpu = process.cpuUsage()
    const sampler = this.sampler || { lastCpu: cpu, lastTime: now, lagMax: 0 }
    const elapsed = Math.max(1, now - sampler.lastTime)
    const cpuDelta = {
      user: cpu.user - sampler.lastCpu.user,
      system: cpu.system - sampler.lastCpu.system
    }
    const cpuPercent = ((cpuDelta.user + cpuDelta.system) / 1000 / elapsed) * 100
    const lag = sampler.lagMax || 0
    if (this.sampler) {
      this.sampler.lastCpu = cpu
      this.sampler.lastTime = now
      this.sampler.lagMax = 0
    }

    let fds = null
    try {
      fds = fs.readdirSync('/proc/self/fd').length
    } catch {
      fds = null
    }

    const reader = this.reader
    const sample = {
      kind: 'sample',
      sampleKind: kind,
      t: now,
      phase: this.phase,
      group: sampleGroup(this.phase),
      rssMb: round1(memory.rss / 1e6),
      heapUsedMb: round1(memory.heapUsed / 1e6),
      heapTotalMb: round1(memory.heapTotal / 1e6),
      externalMb: round1(memory.external / 1e6),
      arrayBuffersMb: round1((memory.arrayBuffers || 0) / 1e6),
      cpuPercent: round1(cpuPercent),
      loopLagMs: round1(lag),
      fds,
      active: reader ? reader.writers.active.size : 0,
      records: reader ? reader.writers._reclaimed.size : 0,
      pending: reader ? reader.writers.pending.length : 0,
      opened: reader ? reader.stats.writersOpened : 0,
      closed: reader ? reader.stats.writersClosed : 0,
      drains: reader ? reader.stats.drains : 0,
      applies: reader ? reader.stats.applies : 0,
      readerVersion: reader ? reader.system.version : 0,
      refVersion: this.reference ? this.reference.system.version : 0,
      liveEdges: this.links.size,
      liveLeaves: this.liveLeaves.size,
      acknowledgedOperations: this.ledger.ops.length,
      authoredIdentities: this.authored.size,
      ...extra
    }

    this.samples.push(sample)
    if (this.samples.length > 500) this.samples.splice(0, this.samples.length - 500)
    console.log(JSON.stringify(sample))

    if (reader) {
      if (sample.active > this.config.readerCap) {
        this.recordBoundViolation(
          'sample: reader active ' + sample.active + ' > cap ' + this.config.readerCap
        )
      }
      if (sample.records > this.config.maxReclaimedWriters) {
        this.recordBoundViolation(
          'sample: reader records ' +
            sample.records +
            ' > budget ' +
            this.config.maxReclaimedWriters
        )
      }
    }
    if (sample.liveLeaves > this.config.leafBound) {
      this.recordBoundViolation(
        'sample: live leaves ' + sample.liveLeaves + ' > bound ' + this.config.leafBound
      )
    }
    if (sample.liveEdges > 3 + this.config.leafBound + 1) {
      this.recordBoundViolation(
        'sample: live edges ' + sample.liveEdges + ' > bound ' + (3 + this.config.leafBound + 1)
      )
    }

    return sample
  }

  async failureSnapshot() {
    const reader = this.reader
    const snapshot = {
      phase: this.phase,
      actionIndex: this.actionIndex,
      liveLeaves: this.liveLeaves.size,
      liveEdges: this.links.labels(),
      authored: this.authored.size,
      expected: this.ledger.expected.size,
      openLeaves: [...this.liveLeaves.keys()].slice(0, 32)
    }

    if (reader) {
      snapshot.reader = {
        active: reader.writers.active.size,
        local: b4a.toString(reader.local.key, 'hex').slice(0, 16),
        records: [...reader.writers._reclaimed.entries()].map(([id, record]) => ({
          id: id.slice(0, 16),
          length: record.length
        })),
        activeWriters: [...reader.writers.active.values()].slice(0, 32).map((writer) => ({
          id: writer.id.slice(0, 16),
          core: writer.core.length,
          hinted: writer.hintedLength,
          head: writer.isHead,
          pending: writer.isPending,
          closed: writer.isClosed
        })),
        pending: reader.writers.pending.slice(0, 32).map((writer) => ({
          id: writer.id.slice(0, 16),
          core: writer.core.length,
          hinted: writer.hintedLength
        })),
        stats: { ...reader.stats }
      }
    }

    for (const [name, auto] of [
      ['hub', this.hub],
      ['reference', this.reference],
      ['admin', this.admin]
    ]) {
      if (!auto) continue
      snapshot[name] = {
        length: auto.local ? auto.local.length : 0,
        heads: auto.system.heads.map((head) => ({
          key: b4a.toString(head.key, 'hex').slice(0, 16),
          length: head.length
        })),
        version: auto.system.version,
        stats: auto.stats ? { ...auto.stats } : null
      }
    }

    const identities = [...this.identityKeys, this.adminKey]
    if (this.reader && identities.length > 0) {
      try {
        const applied = await readLengths(this.reader, identities)
        snapshot.readerAppliedLengths = Object.fromEntries(applied)
      } catch (err) {
        snapshot.readerAppliedLengths = { error: String(err) }
      }
    }
    if (this.hub && identities.length > 0) {
      try {
        const applied = await readLengths(this.hub, identities)
        snapshot.hubAppliedLengths = Object.fromEntries(applied)
      } catch (err) {
        snapshot.hubAppliedLengths = { error: String(err) }
      }
    }

    snapshot.events = summarizeEvents(this.events)
    snapshot.boundsViolations = this.boundsViolations.slice(0, 20)
    snapshot.samples = this.samples.slice(-3)
    snapshot.readerManualCalls = this.readerManualCalls
    return snapshot
  }
}

// ---------------------------------------------------------------------------
// stream links

class Links {
  constructor(run) {
    this.run = run
    this.pairs = new Map()
    this.errors = []
    this.closeTimeoutMs = 2000
  }

  get size() {
    return this.pairs.size
  }

  has(label) {
    return this.pairs.has(label)
  }

  labels() {
    return [...this.pairs.keys()]
  }

  fail(err, label) {
    const text = String((err && err.message) || err)
    this.errors.push({ label, error: text })
    if (this.errors.length > 50) this.errors.splice(0, this.errors.length - 50)
    this.run.asyncError = err
    this.run.log('stream-error', { label, error: text })
    if (typeof this.run.forceFailure === 'function') this.run.forceFailure(err)
  }

  link(a, b, label) {
    if (this.pairs.has(label)) throw new Error('duplicate replication edge ' + label)

    const s1 = a.replicate(true)
    const s2 = b.replicate(false)
    s1.pipe(s2).pipe(s1)

    const pair = { a, b, s1, s2, label, closed: false, errors: [] }
    const onError = (err) => {
      // Only our own controlled unlink makes a stream error expected. The pair
      // is marked closed (before destroying) by unlink(), so every other
      // active-edge error - including formerly blanket-ignored codes such as
      // ECONNRESET - fails the runner.
      if (pair.closed) {
        this.run.log('stream-error-after-unlink', { label, error: String(err && err.message) })
        return
      }
      const text = String((err && err.message) || err)
      pair.errors.push(text)
      this.fail(err, label)
    }
    s1.on('error', onError)
    s2.on('error', onError)

    this.pairs.set(label, pair)
    this.run.checkBoundaries('link')
    return pair
  }

  async unlink(label) {
    const pair = this.pairs.get(label)
    if (!pair) return

    pair.closed = true
    this.pairs.delete(label)

    pair.s1.destroy()
    pair.s2.destroy()

    const settled = await Promise.allSettled([
      closeStream(pair.s1, { timeoutMs: this.closeTimeoutMs, ignoreErrors: true }),
      closeStream(pair.s2, { timeoutMs: this.closeTimeoutMs, ignoreErrors: true })
    ])
    const failures = settled
      .filter((entry) => entry.status === 'rejected')
      .map((entry) => String((entry.reason && entry.reason.message) || entry.reason))

    if (pair.errors.length > 0) {
      this.run.log('edge-close-errors', { label, errors: pair.errors.slice(0, 4) })
    }
    if (failures.length > 0) {
      throw new Error('replication edge ' + label + ' did not close: ' + failures.join(' | '))
    }
  }

  async closeAll() {
    const labels = [...this.pairs.keys()]
    const settled = await Promise.allSettled(labels.map((label) => this.unlink(label)))
    const failures = settled
      .filter((entry) => entry.status === 'rejected')
      .map((entry) => String((entry.reason && entry.reason.message) || entry.reason))
    if (failures.length > 0) {
      throw new Error('failed to close replication edges: ' + failures.join(' | '))
    }
  }
}

function closeStream(stream, options = {}) {
  const timeoutMs = typeof options === 'number' ? options : options.timeoutMs || 2000
  const ignoreErrors = typeof options === 'object' && options.ignoreErrors === true

  if (!stream) return Promise.resolve()
  // `destroyed` only means destroy() was called; `closed` means the close event
  // actually happened. Wait for the real close unless it already happened.
  if (stream.closed === true) return Promise.resolve()

  return new Promise((resolve, reject) => {
    let settled = false
    let timer = null

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      stream.removeListener('close', onClose)
      stream.removeListener('error', onError)
    }
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      cleanup()
      fn(value)
    }
    const onClose = () => finish(resolve)
    const onError = (err) => {
      if (ignoreErrors) return
      finish(reject, err instanceof Error ? err : new Error(String(err)))
    }

    // This timer is intentionally not unref'd: the caller awaits the close, so
    // the bounded deadline must keep the process alive long enough to settle.
    timer = setTimeout(() => {
      finish(reject, new Error('stream did not emit close before the ' + timeoutMs + 'ms deadline'))
    }, timeoutMs)

    stream.once('close', onClose)
    stream.once('error', onError)
    if (stream.closed === true) finish(resolve)
  })
}

// ---------------------------------------------------------------------------
// helpers

function createGate() {
  let resolve
  const gate = {
    promise: new Promise((r) => {
      resolve = r
    }),
    resolved: false,
    resolve() {
      if (gate.resolved) return
      gate.resolved = true
      resolve()
    }
  }
  return gate
}

function freshEvents() {
  return {
    evictions: 0,
    admissions: 0,
    retryAdmissions: 0,
    handoffs: 0,
    deniedWakeups: 0,
    deniedByCap: 0,
    deniedPositiveTail: 0,
    positiveAnnouncements: 0,
    positiveAdvances: 0,
    refusedPositive: 0,
    capturedPositive: 0,
    victimPositiveAnnouncements: 0,
    victimHandoffs: 0,
    victimHandoffLength2: 0,
    victimRetryHandoffs: 0,
    victimRetryHandoffLength2: 0,
    victimRetryAdmissions: 0,
    victimNonRetryAdmissions: 0,
    victimWakeupCalls: 0,
    victimWakeupsAfterIsolation: 0,
    victimPositiveAdvancesAfterIsolation: 0,
    victimFreshIngressAfterIsolation: 0,
    victimMaxLossAfterIsolation: 0,
    victimQueuedRestoresAfterIsolation: 0,
    victimIsolationBaselineLength: null,
    victimBaselineLossObserved: false,
    victimIsolatedAt: null,
    victimOpened: 0,
    reclaimAttempts: [],
    opened: new Map(),
    records: new Map(),
    lastEviction: null,
    lastHandoff: null,
    lastVictimHandoff: null,
    lastCapture: null
  }
}

function summarizeEvents(events) {
  return {
    evictions: events.evictions,
    admissions: events.admissions,
    retryAdmissions: events.retryAdmissions,
    handoffs: events.handoffs,
    deniedWakeups: events.deniedWakeups,
    deniedByCap: events.deniedByCap,
    deniedPositiveTail: events.deniedPositiveTail,
    positiveAnnouncements: events.positiveAnnouncements,
    positiveAdvances: events.positiveAdvances,
    refusedPositive: events.refusedPositive,
    capturedPositive: events.capturedPositive,
    victimPositiveAnnouncements: events.victimPositiveAnnouncements,
    victimHandoffs: events.victimHandoffs,
    victimHandoffLength2: events.victimHandoffLength2,
    victimRetryHandoffs: events.victimRetryHandoffs,
    victimRetryHandoffLength2: events.victimRetryHandoffLength2,
    victimRetryAdmissions: events.victimRetryAdmissions,
    victimNonRetryAdmissions: events.victimNonRetryAdmissions,
    victimWakeupCalls: events.victimWakeupCalls,
    victimWakeupsAfterIsolation: events.victimWakeupsAfterIsolation,
    victimPositiveAdvancesAfterIsolation: events.victimPositiveAdvancesAfterIsolation,
    victimFreshIngressAfterIsolation: events.victimFreshIngressAfterIsolation,
    victimMaxLossAfterIsolation: events.victimMaxLossAfterIsolation,
    victimQueuedRestoresAfterIsolation: events.victimQueuedRestoresAfterIsolation,
    victimIsolationBaselineLength: events.victimIsolationBaselineLength,
    victimOpened: events.victimOpened,
    reclaimAttempts: events.reclaimAttempts.length,
    openWriters: events.opened.size,
    lastEviction: events.lastEviction,
    lastHandoff: events.lastHandoff,
    lastVictimHandoff: events.lastVictimHandoff,
    lastCapture: events.lastCapture
  }
}

function summarizeSamples(samples) {
  const groups = new Map()

  for (const sample of samples) {
    const group = sample.group || 'other'
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push(sample)
  }

  const summary = {}
  for (const [group, entries] of groups) {
    summary[group] = {
      count: entries.length,
      rssMb: stats(entries.map((entry) => entry.rssMb)),
      heapUsedMb: stats(entries.map((entry) => entry.heapUsedMb)),
      externalMb: stats(entries.map((entry) => entry.externalMb)),
      cpuPercent: stats(entries.map((entry) => entry.cpuPercent)),
      loopLagMs: stats(entries.map((entry) => entry.loopLagMs)),
      fds: stats(entries.filter((entry) => entry.fds !== null).map((entry) => entry.fds)),
      maxActive: Math.max(...entries.map((entry) => entry.active)),
      maxRecords: Math.max(...entries.map((entry) => entry.records)),
      maxLiveEdges: Math.max(...entries.map((entry) => entry.liveEdges)),
      maxLiveLeaves: Math.max(...entries.map((entry) => entry.liveLeaves)),
      last: entries[entries.length - 1]
    }
  }

  return summary
}

function stats(values) {
  if (values.length === 0) return null
  const sum = values.reduce((total, value) => total + value, 0)
  return {
    min: round1(Math.min(...values)),
    avg: round1(sum / values.length),
    max: round1(Math.max(...values))
  }
}

function sampleGroup(phase) {
  if (phase && phase.startsWith('setup')) return 'warm-up'
  if (phase === 'drain' || phase === 'final-hold') return 'drain'
  if (phase === 'closed' || phase === 'saturation-closed') return 'after-close'
  return 'steady'
}

function round1(value) {
  return Math.round(value * 10) / 10
}

function range(start, end) {
  const result = []
  for (let i = start; i < end; i++) result.push(i)
  return result
}

// ---------------------------------------------------------------------------

async function main() {
  let config
  try {
    config = resolveConfig(process.env)
  } catch (err) {
    console.error(JSON.stringify({ kind: 'config-error', message: err.message }))
    console.error('usage: see test/soak/README.md')
    process.exitCode = 2
    return
  }

  console.log(JSON.stringify({ kind: 'config-resolved', config, replay: config.replay }))
  const runner = new SoakRunner(config)
  // Success exits naturally once every owned stream/store/timer is closed: no
  // process.exit(0) can hide a live handle. Failure still returns 1 here, and
  // the watchdog/async paths retain a bounded forced termination.
  process.exitCode = await runner.run()
}

if (require.main === module) {
  main().catch((err) => {
    console.error(JSON.stringify({ kind: 'unhandled-main-error', message: String(err) }))
    process.exitCode = 1
  })
}

module.exports = { SoakRunner, Links, closeStream, createGate }
