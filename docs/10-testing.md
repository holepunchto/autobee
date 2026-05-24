# Testing

Autobee applications are straightforward to test because replication is stream-based and storage can be in-memory. You don't need a network or persistent files to test multiwriter scenarios.

## In-memory setup

Use `corestore` with `ram` storage to keep everything in memory:

```js
const Autobee = require('autobee')
const Corestore = require('corestore')

function createDB (key, opts) {
  const store = new Corestore(require('random-access-memory'))
  return new Autobee(store, key || null, opts)
}
```

Or with a test framework like [brittle](https://github.com/holepunchto/brittle):

```js
const test = require('brittle')
const Autobee = require('autobee')
const Corestore = require('corestore')
const RAM = require('random-access-memory')

test('basic put and get', async (t) => {
  const db = new Autobee(new Corestore(RAM), null, { apply })
  await db.ready()

  await db.append(JSON.stringify({ type: 'put', key: 'hello', value: 'world' }))
  await db.updated()

  const node = await db.view.get('hello')
  t.is(node.value.toString(), 'world')

  await db.close()
})
```

## Simulating multiple writers

Create each peer with their own store. Replicate them in-process:

```js
async function createAndSync (...dbs) {
  // Connect all pairs
  for (let i = 0; i < dbs.length - 1; i++) {
    const s1 = dbs[i].replicate(true)
    const s2 = dbs[i + 1].replicate(false)
    s1.pipe(s2).pipe(s1)
  }

  // Wait for all to fully index
  await Promise.all(dbs.map(db => db.flush()))
}

test('two writers converge', async (t) => {
  const db1 = new Autobee(new Corestore(RAM), null, { apply })
  await db1.ready()

  const db2 = new Autobee(new Corestore(RAM), db1.key, { apply })
  await db2.ready()

  // db1 adds db2 as a writer
  await db1.append(JSON.stringify({ type: 'addWriter', key: db2.local.id }))

  await createAndSync(db1, db2)

  // Now both can write
  await db2.append(JSON.stringify({ type: 'put', key: 'from-db2', value: '!' }))

  await createAndSync(db1, db2)

  // Both peers should see the same value
  const n1 = await db1.view.get('from-db2')
  const n2 = await db2.view.get('from-db2')
  t.alike(n1.value, n2.value)
})
```

## Asserting view convergence

A useful helper to verify two or more peers have identical views:

```js
async function assertSameView (...dbs) {
  const results = await Promise.all(
    dbs.map(db => collectAll(db.view.createReadStream()))
  )

  for (let i = 1; i < results.length; i++) {
    assert.deepStrictEqual(results[0], results[i], `peer ${i} view differs`)
  }
}

async function collectAll (stream) {
  const entries = []
  for await (const node of stream) {
    entries.push({ key: node.key.toString(), value: node.value.toString() })
  }
  return entries
}
```

## Testing concurrent writes

To test concurrent write behavior, append from multiple peers before replicating:

```js
test('concurrent puts converge', async (t) => {
  // Set up two writers (after addWriter dance + initial sync)
  // ...

  // Both write concurrently, before seeing each other's data
  await db1.append(JSON.stringify({ type: 'put', key: 'x', value: 'from-1' }))
  await db2.append(JSON.stringify({ type: 'put', key: 'x', value: 'from-2' }))

  // Now sync
  await createAndSync(db1, db2)

  // Both peers should agree — exact value depends on your apply logic
  const n1 = await db1.view.get('x')
  const n2 = await db2.view.get('x')
  t.alike(n1.value, n2.value)  // they agree, even if we don't know which "won"
})
```

## Testing the apply function in isolation

Because `apply` is a plain async function, you can test it directly without a full Autobee:

```js
test('apply handles put operations', async (t) => {
  const ops = [
    { value: Buffer.from(JSON.stringify({ type: 'put', key: 'a', value: '1' })) },
    { value: Buffer.from(JSON.stringify({ type: 'put', key: 'b', value: '2' })) }
  ]

  const written = []
  const mockView = {
    write: () => ({
      tryPut: (k, v) => written.push({ key: k, value: v }),
      flush: async () => {}
    })
  }
  const mockHost = { genesis: false }

  await apply(ops, mockView, mockHost)

  t.is(written.length, 2)
  t.is(written[0].key, 'a')
})
```

## Cleanup

Always close your Autobee instances after tests to avoid resource leaks:

```js
t.teardown(() => Promise.all([db1.close(), db2.close()]))
```

---

[← Previous: Interrupts](09-interrupts.md) | [Index](../README.md) | [Next: API Reference →](11-api-reference.md)
