const c = require('compact-encoding')
const { getEncoding } = require('../spec/hyperschema')

const Oplog = getEncoding('@autobee/oplog')
const SystemInfo = getEncoding('@autobee/system-info')
const SystemWriter = getEncoding('@autobee/system-writer')

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
  return c.decode(Oplog, buf)
}

function encodeOplog(m) {
  return c.encode(Oplog, m)
}
