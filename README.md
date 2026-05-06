# autobee

Unstoppable, scalable multiwriter Hyperbee.

> **Still experimental and under heavy development. Expect breaking changes.**

```sh
npm install autobee
```

Multiple peers each write to their own local Hypercore. An `apply` function you provide merges those writes into a shared Hyperbee view deterministically. The view is consistent across all peers once they replicate.

## Usage

```js
const Autobee = require('autobee')
const Corestore = require('corestore')

const store = new Corestore('./my-db')

const db = new Autobee(store, null, { apply })
await db.ready()

// append some data
await db.append(Buffer.from(JSON.stringify({ hello: 'world' })))

// read it back from the view
const node = await db.view.get(Buffer.from('latest'))
console.log(JSON.parse(node.value))

async function apply (nodes, view, host) {
  for (const node of nodes) {
    const op = JSON.parse(node.value)

    if (op.addWriter) host.addWriter(op.addWriter)
    if (op.removeWriter) host.removeWriter(op.removeWriter)

    const w = view.write()
    w.tryPut(Buffer.from('latest'), node.value)
    await w.flush()
  }
}
```

To add a second writer and replicate:

```js
const db1 = new Autobee(store1, null, { apply })
await db1.ready()

// share db1.key with others so they can join
const db2 = new Autobee(store2, db1.key, { apply })
await db2.ready()

// db1 adds db2 as a writer
await db1.append(Buffer.from(JSON.stringify({ addWriter: db2.local.id })))

// replicate using any stream
const s1 = db1.replicate(true)
const s2 = db2.replicate(false)
s1.pipe(s2).pipe(s1)
```

## API

#### `const db = new Autobee(store, [key], [options])`

Create a new Autobee. `store` is a Corestore. `key` is the public key of an existing Autobee to join — omit or pass `null` to create a new one.

Options:

```js
{
  apply (nodes, view, host) {},  // called with batches of new nodes to apply to the view
  open (bee, db) {},             // called to create a custom view, return it
  close (view) {},               // called when the db closes
  update (view, changes) {},     // called after apply when the view has been updated
  encryptionKey: Buffer,         // 32-byte key to encrypt all data at rest
  encrypted: false,              // set true if using encryptionKey
  keyPair: { publicKey, secretKey }, // custom signing key pair for the local writer
  optimistic: true               // allow optimistic writes from unknown writers
}
```

#### `db.key`

The public key of this Autobee. Share this with peers so they can join.

#### `db.discoveryKey`

The discovery key. Use this to find peers on the network.

#### `db.id`

The public key encoded as a hex string.

#### `db.local`

The local writer Hypercore. Use `db.local.key` or `db.local.id` to identify this writer to others.

#### `db.view`

A read-only snapshot of the Hyperbee view. Updated after each apply cycle. Use the standard [Hyperbee](https://github.com/holepunks/hyperbee) API to read from it.

#### `db.bee`

Alias for `db.view`.

#### `db.writable`

`true` if this instance has been added as a writer.

#### `db.isIndexer`

`true` if this writer is an indexer.

#### `await db.append(value | values)`

Append one or more values to the local writer. Triggers an apply cycle.

```js
await db.append(Buffer.from('hello'))
await db.append([buf1, buf2, buf3])
```

Optionally pass `{ optimistic: true }` to write without waiting to be a confirmed writer.

```js
await db.append(buf, { optimistic: true })
```

#### `await db.update()`

Trigger a new apply cycle. Useful after replication to process new data.

#### `await db.updated()`

Wait until the current apply cycle has finished.

#### `await db.flush()`

Wait until all known writers have been fully indexed.

#### `stream = db.replicate(isInitiator)`

Create a replication stream. Pass `true` for the initiating side, `false` for the other.

```js
const s1 = db1.replicate(true)
const s2 = db2.replicate(false)
s1.pipe(s2).pipe(s1)
```

#### `db.wakeup({ key, length })`

Hint that a new writer core is available at `key` with at least `length` entries. Used to wake up replication when you learn about a peer out of band.

#### `await db.setLocal(key, [options])`

Rotate the local writer to a different key. The new writer takes over as the active oplog.

#### `views = db.views()`

Returns the current system and view core positions. Used for replication coordination.

#### `Autobee.isAutobee(val)`

Returns `true` if `val` is an Autobee instance.

### Apply

The `apply` function is called with a batch of nodes from writers, a writable `view` (Hyperbee batch), and a `host` object.

```js
async function apply (nodes, view, host) {
  for (const node of nodes) {
    // node.key    — writer public key (Buffer)
    // node.value  — the value appended (Buffer)
    // node.length — position in the writer's core

    const op = JSON.parse(node.value)

    // manage writers
    if (op.addWriter) host.addWriter(op.addWriter)
    if (op.removeWriter) host.removeWriter(op.removeWriter)

    // write to the view
    const w = view.write()
    w.tryPut(Buffer.from('key'), node.value)
    await w.flush()
  }
}
```

#### `host.addWriter(key, [options])`

Add a writer by public key (Buffer or hex string). Options:

```js
{
  isIndexer: true  // default
}
```

#### `host.removeWriter(key)`

Remove a writer by public key (Buffer or hex string).

#### `host.ackWriter(key)`

Acknowledge a writer without changing their permissions.

#### `host.interrupt(reason)`

Interrupt the current apply cycle. The db emits `'interrupt'` with the reason. Useful for pausing apply while waiting on external data.

#### `anchor = await host.createAnchor()`

Create an anchor node. Returns `{ key, length }`. Anchors are used to create a verifiable checkpoint in the log that can be used by future writers to prove causal ordering.

#### `host.genesis`

`true` if the system has not yet processed any nodes. Use this to bootstrap the first writer.

### Encryption

Pass an `encryptionKey` to encrypt all writer cores and the view at rest.

```js
const db = new Autobee(store, null, {
  apply,
  encrypted: true,
  encryptionKey: crypto.randomBytes(32)
})
```

All peers must use the same encryption key.

### Static methods

#### `buf = Autobee.encodeValue(value, [opts])`

Encode a value into an Autobee block with optional metadata.

#### `value = Autobee.decodeValue(buf, [opts])`

Decode an Autobee block back to its value.

#### `Autobee.GENESIS`

`{ length: 0, key: null }`. The empty head used to represent the genesis state.

## License

Apache-2.0
