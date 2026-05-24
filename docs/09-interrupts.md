# Interrupts

Sometimes your `apply` function needs data that isn't in the Autobee itself — a file from disk, a response from an external service, or another Hypercore. Since `apply` must be deterministic, you can't make async calls to external systems inline. Interrupts solve this.

## How interrupts work

When your apply function needs something it doesn't have, it calls `host.interrupt(reason)`. Autobee pauses the apply cycle and emits an `'interrupt'` event with the reason. Your code fetches whatever is needed, then calls `db.update()` to resume. Apply runs again from the beginning of the interrupted batch — this time with the external data available.

The key guarantee: `apply` will be called again with the same inputs. The external data must be deterministically available on both runs (i.e. the same data, fetched by all peers).

## Basic pattern

```js
// In apply: interrupt if we don't have a needed resource
async function apply (nodes, view, host) {
  if (host.genesis) { host.addWriter(db.local.key); return }

  for (const node of nodes) {
    const op = JSON.parse(node.value)

    if (op.type === 'ref') {
      const data = cache.get(op.ref)
      if (!data) {
        // Don't have it — pause and go fetch it
        host.interrupt({ ref: op.ref })
        return
      }
      // Have it — process normally
      const w = view.write()
      w.tryPut(op.key, data)
      await w.flush()
    }
  }
}

// Handle the interrupt
db.on('interrupt', async (reason) => {
  // Fetch the missing data by ref
  const data = await fetchByRef(reason.ref)
  cache.set(reason.ref, data)

  // Resume the apply cycle
  db.update()
})
```

## Checking interrupted state

```js
db.interrupted  // the reason passed to host.interrupt(), or null if not interrupted
```

Use this to check status without listening to the event:

```js
await db.update()
if (db.interrupted) {
  // still interrupted — handle it
}
```

## Important: apply runs again from the top

When `db.update()` is called after an interrupt, apply starts over from the beginning of the batch that was interrupted — not from where it left off. Any writes you made to `view` before calling `host.interrupt()` are discarded and will be re-applied.

This means:
- It's safe to `host.interrupt()` partway through a batch
- Don't perform irreversible side effects (network writes, file writes) before interrupting
- Cache the fetched data so the second run doesn't fetch it again

## Interrupting vs. pre-fetching

For most use cases, it's cleaner to fetch all needed external data before calling `db.update()`, rather than letting apply interrupt and resume. Use interrupts when you can't know what you'll need until you're partway through a batch.

```js
// Pre-fetch approach (simpler when you know what you need):
const data = await fetchRequiredData()
cache.set('my-data', data)
await db.update()

// Interrupt approach (when you discover needs dynamically):
db.on('interrupt', async (reason) => {
  const data = await fetch(reason.needed)
  cache.set(reason.needed, data)
  db.update()
})
```

---

[← Previous: Events](08-events.md) | [Index](../README.md) | [Next: Testing →](10-testing.md)
