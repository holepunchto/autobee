const test = require('brittle')
const b4a = require('b4a')
const encoding = require('../lib/encoding.js')
const Promotions = require('../lib/promotions.js')

test('promotions - anchored levels are read once, then served from the pending entries', async function (t) {
  const bee = new CountingBee()
  const [w1, w2, w3, w4, w5] = keys(5)

  bee.putPending(w1, 2)
  bee.putPending(w2, 2)
  bee.putPending(w3, 2)
  bee.putHint(w1, 1)

  const p = new Promotions(bee)

  // cold: one hint read per pending entry, plus the new writer
  t.is(await flush(p, bee, [request(w4, 1)]), 4)
  t.alike(p.digest, [true, true])
  t.alike(p.digest, await fromScratch(bee))

  // warm: only the writer without an entry is read
  t.is(await flush(p, bee, [request(w5, 1)]), 1)
  t.alike(p.digest, await fromScratch(bee))

  // an update for a pending writer reads nothing
  t.is(await flush(p, bee, [grant(w2, 2)]), 0)
  t.alike(p.digest, [true, true], 'w3 still needs both tiers')
  t.alike(p.digest, await fromScratch(bee))
})

test('promotions - a grant refreshes the cached anchored level', async function (t) {
  const bee = new CountingBee()
  const [w1, w2] = keys(2)

  bee.putPending(w1, 2)

  const p = new Promotions(bee)
  await flush(p, bee, [request(w2, 0)])
  t.alike(p.digest, [true, true])

  // a partial approval: w1 still wants 2 but has anchored 1, so tier 1 goes quiet
  await flush(p, bee, [grant(w1, 1)])
  t.alike(p.digest, [false, true])
  t.alike(p.digest, await fromScratch(bee))

  // later flushes use the refreshed level, not the stale one from before the grant
  t.is(await flush(p, bee, [request(w2, 0)]), 1)
  t.alike(p.digest, [false, true])
  t.alike(p.digest, await fromScratch(bee))
})

test('promotions - the cold fill reads all hints at once', async function (t) {
  const bee = new CountingBee()
  const writers = keys(6)

  for (const w of writers.slice(0, 5)) bee.putPending(w, 1)

  const p = new Promotions(bee)
  t.is(await flush(p, bee, [request(writers[5], 1)]), 6)
  t.is(bee.maxInflight, 6, 'every pending entry and the new writer in one round')
  t.alike(p.digest, await fromScratch(bee))
})

test('promotions - reset drops the cached levels', async function (t) {
  const bee = new CountingBee()
  const [w1, w2, w3] = keys(3)

  bee.putPending(w1, 1)
  bee.putPending(w2, 1)

  const p = new Promotions(bee)
  await flush(p, bee, [request(w3, 0)])

  p.reset(null)
  t.is(await flush(p, bee, [request(w3, 0)]), 3, 'cold again')
})

// what system.flush does: hint writes and pending writes land in the same batch. Returns the
// reads flushPending did
async function flush(p, bee, updates) {
  const hints = await Promise.all(updates.map((upd) => p.updateHint(upd)))
  const before = bee.gets
  const pendings = await p.flushPending(updates)
  const reads = bee.gets - before
  for (const op of [...hints, ...(pendings || [])]) {
    if (op) bee.apply(op)
  }
  return reads
}

// the digest an instance without any cache computes for the same state
async function fromScratch(bee) {
  const p = new Promotions(bee)
  await p.flushPending([request(keys(1, 0xff)[0], 0)])
  return p.digest
}

function request(key, weight) {
  return { key, pending: weight, grant: null, isRemoved: false }
}

function grant(key, weight) {
  return { key, pending: -1, grant: { key: b4a.alloc(32), length: 1, weight }, isRemoved: false }
}

function keys(n, fill = 0) {
  return Array.from({ length: n }, (_, i) => b4a.alloc(32, fill || i + 1))
}

// just enough of a bee for Promotions: get, a range read stream and writes, counting gets
class CountingBee {
  constructor() {
    this.map = new Map()
    this.gets = 0
    this.inflight = 0
    this.maxInflight = 0
  }

  putPending(key, weight) {
    this.apply({
      key: encoding.encodeSystemPendingKey(key),
      value: encoding.encodeSystemPending({ weight })
    })
  }

  putHint(key, weight) {
    this.apply({
      key: encoding.encodeSystemGrantKey(key),
      value: encoding.encodeSystemGrantHint({ key: b4a.alloc(32), length: 1, weight })
    })
  }

  apply({ key, value, remove }) {
    const hex = b4a.toString(key, 'hex')
    if (remove) this.map.delete(hex)
    else this.map.set(hex, value)
  }

  // resolves a tick later, like a read that has to go somewhere, so overlapping
  // reads show up in maxInflight
  async get(key) {
    this.gets++
    this.inflight++
    this.maxInflight = Math.max(this.maxInflight, this.inflight)
    await new Promise((resolve) => setImmediate(resolve))
    this.inflight--
    const value = this.map.get(b4a.toString(key, 'hex'))
    return value ? { key, value } : null
  }

  async *createReadStream({ gte, lt }) {
    const from = b4a.toString(gte, 'hex')
    const to = b4a.toString(lt, 'hex')
    for (const hex of [...this.map.keys()].sort()) {
      if (hex >= from && hex < to) yield { key: b4a.from(hex, 'hex'), value: this.map.get(hex) }
    }
  }
}
