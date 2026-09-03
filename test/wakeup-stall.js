const test = require('brittle')
const { create, replicate, replicateAndSync, encode } = require('./helpers')

test('wakeup - a hint no peer can serve does not stall the drain', async function (t) {
  const { a, b, c } = await setup(t)

  const before = await appendAndSettle(a, b)

  a.hintWakeup({ key: c.local.key, length: c.local.length })
  const during = await appendAndSettle(a, b)

  t.comment(
    `b append visible on a: ${before} ms before the hint, ${during} ms while the hint is being read`
  )
  t.ok(before < 500, 'drain is prompt without the hint')
  t.ok(during < 500, 'drain is prompt while the hint is being read')
})

// c is a writer a knows but never connects to, so its head cannot be fetched
async function setup(t) {
  const a = await create(t)
  const b = await create(t, a.key)
  const c = await create(t, a.key)

  await a.append(encode({ addWriter: b.local.id, weight: 1 }))
  await a.append(encode({ addWriter: c.local.id, weight: 1 }))
  await replicateAndSync(a, b)
  await replicateAndSync(a, c)

  await c.append(encode({ from: 'c' }))

  t.teardown(replicate(a, b))

  return { a, b, c }
}

async function appendAndSettle(a, b) {
  const start = Date.now()
  await b.append(encode({ from: 'b', at: start }))

  const key = b.local.key
  while (true) {
    const info = await a.system.get(key)
    if (info && info.length === b.local.length) return Date.now() - start
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
