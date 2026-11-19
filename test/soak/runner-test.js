// Explicit opt-in checks for the soak runner's own configuration, oracle and
// phase accounting. These are harness tests: they do not start a workload and
// they are deliberately not imported by test/all.js.
//
//   node test/soak/runner-test.js

const assert = require('assert')
const fs = require('fs')
const { EventEmitter } = require('events')
const { spawn } = require('child_process')
const b4a = require('b4a')
const {
  ConfigError,
  PhaseError,
  PROFILES,
  resolveConfig,
  createOperationLedger,
  verifyFinalState,
  verifyPhaseCoverage,
  verifySaturation,
  formatReplay,
  createRunRoot,
  removeRunRoot,
  sleep,
  withTimeout
} = require('./helpers.js')
const { SoakRunner, Links, closeStream, createGate } = require('./writer-cap.js')
const { ActiveWriters } = require('../../lib/writers.js')

const tests = []

function test(name, fn) {
  tests.push({ name, fn })
}

function expectConfigError(fn, pattern) {
  let error = null
  try {
    fn()
  } catch (err) {
    error = err
  }

  assert.ok(error instanceof ConfigError, 'expected ConfigError, got ' + String(error))
  if (pattern) assert.match(error.message, pattern)
}

// ---------------------------------------------------------------------------
// configuration

test('soak defaults are the approved 128/16/1024 ten-minute profile', () => {
  const config = resolveConfig({})

  assert.strictEqual(config.profile, 'soak')
  assert.strictEqual(config.seed, 381)
  assert.strictEqual(config.writerCount, 128)
  assert.strictEqual(config.readerCap, 16)
  assert.strictEqual(config.maxReclaimedWriters, 1024)
  assert.strictEqual(config.leafBound, 16)
  assert.strictEqual(config.durationMs, 600000)
  assert.ok(config.setupAllowanceMs > 0)
  assert.ok(config.drainAllowanceMs > 0)
  assert.strictEqual(config.cleanupAllowanceMs, 30000)
  assert.ok(config.replay.includes('SOAK_PROFILE=soak'))
  assert.ok(config.replay.includes('test:writer-cap-soak'))
})

test('smoke defaults to 32 writers, cap 8 and one minute', () => {
  const config = resolveConfig({ SOAK_PROFILE: 'smoke' })

  assert.strictEqual(config.profile, 'smoke')
  assert.strictEqual(config.writerCount, 32)
  assert.strictEqual(config.readerCap, 8)
  assert.strictEqual(config.maxReclaimedWriters, 1024)
  assert.strictEqual(config.leafBound, 8)
  assert.strictEqual(config.durationMs, 60000)
})

test('seed accepts the full unsigned 32 bit range and defaults to 381', () => {
  assert.strictEqual(resolveConfig({ SOAK_SEED: '0' }).seed, 0)
  assert.strictEqual(resolveConfig({ SOAK_SEED: '381' }).seed, 381)
  assert.strictEqual(resolveConfig({ SOAK_SEED: '4294967295' }).seed, 4294967295)

  for (const bad of ['-1', '1.5', '4294967296', '99999999999999999999', 'abc', '', ' 12']) {
    expectConfigError(() => resolveConfig({ SOAK_SEED: bad }), /SOAK_SEED/)
  }
})

test('duration is a positive safe integer and saturation rejects the override', () => {
  assert.strictEqual(resolveConfig({ SOAK_DURATION_MS: '1' }).durationMs, 1)
  assert.strictEqual(resolveConfig({ SOAK_DURATION_MS: '90000' }).durationMs, 90000)

  for (const bad of ['0', '-1', '1.5', 'abc', '9007199254740993', '']) {
    expectConfigError(() => resolveConfig({ SOAK_DURATION_MS: bad }), /SOAK_DURATION_MS/)
  }

  expectConfigError(() => resolveConfig({ SOAK_PROFILE: 'saturation', SOAK_DURATION_MS: '1' }))
})

test('writer count must leave room above the active cap', () => {
  assert.strictEqual(resolveConfig({ SOAK_WRITERS: '20' }).writerCount, 20)
  assert.strictEqual(resolveConfig({ SOAK_PROFILE: 'smoke', SOAK_WRITERS: '12' }).writerCount, 12)

  expectConfigError(() => resolveConfig({ SOAK_WRITERS: '19' }), /SOAK_WRITERS/)
  expectConfigError(() => resolveConfig({ SOAK_WRITERS: '0' }), /SOAK_WRITERS/)
  expectConfigError(
    () => resolveConfig({ SOAK_PROFILE: 'smoke', SOAK_WRITERS: '11' }),
    /SOAK_WRITERS/
  )
  expectConfigError(() => resolveConfig({ SOAK_PROFILE: 'saturation', SOAK_WRITERS: '32' }))
})

test('unknown profiles and unknown override shapes are rejected before workload allocation', () => {
  expectConfigError(() => resolveConfig({ SOAK_PROFILE: 'stress' }), /SOAK_PROFILE/)
  expectConfigError(() => resolveConfig({ SOAK_PROFILE: '' }), /SOAK_PROFILE/)

  const saturation = resolveConfig({ SOAK_PROFILE: 'saturation' })
  assert.strictEqual(saturation.readerCap, PROFILES.saturation.readerCap)
  assert.strictEqual(saturation.maxReclaimedWriters, 1)
  assert.strictEqual(saturation.leafBound, PROFILES.saturation.leafBound)
  assert.strictEqual(saturation.durationMs, null)
  assert.strictEqual(saturation.expectedStalled, true)
})

test('replay command preserves the exact seed/profile/duration/writers', () => {
  const config = resolveConfig({
    SOAK_PROFILE: 'smoke',
    SOAK_SEED: '382',
    SOAK_DURATION_MS: '60000',
    SOAK_WRITERS: '12'
  })
  const replay = formatReplay(config)

  assert.match(replay, /^SOAK_PROFILE=smoke SOAK_SEED=382 SOAK_DURATION_MS=60000 SOAK_WRITERS=12 /)
  assert.match(replay, /npm run test:writer-cap-soak$/)
})

// ---------------------------------------------------------------------------
// independent operation ledger and final oracle

function fixtureState(overrides = {}) {
  const ledger = createOperationLedger()
  ledger.record('aa', 1, { author: 'aa', seq: 1, id: 'a1' })
  ledger.record('aa', 2, { author: 'aa', seq: 2, id: 'a2' })
  ledger.record('bb', 1, { author: 'bb', seq: 1, id: 'b1' })

  const state = {
    ledger,
    reference: {
      history: ['aa.1', 'aa.2', 'bb.1'],
      lengths: new Map([
        ['aa', 2],
        ['bb', 1]
      ])
    },
    reader: {
      history: ['aa.1', 'aa.2', 'bb.1'],
      lengths: new Map([
        ['aa', 2],
        ['bb', 1]
      ])
    },
    identities: ['aa', 'bb']
  }

  return Object.assign(state, overrides)
}

test('exact ordered history plus expected coverage and acknowledged lengths passes', () => {
  const result = verifyFinalState(fixtureState())
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.entries, 3)
})

test('two equally incomplete peers cannot pass: independent expected coverage fails', () => {
  const state = fixtureState()
  // both peers are missing the same authored operation
  state.reference.history = ['aa.1', 'aa.2']
  state.reader.history = ['aa.1', 'aa.2']

  assert.throws(() => verifyFinalState(state), /independent completeness/)
})

test('a duplicate applied operation fails exactly-once coverage', () => {
  const state = fixtureState()
  state.reference.history = ['aa.1', 'aa.2', 'bb.1', 'bb.1']
  state.reader.history = ['aa.1', 'aa.2', 'bb.1', 'bb.1']

  assert.throws(() => verifyFinalState(state), /duplicate/)
})

test('unexpected applied operations fail even when both peers agree', () => {
  const state = fixtureState()
  state.reference.history.push('cc.1')
  state.reader.history.push('cc.1')

  assert.throws(() => verifyFinalState(state), /not in the authored/)
})

test('ordered history disagreement fails even with identical sets', () => {
  const state = fixtureState()
  state.reader.history = ['aa.2', 'aa.1', 'bb.1']

  assert.throws(() => verifyFinalState(state), /ordered apply history/)
})

test('per-writer applied length must match the acknowledged length', () => {
  const state = fixtureState()
  state.reference.lengths.set('bb', 0)
  state.reader.lengths.set('bb', 0)

  assert.throws(() => verifyFinalState(state), /acknowledged length/)
})

test('reference and reader per-writer lengths must agree', () => {
  const state = fixtureState()
  state.reference.lengths.set('bb', 2)

  assert.throws(() => verifyFinalState(state), /per-writer applied lengths/)
})

test('a ledger record needs identity and length, and rejects duplicate refs', () => {
  const ledger = createOperationLedger()
  assert.throws(() => ledger.record('aa', 0, {}), /positive/)
  assert.throws(() => ledger.record('aa', -1, {}), /positive/)

  ledger.record('aa', 1, { author: 'aa', seq: 1 })
  assert.throws(() => ledger.record('aa', 1, { author: 'aa', seq: 1 }), /duplicate/)
})

test('an empty authored ledger cannot accept an applied history', () => {
  const ledger = createOperationLedger()
  const state = {
    ledger,
    reference: { history: ['aa.1'], lengths: new Map([['aa', 1]]) },
    reader: { history: ['aa.1'], lengths: new Map([['aa', 1]]) },
    identities: ['aa']
  }

  assert.throws(() => verifyFinalState(state), /independent completeness/)
})

// ---------------------------------------------------------------------------
// phase coverage: a missed progress/phase must never yield a pass

function completePhaseCoverage() {
  return {
    allIdentitiesAuthored: true,
    appends: 128,
    acknowledgedOperations: 400,
    actualEvictions: 2,
    reservedRecords: 2,
    dependencyEvictions: 1,
    refusedPositiveTails: 1,
    recoveredPositiveTails: 1,
    handoffs: 2,
    deniedWakeups: 1,
    victimRetryAdmissions: 1,
    victimRetryHandoffs: 2,
    victimRetryHandoffLength2: 2,
    victimHandoffLength2: 2,
    victimNonRetryAdmissions: 0,
    victimPositiveAdvancesAfterIsolation: 0,
    victimMaxLossAfterIsolation: 0,
    victimQueuedRestoresAfterIsolation: 0,
    partitions: 2,
    reconnects: 2,
    readerRestart: true,
    readerRestartLedgerEmpty: true,
    writerRestart: true,
    writerRestartSameIdentity: true,
    settledCheckpoints: 3,
    converged: true,
    phases: ['setup-identities', 'pressure', 'cohorts', 'final']
  }
}

test('complete phase evidence passes', () => {
  assert.strictEqual(verifyPhaseCoverage(completePhaseCoverage()).ok, true)
})

test('pressure without an actual eviction cannot pass', () => {
  const coverage = completePhaseCoverage()
  coverage.actualEvictions = 0
  coverage.dependencyEvictions = 0

  assert.throws(() => verifyPhaseCoverage(coverage), /actualEvictions/)
})

test('a refused positive tail that is never recovered cannot pass', () => {
  const coverage = completePhaseCoverage()
  coverage.recoveredPositiveTails = 0
  coverage.refusedPositiveTails = 1

  assert.throws(() => verifyPhaseCoverage(coverage), /recoveredPositiveTails/)
})

test('missing partition/reconnect/restarts/checkpoints cannot pass', () => {
  for (const field of [
    'partitions',
    'reconnects',
    'readerRestart',
    'readerRestartLedgerEmpty',
    'writerRestart',
    'writerRestartSameIdentity',
    'settledCheckpoints',
    'converged',
    'allIdentitiesAuthored'
  ]) {
    const coverage = completePhaseCoverage()
    coverage[field] = typeof coverage[field] === 'number' ? 0 : false
    assert.throws(() => verifyPhaseCoverage(coverage), new RegExp(field))
  }
})

test('a missing retry-proof handoff cannot pass even with an eviction', () => {
  const coverage = completePhaseCoverage()
  coverage.handoffs = 0
  coverage.recoveredPositiveTails = 1

  assert.throws(() => verifyPhaseCoverage(coverage), /handoffs/)
})

// ---------------------------------------------------------------------------
// saturation accounting: bounded ledger, retained obligation, no spin

function reclaimAttemptFixture(overrides = {}) {
  return Object.assign(
    {
      victim: null,
      recordsAtAttempt: 1,
      budget: 1,
      activeAtAttempt: 4,
      cap: 4,
      demand: { id: 'hidden', length: 1, applied: 0, satisfied: false },
      link: { id: 'hidden', length: 1 },
      blockAvailable: true,
      eligible: [{ id: 'idle', applied: 1, core: 1, hinted: 1, revalidated: true }]
    },
    overrides
  )
}

function saturationFixture(overrides = {}) {
  const before = {
    records: 1,
    recordId: 'aa',
    recordLength: 1,
    evictions: 1,
    active: 3,
    open: 7,
    closed: 5,
    drains: 12,
    flushes: 9,
    idleVictimOpen: true,
    targetActive: false
  }

  return Object.assign(
    {
      budget: 1,
      cap: 4,
      evictions: 1,
      records: 1,
      recordId: 'aa',
      recordLength: 1,
      idleVictimOpen: true,
      dependencyDelivered: false,
      expectedStalled: true,
      reclaimAttempt: reclaimAttemptFixture(),
      recordSamples: [0, 1, 1, 1, 1],
      quietBefore: before,
      quietAfter: { ...before }
    },
    overrides
  )
}

test('bounded saturated ledger with retained obligation and no churn passes', () => {
  assert.strictEqual(verifySaturation(saturationFixture()).ok, true)
})

test('a saturation run that silently grows past its metadata budget fails', () => {
  assert.throws(
    () => verifySaturation(saturationFixture({ recordSamples: [0, 1, 2, 2] })),
    /metadata budget/
  )
})

test('saturation without an actual pressure eviction fails', () => {
  assert.throws(
    () => verifySaturation(saturationFixture({ evictions: 0, recordSamples: [0] })),
    /actual pressure eviction/
  )
})

test('saturation that delivered the blocked dependency was not stalled', () => {
  assert.throws(
    () => verifySaturation(saturationFixture({ dependencyDelivered: true })),
    /expected stall/
  )
})

test('refuse-driven open/close/drain spin during the quiet window fails', () => {
  const state = saturationFixture()
  state.quietAfter = { ...state.quietBefore, drains: state.quietBefore.drains + 1 }
  assert.throws(() => verifySaturation(state), /drain/)
})

test('new evictions during the quiet window fail saturation', () => {
  const state = saturationFixture()
  state.quietAfter = { ...state.quietBefore, evictions: state.quietBefore.evictions + 1 }
  assert.throws(() => verifySaturation(state), /evictions/)
})

test('a discarded or replaced obligation fails saturation', () => {
  const dropped = saturationFixture({ records: 0 })
  assert.throws(() => verifySaturation(dropped), /obligation/)

  const replaced = saturationFixture({ recordId: 'bb' })
  assert.throws(() => verifySaturation(replaced), /obligation/)
})

test('saturation needs an otherwise idle victim to prove the metadata limit', () => {
  assert.throws(() => verifySaturation(saturationFixture({ idleVictimOpen: false })), /idle victim/)
})

test('saturation needs a real budget-refused dependency reclaim attempt', () => {
  assert.throws(
    () => verifySaturation(saturationFixture({ reclaimAttempt: undefined })),
    /reclaim attempt/
  )

  assert.throws(
    () =>
      verifySaturation(
        saturationFixture({ reclaimAttempt: reclaimAttemptFixture({ victim: { id: 'v' } }) })
      ),
    /refus/
  )
})

test('the reclaim attempt must run at the full budget and session cap', () => {
  assert.throws(
    () =>
      verifySaturation(
        saturationFixture({ reclaimAttempt: reclaimAttemptFixture({ recordsAtAttempt: 0 }) })
      ),
    /budget/
  )
  assert.throws(
    () =>
      verifySaturation(
        saturationFixture({ reclaimAttempt: reclaimAttemptFixture({ activeAtAttempt: 3 }) })
      ),
    /cap/
  )
})

test('the reclaim attempt must demand the unsatisfied hidden dependency link', () => {
  assert.throws(
    () =>
      verifySaturation(
        saturationFixture({
          reclaimAttempt: reclaimAttemptFixture({
            demand: { id: 'hidden', length: 1, applied: 1, satisfied: true }
          })
        })
      ),
    /dependency/
  )

  assert.throws(
    () =>
      verifySaturation(
        saturationFixture({ reclaimAttempt: reclaimAttemptFixture({ blockAvailable: false }) })
      ),
    /block|available/
  )

  assert.throws(
    () =>
      verifySaturation(
        saturationFixture({ reclaimAttempt: reclaimAttemptFixture({ link: null }) })
      ),
    /link/
  )
})

test('the budget refusal must have a fully revalidated idle alternative', () => {
  assert.throws(
    () =>
      verifySaturation(
        saturationFixture({ reclaimAttempt: reclaimAttemptFixture({ eligible: [] }) })
      ),
    /idle alternative/
  )

  assert.throws(
    () =>
      verifySaturation(
        saturationFixture({
          reclaimAttempt: reclaimAttemptFixture({
            eligible: [{ id: 'idle', applied: 1, core: 1, hinted: 1, revalidated: false }]
          })
        })
      ),
    /revalidated/
  )
})

// ---------------------------------------------------------------------------
// latest application state: presence and bytes, through the real tryVerify

function fakeAuto({ history, lengths, latest, clock }) {
  return {
    view: {
      *createReadStream() {
        for (let i = 0; i < history.length; i++) {
          yield {
            key: b4a.from('#' + String(i).padStart(6, '0')),
            value: b4a.from(history[i])
          }
        }
      },
      get(key) {
        if (b4a.equals(key, b4a.from('latest'))) {
          return latest === undefined || latest === null ? null : { value: b4a.from(latest) }
        }
        if (b4a.equals(key, b4a.from('clock'))) {
          return clock === undefined || clock === null ? null : { value: b4a.from(clock) }
        }
        return null
      }
    },
    system: {
      get(key) {
        return { length: lengths.get(b4a.toString(key, 'hex')) || 0 }
      }
    },
    writers: { active: new Map(), _reclaimed: new Map() }
  }
}

function tryVerifyRunner(options = {}) {
  const {
    history = ['aa.1'],
    ledger = [['aa', 1]],
    latest = 'payload-1',
    clock = '0',
    referenceLatest = latest,
    readerLatest = latest,
    referenceClock = clock,
    readerClock = clock
  } = options

  const runner = new SoakRunner(resolveConfig({ SOAK_PROFILE: 'smoke' }))
  for (const [key, length] of ledger) {
    runner.ledger.record(key, length, { author: key, seq: length })
  }
  runner.identityKeys = [b4a.from('aa', 'hex')]
  runner.adminKey = b4a.from('bb', 'hex')

  const lengths = new Map([
    ['aa', ledger.length === 0 ? 0 : 1],
    ['bb', 0]
  ])
  runner.reference = fakeAuto({ history, lengths, latest: referenceLatest, clock: referenceClock })
  runner.reader = fakeAuto({ history, lengths, latest: readerLatest, clock: readerClock })
  return runner
}

test('tryVerify accepts matching latest and clock presence and bytes', async () => {
  const result = await tryVerifyRunner().tryVerify()

  assert.strictEqual(result.ok, true)
  assert.deepStrictEqual(result.applicationState, { latest: 'payload-1', clock: '0', empty: false })
})

test('tryVerify rejects a reader missing the latest application value', async () => {
  const result = await tryVerifyRunner({ readerLatest: null }).tryVerify()

  assert.strictEqual(result.ok, false)
  assert.match(result.error, /latest.*missing|missing.*latest/i)
})

test('tryVerify rejects a reference missing the latest application value', async () => {
  const result = await tryVerifyRunner({ referenceLatest: null }).tryVerify()

  assert.strictEqual(result.ok, false)
  assert.match(result.error, /latest.*missing|missing.*latest/i)
})

test('tryVerify rejects different latest bytes even when both are present', async () => {
  const result = await tryVerifyRunner({ readerLatest: 'payload-2' }).tryVerify()

  assert.strictEqual(result.ok, false)
  assert.match(result.error, /latest.*differ/i)
})

test('tryVerify rejects a missing clock like it rejects a missing latest', async () => {
  const missingReader = await tryVerifyRunner({ readerClock: null }).tryVerify()
  assert.strictEqual(missingReader.ok, false)
  assert.match(missingReader.error, /clock.*missing|missing.*clock/i)

  const missingReference = await tryVerifyRunner({ referenceClock: null }).tryVerify()
  assert.strictEqual(missingReference.ok, false)
  assert.match(missingReference.error, /clock.*missing|missing.*clock/i)
})

test('tryVerify rejects different clock bytes even when both are present', async () => {
  const result = await tryVerifyRunner({ readerClock: '1' }).tryVerify()

  assert.strictEqual(result.ok, false)
  assert.match(result.error, /clock.*differ/i)
})

test('tryVerify permits both absent only for the empty fixture contract', async () => {
  const empty = await tryVerifyRunner({
    history: [],
    ledger: [],
    latest: null,
    clock: null
  }).tryVerify()
  assert.strictEqual(empty.ok, true)
  assert.deepStrictEqual(empty.applicationState, { latest: null, clock: null, empty: true })

  const oneSided = await tryVerifyRunner({
    history: [],
    ledger: [],
    latest: null,
    clock: null,
    readerLatest: 'leftover'
  }).tryVerify()
  assert.strictEqual(oneSided.ok, false)
  assert.match(oneSided.error, /latest.*missing|missing.*latest/i)
})

test('a non-empty applied history may not omit the latest application value', async () => {
  const result = await tryVerifyRunner({
    latest: null,
    referenceLatest: null,
    readerLatest: null
  }).tryVerify()

  assert.strictEqual(result.ok, false)
  assert.match(result.error, /latest.*missing|missing.*latest/i)
})

// ---------------------------------------------------------------------------
// victim-specific autonomous retry proof

test('a generic admission or handoff cannot satisfy the victim retry proof', () => {
  for (const field of [
    'victimRetryAdmissions',
    'victimRetryHandoffs',
    'victimRetryHandoffLength2',
    'victimHandoffLength2'
  ]) {
    const coverage = completePhaseCoverage()
    coverage[field] = 0
    assert.throws(() => verifyPhaseCoverage(coverage), new RegExp(field))
  }
})

test('a victim admitted or advanced outside the remembered retry cannot pass', () => {
  const admitted = completePhaseCoverage()
  admitted.victimNonRetryAdmissions = 1
  assert.throws(() => verifyPhaseCoverage(admitted), /retry/)

  const advanced = completePhaseCoverage()
  advanced.victimPositiveAdvancesAfterIsolation = 1
  assert.throws(() => verifyPhaseCoverage(advanced), /ingress|advance/i)

  const lost = completePhaseCoverage()
  lost.victimMaxLossAfterIsolation = 1
  assert.throws(() => verifyPhaseCoverage(lost), /baseline|max|lost|isolation/i)
})

function fakeCaptureWriters(id, length = 2) {
  const key = b4a.from(id, 'hex')
  const auto = {
    // Keep the controlled local writer distinct from the reclaimed victim so a
    // disappeared record cannot look like a legitimate local handoff.
    local: { key: b4a.alloc(32, 0x7f), length: 0 },
    key,
    _handlers: {},
    _maxReclaimedWriters: 1024,
    system: {},
    emit() {}
  }
  const writers = new ActiveWriters(auto)
  writers._reclaimed.set(id, { key, length })
  return writers
}

function captureRunner(id) {
  const runner = new SoakRunner(resolveConfig({ SOAK_PROFILE: 'smoke' }))
  const writers = fakeCaptureWriters(id)
  const reader = { writers, _flushWakeup: () => {} }
  runner.reader = reader
  runner.instrumentReader(reader)
  runner.pressureVictimId = id
  runner.beginVictimIsolation(id)
  return { runner, writers, reader }
}

test('raw capture after isolation catches a reduced max restored by fresh ingress', () => {
  const id = 'ab'.repeat(32)
  const { runner, writers } = captureRunner(id)
  const key = b4a.from(id, 'hex')

  // Negative control: the remembered maximum is reduced after the isolation
  // baseline, then a fresh raw positive announcement restores it. The late
  // wakeup observer cannot see the lost maximum; the raw capture guard must.
  writers._reclaimed.get(id).length = 1
  writers.captureReclaimedAnnouncements([{ key, length: 2 }])

  assert.strictEqual(runner.events.victimFreshIngressAfterIsolation, 1)
  assert.strictEqual(runner.events.victimMaxLossAfterIsolation, 1)

  runner.finishVictimIsolationProof()
  assert.strictEqual(runner.coverage.victimPositiveAdvancesAfterIsolation, 1)
  assert.strictEqual(runner.coverage.victimMaxLossAfterIsolation, 1)

  const coverage = completePhaseCoverage()
  coverage.victimPositiveAdvancesAfterIsolation =
    runner.coverage.victimPositiveAdvancesAfterIsolation
  coverage.victimMaxLossAfterIsolation = runner.coverage.victimMaxLossAfterIsolation
  assert.throws(() => verifyPhaseCoverage(coverage), /ingress|advance|baseline|max/i)
})

test('a same-length queued duplicate after isolation is not fresh repair evidence', () => {
  const id = 'cd'.repeat(32)
  const { runner, writers } = captureRunner(id)
  const key = b4a.from(id, 'hex')

  writers.captureReclaimedAnnouncements([{ key, length: 2 }])
  writers.captureReclaimedHints([[id, 2]])

  assert.strictEqual(runner.events.victimFreshIngressAfterIsolation, 0)
  assert.strictEqual(runner.events.victimMaxLossAfterIsolation, 0)

  runner.finishVictimIsolationProof()
  assert.strictEqual(runner.coverage.victimPositiveAdvancesAfterIsolation, 0)
  assert.strictEqual(runner.coverage.victimMaxLossAfterIsolation, 0)

  const coverage = completePhaseCoverage()
  coverage.victimPositiveAdvancesAfterIsolation = 0
  coverage.victimMaxLossAfterIsolation = 0
  assert.strictEqual(verifyPhaseCoverage(coverage).ok, true)
})

// ---------------------------------------------------------------------------
// active deadline: refuse new appends, permit in-flight completion

function fakeAuthor(seedByte, onAppend) {
  return {
    local: { key: b4a.alloc(32, seedByte), length: 0 },
    calls: 0,
    append(blocks) {
      this.calls++
      if (onAppend) onAppend()
      this.local.length += blocks.length
    }
  }
}

test('an append may not start at or after the active deadline', async () => {
  const runner = new SoakRunner(resolveConfig({ SOAK_PROFILE: 'smoke' }))
  runner.activeDeadline = 5000
  runner.now = () => 5000
  const author = fakeAuthor(1)

  await assert.rejects(
    runner.appendBatch(author, 'expired', [{ op: 'late' }], { kind: 'test' }),
    /active deadline/
  )
  assert.strictEqual(author.calls, 0)
  assert.strictEqual(runner.ledger.expected.size, 0)
})

test('an append that started before the deadline may complete late and is labelled', async () => {
  const runner = new SoakRunner(resolveConfig({ SOAK_PROFILE: 'smoke' }))
  let clock = 4999
  runner.now = () => clock
  runner.activeDeadline = 5000
  const author = fakeAuthor(2, () => {
    clock = 5001
  })

  const result = await runner.appendBatch(author, 'in-flight', [{ op: 'ok' }], { kind: 'test' })

  assert.strictEqual(result.end, 1)
  assert.strictEqual(runner.ledger.expected.size, 1)
  assert.strictEqual(runner.coverage.lateAppendCompletions, 1)
})

test('a healthy append inside the active window is not labelled late', async () => {
  const runner = new SoakRunner(resolveConfig({ SOAK_PROFILE: 'smoke' }))
  runner.now = () => 100
  runner.activeDeadline = 5000

  await runner.appendBatch(fakeAuthor(3), 'in-window', [{ op: 'ok' }], { kind: 'test' })

  assert.strictEqual(runner.coverage.lateAppendCompletions, 0)
})

test('the full configured duration is the workload period, not a reduced window', () => {
  const smoke = resolveConfig({ SOAK_PROFILE: 'smoke' })
  const soak = resolveConfig({})

  assert.strictEqual(smoke.durationMs, 60000)
  assert.strictEqual(soak.durationMs, 600000)
  assert.strictEqual(smoke.scenarioAllowanceMs, smoke.durationMs)
  assert.strictEqual(soak.scenarioAllowanceMs, soak.durationMs)
  assert.strictEqual(smoke.mergeReserveMs, undefined)
  assert.strictEqual(soak.mergeReserveMs, undefined)
})

test('the merge closeout is explicit, bounded and inside the drain allowance', () => {
  const smoke = resolveConfig({ SOAK_PROFILE: 'smoke' })
  const soak = resolveConfig({})

  assert.ok(smoke.mergeCloseoutMs > 0)
  assert.strictEqual(smoke.mergeCloseoutMs, soak.mergeCloseoutMs)
  assert.ok(smoke.mergeCloseoutMs <= smoke.drainAllowanceMs)
  assert.strictEqual(resolveConfig({ SOAK_PROFILE: 'saturation' }).mergeCloseoutMs, 0)
})

test('workload appends stop at the churn cutoff but the final merge may use closeout', async () => {
  const runner = new SoakRunner(resolveConfig({ SOAK_PROFILE: 'smoke' }))
  runner.activeDeadline = 5000
  runner.churnDeadline = 5000
  runner.mergeDeadline = 8000
  runner.now = () => 6000
  const author = fakeAuthor(4)

  await assert.rejects(
    runner.appendBatch(author, 'late-workload', [{ op: 'cohort' }], { kind: 'churn' }),
    /workload|churn|deadline|closeout/i
  )
  assert.strictEqual(author.calls, 0)

  const result = await runner.appendBatch(author, 'final-merge', [{ op: 'final-merge' }], {
    kind: 'final-merge'
  })
  assert.strictEqual(result.end, 1)
  assert.strictEqual(runner.coverage.mergeAppendsStartedInCloseout, 1)
})

test('the final merge may not start at or after its own hard deadline', async () => {
  const runner = new SoakRunner(resolveConfig({ SOAK_PROFILE: 'smoke' }))
  runner.activeDeadline = 5000
  runner.churnDeadline = 5000
  runner.mergeDeadline = 8000
  runner.now = () => 8000
  const author = fakeAuthor(5)

  await assert.rejects(
    runner.appendBatch(author, 'final-merge', [{ op: 'final-merge' }], { kind: 'final-merge' }),
    /closeout|merge|deadline/i
  )
  assert.strictEqual(author.calls, 0)
})

test('the deadline guard checks the payload kind, not a spoofed closeout label', async () => {
  const runner = new SoakRunner(resolveConfig({ SOAK_PROFILE: 'smoke' }))
  runner.activeDeadline = 5000
  runner.churnDeadline = 5000
  runner.mergeDeadline = 8000
  runner.now = () => 1000
  const author = fakeAuthor(6)

  await assert.rejects(
    runner.appendBatch(author, 'spoof', [{ op: 'cohort' }], { kind: 'final-merge' }),
    /payload|kind|final-merge/i
  )
  assert.strictEqual(author.calls, 0)
})

// ---------------------------------------------------------------------------
// workload cutoff transition: a real round may stop only at its own boundary
// and hand over to the existing final closeout. It may never start an append at
// or after the cutoff, and every other error still fails the run.

function cohortPlan(isLast) {
  return {
    isLast,
    readerRestart: false,
    writerRestart: false,
    readerPartition: false,
    writerPartition: false
  }
}

function cohortLeaf(index, clock, hooks = {}) {
  const key = b4a.alloc(32, index + 1)
  const leaf = {
    local: { key, length: 0, id: b4a.toString(key, 'hex') },
    writable: true,
    updates: 0,
    appends: [],
    update() {
      leaf.updates++
      if (!hooks.update) return Promise.resolve()
      return hooks.update(leaf, clock)
    },
    append(blocks) {
      const op = JSON.parse(b4a.toString(blocks[0])).op
      leaf.appends.push({ at: clock.now, op })
      if (hooks.append) return hooks.append(leaf, blocks, clock)
      leaf.local.length += blocks.length
      return Promise.resolve()
    },
    close: () => Promise.resolve(),
    system: { get: () => Promise.resolve({ length: 1e9 }) }
  }
  return leaf
}

// The runner's own real methods run. Only external I/O boundaries are stubbed:
// identities/leaves, the hub's length oracle, the settled checkpoint (a
// sentinel) and leaf close (a sentinel).
function cohortRunner({ indices, cutoff, clock, hooks = {} }) {
  const runner = new SoakRunner(resolveConfig({ SOAK_PROFILE: 'smoke' }))
  runner.identityKeys = indices.map((index) => b4a.alloc(32, index + 1))
  runner.now = () => clock.now
  runner.startActiveWindow(cutoff - runner.config.durationMs)
  const lengthOracle = { system: { heads: [], get: () => Promise.resolve({ length: 1e9 }) } }
  runner.hub = lengthOracle
  runner.reference = lengthOracle
  runner.links = { size: 0, unlink: () => Promise.resolve() }
  runner.rng = { int: (min) => min }
  runner.log = () => {}

  const observed = { rounds: [], checkpoints: [], closed: [], result: null }
  runner.checkpoint = (label) => {
    observed.checkpoints.push(label)
    runner.coverage.settledCheckpoints++
    return Promise.resolve()
  }
  runner.closeLeaf = (index) => {
    observed.closed.push(index)
    return Promise.resolve()
  }

  const leaves = {}
  for (const index of indices) leaves[index] = cohortLeaf(index, clock, hooks[index])
  runner.openIdentity = (index) => Promise.resolve(leaves[index])

  // Record the real round result so the integration test observes what the
  // real caller received, without replacing the round itself.
  const realRound = runner.authorCohortRound.bind(runner)
  runner.authorCohortRound = async (...args) => {
    const result = await realRound(...args)
    observed.rounds.push(result)
    return result
  }

  return { runner, leaves, observed }
}

async function withCohortClock(clock, fn) {
  const realNow = Date.now
  Date.now = () => clock.now
  try {
    return await fn()
  } finally {
    Date.now = realNow
  }
}

function assertNoLateWorkloadAppend(leaves, cutoff) {
  for (const leaf of Object.values(leaves)) {
    for (const append of leaf.appends) {
      if (append.op === 'final-merge') continue
      assert.ok(
        append.at < cutoff,
        'workload append ' + append.op + ' started at ' + append.at + ', cutoff ' + cutoff
      )
    }
  }
}

test('a workload round stops at the cutoff and runCohort reaches the final closeout', async () => {
  const cutoff = 1_000_000
  const clock = { now: cutoff - 10 }
  const hooks = {
    0: {
      update: (leaf, clock) => {
        if (leaf.updates > 1) clock.now += 1
      }
    },
    1: {
      update: (leaf, clock) => {
        if (leaf.updates === 2) clock.now += 1
        if (leaf.updates === 3) clock.now += 7
      }
    },
    2: {
      update: (leaf, clock) => {
        if (leaf.updates === 2) clock.now += 1
      }
    }
  }
  const { runner, leaves, observed } = cohortRunner({ indices: [0, 1, 2], cutoff, clock, hooks })

  const result = await withCohortClock(clock, () =>
    runner.runCohort(0, [0, 1, 2], cutoff, cohortPlan(true))
  )

  // The first round authored every identity; the second round stopped at the
  // cutoff after its first append was already accepted.
  assert.strictEqual(observed.rounds.length, 2)
  assert.strictEqual(observed.rounds[0].completed, true)
  assert.strictEqual(observed.rounds[1].completed, false)
  assert.strictEqual(observed.rounds[1].stopped, true)
  assert.strictEqual(observed.rounds[1].authored, 1)

  assertNoLateWorkloadAppend(leaves, cutoff)
  assert.deepStrictEqual(leaves[1].appends, [{ at: cutoff - 8, op: 'cohort' }])
  assert.strictEqual(leaves[2].updates, 2, 'round 2 must not touch the next leaf')

  // Every acknowledged operation stays in the independent ledger and the
  // existing final merge/checkpoint closeout actually ran.
  assert.strictEqual(runner.ledger.expected.size, 5)
  assert.deepStrictEqual(
    runner.ledger.ops.map((op) => op.kind),
    ['churn', 'churn', 'churn', 'churn', 'final-merge']
  )
  assert.deepStrictEqual(observed.checkpoints, ['cohort-0'])
  assert.deepStrictEqual(observed.closed, [0, 1, 2])
  assert.ok(runner.churnEndedAt >= cutoff)
  assert.ok(runner.mergeStartedAt >= cutoff)
  assert.ok(runner.mergeCompletedAt >= runner.mergeStartedAt)
  assert.strictEqual(runner.coverage.mergeAppendsStartedInCloseout, 1)
  assert.strictEqual(runner.coverage.lateAppendCompletions, 0)
  assert.deepStrictEqual(result, {
    readerRestartDone: false,
    writerRestartDone: false,
    readerPartitionDone: false
  })
})

test('a cutoff crossed between the round check and appendBatch starts no append', async () => {
  const cutoff = 1_000_000
  const clock = { now: cutoff - 10 }
  let armed = false
  const hooks = {
    0: {
      update: (leaf, clock) => {
        if (leaf.updates === 3) {
          clock.now = cutoff - 1
          armed = true
        }
      }
    },
    1: {
      update: (leaf, clock) => {
        if (leaf.updates === 2) clock.now += 1
      }
    }
  }
  const { runner, leaves, observed } = cohortRunner({ indices: [0, 1], cutoff, clock, hooks })
  // The round's caller-side check reads cutoff-1 and only the final appendBatch
  // guard reads the crossed clock, with no await in between.
  runner.now = () => {
    const value = clock.now
    if (armed) {
      armed = false
      clock.now = cutoff
    }
    return value
  }

  await withCohortClock(clock, () => runner.runCohort(0, [0, 1], cutoff, cohortPlan(true)))

  assert.strictEqual(observed.rounds.length, 2)
  assert.strictEqual(observed.rounds[0].completed, true)
  assert.strictEqual(observed.rounds[1].stopped, true)
  assert.strictEqual(observed.rounds[1].authored, 0)
  assertNoLateWorkloadAppend(leaves, cutoff)
  assert.deepStrictEqual(
    leaves[0].appends.filter((append) => append.op !== 'final-merge'),
    [{ at: cutoff - 10, op: 'cohort' }]
  )
  assert.strictEqual(leaves[1].appends.length, 1)
  assert.deepStrictEqual(observed.checkpoints, ['cohort-0'])
  assert.deepStrictEqual(
    runner.ledger.ops.map((op) => op.kind),
    ['churn', 'churn', 'final-merge']
  )
  assert.strictEqual(runner.coverage.mergeAppendsStartedInCloseout, 1)
})

test('an in-flight append completes after the cutoff and is retained with its label', async () => {
  const cutoff = 1_000_000
  const clock = { now: cutoff - 10 }
  const hooks = {
    0: {
      update: (leaf, clock) => {
        if (leaf.updates === 3) clock.now += 2
      },
      append: (leaf, blocks, clock) => {
        if (leaf.appends.length === 2) clock.now += 20
        leaf.local.length += blocks.length
      }
    },
    1: {
      update: (leaf, clock) => {
        if (leaf.updates === 2) clock.now += 1
      }
    }
  }
  const { runner, leaves, observed } = cohortRunner({ indices: [0, 1], cutoff, clock, hooks })

  await withCohortClock(clock, () => runner.runCohort(0, [0, 1], cutoff, cohortPlan(true)))

  assert.strictEqual(observed.rounds[1].stopped, true)
  assert.strictEqual(observed.rounds[1].authored, 1)
  assert.strictEqual(runner.coverage.lateAppendCompletions, 1)
  const late = runner.ledger.ops.filter((op) => op.startedAt < cutoff && op.completedAt >= cutoff)
  assert.strictEqual(late.length, 1)
  assert.strictEqual(late[0].kind, 'churn')
  assert.strictEqual(leaves[1].appends.length, 1, 'later workload was not started')
  assert.deepStrictEqual(observed.checkpoints, ['cohort-0'])
  assert.strictEqual(runner.mergeStartedAt >= cutoff, true)
  assert.strictEqual(runner.ledger.expected.size, 4)
})

test('an expired first round that did not author every identity still fails', async () => {
  const cutoff = 1_000_000
  const clock = { now: cutoff - 10 }
  const hooks = {
    0: {
      update: (leaf, clock) => {
        if (leaf.updates === 2) clock.now += 1
      }
    },
    1: {
      update: (leaf, clock) => {
        if (leaf.updates === 2) clock.now += 10
      }
    }
  }
  const { runner, leaves, observed } = cohortRunner({ indices: [0, 1, 2], cutoff, clock, hooks })

  let error = null
  await withCohortClock(clock, async () => {
    try {
      await runner.runCohort(0, [0, 1, 2], cutoff, cohortPlan(true))
    } catch (err) {
      error = err
    }
  })

  assert.ok(error instanceof PhaseError, 'expected a fatal PhaseError, got ' + String(error))
  assert.strictEqual(observed.rounds.length, 1)
  assert.strictEqual(observed.rounds[0].stopped, true)
  assert.strictEqual(observed.rounds[0].authored, 1)
  assert.deepStrictEqual(observed.checkpoints, [])
  assert.strictEqual(runner.mergeStartedAt, null)
  assert.strictEqual(runner.ledger.expected.size, 1)
  assert.strictEqual(leaves[2].updates, 1)
})

test('a non-final cohort that hits the cutoff cannot waive the remaining cohorts', async () => {
  const cutoff = 1_000_000
  const clock = { now: cutoff - 10 }
  const hooks = {
    0: {
      update: (leaf, clock) => {
        if (leaf.updates === 2) clock.now += 1
        if (leaf.updates === 3) clock.now += 20
      }
    },
    1: {
      update: (leaf, clock) => {
        if (leaf.updates === 2) clock.now += 1
      }
    }
  }
  const { runner, observed } = cohortRunner({ indices: [0, 1], cutoff, clock, hooks })

  let error = null
  await withCohortClock(clock, async () => {
    try {
      await runner.runCohort(0, [0, 1], cutoff, cohortPlan(false))
    } catch (err) {
      error = err
    }
  })

  assert.ok(error instanceof PhaseError, 'expected a fatal PhaseError, got ' + String(error))
  assert.strictEqual(observed.rounds.length, 2)
  assert.strictEqual(observed.rounds[1].stopped, true)
  assert.deepStrictEqual(observed.checkpoints, [])
  assert.strictEqual(runner.mergeStartedAt, null)
  assert.strictEqual(runner.ledger.expected.size, 2)
})

test('a round ending exactly at the cutoff exits between rounds into closeout', async () => {
  const cutoff = 1_000_000
  const clock = { now: cutoff - 10 }
  const hooks = {
    0: {
      update: (leaf, clock) => {
        if (leaf.updates === 2) clock.now += 1
      }
    },
    1: {
      update: (leaf, clock) => {
        if (leaf.updates === 2) clock.now += 8
      },
      append: (leaf, blocks, clock) => {
        clock.now += 1
        leaf.local.length += blocks.length
      }
    }
  }
  const { runner, leaves, observed } = cohortRunner({ indices: [0, 1], cutoff, clock, hooks })

  await withCohortClock(clock, () => runner.runCohort(0, [0, 1], cutoff, cohortPlan(true)))

  // This is the pre-existing between-round exit: the loop sees the cutoff at
  // its own boundary, so no round result contract is involved.
  assertNoLateWorkloadAppend(leaves, cutoff)
  assert.strictEqual(runner.coverage.lateAppendCompletions, 1)
  assert.deepStrictEqual(observed.checkpoints, ['cohort-0'])
  assert.strictEqual(runner.mergeStartedAt >= cutoff, true)
})

// Drive a real mandatory first round to completion, then fail the subsequent
// real round. The sentinel is thrown only from the later round's awaited
// leaf.update or from an append that has already passed the cutoff guard, so
// this exercises the round's genuine-error path rather than setup or the
// initial writable check.
async function runLaterRoundFailure(kind, sentinel) {
  const cutoff = 1_000_000
  const clock = { now: cutoff - 10 }
  const hooks = {}

  if (kind === 'update') {
    hooks[1] = {
      update: (leaf, clock) => {
        if (leaf.updates === 3) {
          clock.now = cutoff + 5
          throw sentinel
        }
      }
    }
  } else {
    hooks[1] = {
      append: (leaf, blocks, clock) => {
        if (leaf.appends.length === 2) {
          clock.now = cutoff + 5
          throw sentinel
        }
        leaf.local.length += blocks.length
      }
    }
  }

  const { runner, leaves, observed } = cohortRunner({ indices: [0, 1], cutoff, clock, hooks })
  let error = null
  await withCohortClock(clock, async () => {
    try {
      await runner.runCohort(0, [0, 1], cutoff, cohortPlan(true))
    } catch (err) {
      error = err
    }
  })

  return { error, runner, leaves, observed, clock, cutoff }
}

test('later-round update Error and PhaseError escape unchanged after the first round', async () => {
  const sentinels = [
    new Error('later leaf update exploded'),
    new PhaseError('later genuine phase failure')
  ]

  for (const sentinel of sentinels) {
    const { error, runner, observed, clock, cutoff } = await runLaterRoundFailure(
      'update',
      sentinel
    )

    assert.strictEqual(error, sentinel)
    assert.strictEqual(observed.rounds.length, 1)
    assert.strictEqual(observed.rounds[0].completed, true)
    assert.strictEqual(observed.rounds[0].authored, 2)
    assert.strictEqual(runner.ledger.expected.size, 3)
    assert.deepStrictEqual(
      runner.ledger.ops.map((op) => op.kind),
      ['churn', 'churn', 'churn']
    )
    assert.deepStrictEqual(observed.checkpoints, [])
    assert.deepStrictEqual(observed.closed, [])
    assert.strictEqual(runner.mergeStartedAt, null)
    assert.ok(clock.now >= cutoff)
  }
})

test('later-round append failure crossing the cutoff never becomes a graceful stop', async () => {
  const sentinels = [
    new Error('later append exploded'),
    new PhaseError('unrelated append phase failure')
  ]

  for (const sentinel of sentinels) {
    const { error, runner, leaves, observed, clock, cutoff } = await runLaterRoundFailure(
      'append',
      sentinel
    )

    assert.strictEqual(error, sentinel)
    assert.strictEqual(observed.rounds.length, 1)
    assert.strictEqual(observed.rounds[0].completed, true)
    assert.strictEqual(observed.rounds[0].authored, 2)
    assert.strictEqual(runner.ledger.expected.size, 3)
    assert.deepStrictEqual(
      runner.ledger.ops.map((op) => op.kind),
      ['churn', 'churn', 'churn']
    )
    assert.deepStrictEqual(observed.checkpoints, [])
    assert.deepStrictEqual(observed.closed, [])
    assert.strictEqual(runner.mergeStartedAt, null)
    assert.strictEqual(leaves[1].appends.length, 2)
    assert.ok(leaves[1].appends[1].at < cutoff)
    assert.strictEqual(leaves[1].local.length, 1, 'the failed append is not acknowledged')
    assert.ok(clock.now >= cutoff)
  }
})

test('a later-round append acknowledgement mismatch after the cutoff stays fatal', async () => {
  const cutoff = 1_000_000
  const clock = { now: cutoff - 10 }
  const hooks = {
    1: {
      append: (leaf, blocks, clock) => {
        if (leaf.appends.length === 2) {
          clock.now = cutoff + 5
          // Deliberately do not acknowledge the second-round blocks.
          return
        }
        leaf.local.length += blocks.length
      }
    }
  }
  const { runner, leaves, observed } = cohortRunner({ indices: [0, 1], cutoff, clock, hooks })
  let error = null
  await withCohortClock(clock, async () => {
    try {
      await runner.runCohort(0, [0, 1], cutoff, cohortPlan(true))
    } catch (err) {
      error = err
    }
  })

  assert.match(error && error.message, /acknowledgement mismatch/)
  assert.strictEqual(observed.rounds.length, 1)
  assert.strictEqual(observed.rounds[0].completed, true)
  assert.strictEqual(observed.rounds[0].authored, 2)
  assert.strictEqual(runner.ledger.expected.size, 3)
  assert.deepStrictEqual(
    runner.ledger.ops.map((op) => op.kind),
    ['churn', 'churn', 'churn']
  )
  assert.deepStrictEqual(observed.checkpoints, [])
  assert.deepStrictEqual(observed.closed, [])
  assert.strictEqual(runner.mergeStartedAt, null)
  assert.strictEqual(leaves[1].local.length, 1)
  assert.ok(clock.now >= cutoff)
})

// ---------------------------------------------------------------------------
// shared post-churn deadline: one absolute drain allowance for every recovery
// phase (merge closeout, propagation, leaf closes, checkpoints, final recovery)

test('all post-churn phases share one absolute recovery deadline', () => {
  const config = resolveConfig({ SOAK_PROFILE: 'smoke' })
  const runner = new SoakRunner(config)

  runner.startActiveWindow(1000)

  assert.strictEqual(runner.activeStart, 1000)
  assert.strictEqual(runner.activeDeadline, 1000 + config.durationMs)
  assert.strictEqual(runner.churnDeadline, runner.activeDeadline)
  assert.strictEqual(runner.mergeDeadline, runner.churnDeadline + config.mergeCloseoutMs)
  assert.strictEqual(runner.recoveryDeadline, runner.churnDeadline + config.drainAllowanceMs)
  // The final merge keeps its own earlier hard deadline inside the one shared
  // post-churn drain allowance.
  assert.ok(runner.mergeDeadline < runner.recoveryDeadline)
})

test('final recovery cannot get a fresh drain allowance after the shared deadline is spent', async () => {
  const config = resolveConfig({ SOAK_PROFILE: 'smoke' })
  const runner = new SoakRunner(config)
  runner.activeDeadline = 1000
  runner.churnDeadline = 1000
  runner.mergeDeadline = 1000 + config.mergeCloseoutMs
  runner.recoveryDeadline = 1000 + config.drainAllowanceMs
  runner.now = () => runner.recoveryDeadline + 5000
  let verifications = 0
  runner.tryVerify = () => {
    verifications++
    return Promise.resolve({ ok: true, entries: 0 })
  }

  // The merge/checkpoint already consumed the whole shared allowance. A fresh
  // drain allowance here would silently extend the contract by another 240 s.
  const started = Date.now()
  await assert.rejects(runner.finalRecovery(), /shared post-churn recovery deadline/i)
  assert.ok(Date.now() - started < 2000, 'spent budget must fail at once, not retry for 240 s')
  assert.strictEqual(verifications, 0)
  assert.strictEqual(runner.coverage.converged, false)
})

test('a held final recovery verification fails inside the shared deadline', async () => {
  const runner = new SoakRunner(resolveConfig({ SOAK_PROFILE: 'smoke' }))
  runner.recoveryDeadline = Date.now() + 300
  let calls = 0
  runner.tryVerify = () => {
    calls++
    return new Promise(() => {})
  }

  const started = Date.now()
  await assert.rejects(
    withTimeout(runner.finalRecovery(), 2000, 'a held final recovery await was not bounded'),
    /shared post-churn recovery deadline/i
  )
  const elapsed = Date.now() - started
  assert.strictEqual(calls, 1)
  assert.ok(elapsed >= 250, 'the held await must be given its real remaining budget')
  assert.ok(elapsed < 1500, 'the held await exceeded its bound after ' + elapsed + 'ms')
  assert.strictEqual(runner.coverage.converged, false)
})

test('a held settled checkpoint fails inside the shared deadline', async () => {
  const runner = new SoakRunner(resolveConfig({ SOAK_PROFILE: 'smoke' }))
  runner.recoveryDeadline = Date.now() + 300
  let calls = 0
  runner.tryVerify = () => {
    calls++
    return new Promise(() => {})
  }

  const started = Date.now()
  await assert.rejects(
    withTimeout(runner.checkpoint('held'), 2000, 'a held checkpoint await was not bounded'),
    /deadline/i
  )
  const elapsed = Date.now() - started
  assert.strictEqual(calls, 1)
  assert.ok(elapsed < 1500, 'the held checkpoint exceeded its bound after ' + elapsed + 'ms')
})

test('the absolute recovery watchdog is armed once at the shared recovery deadline', () => {
  const runner = new SoakRunner(resolveConfig({ SOAK_PROFILE: 'smoke' }))
  runner.recoveryDeadline = Date.now() + 60000

  try {
    runner.startRecoveryWatchdog()
    assert.notStrictEqual(runner.recoveryWatchdog, null)
    assert.strictEqual(runner.recoveryWatchdogFired, false)
    assert.throws(() => runner.startRecoveryWatchdog(), /already armed/i)
  } finally {
    runner.disarmRecoveryWatchdog()
  }

  assert.strictEqual(runner.recoveryWatchdog, null)
  assert.strictEqual(runner.recoveryWatchdogFired, false)
})

test('a successful completion disarms the recovery watchdog before bounded cleanup', async () => {
  const runner = new SoakRunner(resolveConfig({ SOAK_PROFILE: 'smoke' }))
  runner.links = fakeLinks()
  runner.recoveryDeadline = Date.now() + 60000
  runner.startRecoveryWatchdog()

  let armedDuringCleanup = null
  runner.cleanup = () => {
    runner.closeErrors = []
    armedDuringCleanup = runner.recoveryWatchdog
    return Promise.resolve()
  }

  const originalLog = console.log
  console.log = () => {}
  try {
    await runner.finishSuccessfulRun()
  } finally {
    console.log = originalLog
  }

  assert.strictEqual(
    armedDuringCleanup,
    null,
    'cleanup must begin with the watchdog already disarmed'
  )
  assert.strictEqual(runner.recoveryWatchdog, null)
  assert.strictEqual(runner.recoveryWatchdogFired, false)
})

test('a fired recovery watchdog cannot be disarmed or converted into a late success', async () => {
  const runner = new SoakRunner(resolveConfig({ SOAK_PROFILE: 'smoke' }))
  runner.links = fakeLinks()
  runner.recoveryWatchdogFired = true
  runner.recoveryWatchdogError = new Error('shared recovery watchdog expired')

  assert.strictEqual(runner.disarmRecoveryWatchdog(), false)
  assert.strictEqual(runner.recoveryWatchdogFired, true)
  assert.throws(
    () => runner.assertRecoveryWatchdogDidNotFire('late completion'),
    /watchdog already fired/i
  )

  let printedOk = false
  const originalLog = console.log
  console.log = () => {
    printedOk = true
  }
  try {
    await assert.rejects(runner.finishSuccessfulRun(), /watchdog already fired/i)
  } finally {
    console.log = originalLog
  }

  assert.strictEqual(printedOk, false)
  assert.strictEqual(runner.recoveryWatchdogFired, true)
})

// These three subprocesses hold an await that previously had no bound beyond
// the overall watchdog: the signed final merge append, the premerge head poll,
// and unlink plus leaf close. They arm the overall watchdog with a deliberately
// huge allowance, so only the separately owned recovery watchdog can make them
// fail inside the shared post-churn budget.
test('a held final merge append fails inside the shared recovery budget, not the overall watchdog', async () => {
  const result = await spawnRecoveryChild('final-merge', 3500)

  assert.strictEqual(
    result.timedOut,
    false,
    'the held final merge append waited for the overall watchdog'
  )
  assert.notStrictEqual(result.code, 0)
  assert.ok(result.elapsed < 3500, 'the held final merge append exceeded the shared budget')
  assert.match(result.stderr, /shared recovery watchdog/i)

  // The child must prove that it actually entered author.append with the final
  // merge payload before the shared deadline failed it. A watchdog failure on
  // its own only proves that some await was still pending, not which one.
  const entry = assertRecoveryChildEntryBeforeDeadline(result, 'final-merge-append')
  assert.strictEqual(entry.phase, 'cohort-0-close')
  assert.strictEqual(entry.payloadOp, 'final-merge')
  assert.strictEqual(entry.blocks, 1)
})

test('a held premerge preparation fails inside the shared recovery budget', async () => {
  const result = await spawnRecoveryChild('premerge', 3500)

  assert.strictEqual(
    result.timedOut,
    false,
    'the held premerge preparation waited for the overall watchdog'
  )
  assert.notStrictEqual(result.code, 0)
  assert.ok(result.elapsed < 3500, 'the held premerge preparation exceeded the shared budget')
  assert.match(result.stderr, /shared recovery watchdog/i)

  // The held update must be the real close-phase premerge preparation, not an
  // earlier workload update that happens to stay pending.
  const entry = assertRecoveryChildEntryBeforeDeadline(result, 'premerge-update')
  assert.strictEqual(entry.phase, 'cohort-0-close')
  assert.strictEqual(entry.updateCount, 2)
})

test('unlink plus close exhaustion fails inside the shared recovery budget', async () => {
  const result = await spawnRecoveryChild('close', 4300)

  assert.strictEqual(result.timedOut, false, 'stale close allowance outlived the overall watchdog')
  assert.notStrictEqual(result.code, 0)
  assert.ok(result.elapsed < 4300, 'unlink plus close exceeded the shared budget')
  assert.match(result.stderr, /shared recovery watchdog|leaf close timed out/i)
})

test('a successful run clears the recovery watchdog before bounded cleanup and exits naturally', async () => {
  const result = await spawnRecoveryChild('success', 3000)

  assert.strictEqual(result.timedOut, false)
  assert.strictEqual(result.code, 0, result.stderr)
  assert.match(result.stdout, /"ok": true/)
  assert.match(result.stdout, /success-child-cleanup-timer-armed=false/)
  assert.match(result.stdout, /success-child-terminal-guard-armed=false/)
})

test('a final verification that settles after the shared deadline cannot pass', async () => {
  const runner = new SoakRunner(resolveConfig({ SOAK_PROFILE: 'smoke' }))
  let clock = 100000
  let calls = 0
  runner.now = () => clock
  runner.recoveryDeadline = 100500
  runner.tryVerify = () => {
    calls++
    // The first verification still fits; the stability re-verification settles
    // after the absolute deadline and must be rejected after the await.
    clock += calls === 1 ? 100 : 500
    return Promise.resolve({ ok: true, entries: 7 })
  }

  await assert.rejects(runner.finalRecovery(), /shared post-churn recovery deadline/i)
  assert.strictEqual(calls, 2)
  assert.strictEqual(runner.coverage.converged, false)
  assert.strictEqual(runner.coverage.settledCheckpoints, 0)
})

// ---------------------------------------------------------------------------
// teardown: release the real pressure gate and report close failures

function fakeLinks() {
  return {
    size: 0,
    errors: [],
    labels: () => [],
    has: () => false,
    unlink: () => Promise.resolve(),
    closeAll: () => Promise.resolve()
  }
}

test('failure releases the real pressure flush gate before waiting for diagnostics', async () => {
  const runner = new SoakRunner(resolveConfig({ SOAK_PROFILE: 'saturation' }))
  runner.links = fakeLinks()
  const gate = createGate()
  runner.pressureFlushGate = gate
  let resolvedBeforeSnapshot = null
  runner.failureSnapshot = () => {
    resolvedBeforeSnapshot = gate.resolved
    return {}
  }

  const originalError = console.error
  console.error = () => {}
  try {
    await withTimeout(
      runner.handleFailure(new Error('injected async failure')),
      2000,
      'failure handling hung on the held pressure flush gate'
    )
  } finally {
    console.error = originalError
  }

  assert.strictEqual(resolvedBeforeSnapshot, true)
  assert.strictEqual(gate.resolved, true)
  assert.strictEqual(runner.pressureFlushGate, null)
})

test('releasing the pressure flush gate is idempotent and cleanup does it too', async () => {
  const runner = new SoakRunner(resolveConfig({ SOAK_PROFILE: 'saturation' }))
  runner.links = fakeLinks()
  const gate = createGate()
  runner.pressureFlushGate = gate

  runner.releasePressureFlushGate()
  runner.releasePressureFlushGate()
  assert.strictEqual(gate.resolved, true)
  assert.strictEqual(runner.pressureFlushGate, null)

  const cleanupGate = createGate()
  runner.pressureFlushGate = cleanupGate
  await runner.cleanup({ retainRoot: false, bestEffort: true })
  assert.strictEqual(cleanupGate.resolved, true)
  assert.strictEqual(runner.pressureFlushGate, null)
})

function spawnRecoveryChild(mode, timeoutMs = 3500) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [__filename], {
      env: { ...process.env, SOAK_RECOVERY_CHILD: mode },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const started = Date.now()
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr, timedOut, elapsed: Date.now() - started })
    })
  })
}

const RECOVERY_CHILD_ENTRY = 'RECOVERY-CHILD-ENTRY '

function recoveryChildLog(stdout, kind) {
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue
    try {
      const event = JSON.parse(line)
      if (event.kind === kind) return event
    } catch {
      // A partial or marker line is parsed separately below.
    }
  }
  return null
}

function recoveryChildEntry(stdout, op) {
  for (const line of stdout.split('\n')) {
    if (!line.startsWith(RECOVERY_CHILD_ENTRY)) continue
    try {
      const entry = JSON.parse(line.slice(RECOVERY_CHILD_ENTRY.length))
      if (entry.op === op) return entry
    } catch {
      return null
    }
  }
  return null
}

function assertRecoveryChildEntryBeforeDeadline(result, op) {
  const entry = recoveryChildEntry(result.stdout, op)
  assert.ok(
    entry,
    'child never emitted the held ' +
      op +
      ' entry marker; an unrelated await can produce the watchdog failure'
  )

  const armed = recoveryChildLog(result.stdout, 'recovery-watchdog-armed')
  const fired = recoveryChildLog(result.stdout, 'recovery-watchdog-fired')
  assert.ok(armed, 'child never logged the armed recovery watchdog')
  assert.ok(fired, 'child never logged the fired recovery watchdog')
  assert.ok(entry.t >= armed.t, 'held ' + op + ' entered before the recovery watchdog was armed')
  assert.ok(
    entry.t < armed.recoveryDeadline,
    'held ' + op + ' entered after the shared recovery deadline'
  )
  assert.ok(entry.t < fired.t, 'held ' + op + ' entry marker must precede the deadline failure')
  return entry
}

function recoveryChildConfig(overrides = {}) {
  const config = resolveConfig({ SOAK_PROFILE: 'smoke' })
  config.durationMs = 100
  config.drainAllowanceMs = 1500
  config.mergeCloseoutMs = 30000
  config.cleanupAllowanceMs = 100
  // Deliberately far beyond the shared recovery budget: a failure inside it
  // cannot be attributed to the overall watchdog.
  config.totalAllowanceMs = 600000
  return Object.assign(config, overrides)
}

function recoveryChildHub() {
  return {
    local: { length: 0 },
    system: {
      heads: [],
      version: 0,
      get() {
        return Promise.resolve({ length: 0 })
      }
    },
    stats: {},
    close() {
      return Promise.resolve()
    }
  }
}

function recoveryChildLeaf(
  index,
  { holdUpdateAfter = null, holdAppend = false } = {},
  context = {}
) {
  let updates = 0
  const phase = () => (context.phase ? context.phase() : 'unknown')
  const markEntry = (entry) => {
    console.log(RECOVERY_CHILD_ENTRY + JSON.stringify({ t: Date.now(), phase: phase(), ...entry }))
  }

  return {
    local: { key: b4a.alloc(32, index + 1), length: 0 },
    writable: true,
    update() {
      updates++
      if (holdUpdateAfter !== null && updates >= holdUpdateAfter) {
        markEntry({ op: 'premerge-update', updateCount: updates })
        return new Promise(() => {})
      }
      return Promise.resolve()
    },
    close() {
      return Promise.resolve()
    },
    system: {
      get() {
        return Promise.resolve({ length: 0 })
      }
    },
    append(blocks) {
      if (holdAppend) {
        let payloadOp = null
        try {
          payloadOp = JSON.parse(b4a.toString(blocks[0])).op
        } catch {
          payloadOp = 'unparseable'
        }
        markEntry({ op: 'final-merge-append', payloadOp, blocks: blocks.length })
        return new Promise(() => {})
      }
      this.local.length += blocks.length
      return Promise.resolve()
    }
  }
}

function startRecoveryChildWindow(runner) {
  // The overall watchdog is started with the huge child allowance above. The
  // keepalive interval represents the live replication handles of a real run:
  // an old unbounded await must hang rather than let the event loop empty.
  runner.startWatchdog()
  runner.startActiveWindow(Date.now() - 100)
  if (typeof runner.startRecoveryWatchdog === 'function') runner.startRecoveryWatchdog()
  runner.keepalive = setInterval(() => {}, 1000)
}

async function runRecoveryCohortChild(hold) {
  const runner = new SoakRunner(recoveryChildConfig())
  startRecoveryChildWindow(runner)

  runner.identityKeys = [b4a.alloc(32, 9)]
  runner.hub = recoveryChildHub()
  runner.openIdentity = (index) =>
    Promise.resolve(recoveryChildLeaf(index, hold, { phase: () => runner.phase }))
  // The workload itself is unrelated churn. Empty it so no earlier workload
  // append/update can trip the churn cutoff or satisfy the held operation; the
  // close-phase closer.update() and final-merge append remain the real runtime
  // paths under test.
  runner.authorCohortRound = () =>
    Promise.resolve({ completed: true, stopped: false, round: 1, authored: 0 })
  // Keep the setup sleep short without changing the runner's own thresholds.
  runner.rng = { int: (min) => min }

  const plan = {
    isLast: true,
    readerRestart: false,
    writerRestart: false,
    readerPartition: false,
    writerPartition: false
  }
  // Leave a small real active window: runCohort refuses to open after its end,
  // then the close phase reaches the held update/append well inside the 1500 ms
  // shared recovery allowance. Fifty milliseconds lets at most one churn-loop
  // iteration run; the earlier 100 ms fixture reached round 4 and slept 2000 ms
  // before the close phase, so the watchdog fired without entering the hold.
  await runner.runCohort(0, [0], Date.now() + 50, plan)
  console.log('recovery-child-unexpectedly-returned')
}

async function runRecoveryCloseChild() {
  const runner = new SoakRunner(recoveryChildConfig({ drainAllowanceMs: 3000 }))
  startRecoveryChildWindow(runner)

  runner.links = {
    size: 1,
    errors: [],
    labels: () => ['held-edge'],
    has: () => true,
    unlink: () => sleep(2000),
    closeAll: () => Promise.resolve()
  }
  runner.leaves.set(0, 'held-edge')
  runner.liveLeaves.set(0, {
    close() {
      return new Promise(() => {})
    }
  })

  try {
    const timeoutMs = runner.recoveryBound('leaf close', 20000)
    await runner.closeLeaf(0, { timeoutMs })
    console.log('recovery-child-unexpectedly-returned')
  } catch (err) {
    runner.forceFailure(err)
  }
}

async function runRecoverySuccessChild() {
  const config = recoveryChildConfig({ cleanupAllowanceMs: 1000, totalAllowanceMs: 5000 })
  const runner = new SoakRunner(config)
  runner.links = {
    size: 0,
    errors: [],
    labels: () => [],
    has: () => false,
    unlink: () => Promise.resolve(),
    closeAll: () => Promise.resolve()
  }
  runner.recoveryDeadline = Date.now() + 300
  // The overall terminal guard must also be clear on success. If it remained
  // referenced after finishSuccessfulRun, this child would stay alive for its
  // full allowance and the parent timeout would kill it instead of a natural
  // code 0 exit.
  runner.startWatchdog()
  if (typeof runner.startRecoveryWatchdog === 'function') runner.startRecoveryWatchdog()

  let armedDuringCleanup = null
  runner.cleanup = async () => {
    runner.closeErrors = []
    armedDuringCleanup = Boolean(runner.recoveryWatchdog)
    // Settle well after the armed deadline: an uncleared watchdog would fire
    // during this independently bounded cleanup instead of letting success
    // exit naturally.
    await sleep(600)
  }

  await runner.finishSuccessfulRun()
  console.log('success-child-cleanup-timer-armed=' + String(armedDuringCleanup))
  console.log('success-child-terminal-guard-armed=' + String(Boolean(runner.watchdog)))
}

function runRecoveryChild(mode) {
  if (mode === 'final-merge') return runRecoveryCohortChild({ holdAppend: true })
  if (mode === 'premerge') return runRecoveryCohortChild({ holdUpdateAfter: 2 })
  if (mode === 'close') return runRecoveryCloseChild()
  if (mode === 'success') return runRecoverySuccessChild()
  throw new Error('unknown recovery child mode ' + JSON.stringify(mode))
}

function spawnFailureChild(timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [__filename], {
      env: { ...process.env, SOAK_FAILURE_CHILD: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr, timedOut })
    })
  })
}

async function runFailureChild() {
  const config = resolveConfig({ SOAK_PROFILE: 'smoke' })
  config.cleanupAllowanceMs = 100
  const runner = new SoakRunner(config)
  runner.failureExitMs = 300
  runner.runSoak = () => {
    throw new Error('ordinary failure with a retained live handle')
  }
  // A close operation that never settles is the cleanup deadline the failure
  // path must bound; the interval is a genuinely retained live handle.
  runner.cleanup = () => new Promise(() => {})
  setInterval(() => {}, 1000)

  const code = await runner.run()
  process.exitCode = code
  console.log('ordinary-failure-handling-returned')
}

const TERMINAL_GUARD_CHILD_ENTRY = 'TERMINAL-GUARD-CHILD-ENTRY '

function terminalGuardChildConfig(mode) {
  const profile = mode === 'saturation' ? 'saturation' : 'smoke'
  const config = resolveConfig({ SOAK_PROFILE: profile })
  // Keep the referenced terminal guard short enough for the parent timeout to
  // remain the only outer bound, while leaving room for setup instrumentation.
  config.totalAllowanceMs = 900
  config.cleanupAllowanceMs = 100
  return config
}

async function runTerminalGuardChild(mode) {
  const runner = new SoakRunner(terminalGuardChildConfig(mode))
  const hold = () => {
    console.log(
      TERMINAL_GUARD_CHILD_ENTRY + JSON.stringify({ t: Date.now(), phase: runner.phase, mode })
    )
    return new Promise(() => {})
  }

  if (mode === 'setup') {
    runner.setupPeers = hold
  } else if (mode === 'saturation') {
    runner.setupPeers = () => Promise.resolve()
    runner.setupSaturationIdentities = hold
  } else {
    throw new Error('unknown terminal guard child mode ' + JSON.stringify(mode))
  }

  process.exitCode = await runner.run()
}

function spawnTerminalGuardChild(mode, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [__filename], {
      env: { ...process.env, SOAK_TERMINAL_GUARD_CHILD: mode },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const started = Date.now()
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr, timedOut, elapsed: Date.now() - started })
    })
  })
}

function terminalGuardChildEntry(stdout) {
  for (const line of stdout.split('\n')) {
    if (!line.startsWith(TERMINAL_GUARD_CHILD_ENTRY)) continue
    try {
      return JSON.parse(line.slice(TERMINAL_GUARD_CHILD_ENTRY.length))
    } catch {
      return null
    }
  }
  return null
}

async function runTerminalGuardChildProcess(mode) {
  const result = await spawnTerminalGuardChild(mode)

  for (const line of result.stdout.split('\n')) {
    if (!line.startsWith('{')) continue
    try {
      const entry = JSON.parse(line)
      if (entry.kind === 'config' && entry.root) removeRunRoot(entry.root)
    } catch {}
  }

  return result
}

async function runFailureChildProcess() {
  const started = Date.now()
  const result = await spawnFailureChild(5000)
  const elapsed = Date.now() - started

  for (const line of result.stdout.split('\n')) {
    if (!line.startsWith('{')) continue
    try {
      const entry = JSON.parse(line)
      if (entry.kind === 'config' && entry.root) removeRunRoot(entry.root)
    } catch {}
  }

  return { ...result, elapsed }
}

test('ordinary failure with a retained live handle exits nonzero within a bound', async () => {
  const result = await runFailureChildProcess()

  assert.strictEqual(result.timedOut, false, 'ordinary failure hung on a retained live handle')
  assert.notStrictEqual(result.code, 0)
  assert.ok(result.elapsed < 5000, 'ordinary failure termination exceeded its bound')
  assert.match(result.stderr, /forced termination/i)
})

// These children have no artificial keepalive: an unresolved setup/saturation
// await must not leave the event loop empty. Only the runner's referenced
// terminal guard may keep the process alive until the bounded failure path.
for (const mode of ['setup', 'saturation']) {
  test('an unresolved ' + mode + ' await without a keepalive fails, not exit 0', async () => {
    const result = await runTerminalGuardChildProcess(mode)

    assert.strictEqual(result.timedOut, false, 'the ' + mode + ' child needed the parent timeout')
    assert.notStrictEqual(
      result.code,
      0,
      'the ' + mode + ' child exited 0 from an unresolved await with no live handle'
    )
    const entry = terminalGuardChildEntry(result.stdout)
    assert.ok(entry, 'the ' + mode + ' child never reached the named hold')
    assert.strictEqual(entry.phase, mode)
    assert.doesNotMatch(result.stdout, /"ok": true/)
    assert.doesNotMatch(result.stdout, /"kind": "(soak|saturation)-result"/)
    assert.match(result.stderr, /soak-failure/)
    assert.match(result.stderr, /overall soak watchdog expired/)
  })
}

test('an async failure during completion neither prints ok nor removes the failed root', async () => {
  const runner = new SoakRunner(resolveConfig({ SOAK_PROFILE: 'smoke' }))
  runner.links = fakeLinks()
  runner.root = createRunRoot()
  const root = runner.root
  runner.asyncError = new Error('edge failed before close')
  let printedOk = false

  const originalLog = console.log
  console.log = () => {
    printedOk = true
  }
  try {
    await assert.rejects(runner.finishSuccessfulRun())
  } finally {
    console.log = originalLog
  }

  assert.strictEqual(printedOk, false)
  assert.ok(fs.existsSync(root))
  removeRunRoot(root)
  runner.root = null
})

test('successful completion removes its own root and never calls process.exit', async () => {
  const runner = new SoakRunner(resolveConfig({ SOAK_PROFILE: 'smoke' }))
  runner.links = fakeLinks()
  runner.root = createRunRoot()
  const root = runner.root
  let exitCalled = false

  const originalExit = process.exit
  const originalLog = console.log
  process.exit = () => {
    exitCalled = true
  }
  console.log = () => {}
  try {
    await runner.finishSuccessfulRun()
  } finally {
    process.exit = originalExit
    console.log = originalLog
    if (fs.existsSync(root)) removeRunRoot(root)
  }

  assert.strictEqual(exitCalled, false)
  assert.strictEqual(fs.existsSync(root), false)
})

// ---------------------------------------------------------------------------
// stream close deadline, listener cleanup, close failures and expected errors

class FakeStream extends EventEmitter {
  constructor() {
    super()
    this.destroyed = false
    this.closed = false
  }

  pipe(other) {
    return other
  }

  destroy() {
    this.destroyed = true
    this.closed = true
    this.emit('close')
  }
}

class NonClosingStream extends FakeStream {
  destroy() {
    this.destroyed = true
  }
}

function fakeLinkRun() {
  const run = {
    failures: [],
    asyncError: null,
    log() {},
    checkBoundaries() {}
  }
  run.forceFailure = (err) => {
    run.failures.push(err)
  }
  return run
}

function linkAuto(stream) {
  return { replicate: () => stream }
}

test('closeStream rejects a non-closing stream at its deadline', async () => {
  const stream = new NonClosingStream()
  const started = Date.now()

  await assert.rejects(closeStream(stream, 25), /close/)

  assert.ok(Date.now() - started < 1000)
  assert.strictEqual(stream.listenerCount('close'), 0)
  assert.strictEqual(stream.listenerCount('error'), 0)
})

test('closeStream resolves immediately when the stream is actually closed before listening', async () => {
  const stream = new FakeStream()
  stream.closed = true
  const started = Date.now()

  await closeStream(stream, 25)

  assert.ok(Date.now() - started < 500)
  assert.strictEqual(stream.listenerCount('close'), 0)
})

test('closeStream removes its listeners after a close event', async () => {
  const stream = new FakeStream()
  setTimeout(() => {
    stream.closed = true
    stream.emit('close')
  }, 5)

  await closeStream(stream, 100)

  assert.strictEqual(stream.listenerCount('close'), 0)
  assert.strictEqual(stream.listenerCount('error'), 0)
})

test('closeStream rejects when the stream emits an error while closing', async () => {
  const stream = new FakeStream()
  stream.on('error', () => {})
  setTimeout(() => stream.emit('error', new Error('broken pipe')), 5)

  await assert.rejects(closeStream(stream, 100), /broken pipe/)
})

test('unlink and closeAll reject when a controlled close never finishes', async () => {
  const run = fakeLinkRun()
  const links = new Links(run)
  links.closeTimeoutMs = 25
  links.link(linkAuto(new NonClosingStream()), linkAuto(new NonClosingStream()), 'edge-stuck')

  await assert.rejects(links.unlink('edge-stuck'), /close/)

  links.link(linkAuto(new NonClosingStream()), linkAuto(new NonClosingStream()), 'edge-stuck-2')
  await assert.rejects(links.closeAll(), /close/)
})

test('closeLeaf recomputes its close bound after unlink instead of spending a stale allowance', async () => {
  const runner = new SoakRunner(resolveConfig({ SOAK_PROFILE: 'smoke' }))
  runner.recoveryDeadline = Date.now() + 800
  runner.links = { unlink: () => sleep(500) }
  runner.leaves.set(0, 'slow-edge')
  runner.liveLeaves.set(0, {
    close() {
      return new Promise(() => {})
    }
  })

  // This is the bound runCohort computes before unlink starts. Reusing it after
  // a 500 ms unlink would let the close run ~1100 ms from here, past both the
  // absolute deadline and the shared budget.
  const timeoutMs = runner.recoveryBound('leaf close', 20000)
  const started = Date.now()
  await assert.rejects(runner.closeLeaf(0, { timeoutMs }), /timed out|spent|deadline/i)
  const elapsed = Date.now() - started

  assert.ok(elapsed >= 700, 'the close must use the real remaining allowance after unlink')
  assert.ok(
    elapsed < 1050,
    'the close spent the stale pre-unlink allowance after ' + elapsed + 'ms'
  )
})

test('an unexpected active-edge stream error fails the runner', async () => {
  const run = fakeLinkRun()
  const links = new Links(run)
  const pair = links.link(linkAuto(new FakeStream()), linkAuto(new FakeStream()), 'edge-error')
  const err = Object.assign(new Error('replication reset'), { code: 'ECONNRESET' })

  pair.s1.emit('error', err)

  assert.strictEqual(run.failures.length, 1)
  assert.strictEqual(run.failures[0], err)
  assert.strictEqual(run.asyncError, err)
  await links.unlink('edge-error')
})

test('a controlled unlink marks the pair closed before destroying and ignores its error', async () => {
  const run = fakeLinkRun()
  const links = new Links(run)
  const pair = links.link(linkAuto(new FakeStream()), linkAuto(new FakeStream()), 'edge-controlled')

  const closing = links.unlink('edge-controlled')
  assert.strictEqual(pair.closed, true)
  pair.s1.emit('error', new Error('destroyed on purpose'))
  await closing

  assert.strictEqual(run.failures.length, 0)
  assert.strictEqual(run.asyncError, null)
})

// ---------------------------------------------------------------------------

async function main() {
  if (process.env.SOAK_FAILURE_CHILD === '1') {
    await runFailureChild()
    return
  }
  if (process.env.SOAK_RECOVERY_CHILD) {
    await runRecoveryChild(process.env.SOAK_RECOVERY_CHILD)
    return
  }
  if (process.env.SOAK_TERMINAL_GUARD_CHILD) {
    await runTerminalGuardChild(process.env.SOAK_TERMINAL_GUARD_CHILD)
    return
  }

  let failed = 0

  for (const { name, fn } of tests) {
    try {
      await fn()
      console.log('ok - ' + name)
    } catch (err) {
      failed++
      // Report failure immediately as well: a buggy runner/test can let the
      // process exit naturally before the loop finishes, and that must not be
      // mistaken for success.
      process.exitCode = 1
      console.log('not ok - ' + name)
      console.log(String((err && err.stack) || err))
    }
  }

  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' runner checks passed')
  if (failed > 0) process.exitCode = 1
}

main()
