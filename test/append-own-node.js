// #356: append() must resolve once its own node is applied, not when the
// shared drain goes idle. With other writers producing continuously, waiting
// on the drain makes append latency track everyone else's traffic.
const test = require('brittle')
const { create, replicateAndSync, encode, apply } = require('./helpers')

test('append resolves when its own node is applied, not when the drain goes idle (#356)', async function (t) {
  const n = 5
  const applied = new Map()

  const bees = [
    await create(t, {
      apply: async (batch, view, host) => {
        for (const node of batch) {
          try {
            const op = JSON.parse(node.value)
            if (op.me && !applied.has(op.v)) applied.set(op.v, Date.now())
          } catch {
            // ignore
          }
        }
        return apply(batch, view, host)
      }
    })
  ]
  for (let i = 1; i < n; i++) bees.push(await create(t, bees[0].key))

  for (const db of bees.slice(1)) {
    await bees[0].append(encode({ addWriter: db.local.id }))
  }
  await replicateAndSync(...bees)

  for (const db of bees) t.ok(db.writable, 'writable after bootstrap')

  let running = true
  const others = bees.slice(1).map(async (db) => {
    while (running) {
      try {
        await db.append(encode({ pad: Date.now() }))
      } catch {
        break
      }
    }
  })

  await new Promise((r) => setTimeout(r, 50))

  const appendLat = []
  const applyLat = []
  for (let i = 0; i < 8; i++) {
    const v = Date.now()
    const t0 = Date.now()
    await bees[0].append(encode({ v, me: true }))
    appendLat.push(Date.now() - t0)
    applyLat.push(applied.has(v) ? applied.get(v) - v : -1)
    await new Promise((r) => setTimeout(r, 20))
  }

  running = false
  await Promise.all(others)

  const p50 = (a) => {
    const s = a.filter((x) => x >= 0).sort((x, y) => x - y)
    return s[Math.floor(s.length / 2)]
  }

  t.comment(
    `append p50=${p50(appendLat)}ms max=${Math.max(...appendLat)}ms | apply p50=${p50(applyLat)}ms`
  )

  // On main, append p50 tracked the drain (hundreds of ms to seconds) while
  // apply stayed near-instant. With the fix, append settles with apply.
  t.ok(p50(appendLat) < 200, `append p50 stays near apply under load (got ${p50(appendLat)}ms)`)
  t.ok(
    Math.max(...appendLat) < 2000,
    `append max does not wait out the drain (got ${Math.max(...appendLat)}ms)`
  )
  for (const d of applyLat) t.ok(d >= 0, 'every append was seen by apply')
})
