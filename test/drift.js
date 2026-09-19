const test = require('brittle')
const { create, replicateAndSync, encode } = require('./helpers')
const encoding = require('../lib/encoding.js')

const SKEW = 30 * 60 * 1000

async function last(auto) {
  return encoding.decodeOplog(await auto.local.get(auto.local.length - 1))
}

test('drift - zero when our clock is not behind the system', async function (t) {
  const a = await create(t)

  await a.append(encode({ m: 'one' }))
  await a.updated()

  const node = await last(a)
  t.is(node.drift, 0, 'no drift on a lone writer')
  t.ok(node.timestamp <= Date.now(), 'stamped with our own clock')
})

test('drift - records how far the system ts is ahead of our clock', async function (t) {
  const a = await create(t)
  const b = await create(t, a.key, { now: () => Date.now() + SKEW })

  await a.append(encode({ addWriter: b.local.id, weight: 3 }))
  await a.append(encode({ m: 'approve' }))
  await replicateAndSync(a, b)

  await b.append(encode({ m: 'from the future' }))
  await replicateAndSync(a, b)

  const ahead = await last(b)
  t.is(ahead.drift, 0, 'the fast clock never lags the system')

  const before = Date.now()
  await a.append(encode({ m: 'from the present' }))
  await a.updated()
  const after = Date.now()

  const node = await last(a)
  t.is(node.timestamp, ahead.timestamp, 'stamped no earlier than what we link')
  t.ok(node.drift >= ahead.timestamp - after, 'drift is at least the lag')
  t.ok(node.drift <= ahead.timestamp - before, 'drift is at most the lag')
  t.is(
    node.timestamp - node.drift >= before && node.timestamp - node.drift <= after,
    true,
    'ts minus drift is our clock'
  )
})

test('drift - absent on nodes that predate the field', async function (t) {
  const a = await create(t)

  await a.append(encode({ m: 'one' }))
  await a.updated()

  const oplog = encoding.decodeOplog(await a.local.get(0))
  delete oplog.drift

  t.is(encoding.decodeOplog(encoding.encodeOplog(oplog)).drift, 0, 'decodes as zero')
})
