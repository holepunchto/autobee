const test = require('brittle')
const Corestore = require('corestore')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { create, sync, replicate, encode } = require('./helpers')

test('a restored writer converges once its own lost tail is replicated back', async function (t) {
  const dir = await t.tmp()
  const keyPair = crypto.keyPair(b4a.alloc(32).fill('own-tail'))

  const a = await create(t)
  const b = await create(t, a.key, { keyPair })

  await a.append(encode({ addWriter: b.local.id }))

  let unreplicate = replicate(a, b)
  await sync(a, b)

  for (let i = 0; i < 47; i++) await b.append(encode({ value: 'b' + i }))
  await sync(a, b)

  for (let i = 0; i < 3; i++) await a.append(encode({ value: 'a' + i }))
  await sync(a, b)

  const key = b.local.key
  const canonical = b.local.length

  // mirror the full writer core so the withheld tail can be served later
  const mirror = new Corestore(dir + '/mirror', { manifestVersion: 2 })
  t.teardown(() => mirror.close())

  const copy = mirror.get({ key })
  await copy.ready()

  const s1 = b.store.replicate(true)
  const s2 = mirror.replicate(false)
  s1.pipe(s2).pipe(s1)

  await copy.download({ start: 0, end: canonical }).done()

  s1.destroy()
  s2.destroy()

  await unreplicate()
  await b.close()

  // A keeps the length but forgets the blocks: it serves the backlog, not the tail
  const aB = a.store.get({ key })
  await aB.ready()
  await aB.clear(0, canonical)
  await aB.close()

  // hard-kill restore: the same writer identity with none of its own history
  const r = await create(t, a.key, { keyPair })
  t.is(r.local.length, 0)

  unreplicate = replicate(a, r)
  await r.updated()

  // deliver the own-tail blocks: the writer must reschedule and apply them
  const s3 = mirror.replicate(true)
  const s4 = r.store.replicate(false)
  s3.pipe(s4).pipe(s3)
  t.teardown(() => {
    s3.destroy()
    s4.destroy()
    return unreplicate()
  })

  let applied = 0
  for (let i = 0; i < 80 && applied < canonical; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    await r.updated()
    const info = await r.system.get(r.local.key)
    applied = info ? info.length : 0
  }

  t.is(applied, canonical)
  if (applied !== canonical) return

  // the adopted tail must not poison the next append
  await r.append(encode({ value: 'post-restore' }))
  await sync(a, r)

  const info = await a.system.get(r.local.key)
  t.is(info.length, canonical + 1)
})
