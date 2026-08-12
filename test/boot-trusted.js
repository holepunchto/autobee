const test = require('brittle')
const b4a = require('b4a')

const { create, replicate, sync, same, apply, encode, decode } = require('./helpers')

async function trustApply(nodes, view, host) {
  for (const node of nodes) {
    const data = decode(node.value)
    if (data.addWriter) host.addWriter(data.addWriter, { weight: data.weight })

    const w = view.write()
    if (data.trust) w.tryPut(b4a.from('@trusted/' + data.trust), b4a.from('1'))
    w.tryPut(b4a.from('@head/' + b4a.toString(node.key, 'hex')), b4a.from('' + node.length))
    w.tryPut(b4a.from('latest'), node.value)
    await w.flush()
  }
}

function mirror(a, b) {
  const s1 = a.store.replicate(true)
  const s2 = b.store.replicate(false)

  s1.pipe(s2).pipe(s1)

  s1.on('error', () => {})
  s2.on('error', () => {})

  return async () => {
    s1.destroy()
    s2.destroy()
    await Promise.all([
      new Promise((resolve) => s1.once('close', resolve)),
      new Promise((resolve) => s2.once('close', resolve))
    ])
  }
}

test('bootFrom trusted - bootCondition fast-forwards to first accepted trusted head', async function (t) {
  const auto1 = await create(t)

  for (let i = 0; i < 1000; i++) {
    await auto1.append(encode({ value: 'a' + i }))
  }

  let sawView = false

  const auto3 = await create(t, auto1.key, {
    bootFrom: {
      trusted: {
        key: auto1.local.key,
        bootCondition: async (view, ontrusted) => {
          const entry = await view.get(b4a.from('latest'))
          if (!entry) return false
          sawView = true
          return decode(entry.value).value === 'a999'
        }
      }
    }
  })

  const moved = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('did not move')), 10_000)
    auto3.once('move-to', () => {
      clearTimeout(timer)
      resolve()
    })
  })

  t.teardown(replicate(auto1, auto3))

  await t.execution(moved, 'joiner fast-forwarded')

  t.ok(sawView, 'bootCondition was consulted with a candidate view')
  t.alike(auto1.view.head(), auto3.view.head(), 'joiner landed on the tip')

  const node = await auto3.view.get(b4a.from('latest'))
  t.alike(node.value, encode({ value: 'a999' }), 'joiner has the accepted state')

  t.ok(await same(auto1, auto3), 'views converged')
})

test('bootFrom trusted - bootCondition can discover more trusted keys via ontrusted', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)

  for (let i = 0; i < 100; i++) {
    await auto1.append(encode({ value: 'a' + i }))
  }

  let discovered = false
  const extra = auto2.local.key

  const auto3 = await create(t, auto1.key, {
    bootFrom: {
      trusted: {
        key: auto1.local.key,
        bootCondition: async (view, ontrusted) => {
          const entry = await view.get(b4a.from('latest'))
          if (!entry) return false
          await ontrusted(extra)
          discovered = auto3.trusted.cores.has(b4a.toString(extra, 'hex'))
          return decode(entry.value).value === 'a99'
        }
      }
    }
  })

  const moved = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('did not move')), 10_000)
    auto3.once('move-to', () => {
      clearTimeout(timer)
      resolve()
    })
  })

  t.teardown(replicate(auto1, auto3))

  await t.execution(moved, 'joiner fast-forwarded')

  t.ok(discovered, 'ontrusted added the discovered key to the trusted set')
  t.ok(auto3.trusted.cores.has(b4a.toString(auto1.local.key, 'hex')), 'seed trusted key tracked')
  t.ok(auto3.trusted.cores.has(b4a.toString(extra, 'hex')), 'discovered trusted key tracked')
})

test('bootFrom trusted - close settles while boot is parked', async function (t) {
  const auto1 = await create(t)
  await auto1.append(encode({ value: 'a' }))

  const auto3 = await create(t, auto1.key, {
    bootFrom: {
      trusted: {
        key: auto1.local.key,
        bootCondition: () => false
      }
    }
  })

  const teardown = replicate(auto1, auto3)

  await new Promise((resolve) => setTimeout(resolve, 500))

  const started = Date.now()
  const result = await Promise.race([
    auto3.close().then(() => 'closed'),
    new Promise((resolve) => setTimeout(() => resolve('timed out'), 10_000))
  ])

  t.is(result, 'closed', 'close settled while parked')
  t.comment('close took ' + (Date.now() - started) + 'ms')

  await teardown()
})

test('bootFrom trusted - bootCondition defaults to accepting the first head', async function (t) {
  const auto1 = await create(t)

  for (let i = 0; i < 200; i++) {
    await auto1.append(encode({ value: 'a' + i }))
  }

  const auto3 = await create(t, auto1.key, {
    bootFrom: {
      trusted: { key: auto1.local.key }
    }
  })

  const moved = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('did not move')), 10_000)
    auto3.once('move-to', () => {
      clearTimeout(timer)
      resolve()
    })
  })

  t.teardown(replicate(auto1, auto3))

  await t.execution(moved, 'joiner fast-forwarded with default bootCondition')

  t.ok(await same(auto1, auto3), 'views converged')
})

test('bootFrom head - fast-forwards straight onto a known head', async function (t) {
  const auto1 = await create(t)

  for (let i = 0; i < 200; i++) {
    await auto1.append(encode({ value: 'a' + i }))
  }

  const head = { key: auto1.local.key, length: auto1.local.length }

  const auto3 = await create(t, auto1.key, { bootFrom: { head } })

  const moved = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('did not move')), 10_000)
    auto3.once('move-to', () => {
      clearTimeout(timer)
      resolve()
    })
  })

  t.teardown(replicate(auto1, auto3))

  await t.execution(moved, 'joiner fast-forwarded from head')

  t.ok(await same(auto1, auto3), 'views converged')
})

test('bootFrom - head is favoured when both head and trusted are set', async function (t) {
  const auto1 = await create(t)

  for (let i = 0; i < 200; i++) {
    await auto1.append(encode({ value: 'a' + i }))
  }

  const head = { key: auto1.local.key, length: auto1.local.length }

  let bootConditionCalled = false

  const auto3 = await create(t, auto1.key, {
    bootFrom: {
      head,
      trusted: {
        key: auto1.local.key,
        bootCondition: () => {
          bootConditionCalled = true
          return true
        }
      }
    }
  })

  const moved = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('did not move')), 10_000)
    auto3.once('move-to', () => {
      clearTimeout(timer)
      resolve()
    })
  })

  t.teardown(replicate(auto1, auto3))

  await t.execution(moved, 'joiner fast-forwarded')

  t.absent(bootConditionCalled, 'trusted bootCondition was not consulted when head is set')
  t.ok(await same(auto1, auto3), 'views converged')
})

test('trusted - fast-forward to a trusted peer head advertised by another writer', async function (t) {
  const a = await create(t)
  const b = await create(t, a.key)

  await a.trusted.add(a.local.key)
  await b.trusted.add(a.local.key)

  const unreplicate = replicate(a, b)

  await a.append(encode({ addWriter: b.local.id }))
  for (let i = 0; i < 100; i++) {
    await a.append(encode({ value: 'a' + i }))
  }

  await sync(a, b)

  for (let i = 0; i < 5; i++) {
    await b.append(encode({ value: 'b' + i }))
  }

  await sync(a, b)
  await unreplicate()

  t.ok(a.system.flushes >= 32, 'a is far enough ahead to fast-forward')

  let slow = true
  const c = await create(t, a.key, {
    async apply(nodes, view, host) {
      for (const node of nodes) {
        if (slow) await new Promise((resolve) => setTimeout(resolve, 1000))
        await apply([node], view, host)
      }
    }
  })
  await c.trusted.add(a.local.key)

  const moved = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('did not move')), 30_000)
    c.once('move-to', () => {
      clearTimeout(timer)
      resolve()
    })
  })

  t.teardown(mirror(a, c))

  await t.execution(moved, 'c fast-forwarded from a trusted head advertised by b')

  slow = false
  let converged = false
  for (let i = 0; i < 100 && !converged; i++) {
    converged = await same(a, c)
    if (!converged) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  t.ok(converged, 'c converged with a')
})

test('trusted - resolve an untrusted advertised head via its view, then grow trust', async function (t) {
  const bhex = (k) => b4a.toString(k, 'hex')

  const a = await create(t, { apply: trustApply })
  const b = await create(t, a.key, { apply: trustApply })

  // a trusts b (so a advertises b's head); b applies a but does NOT trust a,
  // so b's oplog advertises nothing - c can only reach a via b's view.
  await a.trusted.add(b.local.key)

  const unreplicate = replicate(a, b)

  await a.append(encode({ addWriter: b.local.id }))
  await a.append(encode({ trust: bhex(b.local.key) }))
  await sync(a, b)

  for (let i = 0; i < 100; i++) {
    await a.append(encode({ value: 'a' + i }))
  }
  await sync(a, b)

  for (let i = 0; i < 5; i++) {
    await b.append(encode({ value: 'b' + i }))
  }
  await sync(a, b)

  // final append so a flushes its tip (b's head) into its oplog trusted field
  await a.append(encode({ value: 'final' }))
  await sync(a, b)
  await unreplicate()

  let slow = true
  let cRef = null
  const c = await create(t, a.key, {
    async apply(nodes, view, host) {
      for (const node of nodes) {
        if (slow) await new Promise((resolve) => setTimeout(resolve, 1000))
        await trustApply([node], view, host)
      }
    },
    async ontrusted(peer, view, auto) {
      const stream = view.createReadStream({ gte: b4a.from('@head/'), lt: b4a.from('@head0') })
      for await (const { key, value } of stream) {
        const hex = b4a.toString(key).slice('@head/'.length)
        const peerKey = b4a.from(hex, 'hex')
        if (auto.trusted.has(peerKey)) return { key: peerKey, length: Number(b4a.toString(value)) }
      }
      return null
    },
    async update(view) {
      const stream = view.createReadStream({
        gte: b4a.from('@trusted/'),
        lt: b4a.from('@trusted0')
      })
      for await (const { key } of stream) {
        const hex = b4a.toString(key).slice('@trusted/'.length)
        await cRef.trusted.add(b4a.from(hex, 'hex'))
      }
    }
  })
  cRef = c
  await c.trusted.add(a.local.key)

  const moved = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('did not move')), 30_000)
    c.once('move-to', () => {
      clearTimeout(timer)
      resolve()
    })
  })

  t.teardown(mirror(a, c))

  await t.execution(moved, 'c resolved a via untrusted b view and fast-forwarded onto a')

  slow = false
  let converged = false
  for (let i = 0; i < 100 && !converged; i++) {
    converged = await same(a, c)
    if (!converged) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  t.ok(converged, 'c converged with a')
  t.ok(c.trusted.has(b.local.key), 'c grew trust to b from the view diff')
})
