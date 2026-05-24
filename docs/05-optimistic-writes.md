# Optimistic Writes

Optimistic writes let a peer append operations to the log before being confirmed as a writer. The operations are applied speculatively on that peer's local view. When peers replicate and the apply function runs across all nodes, the optimistic writes are validated — or rolled back if they weren't accepted.

## Use case

The typical scenario: a new peer wants to submit data (a message, a transaction, a request) before they've been formally added as a writer. Rather than waiting for the round trip of "request access → granted → write", the peer writes immediately and the network sorts it out.

## Appending optimistically

Pass `{ optimistic: true }` to `db.append`:

```js
await db.append(JSON.stringify({ type: 'put', key: 'message', value: 'hello' }), {
  optimistic: true
})
```

The write is applied to the local view immediately. The peer doesn't need to be in `db.writable` state.

Alternatively, configure the entire instance to allow optimistic writes:

```js
const db = new Autobee(store, key, { apply, optimistic: true })
```

## Validating in apply

When a peer replicates and other nodes process the operation, each node that was written optimistically has `node.optimistic === true`. Your apply function decides whether to accept or ignore it:

```js
async function apply (nodes, view, host) {
  for (const node of nodes) {
    // Reject optimistic writes from non-writers
    if (node.optimistic) {
      // Check if the writer has been granted permission via some out-of-band mechanism,
      // or simply ignore all optimistic writes
      continue
    }

    const op = JSON.parse(node.value)
    // ...normal processing
  }
}
```

If you want to accept optimistic writes from certain peers (e.g. known public keys), check `node.key`:

```js
if (node.optimistic && !isAllowed(node.key)) continue
```

## Rollback

If an optimistic write is not accepted by the apply function during the replicated apply cycle, it's rolled back — the view reverts to the state it would have been without it. The peer's local view, which had speculatively applied the write, is updated to match.

This means users may briefly see state that later disappears. Design your UX accordingly — show optimistic writes as "pending" until `db.flush()` resolves.

## Checking status

```js
db.writable  // true once confirmed; false while still optimistic-only
```

Listen for confirmation:

```js
db.on('writable', () => {
  console.log('confirmed writer — no longer just optimistic')
})
```

---

[← Previous: The Apply Function](04-apply-function.md) | [Index](../README.md) | [Next: Custom Views →](06-custom-views.md)
