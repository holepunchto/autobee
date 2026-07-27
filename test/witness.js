const test = require('brittle')
const b4a = require('b4a')
const { create, replicateAndSync, encode } = require('./helpers')

// 1) sanity: granter-backed witness elevates the claimant's node everywhere
test('witness - granter-backed elevation works end to end', async function (t) {
  const a = await create(t)
  const b = await create(t, a.key)
  const c = await create(t, a.key)

  await a.append(encode({ addWriter: b.local.id, weight: 2 }))
  await replicateAndSync(a, b, c)

  t.ok(b.writable, 'b writable')

  await b.append(encode({ msg: 'from b' }))
  await replicateAndSync(a, b, c)

  for (const [name, auto] of [
    ['a', a],
    ['b', b],
    ['c', c]
  ]) {
    const nodes = await auto.replay()
    const mine = nodes.filter((n) => b4a.equals(n.key, b.local.key))
    t.is(mine.length, 1, `${name}: b has one node`)
    t.is(mine[0].weight, 2, `${name}: b's node resolved at weight 2`)
    t.ok(mine[0].witness, `${name}: b's node carries a witness`)
  }
})

// 2) the third-party path: the granter's record is removed, so the claimant
// must fall back to an attestation signed by a bystander who applied the
// grant off a foreign batch (empty pending at attest time)
test('witness - third-party attestation elevates after granter removal', async function (t) {
  const a = await create(t)
  const b = await create(t, a.key)
  const c = await create(t, a.key)

  // c is an established writer first
  await a.append(encode({ addWriter: c.local.id, weight: 2 }))
  await replicateAndSync(a, b, c)
  t.ok(c.writable, 'c writable')

  // a grants b - both a AND c attest (c via applying a's foreign batch)
  await a.append(encode({ addWriter: b.local.id, weight: 2 }))
  await replicateAndSync(a, b, c)

  // c ships its queued attestation on its next flush
  await c.append(encode({ msg: 'carrier from c' }))
  await replicateAndSync(a, b, c)

  // dump what b harvested
  for (const w of b.writers.witnesses) {
    t.comment(
      `b harvested: backer=${b4a.toString(w.key, 'hex').slice(0, 8)} at ${w.length} weight=${w.attestation.weight}`
    )
  }

  // remove a: its attestation is now a dead backer, b must use c's
  await c.append(encode({ removeWriter: a.local.id }))
  await replicateAndSync(b, c)

  await b.append(encode({ msg: 'from b' }))
  await replicateAndSync(b, c)

  for (const [name, auto] of [
    ['b', b],
    ['c', c]
  ]) {
    const nodes = await auto.replay()
    const mine = nodes.filter((n) => b4a.equals(n.key, b.local.key))
    t.is(mine.length, 1, `${name}: b has one node`)
    if (mine[0].witness) {
      t.comment(
        `${name}: witness backer=${b4a.toString(mine[0].witness.backer.key, 'hex').slice(0, 8)} weight=${mine[0].witness.weight}`
      )
    }
    t.is(mine[0].weight, 2, `${name}: b's node resolved at weight 2 via third-party backer`)
  }
})

// 3) byzantine determinism: a buggy/colluding backer signs a claim no
// applied grant supports, and a buggy claimant embeds it anyway (bypassing
// append's selection filter). resolvers must floor the node - and, the real
// point, they must all floor it IDENTICALLY: a garbage claim may cost the
// claimant its elevation, but it must never buy a consistency split
test('witness - unbacked claim floors deterministically on every peer', async function (t) {
  const { signAttestation } = require('../lib/witness.js')

  const a = await create(t)
  const b = await create(t, a.key)
  const c = await create(t, a.key)

  await a.append(encode({ addWriter: b.local.id, weight: 2 }))
  await a.append(encode({ addWriter: c.local.id, weight: 2 }))
  await replicateAndSync(a, b, c)

  // b establishes its honest standing of 2 first
  await b.append(encode({ msg: 'honest' }))
  await replicateAndSync(a, b, c)

  // c "buggily" attests b at weight 3 - no grant of 3 exists anywhere
  const backerInfo = await b.system.get(c.local.key)
  const signature = signAttestation(
    c.local.keyPair.secretKey,
    c.local.key,
    b.local.key,
    backerInfo.length,
    3
  )
  const manifest = c.local.getManifest({ raw: true })

  // b (buggy too) embeds it directly, bypassing append()'s selection filter
  const links = b.system.getLinks(b.local.key)
  const ts = Math.max(Date.now(), b.system.timestamp)
  b.writers.appendLocal(encode({ msg: 'inflated' }), ts, { start: 0, end: 0 }, links, false, {
    weight: 3,
    backer: { key: c.local.key, length: backerInfo.length, signature, manifest }
  })
  await b._bump()

  await replicateAndSync(a, b, c)

  for (const [name, auto] of [
    ['a', a],
    ['b', b],
    ['c', c]
  ]) {
    const nodes = await auto.replay()
    const mine = nodes.filter((n) => b4a.equals(n.key, b.local.key))
    t.is(mine.length, 2, `${name}: b has two nodes`)
    t.is(mine[0].weight, 2, `${name}: honest node holds at 2`)
    t.is(mine[1].weight, 2, `${name}: inflated claim floored at prev standing, not 3`)
  }
})
