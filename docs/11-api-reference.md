# API Reference

## Constructor & Lifecycle

#### `const db = new Autobee(store, [key], [options])`

Create a new Autobee. `store` is a Corestore. `key` is the public key of an existing Autobee to join — omit or pass `null` to create a new one.

```js
{
  apply (nodes, view, host) {},  // required — merge operations into the view
  open (bee, db) {},             // optional — return a custom view object
  close (view) {},               // optional — clean up the custom view
  update (view, changes) {},     // optional — called after each apply cycle
  encryptionKey: Buffer,         // 32-byte key for at-rest encryption
  encrypted: false,              // set true when using encryptionKey
  keyPair: { publicKey, secretKey }, // custom signing key pair for local writer
  optimistic: false              // allow optimistic appends before confirmed as writer
}
```

#### `await db.ready()`

Wait for the instance to fully initialize. Must be called before using the database.

#### `await db.close()`

Shut down the instance. Closes all underlying Hypercores and the Corestore.

---

## Identity & State

#### `db.key` → `Buffer`

The public key of this Autobee. Share with peers so they can join using the same key.

#### `db.id` → `string`

`db.key` encoded as a hex string.

#### `db.discoveryKey` → `Buffer`

The discovery key. Pass to Hyperswarm's `swarm.join()` to find peers on the network.

#### `db.local`

The local writer Hypercore.

```js
db.local.key    // Buffer — writer public key
db.local.id     // string — writer public key as hex
db.local.length // number — number of entries appended
```

#### `db.writable` → `boolean`

`true` if this instance has been added as a confirmed writer.

#### `db.isIndexer` → `boolean`

`true` if this writer has indexer weight (weight=2).

#### `db.encrypted` → `boolean`

`true` if encryption is enabled.

#### `db.interrupted`

The reason passed to `host.interrupt()` if the last apply cycle was interrupted, otherwise `null`.

---

## Reading

#### `db.view`

A read-only snapshot of the Hyperbee view. Updated after each apply cycle. Use the full [Hyperbee](https://github.com/holepunchto/hyperbee) API:

```js
await db.view.get(key)
db.view.createReadStream([options])
db.view.createHistoryStream([options])
```

#### `db.bee`

Alias for `db.view`.

---

## Writing

#### `await db.append(value | values, [options])`

Append one or more values to the local writer oplog. Triggers an apply cycle.

```js
await db.append(Buffer.from('hello'))
await db.append([buf1, buf2, buf3])
await db.append(buf, { optimistic: true }) // write without confirmed writer status
```

---

## Syncing

#### `await db.update()`

Trigger a new apply cycle. Call this after replication to process newly arrived data.

#### `await db.updated()`

Wait for the current in-progress apply cycle to finish. Lighter than `flush()`.

#### `await db.flush()`

Wait until all known writers have been fully indexed. Use when you need certainty that the view reflects all available data.

---

## Replication

#### `stream = db.replicate(isInitiator)`

Create a replication stream. Pass `true` for the initiating side, `false` for the other.

```js
const s1 = db1.replicate(true)
const s2 = db2.replicate(false)
s1.pipe(s2).pipe(s1)
```

#### `db.wakeup({ key, length })`

Hint that a writer core at `key` has at least `length` entries available. Used for out-of-band peer discovery to start replication before the writer appears through normal apply.

#### `views = db.views()`

Returns current core positions for the system and view Hypercores. Used for external sync coordination.

```js
{ system: { key: Buffer, length: Number }, view: { key: Buffer, length: Number } }
```

---

## Writer Rotation

#### `await db.setLocal(key, [options])`

Rotate the local writer to a different public key. The new key becomes the active oplog. Emits `'rotate-local-writer'` when complete.

```js
await db.setLocal(newKeyPair.publicKey, { keyPair: newKeyPair })
```

---

## Apply Host API

These methods are only available inside your `apply` function via the `host` argument.

#### `host.addWriter(key, [options])`

Grant write permission to a peer by public key (Buffer or hex string).

```js
host.addWriter(key)
host.addWriter(key, { isIndexer: false })
```

#### `host.removeWriter(key)`

Revoke write permission from a peer.

#### `host.ackWriter(key)`

Acknowledge a writer without changing their permissions.

#### `host.interrupt(reason)`

Pause the apply cycle. The `reason` is emitted on the `'interrupt'` event. Call `db.update()` to resume.

#### `anchor = await host.createAnchor()`

Create a verifiable checkpoint in the log. Returns `{ key: Buffer, length: Number }`. Anchors cryptographically link the current state to prior writer states and enable future writers to prove causal ordering.

#### `host.genesis` → `boolean`

`true` on the very first apply call (before any nodes exist). Use to bootstrap the initial writer.

#### `host.clock` → `number`

The number of completed apply cycles. This is Autobee's logical clock, not wall-clock time.

---

## Static Methods

#### `Autobee.isAutobee(val)` → `boolean`

Returns `true` if `val` is an Autobee instance.

#### `buf = Autobee.encodeValue(value, [opts])`

Encode a value into an Autobee block with optional causal metadata (links, timestamps).

#### `value = Autobee.decodeValue(buf, [opts])`

Decode an Autobee block back to its value and metadata.

#### `Autobee.GENESIS`

`{ length: 0, key: null }` — the empty head representing the genesis state.

---

[← Previous: Testing](10-testing.md) | [Index](../README.md)
