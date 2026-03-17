const c = require('compact-encoding')
const { getEncoding } = require('../spec/hyperschema')

const OPLOG_VERSION = 4 // check with auto
const LEGACY_OPLOG_VERSION = 2

const Oplog = getEncoding('@autobee/oplog')
const SystemInfo = getEncoding('@autobee/system-info')
const SystemWriter = getEncoding('@autobee/system-writer')

exports.OPLOG_VERSION = OPLOG_VERSION

exports.Oplog = Oplog
exports.encodeSystemWriter = encodeSystemWriter
exports.decodeSystemWriter = decodeSystemWriter

function encodeSystemWriter(m) {
  return c.encode(SystemWriter, m)
}

function decodeSystemWriter(key, value) {
  return {
    // TODO: add dummy type to schema to preset key without extra alloc
    key: key.subarray(1),
    ...c.decode(SystemWriter, value)
  }
}

exports.encodeSystemInfo = encodeSystemInfo
exports.decodeSystemInfo = decodeSystemInfo

function encodeSystemInfo(m) {
  return c.encode(SystemInfo, m)
}

function decodeSystemInfo(buf) {
  return c.decode(SystemInfo, buf)
}

exports.encodeOplog = encodeOplog
exports.decodeOplog = decodeOplog

function convertLegacyOplog(l) {
  const m = Object.create(null)

  m.version = l.version
  m.timestamp = 0
  m.links = l.node.heads
  m.batch = { start: 0, end: 0 }
  m.views = null
  m.optimistic = !!l.optimistic
  m.value = l.node.value

  return m
}

function decodeOplog(buf) {
  const m = c.decode(Oplog, buf)

  if (m.version <= LEGACY_OPLOG_VERSION) {
    return convertLegacyOplog(m)
  }

  if (m.batch === null) m.batch = { start: 0, end: 0 }
  return m
}

function encodeOplog(m) {
  if (m.batch && m.batch.start === 0 && m.batch.end === 0) m.batch = null
  return c.encode(Oplog, m)
}

exports.encodeValue = encodeValue
exports.decodeValue = decodeValue

function encodeValue(value, opts = {}) {
  const {
    version = OPLOG_VERSION,
    optimistic = false,
    timestamp = Date.now(),
    links = [],
    views = null
  } = opts

  const oplog = {
    version,
    timestamp,
    links,
    batch: null,
    views,
    optimistic,
    value
  }

  return encodeOplog(oplog)
}

function decodeValue(buf, opts = {}) {
  return decodeOplog(buf).value
}
