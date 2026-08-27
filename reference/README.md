# reference — canonical stratified order

The batch-computed, pure-function-of-the-DAG definition of autobee's
converged linearization. This is the **oracle** for the incremental walk:
whatever `lib/topo.js` produces under any causal arrival schedule must equal
`order(nodes)` over the same node set.

## The definition

```
order(D):
  W = highest resolved weight in D
  H = weight-W members, sequenced by anti-Kahn within the class:
      repeatedly extract the cmp-GREATEST causally-maximal member,
      building from the END (cmp = ts, key, length — one class only)
  for each h in sequence:
    emit order(closure(h))     # h's not-yet-emitted causal past
    emit h                     # first acknowledger claims
  emit order(remainder)        # the unacked tail, next class down
```

Why this shape: cmp is only ever applied **within one weight class**;
cross-class order comes from closure membership — a causal fact. No
weight-vs-timestamp comparison exists, so the weight/causality cycle that
makes the mixed-cmp walk arrival-dependent cannot form. Within a class the
top-down (anti-Kahn) greedy matches the insertion walk's natural fixed
point (see the Shielding Lemma discussion in TODO.md).

Consequences worth knowing:

- an unacknowledged node sorts in the tail, after the heavy block — stale
  arrivals place at ack time, not stamp time
- a light node claimed by a heavy node sits inside that (first) heavy
  node's closure segment, never escaping it
- only a stale **heavy** arrival can reorder deep (within its own stratum)

## Node shape (adapter contract)

```
{
  key: string,              // writer id (hex)
  length: number,           // >= 1, position in the writer's chain
  links: [{key, length}],   // causal deps (length 0 ignored)
  witness: { backer: {key, length} } | null,   // backer is a dep too
  ts: number,               // wire timestamp
  weight: number            // RESOLVED sort weight — input, not computed.
}
```

Weights are inputs: resolution (witness/floor machinery) is a separate,
already-validated fixed point. The input set must be causally closed and
acyclic — asserted.

## Usage

```js
const { order, explain } = require('./reference/order.js')
order(nodes) // canonical sequence
explain(nodes) // segment tree: { weight, entries: [{node, closure}], tail }
```

`explain` is the debugging view — stratum boundaries and closure
assignments — for diffing against the incremental implementation's segment
bookkeeping.

## Tests

```
node reference/order.test.js
REF_SEED=5 REF_RUNS=500 REF_STEPS=120 node reference/order.test.js
```

Hand vectors (seed-5 shape, closure grouping, anti-Kahn ties, multi-strata
nesting) plus property fuzz over random DAGs with partial
visibility, climbs, stamp ties and hard backdates: determinism under input
permutation, causality, and the strata invariants (unclaimed ⇒ after the
top class; claimed ⇒ inside the acknowledger's segment).

## Differential harness (next step, once the incremental walk exists)

Generate a DAG (the generator in order.test.js), feed it to real autobee
instances in multiple causal arrival orders, `replay()` each, and assert
byte-equality with `order(nodes)` — an adapter mapping oplog nodes to the
shape above is all that's missing. Strictly stronger than the current fuzz
oracle (peer agreement): peers agreeing with the _definition_ rather than
with each other.
