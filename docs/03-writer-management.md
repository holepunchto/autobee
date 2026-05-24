# Writer Management

A *writer* is any peer whose operations are processed by the apply function and reflected in the shared view. Writer status is part of the Autobee's replicated state — every peer tracks it deterministically.

## What is a writer?

Each Autobee instance has a local Hypercore called its *oplog*. When a peer appends to their Autobee, they're appending to this local oplog. Only peers that have been granted writer status will have their operations merged into the shared view.

```js
db.local.key  // this peer's writer public key (Buffer)
db.local.id   // same, as hex string
db.writable   // true once this peer has been added as a writer
```

## The genesis writer

The very first apply cycle runs with `host.genesis === true` and no nodes. This is the only time you can add a writer without an explicit operation — use it to bootstrap the first writer.

```js
async function apply (nodes, view, host) {
  if (host.genesis) {
    host.addWriter(db.local.key)
    return
  }
  // ...
}
```

After genesis, all writer changes must flow through operations in the log.

## Adding writers

The canonical pattern: encode an "add writer" command as an operation, append it, then process it in `apply`.

```js
// Peer 1 grants Peer 2 write access:
await db1.append(JSON.stringify({ type: 'addWriter', key: db2.local.id }))

// In apply:
async function apply (nodes, view, host) {
  for (const node of nodes) {
    const op = JSON.parse(node.value)
    if (op.type === 'addWriter') {
      host.addWriter(op.key) // key can be Buffer or hex string
    }
  }
}
```

Only existing writers can issue `addWriter` operations that will be processed. Operations from non-writers are ignored.

### Writer options

```js
host.addWriter(key, {
  isIndexer: true // default: true
})
```

`isIndexer: true` gives the writer a higher weight in the topological merge, making its core a reference point for causal ordering. For the most common setups, leave this as the default.

## Removing writers

```js
await db1.append(JSON.stringify({ type: 'removeWriter', key: db2.local.id }))

// In apply:
if (op.type === 'removeWriter') {
  host.removeWriter(op.key)
}
```

Once removed, a writer's future operations are no longer accepted. Operations already in flight that were appended before removal may still be processed.

## Acknowledging writers

`host.ackWriter(key)` acknowledges a writer's presence without changing their permissions. This is useful for letting a peer know their operations have been seen, triggering progress in sync protocols that wait for acknowledgment.

## Checking writer status

```js
db.writable       // true if this instance is a confirmed writer
db.isIndexer      // true if this writer has indexer weight
```

Listen to events to react when status changes:

```js
db.on('writable', () => {
  console.log('now writable — can append operations')
})

db.on('unwritable', () => {
  console.log('write access was removed')
})
```

## Multiple writers and concurrency

When multiple writers append operations concurrently — before seeing each other's data — those operations are processed in causal topological order. Operations that are truly concurrent (no causal dependency) may be processed in either order across peers.

This means your writer management logic should be commutative where possible. Adding a writer that's already added, or removing one that's already gone, should be a no-op in your apply function.

## Key rotation

To switch a peer to a new signing key:

```js
await db.setLocal(newKeyPair.publicKey, { keyPair: newKeyPair })
```

The new writer becomes the active oplog. The previous writer remains in the system but is no longer written to. You'll typically want to add the new writer key and remove the old one via operations in the log.

---

[← Previous: Quick Start](02-quick-start.md) | [Index](../README.md) | [Next: The Apply Function →](04-apply-function.md)
