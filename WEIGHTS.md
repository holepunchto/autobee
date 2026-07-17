# Weights

Sort weight decides where a writer's nodes land in the converged order.
Heavier writers win reorgs, so weight must be provable — a writer cannot just assert it.

## Records

Every writer has a system record with three weight fields:

```
weight     resolved standing (the floor, only ever rises)
maxWeight  granted ceiling (set by addWriter)
isGenesis  grant was made outside apply — a trust root
```

A writer's current standing:

```
currentWeight(rec) = rec.isGenesis && rec.maxWeight > 0 ? rec.maxWeight
                                                        : rec.weight
```

Genesis grants are self-certifying: they stand at the ceiling immediately.
Everyone else starts at the floor and must climb to the ceiling by carrying a witness.

## Lifecycle

```
 grant                append                 ingest (each peer)        apply
 ─────                ──────                 ──────────────────        ─────
 maxWeight = N  ───►  gap open? hunt   ───►  replay the same    ───►  weight = max(prev,
 (gap opens:          a backer, attach       snapshot read:           min(witness, backer, max))
 weight < max)        {weight, backer}       ok | park | freeze       floor rises, gap closes
```

## Append — attach a witness

While `maxWeight > currentWeight`, each append hunts a **backer**: a writer whose
committed system snapshot already contains our grant.

```
witness = {
  weight,   // the value the backer's snapshot shows for us
  backer    // { key, length } — pins that exact snapshot
}
```

The witness rides the first node of the batch. Probes run in parallel and time out
(750ms), so an offline append degrades witness-free and simply sorts at the floor.

## `writer._next()` — verify the witness

Before a witnessed node enters the linearizer, every peer replays the exact read the
appender made: open the backer's block, checkout the system view it references, read
the writer's entry there.

```
witnessed = snapshot[node.key].maxWeight    // 0 if missing / removed / not predating
verified  = (witnessed === witness.weight)
```

The snapshot must predate the node (`entry.length < node.length`), so a node can never
influence its own sort position.

Unfetchable backer data parks that one writer, never the drain loop.
A definitive mismatch is a false witness: provable misbehaviour, the writer is frozen (order-independent - will fail for all readers alike since they validate the same backer node).

## Apply — resolve the sort weight

Recomputed on every (re)application from two O(1) record reads.
It converges because it is a pure function of the applied DAG, there is no runtime induced path dependency - for any given DAG the result it unqie and deterministic.

```
prev  = currentWeight(rec)                       // rec    = our record of the writer
if no witness, or witness.weight <= prev  → prev
if rec.maxWeight <= prev                  → prev // grant not applied in our view yet
if backer is self / missing / removed     → prev

→ max(prev, min(witness.weight, currentWeight(backer), rec.maxWeight))
```

Weight is monotone: a capped or unusable witness degrades to the previous resolved
weight, never to zero.

## Steady state

The resolved weight is stamped back into the record, raising the floor and closing the
gap. From then on appends carry no witness — the floor alone carries the weight.
