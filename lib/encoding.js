const b4a = require('b4a')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')
const { AutobeeEncryption, WriterEncryption } = require('autobee-encryption')

const { getEncoding } = require('../encoding/spec/autobee')
const { LEGACY_OPLOG_VERSION, OPLOG_VERSION } = require('./constants')

const Oplog = getEncoding('@autobee/oplog')
const Link = getEncoding('@autobee/link')
const SystemInfo = getEncoding('@autobee/system-info')
const SystemWriter = getEncoding('@autobee/system-writer')
const ManifestData = getEncoding('@autobee/manifest-data')
const AutobaseBootRecord = getEncoding('@autobase-compat/boot-record')

exports.OPLOG_VERSION = OPLOG_VERSION

exports.Oplog = Oplog
exports.ManifestData = ManifestData

exports.encodeBootRecord = encodeBootRecord
exports.decodeBootRecord = decodeBootRecord

exports.encodePreviousDrain = encodePreviousDrain
exports.decodePreviousDrain = decodePreviousDrain

exports.decodeAutobaseBootRecord = decodeAutobaseBootRecord

exports.encodeSystemWriter = encodeSystemWriter
exports.decodeSystemWriter = decodeSystemWriter

function encodeBootRecord(r) {
  return c.encode(Link, r)
}

function decodeBootRecord(value) {
  return c.decode(Link, value)
}

function encodePreviousDrain(d) {
  return c.encode(c.uint, d)
}

function decodePreviousDrain(value) {
  return c.decode(c.uint, value)
}

function decodeAutobaseBootRecord(value) {
  return c.decode(AutobaseBootRecord, value)
}

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

  if (m.version <= LEGACY_OPLOG_VERSION) {
    return {
      version: m.version,
      timestamp: 0,
      links: m.node.heads,
      batch: { start: 0, end: 0 },
      views: null,
      optimistic: !!m.optimistic,
      value: m.node.value
    }
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

function createValue(value, opts = {}) {
  if (opts.legacy) {
    return {
      version: opts.version || LEGACY_OPLOG_VERSION,
      digest: null,
      checkpoint: null,
      optimistic: !!opts.optimistic,
      node: {
        heads: opts.heads || [],
        batch: 1,
        value
      }
    }
  }

  const {
    version = OPLOG_VERSION,
    optimistic = false,
    timestamp = Date.now(),
    links = [],
    views = null
  } = opts

  return {
    version,
    timestamp,
    links,
    batch: null,
    views,
    optimistic,
    value
  }
}

function encodeValue(value, opts = {}) {
  const oplog = createValue(value, opts)

  const state = { start: 0, end: 0, buffer: null }

  Oplog.preencode(state, oplog)

  if (opts.padding) {
    state.start = opts.padding
    state.end += opts.padding
  }

  state.buffer = b4a.alloc(state.end)

  Oplog.encode(state, oplog)

  if (!opts.encrypted) return state.buffer

  if (!opts.optimistic) {
    throw new Error('Encoding an encrypted value is not supported')
  }

  const padding = b4a.alloc(16) // sodium.crypto_generichash_MINBYTES
  crypto.hash(state.buffer, padding)
  padding[0] = 0

  return b4a.concat([padding.subarray(0, AutobeeEncryption.PADDING), state.buffer])
}

async function decodeValue(buf, { encryptionKey, autobeeKey, key, manifest, index = 0 } = {}) {
  if (encryptionKey) {
    const w = new WriterEncryption({ encryptionKey, key: autobeeKey })

    await w.decrypt(index, buf, { key, manifest })
    buf = buf.subarray(AutobeeEncryption.PADDING)
  }

  return decodeOplog(buf).value
}
