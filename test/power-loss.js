const test = require('brittle')
const fs = require('fs')
const { create, encode, replicate, replicateAndSync } = require('./helpers')

test('power loss - writing on a rolled back core fails with a fork error', async function (t) {
  const { a, b } = await rolledBack(t)

  const failed = new Promise((resolve) => a.once('error', resolve))

  await a.append(encode({ value: 'fork' }))

  const done = replicate(a, b)
  const err = await failed
  await done()

  t.is(err.message, 'Local oplog core forked at length 5')
})

test('power loss - writing while a peer is ahead fails with a rollback error', async function (t) {
  const { a, b, open } = await rolledBack(t)

  const done = replicate(a, b)
  await synced(a.local)

  const err = await a.append(encode({ value: 'held' })).catch((err) => err)

  // hypercore takes the peer's longer signed length for our core
  while (a.local.length < 9) await new Promise((resolve) => a.local.once('append', resolve))
  await done()

  t.is(err.message, 'Local oplog core rolled back to 4 of 9 blocks')

  await a.close()

  // offline, the signed length taken from the peer keeps failing
  const reopened = await open()
  const again = await reopened.append(encode({ value: 'held' })).catch((err) => err)

  t.is(again.message, 'Local oplog core rolled back to 4 of 9 blocks')
})

// `a` comes back from a backup taken before it replicated more to `b` - the
// same state a power cut leaves when the store's unsynced tail is lost
async function rolledBack(t) {
  const dir = await t.tmp()
  const backup = await t.tmp()

  const a = await create(t, { storage: dir })
  const b = await create(t, a.key)

  await a.append(encode({ addWriter: b.local.id }))
  for (let i = 0; i < 3; i++) await a.append(encode({ value: 'a' + i }))
  await replicateAndSync(a, b)
  await a.close()

  fs.cpSync(dir, backup, { recursive: true })

  const ahead = await create(t, a.key, { storage: dir })
  for (let i = 3; i < 8; i++) await ahead.append(encode({ value: 'a' + i }))
  await replicateAndSync(ahead, b)
  await ahead.close()

  const open = () => create(t, a.key, { storage: backup, allowBackup: true })

  return { a: await open(), b, open }
}

async function synced(core) {
  while (!core.peers.some((peer) => peer.remoteSynced)) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}
