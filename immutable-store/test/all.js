const sodium = require('sodium-universal')
const test = require('tape')
const Omega = require('omega')

const ImmutableStore = require('..')

test('simple exchange', async t => {
  const o1 = Omega.createProtocolStream(true)
  const o2 = Omega.createProtocolStream(false)
  o1.pipe(o2).pipe(o1)

  const store1 = new ImmutableStore()
  const store2 = new ImmutableStore()

  store1.register(o1)
  store2.register(o2)

  const hash = await store1.put(Buffer.from('hello world'))

  const val = await store2.get(hash)
  t.same(val, Buffer.from('hello world'))

  t.end()
})

test('second get should not send requests', async t => {
  const o1 = Omega.createProtocolStream(true)
  const o2 = Omega.createProtocolStream(false)
  o1.pipe(o2).pipe(o1)

  let s1rx = 0
  let s2rx = 0
  const store1 = new ImmutableStore({ debug: { onmessage: () => s1rx++ } })
  const store2 = new ImmutableStore({ debug: { onmessage: () => s2rx++ } })

  store1.register(o1)
  store2.register(o2)

  const hash = await store1.put(Buffer.from('hello world'))

  {
    const val = await store2.get(hash)
    t.same(val, Buffer.from('hello world'))
  }

  {
    // A second get should not hit the network.
    const rxBeforeGet = s1rx
    const val = await store2.get(hash)
    t.same(val, Buffer.from('hello world'))
    t.true(s1rx > 0)
    t.same(s1rx, rxBeforeGet)
  }

  t.end()
})

test('values split between peers', async t => {
  const o1 = Omega.createProtocolStream(true)
  const o2 = Omega.createProtocolStream(false)
  const o3 = Omega.createProtocolStream(true)
  const o4 = Omega.createProtocolStream(false)
  o1.pipe(o2).pipe(o1)
  o3.pipe(o4).pipe(o3)

  const store1 = new ImmutableStore()
  const store2 = new ImmutableStore()
  const store3 = new ImmutableStore()

  /**
   *         |----> store2 (hello)
   *  store1
   *         |----> store3 (world)
   *
   * */
  store1.register(o1)
  store1.register(o3)
  store2.register(o2)
  store3.register(o4)

  const h1 = await store2.put(Buffer.from('hello'))
  const h2 = await store3.put(Buffer.from('world'))

  t.same(await store1.get(h1), Buffer.from('hello'))
  t.same(await store1.get(h2), Buffer.from('world'))

  t.end()
})

test('empty response scenarios', async t => {
  const o1 = Omega.createProtocolStream(true)
  const o2 = Omega.createProtocolStream(false)
  o1.pipe(o2).pipe(o1)

  let received = 0
  const store1 = new ImmutableStore({
    timeout: 50,
    debug: {
      onmessage (msg, from) {
        t.true(msg.response && msg.response.discoveryKey)
        t.false(msg.response.hash)
        t.false(msg.response.value)
        received++
      }
    }
  })
  const store2 = new ImmutableStore()

  store1.register(o1)
  store2.register(o2)

  const h1 = await store2.put(Buffer.from('hello world'))

  // Remote does not have this value -- empty response
  await store1.get(randomBytes(32))

  // Remote has the value, but the capability check should fail.
  store1._send([...store1._exts.values()][0], {
    request: {
      discoveryKey: deriveHash(h1),
      capability: randomBytes(32)
    }
  })

  await new Promise(resolve => setImmediate(resolve))
  t.same(received, 2)

  t.end()
})

test('parallel gets should only trigger one request', async t => {
  const o1 = Omega.createProtocolStream(true)
  const o2 = Omega.createProtocolStream(false)
  o1.pipe(o2).pipe(o1)

  let received = 0
  const store1 = new ImmutableStore({
    debug: {
      onmessage () {
        received++
      }
    }
  })
  const store2 = new ImmutableStore()

  store1.register(o1)
  store2.register(o2)

  const h1 = await store1.put(Buffer.from('a'))

  const promises = []
  for (let i = 0; i < 5; i++) {
    promises.push(store2.get(h1))
  }

  const results = await Promise.all(promises)
  t.same(Buffer.concat(results), Buffer.from('aaaaa'))
  t.same(received, 1)

  t.end()
})

function randomBytes (len) {
  const buf = Buffer.allocUnsafe(len)
  sodium.randombytes_buf(buf)
  return buf
}

function deriveHash (buf) {
  const digest = Buffer.allocUnsafe(32)
  sodium.crypto_generichash(digest, buf)
  return digest
}
