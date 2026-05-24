# Replication

Autobee replication is stream-based and multiplexed. All writer oplogs and the view core replicate over a single stream, managed by the underlying Corestore.

## Replication streams

`db.replicate(isInitiator)` returns a Node.js stream. One side must pass `true` (the initiator), the other `false`.

```js
const s1 = db1.replicate(true)
const s2 = db2.replicate(false)
s1.pipe(s2).pipe(s1)
```

After data flows, trigger an apply cycle to process new operations:

```js
await db1.update()
await db2.update()
```

Or wait for full convergence across all known writers:

```js
await db1.flush()
```

## Replicating with Hyperswarm

For real peer-to-peer networking, use [Hyperswarm](https://github.com/holepunchto/hyperswarm) to find peers by the Autobee's discovery key:

```js
const Hyperswarm = require('hyperswarm')

const swarm = new Hyperswarm()
swarm.join(db.discoveryKey)
await swarm.flush() // wait for initial peer discovery

swarm.on('connection', (socket) => {
  const stream = db.replicate(swarm.isInitiator(socket))
  socket.pipe(stream).pipe(socket)
  stream.on('close', () => db.update())
})
```

`db.discoveryKey` is derived from `db.key` — peers joining the same key will find each other.

## Joining an existing Autobee

To join a database started by someone else, pass their `db.key` (or `db.id`) to your constructor:

```js
// Share this value out of band (QR code, URL, etc.)
console.log(db1.id)  // hex string

// Another peer joins:
const db2 = new Autobee(store2, db1.key, { apply })
await db2.ready()

// Connect via Hyperswarm or any stream and replicate
```

## Triggering apply after replication

Replication moves raw data between peers, but doesn't automatically run the apply cycle. After connecting and syncing, call `db.update()` to process any new operations that arrived:

```js
stream.on('close', () => db.update())
```

Or listen to the `'update'` event to react whenever new data is applied:

```js
db.on('update', () => {
  console.log('view updated — fetch fresh data')
})
```

## Waiting for full sync

`db.flush()` waits until all known writers have been fully indexed. Use this when you need to be certain the view is up to date before reading:

```js
await db.flush()
const node = await db.view.get('key')
```

`db.updated()` waits only for the current in-progress apply cycle to finish — lighter weight when you just appended something and want to read it back:

```js
await db.append(op)
await db.updated()
const result = await db.view.get('key')
```

## Out-of-band writer hints

If you learn about a new peer's writer key through a side channel (e.g. a signaling server), hint Autobee directly:

```js
db.wakeup({ key: writerPublicKey, length: knownLength })
```

This causes Autobee to start tracking and replicating that writer's core even before it appears through the normal apply cycle. Useful for faster bootstrapping in constrained network environments.

## View positions for coordination

`db.views()` returns the current core lengths for the system and view Hypercores. This is useful for building higher-level synchronization protocols that need to compare progress between peers.

```js
const positions = db.views()
// { system: { key, length }, view: { key, length } }
```

---

[← Previous: Custom Views](06-custom-views.md) | [Index](../README.md) | [Next: Events →](08-events.md)
