# Quick Start

```sh
npm install autobee corestore
```

## Single writer

The simplest Autobee: one peer, writing and reading.

```js
const Autobee = require('autobee')
const Corestore = require('corestore')

const store = new Corestore('./my-db')
const db = new Autobee(store, null, { apply })
await db.ready()

// Append an operation
await db.append(JSON.stringify({ type: 'put', key: 'name', value: 'Alice' }))

// Read from the view
const node = await db.view.get('name')
console.log(node.value.toString()) // Alice

async function apply (nodes, view, host) {
  // Bootstrap the first writer on genesis
  if (host.genesis) {
    host.addWriter(db.local.key)
    return
  }

  for (const node of nodes) {
    const op = JSON.parse(node.value)
    if (op.type === 'put') {
      const w = view.write()
      w.tryPut(op.key, op.value)
      await w.flush()
    }
  }
}
```

`db.view` is a [Hyperbee](https://github.com/holepunch/hyperbee) — use its full API for reads: `get`, `createReadStream`, range queries, etc.

## Multiple writers

To let a second peer write, the first peer must add them via an operation in the log.

```js
// Peer 1: create the database
const db1 = new Autobee(store1, null, { apply })
await db1.ready()

// Share db1.key with Peer 2 (over the network, via QR code, etc.)
console.log(db1.id) // hex string — share this

// Peer 2: join using the key
const db2 = new Autobee(store2, db1.key, { apply })
await db2.ready()

// Peer 1 grants Peer 2 write access
await db1.append(JSON.stringify({ type: 'addWriter', key: db2.local.id }))

// Your apply function handles the addWriter operation:
async function apply (nodes, view, host) {
  if (host.genesis) {
    host.addWriter(db.local.key)
    return
  }

  for (const node of nodes) {
    const op = JSON.parse(node.value)
    if (op.type === 'addWriter') host.addWriter(op.key)
    if (op.type === 'put') {
      const w = view.write()
      w.tryPut(op.key, op.value)
      await w.flush()
    }
  }
}
```

Once Peer 2 has been added and the peers replicate, Peer 2 can append its own operations:

```js
await db2.append(JSON.stringify({ type: 'put', key: 'name', value: 'Bob' }))
```

## Replication

Autobee replication is stream-based. You can pipe two instances together directly:

```js
const s1 = db1.replicate(true)   // true = initiator
const s2 = db2.replicate(false)
s1.pipe(s2).pipe(s1)

// After data flows, trigger an apply cycle on both sides
await db1.update()
await db2.update()
```

For real peer-to-peer networking over the internet, use [Hyperswarm](https://github.com/holepunch/hyperswarm):

```js
const Hyperswarm = require('hyperswarm')

const swarm = new Hyperswarm()
swarm.join(db.discoveryKey)

swarm.on('connection', (socket) => {
  const stream = db.replicate(swarm.isInitiator(socket))
  socket.pipe(stream).pipe(socket)
  stream.on('close', () => db.update())
})
```

See [Replication](07-replication.md) for more detail on network setups.

## What's next

- [How it Works](01-concepts.md) — understand the mental model before going further
- [Writer Management](03-writer-management.md) — controlling who can write
- [The Apply Function](04-apply-function.md) — patterns and best practices for your apply logic
- [API Reference](11-api-reference.md) — complete API

---

[← Previous: How it Works](01-concepts.md) | [Index](../README.md) | [Next: Writer Management →](03-writer-management.md)
