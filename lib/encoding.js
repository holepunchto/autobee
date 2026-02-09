const c = require('compact-encoding')
const { getEncoding } = require('../spec/hyperschema')

const OPLOG_VERSION = 4 // check with auto

const Oplog = getEncoding('@autobee/oplog')
const SystemInfo = getEncoding('@autobee/system-info')
const SystemWriter = getEncoding('@autobee/system-writer')

exports.OPLOG_VERSION = OPLOG_VERSION

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

function decodeOplog(buf) {
  const m = c.decode(Oplog, buf)
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
