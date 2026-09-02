const test = require('brittle')
const c = require('compact-encoding')
const b4a = require('b4a')

const { Oplog, decodeOplog } = require('../lib/encoding.js')
const { getEncoding } = require('../encoding/spec/autobee/index.js')

const SystemInfo = getEncoding('@autobee/system-info')

const KEY = b4a.alloc(32, 1)
const LINK = { key: b4a.alloc(32, 2), length: 7 }

// an oplog node as a v3 peer wrote it: a signed witness plus attestations, the
// scheme grant citations replaced
function v3Node() {
  return {
    version: 3,
    timestamp: 42,
    links: [LINK],
    batch: { start: 0, end: 0 },
    views: null,
    optimistic: false,
    value: b4a.from('hello'),
    witness: {
      weight: 3,
      backer: {
        key: b4a.alloc(32, 3),
        length: 9,
        signature: b4a.alloc(64, 4),
        manifest: b4a.from('manifest-bytes')
      }
    },
    attestations: [{ key: KEY, weight: 2, signature: b4a.alloc(64, 5) }],
    trusted: [{ key: b4a.alloc(32, 6), length: 11, flushes: 3 }]
  }
}

test('wire compat - a v3 oplog node still decodes', function (t) {
  const node = decodeOplog(c.encode(Oplog, v3Node()))

  t.is(node.version, 3, 'version preserved')
  t.is(node.timestamp, 42, 'timestamp survives')
  t.alike(b4a.toString(node.value), 'hello', 'value survives')
  t.is(node.links.length, 1, 'links survive')
  t.is(node.trusted.length, 1, 'trusted heads survive')
})

test('wire compat - a v3 signed witness confers nothing', function (t) {
  const node = decodeOplog(c.encode(Oplog, v3Node()))

  // the signature scheme is gone, so the claim cannot be checked - it maps to
  // null and the node sorts at whatever standing its record already holds,
  // which is monotone and so never lost
  t.is(node.witness, null, 'signed witness maps to null')
  t.is(node.approvals, null, 'no approvals on a v3 node')
})

test('wire compat - a v4 oplog node round-trips', function (t) {
  const node = decodeOplog(
    c.encode(Oplog, {
      version: 4,
      timestamp: 43,
      links: [LINK],
      batch: { start: 0, end: 0 },
      views: null,
      optimistic: false,
      value: b4a.from('world'),
      witness: { weight: 3, link: LINK },
      trusted: null,
      approvals: [{ key: KEY, weight: 2 }]
    })
  )

  t.is(node.version, 4, 'version 4')
  t.is(node.witness.weight, 3, 'witness weight')
  t.is(node.witness.link.length, LINK.length, 'witness cites its coordinate')
  t.ok(b4a.equals(node.witness.link.key, LINK.key), 'witness link key')
  t.is(node.approvals.length, 1, 'approvals present')
  t.is(node.approvals[0].weight, 2, 'approval weight')
})

test('wire compat - a legacy v2 oplog node still decodes', function (t) {
  const node = decodeOplog(
    c.encode(Oplog, {
      version: 2,
      node: { heads: [LINK], batch: 1, value: b4a.from('legacy') },
      checkpoint: null,
      digest: null,
      optimistic: false,
      trace: null
    })
  )

  t.is(node.version, 2, 'version 2')
  t.alike(b4a.toString(node.value), 'legacy', 'value still readable')
})

test('wire compat - system info decodes with and without pending', function (t) {
  const base = {
    version: 3,
    timestamp: 1,
    flushes: 2,
    view: LINK,
    heads: [LINK],
    indexers: null
  }

  const without = c.decode(SystemInfo, c.encode(SystemInfo, base))
  t.is(without.flushes, 2, 'a record written before pending existed still decodes')
  t.ok(!without.pending || without.pending.length === 0, 'missing pending reads as empty')

  // one flag per weight class: tier 1 quiet, tier 2 wants a stronger approver
  // the codec renders flags as 0/1, so assert the flags themselves
  const with_ = c.decode(SystemInfo, c.encode(SystemInfo, { ...base, pending: [false, true] }))
  t.is(with_.pending.length, 2, 'both weight classes round-trip')
  t.absent(with_.pending[0], 'tier 1 flag is false')
  t.ok(with_.pending[1], 'tier 2 flag is true')
})
