# How Autobee Works

Autobee is a multiwriter database where peers never need to coordinate in real time. Each peer appends operations to their own private append-only log. An `apply` function you provide merges those operations into a shared Hyperbee view. Once peers replicate, they all arrive at exactly the same view — no central server, no consensus round-trips.

## The three parts

```
  Peer A                Peer B
  ┌──────────┐          ┌──────────┐
  │ oplog A  │          │ oplog B  │
  │ [op,op,…]│          │ [op,op,…]│
  └────┬─────┘          └────┬─────┘
       │   replication       │
       └──────────┬──────────┘
                  │
             apply(nodes, view, host)
                  │
           ┌──────▼──────┐
           │  Hyperbee   │
           │    view     │   ← identical on every peer
           └─────────────┘
```

### Writer Oplogs

Each participant owns a **Hypercore** — an append-only, cryptographically signed log. Peers never write directly to the shared view. Instead they append *operations* to their own log: commands, events, or any serialized data your application defines.

### The Apply Function

The `apply` function is the heart of Autobee. It receives batches of new operations from all writers in causal order and writes the merged result into a Hyperbee. This function must be **deterministic** — given the same input operations, every peer must produce the exact same output view.

### The View

The view is a Hyperbee B-tree — a sorted key-value store. It's computed by replaying all operations through your `apply` function. Every peer, once fully synced, holds an identical view because they all run the same deterministic function over the same inputs.

## Convergence

Autobee uses topological sorting to process operations in causal order. If Writer A appended op2 after seeing op1 from Writer B, op1 will always be processed before op2.

Operations from different writers that have no causal relationship — truly concurrent writes — may arrive in any order. Your `apply` function must produce the same view regardless of which concurrent order it sees. The simplest way to achieve this: use commutative operations (last-write-wins, counters, sets) or encode enough context in each operation that ordering doesn't matter.

## Writers and permissions

Not every peer is a writer by default. A peer must be explicitly granted write permission before its operations affect the shared view. This is enforced via the system state tracked inside Autobee.

Writer permissions are managed from inside your `apply` function using `host.addWriter(key)` and `host.removeWriter(key)`. Because `apply` is deterministic, every peer reaches the same conclusions about who is and isn't a writer.

## The genesis state

When an Autobee is first created, no writers exist yet. The very first `apply` call receives `host.genesis === true` — a signal to bootstrap the database by adding the initial writer.

```js
async function apply(nodes, view, host) {
  if (host.genesis) {
    // No nodes yet — bootstrap the first writer
    host.addWriter(db.local.key)
    return
  }
  // ...process normal operations
}
```

After genesis, all writer changes must come through normal operations in the log.

## Determinism is the contract

Your `apply` function is the only thing you must get right. The rules:

- **No randomness** — don't use `Math.random()`, `Date.now()`, or anything non-deterministic
- **No side effects** — don't mutate external state, make network calls, or rely on ordering of async operations beyond what Autobee provides
- **Same inputs → same outputs** — always

If your apply function is deterministic, peers converge. If it isn't, they diverge silently.

---

[Index](../README.md) | [Next: Quick Start →](02-quick-start.md)
