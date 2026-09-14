const test = require('brittle')
const { create, replicate, replicateAndSync, sync, encode } = require('./helpers')

const N = 10

test('weights - a weight-1 request in front of 10 online standing-1 peers triggers no appends', async function (t) {
  const g = await create(t)
  const peers = []
  for (let i = 0; i < N; i++) peers.push(await create(t, g.key))
  const n = await create(t, g.key)

  for (const p of peers) await g.append(encode({ addWriter: p.local.id, weight: 1 }))
  await g.append(encode({ msg: 'g-approves' }))
  await replicateAndSync(g, ...peers)
  for (const p of peers) await p.append(encode({ msg: 'cite' }))
  await replicateAndSync(g, ...peers)

  for (const p of peers) {
    const own = await p.system.get(p.local.key)
    t.is(own.weight, 1, 'peer stands at 1 in its own view')
  }

  await g.append(encode({ addWriter: n.local.id, weight: 1 }))
  await replicateAndSync(g, n, ...peers)

  const all = [g, n, ...peers]

  for (const a of all) {
    t.is(await a.system.pendingPromotion(n.local.key), 1, `${a.name}: tier-1 request is pending`)
    t.ok(a.system.promotions.digest[0], `${a.name}: tier 1 open`)
    t.absent(await a.system.grantHint(n.local.key), `${a.name}: not anchored yet`)
  }

  const before = all.map((a) => a.local.length)
  const appends = all.map((a) => a.stats.appends)

  const done = replicate(...all)
  await sync(...all)
  await new Promise((resolve) => setTimeout(resolve, 2000))
  for (const a of all) await a.updated()
  for (const a of all) await a.flush()
  await sync(...all)
  await done()

  for (let i = 0; i < all.length; i++) {
    t.is(all[i].local.length, before[i], `${all[i].name}: local core untouched while idle`)
    t.is(all[i].stats.appends, appends[i], `${all[i].name}: no append happened`)
    t.is(await all[i].system.pendingPromotion(n.local.key), 1, `${all[i].name}: still pending`)
    t.absent(await all[i].system.grantHint(n.local.key), `${all[i].name}: still not anchored`)
  }

  await peers[0].append(encode({ msg: 'user-append' }))
  await replicateAndSync(...all)

  for (const a of all) {
    t.is(
      await a.system.pendingPromotion(n.local.key),
      0,
      `${a.name}: pending cleared by user append`
    )
    const hint = await a.system.grantHint(n.local.key)
    t.is(hint && hint.weight, 1, `${a.name}: anchored at 1`)
  }
  t.is(peers[0].local.length, before[2] + 1, 'exactly one node carried it')
})
