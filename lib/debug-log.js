const b4a = require('b4a')
const ID = require('hypercore-id-encoding')

// Human-readable tracing of the migration/sync paths. On by default on this
// debug branch - set AUTOBEE_LOG=0 to silence it.
const level = readEnv('AUTOBEE_LOG')
const enabled = level !== '0'
// the hot per-node paths only come along at level 2 - they bury everything else
const verbose = level === '2'

module.exports = {
  enabled,
  verbose,
  trace,
  traceVerbose,
  short,
  head
}

function trace(subject, event, fields = null) {
  if (!enabled) return

  let line = stamp() + ' ' + tag(subject) + ' ' + event
  if (fields) line += ' ' + format(fields)

  console.error(line)
}

function traceVerbose(subject, event, fields = null) {
  if (!verbose) return
  trace(subject, event, fields)
}

// wall clock, so lines from different modules and processes interleave correctly
function stamp() {
  const now = new Date()
  const t = now.toISOString()
  return '[' + t.slice(11, 23) + ']'
}

// subject is an Autobee, or anything holding one (FastForward, ActiveWriters, Writer)
function tag(subject) {
  const auto = resolve(subject)
  if (auto === null) return 'bee/?'

  const name = auto.name ? '/' + auto.name : ''
  return 'bee' + name + ' ' + short(auto.key)
}

function resolve(subject) {
  if (!subject) return null
  if (subject.store && subject.system) return subject // an Autobee
  if (subject.auto) return subject.auto // FastForward, ActiveWriters
  if (subject.writers) return subject.writers.auto // Writer
  return null
}

function format(fields) {
  const parts = []
  for (const key of Object.keys(fields)) parts.push(key + '=' + value(fields[key], 0))
  return parts.join(' ')
}

function value(v, depth) {
  if (v === null || v === undefined) return String(v)
  if (b4a.isBuffer(v)) return short(v)
  if (typeof v === 'string') return v
  if (typeof v !== 'object') return String(v)
  if (depth > 2) return '…'

  if (Array.isArray(v)) return '[' + v.map((e) => value(e, depth + 1)).join(',') + ']'
  if (v instanceof Map) return '[' + [...v.keys()].map((k) => value(k, depth + 1)).join(',') + ']'
  if (v instanceof Set) return '[' + [...v].map((e) => value(e, depth + 1)).join(',') + ']'
  if (isHead(v)) return head(v)

  const parts = []
  for (const key of Object.keys(v)) parts.push(key + ':' + value(v[key], depth + 1))
  return '{' + parts.join(' ') + '}'
}

function isHead(v) {
  if (typeof v.length !== 'number') return false
  return b4a.isBuffer(v.key) || v.key === null
}

// key/length pairs are the currency of every sync decision, so render them
// as one token
function head(h) {
  if (!h) return String(h)
  return short(h.key) + '@' + h.length
}

function short(key) {
  if (!key) return String(key)
  if (typeof key === 'string') return key.slice(0, 6)
  return ID.normalize(key).slice(0, 6)
}

function readEnv(name) {
  try {
    // node
    if (typeof process !== 'undefined' && process.env) return process.env[name]
    // bare
    return require('bare-process').env[name]
  } catch {
    return undefined
  }
}
