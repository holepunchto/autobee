# The Apply Function

The apply function is the developer extension point in Autobee. It receives batches of new operations from writers and merges them into the shared view. Every peer runs the same function over the same inputs, so every peer converges to the same state.

## Signature

```js
async function apply (nodes, view, host) {
  // nodes — array of new operation nodes to process
  // view  — writable Hyperbee batch interface
  // host  — controls writers and apply lifecycle
}
```

## The node object

Each element of `nodes` represents one operation appended by a writer:

```js
{
  key: Buffer,        // writer's public key
  value: Buffer,      // the raw value passed to db.append()
  length: Number,     // position in the writer's oplog (1-indexed)
  version: Number,    // internal version counter
  timestamp: Number,  // system clock at time of processing (flushes count, not wall clock)
  optimistic: Boolean // true if this is an unconfirmed optimistic write
}
```

`timestamp` is Autobee's logical clock (how many apply cycles have completed), not wall-clock time. It's useful for ordering within the apply function but should not be exposed to users as a real timestamp.

## Writing to the view

The `view` parameter is a writable Hyperbee batch. Use `view.write()` to get a batch writer:

```js
async function apply (nodes, view, host) {
  for (const node of nodes) {
    const op = JSON.parse(node.value)

    const w = view.write()
    w.tryPut(op.key, op.value)   // put if not already set (conflict-safe)
    // w.put(op.key, op.value)   // unconditional put (last-write-wins)
    // w.del(op.key)             // delete
    await w.flush()
  }
}
```

For multiple writes in one batch, accumulate operations before flushing:

```js
const w = view.write()
for (const node of nodes) {
  const op = JSON.parse(node.value)
  if (op.type === 'put') w.tryPut(op.key, op.value)
  if (op.type === 'del') w.del(op.key)
}
await w.flush()
```

## Managing writers

Writer management calls go through the `host` object:

```js
host.addWriter(key)            // add a writer (Buffer or hex string)
host.addWriter(key, { isIndexer: false }) // add with lower weight
host.removeWriter(key)         // remove a writer
host.ackWriter(key)            // acknowledge without changing permissions
```

These are processed after the current batch completes, not immediately. The changes take effect in the next apply cycle.

## The host object

```js
host.genesis  // Boolean: true on the very first apply call (no nodes yet)
host.clock    // Number: how many apply cycles have completed
```

`host.genesis` is the signal to bootstrap the first writer. It's always called with an empty `nodes` array:

```js
async function apply (nodes, view, host) {
  if (host.genesis) {
    host.addWriter(db.local.key)
    return
  }
  // normal processing...
}
```

## Designing operations

Operations are just bytes — use whatever encoding works for your application. A common pattern is a JSON envelope with a `type` discriminant:

```js
const op = {
  type: 'put' | 'del' | 'addWriter' | 'removeWriter',
  // ...type-specific fields
}
await db.append(JSON.stringify(op))
```

For performance-sensitive use cases, binary encoding (e.g. `compact-encoding` or `hyperschema`) produces much smaller payloads.

### Encoding with metadata

`Autobee.encodeValue` wraps a value with causal metadata that helps Autobee link operations causally:

```js
await db.append(Autobee.encodeValue(myBuffer))
```

Most applications don't need this — use it when you need explicit causal links between operations.

## Handling concurrency

Two operations are *concurrent* if neither causally precedes the other. Your apply function must produce the same view regardless of which order concurrent operations arrive.

Strategies:

**Last-write-wins** — use `w.put()` unconditionally. The topological sort determines a consistent ordering, so all peers see the same "last" write.

**First-write-wins** — use `w.tryPut()`. The first writer to set a key wins, and subsequent puts for the same key are no-ops.

**Merge** — read the current value and merge it with the incoming operation. Since you're inside a batch, reads within `view.write()` see the state before this batch, not the partial writes.

## Determinism requirements

The apply function is a contract: it must be a pure function of its inputs.

**Do:**
- Read from `view` (the current state before this batch)
- Write to `view` via `view.write()`
- Call `host` methods

**Do not:**
- Use `Math.random()`, `Date.now()`, or wall-clock time
- Make network requests or read from external state
- Use non-deterministic data structures (unordered sets, random hash seeds)
- Store state in module-level variables that affect output

If you need to fetch external data during apply, use [Interrupts](09-interrupts.md).

## Multiple operations in one append

You can append an array of values. They're appended atomically and processed as a group:

```js
await db.append([
  JSON.stringify({ type: 'put', key: 'a', value: '1' }),
  JSON.stringify({ type: 'put', key: 'b', value: '2' })
])
```

---

[← Previous: Writer Management](03-writer-management.md) | [Index](../README.md) | [Next: Optimistic Writes →](05-optimistic-writes.md)
