// Shared, dependency-free pieces of the opt-in writer-cap soak.
//
// The configuration/oracle half is pure so test/soak/runner-test.js can prove
// the runner rejects bad input and incomplete evidence before any workload is
// trusted. The runtime half only owns test-side resources (streams, temp dirs,
// delegated observations); it never changes product behaviour.

const fs = require('fs')
const os = require('os')
const path = require('path')
const b4a = require('b4a')

const PROFILES = Object.freeze({
  soak: Object.freeze({
    profile: 'soak',
    readerCap: 16,
    defaultWriters: 128,
    maxReclaimedWriters: 1024,
    leafBound: 16,
    defaultDurationMs: 10 * 60 * 1000,
    expectedStalled: false
  }),
  smoke: Object.freeze({
    profile: 'smoke',
    readerCap: 8,
    defaultWriters: 32,
    maxReclaimedWriters: 1024,
    leafBound: 8,
    defaultDurationMs: 60 * 1000,
    expectedStalled: false
  }),
  saturation: Object.freeze({
    profile: 'saturation',
    readerCap: 4,
    defaultWriters: 6,
    maxReclaimedWriters: 1,
    leafBound: 8,
    defaultDurationMs: null,
    expectedStalled: true
  })
})

const SETUP_ALLOWANCE_MS = 240 * 1000
const DRAIN_ALLOWANCE_MS = 240 * 1000
const CLEANUP_ALLOWANCE_MS = 30 * 1000
const MERGE_CLOSEOUT_MS = 30 * 1000
const SAMPLE_INTERVAL_MS = 3000
const SATURATION_ALLOWANCE_MS = 120 * 1000
const SATURATION_QUIET_MS = 3000

class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

class OracleError extends Error {
  constructor(message) {
    super(message)
    this.name = 'OracleError'
  }
}

class PhaseError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PhaseError'
  }
}

class SaturationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SaturationError'
  }
}

function has(env, key) {
  return Object.prototype.hasOwnProperty.call(env, key) && env[key] !== undefined
}

function parseSeed(value) {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    throw new ConfigError(
      'SOAK_SEED must be an unsigned 32-bit integer, got ' + JSON.stringify(value)
    )
  }

  const seed = Number(value)
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new ConfigError('SOAK_SEED must be in [0, 4294967295], got ' + JSON.stringify(value))
  }

  return seed
}

function parsePositiveSafeInteger(name, value) {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    throw new ConfigError(name + ' must be a positive safe integer, got ' + JSON.stringify(value))
  }

  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ConfigError(name + ' must be a positive safe integer, got ' + JSON.stringify(value))
  }

  return parsed
}

function resolveConfig(env = {}) {
  const profileName = has(env, 'SOAK_PROFILE') ? env.SOAK_PROFILE : 'soak'
  if (!Object.prototype.hasOwnProperty.call(PROFILES, profileName)) {
    throw new ConfigError(
      'SOAK_PROFILE must be soak, smoke or saturation, got ' + JSON.stringify(profileName)
    )
  }

  const constants = PROFILES[profileName]
  const saturation = profileName === 'saturation'
  const seed = has(env, 'SOAK_SEED') ? parseSeed(env.SOAK_SEED) : 381

  if (saturation && has(env, 'SOAK_DURATION_MS')) {
    throw new ConfigError('SOAK_DURATION_MS is not supported for the fixed saturation scenario')
  }
  if (saturation && has(env, 'SOAK_WRITERS')) {
    throw new ConfigError('SOAK_WRITERS is not supported for the fixed saturation scenario')
  }

  const durationMs = saturation
    ? null
    : has(env, 'SOAK_DURATION_MS')
      ? parsePositiveSafeInteger('SOAK_DURATION_MS', env.SOAK_DURATION_MS)
      : constants.defaultDurationMs

  const writerCount = saturation
    ? constants.defaultWriters
    : has(env, 'SOAK_WRITERS')
      ? parsePositiveSafeInteger('SOAK_WRITERS', env.SOAK_WRITERS)
      : constants.defaultWriters

  if (!saturation && writerCount < constants.readerCap + 4) {
    throw new ConfigError(
      'SOAK_WRITERS must be at least readerCap + 4 (' +
        (constants.readerCap + 4) +
        '), got ' +
        writerCount
    )
  }

  const scenarioAllowanceMs = saturation ? SATURATION_ALLOWANCE_MS : durationMs
  const totalAllowanceMs =
    SETUP_ALLOWANCE_MS + scenarioAllowanceMs + DRAIN_ALLOWANCE_MS + CLEANUP_ALLOWANCE_MS
  if (!Number.isSafeInteger(totalAllowanceMs)) {
    throw new ConfigError('duration leaves no safe overall watchdog; choose a smaller duration')
  }
  if (!saturation && MERGE_CLOSEOUT_MS > DRAIN_ALLOWANCE_MS) {
    throw new ConfigError('merge closeout does not fit inside the drain allowance')
  }

  const config = {
    profile: profileName,
    seed,
    writerCount,
    readerCap: constants.readerCap,
    maxReclaimedWriters: constants.maxReclaimedWriters,
    leafBound: constants.leafBound,
    durationMs,
    mergeCloseoutMs: saturation ? 0 : MERGE_CLOSEOUT_MS,
    expectedStalled: constants.expectedStalled,
    saturation,
    saturationQuietMs: saturation ? SATURATION_QUIET_MS : 0,
    scenarioAllowanceMs,
    setupAllowanceMs: SETUP_ALLOWANCE_MS,
    drainAllowanceMs: DRAIN_ALLOWANCE_MS,
    cleanupAllowanceMs: CLEANUP_ALLOWANCE_MS,
    totalAllowanceMs,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    pressureCohortSize: constants.readerCap,
    regularCohortSize: constants.readerCap
  }

  config.replay = formatReplay(config)
  return config
}

// The configured duration is the full active workload period. The only append
// allowed afterwards is the final administrative merge, in a separate bounded
// closeout window that is paid for by the existing drain allowance rather than
// by shortening the workload. Data recovery begins after that merge.
function formatReplay(config) {
  const parts = ['SOAK_PROFILE=' + config.profile, 'SOAK_SEED=' + config.seed]

  if (config.profile !== 'saturation') {
    parts.push('SOAK_DURATION_MS=' + config.durationMs)
    parts.push('SOAK_WRITERS=' + config.writerCount)
  }

  return parts.join(' ') + ' npm run test:writer-cap-soak'
}

// ---------------------------------------------------------------------------
// Independent authored-operation ledger

function createOperationLedger() {
  return {
    expected: new Map(),
    ack: new Map(),
    ops: [],
    record(key, length, meta = {}) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new Error('operation key must be a non-empty hex string')
      }
      if (!Number.isSafeInteger(length) || length <= 0) {
        throw new Error('operation length must be a positive safe integer')
      }

      const ref = key + '.' + length
      if (this.expected.has(ref)) {
        throw new Error('duplicate authored operation ' + ref)
      }

      const entry = { ...meta, key, length, ref }
      this.expected.set(ref, entry)
      this.ack.set(key, Math.max(this.ack.get(key) || 0, length))
      this.ops.push(entry)
    }
  }
}

function historyRefs(history, label) {
  if (!Array.isArray(history)) throw new OracleError(label + ' history is not an array')

  const seen = new Set()
  for (const ref of history) {
    if (typeof ref !== 'string') throw new OracleError(label + ' history contains a non-string ref')
    if (seen.has(ref)) {
      throw new OracleError(label + ' history has a duplicate applied operation ' + ref)
    }
    seen.add(ref)
  }

  return seen
}

function verifyFinalState({ ledger, reference, reader, identities }) {
  if (!ledger || !(ledger.expected instanceof Map) || !(ledger.ack instanceof Map)) {
    throw new OracleError('the independent authored-operation ledger is missing')
  }
  if (!reference || !reader) throw new OracleError('reference and reader state are required')

  const referenceHistory = reference.history
  const readerHistory = reader.history

  historyRefs(referenceHistory, 'reference')
  historyRefs(readerHistory, 'reader')

  if (JSON.stringify(referenceHistory) !== JSON.stringify(readerHistory)) {
    throw new OracleError(
      'ordered apply history differs between reference and reader: reference ' +
        referenceHistory.length +
        ' entries, reader ' +
        readerHistory.length +
        ' entries'
    )
  }

  const expected = ledger.expected
  if (expected.size === 0) {
    if (referenceHistory.length !== 0) {
      throw new OracleError(
        'independent completeness failed: applied history is non-empty but no operation was authored'
      )
    }
  } else {
    for (const ref of referenceHistory) {
      if (!expected.has(ref)) {
        throw new OracleError('applied operation ' + ref + ' is not in the authored ledger')
      }
    }
  }

  if (referenceHistory.length !== expected.size) {
    const missing = []
    for (const ref of expected.keys()) {
      if (!referenceHistory.includes(ref)) missing.push(ref)
    }
    throw new OracleError(
      'independent completeness failed: applied ' +
        referenceHistory.length +
        ' of ' +
        expected.size +
        ' authored operations (missing ' +
        (missing.slice(0, 4).join(', ') || 'none') +
        ')'
    )
  }

  const referenceLengths = normalizeLengths(reference.lengths, 'reference')
  const readerLengths = normalizeLengths(reader.lengths, 'reader')
  const keys = new Set([...(identities || []), ...ledger.ack.keys()])

  for (const key of keys) {
    const acknowledged = ledger.ack.get(key) || 0
    const refLength = referenceLengths.get(key) || 0
    const readerLength = readerLengths.get(key) || 0

    if (refLength !== readerLength) {
      throw new OracleError(
        'per-writer applied lengths differ for ' +
          key +
          ': reference ' +
          refLength +
          ', reader ' +
          readerLength
      )
    }

    if (readerLength !== acknowledged) {
      throw new OracleError(
        'per-writer applied length for ' +
          key +
          ' is ' +
          readerLength +
          ' but the acknowledged length is ' +
          acknowledged
      )
    }
  }

  return { ok: true, entries: referenceHistory.length, writers: keys.size }
}

function normalizeLengths(lengths, label) {
  if (lengths instanceof Map) return lengths
  if (lengths && typeof lengths === 'object') return new Map(Object.entries(lengths))
  throw new OracleError(label + ' per-writer applied lengths are missing')
}

function applicationBytes(entry, label) {
  if (entry === null || entry === undefined) return null
  if (!entry.value || !b4a.isBuffer(entry.value)) {
    throw new OracleError(label + ' application value is not a buffer')
  }
  return b4a.from(entry.value)
}

// latest/clock are application state, not optional observations: a non-empty
// apply history must expose both, and presence plus bytes must match. Both
// absent is only a valid outcome for the explicitly empty fixture contract.
function verifyApplicationState({
  referenceLatest,
  readerLatest,
  referenceClock,
  readerClock,
  entries = 0
}) {
  const refLatest = applicationBytes(referenceLatest, 'reference latest')
  const readLatest = applicationBytes(readerLatest, 'reader latest')
  const refClock = applicationBytes(referenceClock, 'reference clock')
  const readClock = applicationBytes(readerClock, 'reader clock')

  if (entries === 0 && !refLatest && !readLatest && !refClock && !readClock) {
    return { latest: null, clock: null, empty: true }
  }

  if (!refLatest || !readLatest) {
    throw new OracleError(
      'application latest is missing from the ' +
        (!refLatest ? 'reference' : 'reader') +
        ' (non-empty application state must expose it)'
    )
  }
  if (!b4a.equals(refLatest, readLatest)) {
    throw new OracleError('application latest bytes differ between reference and reader')
  }

  if (!refClock || !readClock) {
    throw new OracleError(
      'application clock is missing from the ' +
        (!refClock ? 'reference' : 'reader') +
        ' (non-empty application state must expose it)'
    )
  }
  if (!b4a.equals(refClock, readClock)) {
    throw new OracleError('application clock bytes differ between reference and reader')
  }

  return {
    latest: b4a.toString(refLatest),
    clock: b4a.toString(refClock),
    empty: false
  }
}

// ---------------------------------------------------------------------------
// Mandatory phase accounting

const REQUIRED_PHASES = [
  ['allIdentitiesAuthored', 'allIdentitiesAuthored'],
  ['actualEvictions', 'actualEvictions'],
  ['reservedRecords', 'reservedRecords'],
  ['dependencyEvictions', 'dependencyEvictions'],
  ['refusedPositiveTails', 'refusedPositiveTails'],
  ['recoveredPositiveTails', 'recoveredPositiveTails'],
  ['victimRetryAdmissions', 'victimRetryAdmissions'],
  ['victimRetryHandoffs', 'victimRetryHandoffs'],
  ['victimRetryHandoffLength2', 'victimRetryHandoffLength2'],
  ['victimHandoffLength2', 'victimHandoffLength2'],
  ['handoffs', 'handoffs'],
  ['deniedWakeups', 'deniedWakeups'],
  ['partitions', 'partitions'],
  ['reconnects', 'reconnects'],
  ['readerRestart', 'readerRestart'],
  ['readerRestartLedgerEmpty', 'readerRestartLedgerEmpty'],
  ['writerRestart', 'writerRestart'],
  ['writerRestartSameIdentity', 'writerRestartSameIdentity'],
  ['settledCheckpoints', 'settledCheckpoints'],
  ['converged', 'converged']
]

function verifyPhaseCoverage(coverage = {}) {
  const missing = []

  for (const [field, label] of REQUIRED_PHASES) {
    const value = coverage[field]
    if (typeof value === 'number' ? value <= 0 : value !== true) missing.push(label)
  }

  if (missing.length > 0) {
    throw new PhaseError('mandatory soak phases did not run: ' + missing.join(', '))
  }

  if ((coverage.victimNonRetryAdmissions || 0) !== 0) {
    throw new PhaseError(
      'the pressure victim was admitted outside the remembered retry path (' +
        coverage.victimNonRetryAdmissions +
        ' non-retry admissions)'
    )
  }

  if ((coverage.victimPositiveAdvancesAfterIsolation || 0) !== 0) {
    throw new PhaseError(
      'positive ingress advanced the isolated pressure victim (' +
        coverage.victimPositiveAdvancesAfterIsolation +
        ' advancing announcements)'
    )
  }

  if ((coverage.victimMaxLossAfterIsolation || 0) !== 0) {
    throw new PhaseError(
      'the isolated pressure victim lost its remembered maximum baseline (' +
        coverage.victimMaxLossAfterIsolation +
        ' observed drops)'
    )
  }

  return { ok: true }
}

// ---------------------------------------------------------------------------
// Saturation accounting

const QUIET_FIELDS = [
  ['records', 'ledger record count'],
  ['recordId', 'ledger identity'],
  ['recordLength', 'ledger length'],
  ['evictions', 'evictions'],
  ['active', 'active sessions'],
  ['open', 'writersOpened'],
  ['closed', 'writersClosed'],
  ['drains', 'drains'],
  ['flushes', 'flushes'],
  ['idleVictimOpen', 'idle victim'],
  ['targetActive', 'blocked dependency presence']
]

function verifySaturation(state = {}) {
  if (!Number.isSafeInteger(state.budget) || state.budget <= 0) {
    throw new SaturationError('saturation metadata budget must be positive')
  }

  const samples = Array.isArray(state.recordSamples) ? state.recordSamples : []
  for (const size of samples) {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new SaturationError('metadata record samples must be non-negative integers')
    }
    if (size > state.budget) {
      throw new SaturationError('metadata budget exceeded: ' + size + ' > ' + state.budget)
    }
  }

  if (!Number.isSafeInteger(state.evictions) || state.evictions < 1) {
    throw new SaturationError('saturation observed no actual pressure eviction')
  }

  if (state.records < 1) {
    throw new SaturationError('the pressure eviction did not retain its obligation')
  }
  if (
    state.recordId !== state.quietBefore.recordId ||
    state.recordId !== state.quietAfter.recordId ||
    state.recordLength !== state.quietBefore.recordLength ||
    state.recordLength !== state.quietAfter.recordLength
  ) {
    throw new SaturationError('the retained obligation changed during saturation')
  }

  if (state.idleVictimOpen !== true) {
    throw new SaturationError('saturation had no otherwise idle victim to prove the metadata limit')
  }

  const attempt = state.reclaimAttempt
  if (!attempt || typeof attempt !== 'object') {
    throw new SaturationError(
      'saturation has no real dependency reclaim attempt; the ledger budget was never exercised'
    )
  }
  if (attempt.victim !== null) {
    throw new SaturationError(
      'the dependency reclaim attempt was not refused: a victim was reserved instead'
    )
  }
  if (attempt.recordsAtAttempt !== state.budget) {
    throw new SaturationError(
      'the dependency reclaim attempt did not run at the full metadata budget: ' +
        attempt.recordsAtAttempt +
        ' records, budget ' +
        state.budget
    )
  }
  if (attempt.activeAtAttempt !== state.cap) {
    throw new SaturationError(
      'the dependency reclaim attempt did not run with the session cap full: ' +
        attempt.activeAtAttempt +
        ' active, cap ' +
        state.cap
    )
  }
  if (!attempt.demand || attempt.demand.satisfied !== false) {
    throw new SaturationError(
      'the refused reclaim did not name an unsatisfied dependency link at the observed length'
    )
  }
  if (
    !attempt.demand.id ||
    !Number.isSafeInteger(attempt.demand.length) ||
    attempt.demand.applied >= attempt.demand.length
  ) {
    throw new SaturationError('the refused reclaim demand is not a real missing dependency')
  }
  if (attempt.blockAvailable !== true) {
    throw new SaturationError(
      'the dependency block was not proven locally available and decoded without waiting'
    )
  }
  if (
    !attempt.link ||
    attempt.link.id !== attempt.demand.id ||
    attempt.link.length !== attempt.demand.length
  ) {
    throw new SaturationError(
      'the decoded resident link does not point at the hidden dependency key and length'
    )
  }
  if (!Array.isArray(attempt.eligible) || attempt.eligible.length === 0) {
    throw new SaturationError(
      'the budget refusal had no otherwise fully eligible idle alternative; refusal may have been all-busy'
    )
  }
  for (const candidate of attempt.eligible) {
    if (candidate.revalidated !== true) {
      throw new SaturationError(
        'the eligible idle alternative was not revalidated after its awaited checks'
      )
    }
  }

  if (state.expectedStalled !== true) {
    throw new SaturationError('saturation must declare its expected stalled outcome')
  }
  if (state.dependencyDelivered !== false) {
    throw new SaturationError(
      'expected stall was not observed: the budget-blocked dependency was delivered'
    )
  }

  for (const [field, label] of QUIET_FIELDS) {
    if (state.quietBefore[field] !== state.quietAfter[field]) {
      throw new SaturationError(
        'saturation was not quiescent: ' +
          label +
          ' changed from ' +
          String(state.quietBefore[field]) +
          ' to ' +
          String(state.quietAfter[field]) +
          ' over the ' +
          state.budget +
          '-record quiet window'
      )
    }
  }

  return { ok: true, stalled: true }
}

// ---------------------------------------------------------------------------
// Runtime helpers (test-side resources only)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout(promise, ms, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function waitFor(fn, { label, timeout = 30000, interval = 50 } = {}) {
  const started = Date.now()
  let state = null

  while (Date.now() - started < timeout) {
    state = await fn()
    if (state && state.ok) return state
    await sleep(interval)
  }

  throw new Error('timed out waiting for ' + (label || 'condition') + ': ' + serialize(state))
}

async function quiesce(fn, { stable = 1000, timeout = 15000, interval = 50 } = {}) {
  const started = Date.now()
  let previous = null
  let since = started

  while (Date.now() - started < timeout) {
    const current = await fn()
    const serialized = JSON.stringify(current)

    if (serialized !== previous) {
      previous = serialized
      since = Date.now()
    } else if (Date.now() - since >= stable) {
      return current
    }

    await sleep(interval)
  }

  return fn()
}

function serialize(value) {
  const seen = new WeakSet()

  try {
    return JSON.stringify(value, (key, val) => {
      if (typeof val === 'bigint') return val.toString()
      if (val === null || typeof val !== 'object') return val
      if (seen.has(val)) return '[circular]'
      seen.add(val)

      if (Array.isArray(val)) return val.slice(0, 8)
      if (val instanceof Map) return { size: val.size, keys: [...val.keys()].slice(0, 8) }
      if (val instanceof Set) return { size: val.size, values: [...val.values()].slice(0, 8) }
      if (b4a.isBuffer(val)) return '0x' + b4a.toString(val, 'hex').slice(0, 64)

      return val
    })
  } catch {
    return '<unserializable>'
  }
}

function createRing(limit) {
  const items = []

  return {
    push(entry) {
      items.push(entry)
      if (items.length > limit) items.splice(0, items.length - limit)
    },
    snapshot() {
      return items.slice()
    }
  }
}

const RUN_PREFIX = 'autobee-writer-soak-'
const OWNER_FILE = '.autobee-writer-soak-owner'

function createRunRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), RUN_PREFIX))
  fs.writeFileSync(
    path.join(root, OWNER_FILE),
    JSON.stringify({ pid: process.pid, started: Date.now(), prefix: RUN_PREFIX })
  )
  return root
}

function removeRunRoot(root) {
  if (typeof root !== 'string') return false
  if (path.basename(root).indexOf(RUN_PREFIX) !== 0) return false
  if (!path.isAbsolute(root)) return false
  if (!fs.existsSync(path.join(root, OWNER_FILE))) return false

  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  return true
}

async function readAppliedHistory(auto) {
  const history = []

  for await (const { key, value } of auto.view.createReadStream()) {
    const text = b4a.toString(key)
    if (!text.startsWith('#')) continue
    history.push({ index: Number(text.slice(1)), ref: b4a.toString(value) })
  }

  history.sort((a, b) => a.index - b.index)
  return history.map((entry) => entry.ref)
}

async function readLengths(auto, identities) {
  const lengths = new Map()

  for (const identity of identities) {
    const key = b4a.isBuffer(identity)
      ? identity
      : typeof identity === 'string'
        ? b4a.from(identity, 'hex')
        : identity.key
    const info = await auto.system.get(key)
    lengths.set(b4a.toString(key, 'hex'), info ? info.length : 0)
  }

  return lengths
}

function appliedRefs(history) {
  return history.map((entry) => entry.ref)
}

module.exports = {
  PROFILES,
  ConfigError,
  OracleError,
  PhaseError,
  SaturationError,
  resolveConfig,
  formatReplay,
  MERGE_CLOSEOUT_MS,
  createOperationLedger,
  verifyFinalState,
  verifyApplicationState,
  verifyPhaseCoverage,
  verifySaturation,
  sleep,
  withTimeout,
  waitFor,
  quiesce,
  serialize,
  createRing,
  createRunRoot,
  removeRunRoot,
  readAppliedHistory,
  readLengths,
  appliedRefs
}
