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

The genesis grant is self-certifying: it stands at the bootstrap ceiling immediately,
and it also seeds `weight` so the standing survives the flag. A later regrant raises
`maxWeight` and clears `isGenesis` in the same record write — the bypass can only ever
see the bootstrap value, and from then on genesis climbs like everyone else.
Everyone else starts at the floor and must climb to the ceiling by carrying a witness.

## Lifecycle

```
 grant                 flush (each peer)        append                  apply
 ─────                 ─────────────────        ──────                  ─────
 maxWeight = N  ───►   attest: sign       ───►  gap open? attach  ───►  verify signature,
 (gap opens:           {grantee, N} onto        best harvested          weight = claim
 weight < max)         own flush tail           attestation             floor rises, gap closes
```

## Attest — backers testify at flush

When a flush applies a grant that raised a writer's ceiling, every other writer that
applied it queues an **attestation** about the grantee, signed with its core signing
key when its own next flush picks its tail block:

```
sign(NS_WITNESS ‖ backer ‖ grantee ‖ position ‖ weight)
```

`position` is the backer's own block carrying the attestation — the same block that
commits the backer's views, so a suspect attestation can always be audited against
the system state its signer committed alongside it.

Attestations ride the flush tail and are harvested passively by their subject during
ordinary ingest, together with the backer's raw core manifest — no probing, no extra
round trips, no remote reads anywhere in the pipeline.

## Append — attach a witness

While `maxWeight > currentWeight`, an append attaches the best harvested attestation:
highest weight, capped to the writer's own applied ceiling, backer applied and not
removed in its own view.

```
witness = {
  weight,          // the value the backer attested
  backer: {
    key, length,   // the backer block carrying the attestation
    signature,     // over (backer, us, length, weight)
    manifest       // the backer's raw core manifest, inlined
  }
}
```

The witness rides the first node of the batch. With nothing harvested yet the append
degrades witness-free and simply sorts at the floor — the climb self-heals off a
later attestation.

## Verify — pure bytes

Verification is a pure function of the node's own bytes — no core session, no store
lookup, no IO:

```
manifest = Hypercore.parseManifest(backer.manifest, backer.key)  // throws on mismatch
verified = crypto.verify(message, backer.signature, manifest.signers[0].publicKey)
```

Every peer reaches the same verdict at every point in time — including peers that
fast-forwarded past the backer's history and never ingested a block of it. There is
no park and no freeze: an invalid witness floors the node, identically everywhere.

The backer position additionally gates ingest like a link (present-or-wait), pinning
it as a causal dependency of the node.

## Apply — resolve the sort weight

Recomputed on every (re)application. Every input is a deterministic function of the
node's causal past — this is the load-bearing contract: a live register read here
lets relative node order flip mid-reorg and the sort never converges.

```
prev = currentWeight(rec)                        // rec = our record of the writer
if no witness, or witness.weight <= prev  → prev
if witness.weight > rec.maxWeight         → prev // claim not grant-backed in our order
if backer is self                         → prev
if backer missing / shorter than cited    → prev
if manifest or signature invalid          → prev

→ max(prev, witness.weight)
```

Why each input is pinned:

- `prev` — the writer's own chain stamp, applied in chain order
- `witness.weight`, signature, manifest — fixed wire bytes
- backer presence at the cited length — an ingest-gated causal dep
- the grant gate — an honest claim's grant sits in the backer's flush's causal past,
  which is a dep of the node, so the grant is always applied by the time the node
  (re)applies; the gate only ever floors claims no applied grant supports, and does
  so deterministically

Deliberately **not** consulted: the backer's live standing and its removal state.
Both are concurrent facts a reorg rewinds independently of the node — reading them
here is what made the snapshot-era resolution thrash. A backer's removal blocks
future selection, never past testimony.

Weight is monotone: a capped or unusable witness degrades to the previous resolved
weight, never to zero.

## Steady state

The resolved weight is stamped back into the record, raising the floor and closing
the gap. From then on appends carry no witness — the floor alone carries the weight.

## Trust model

The contract is the only weight authority: nothing sorts above what our own order
granted (`maxWeight`), regardless of what anyone signs. The witness confers no
capability — it is a causal pin plus a verifiable certificate, and its one security
job is consistency-integrity against faulty writers (byzantine-as-bug included):

- one faulty writer cannot affect anything: an inflated attestation is skipped by
  honest claimants at selection (claim above their own ceiling), and a directly
  embedded bogus claim floors identically on every peer — never a consistency split,
  always attributable
- the residual corner needs two faulty writers AND a coincidence: a claim with no
  supporting grant, later matched by a real grant of at least that value, stamps
  divergently until a reorg re-resolves it — bounded to the colluders' own nodes,
  capability still capped by the contract, both parties provable from the
  attestation and the views its signer committed in the same block

Because the backer's standing no longer caps the raise, any committed testimony is
valid: a weight-1 survivor can restore a weight-2 writer after a wipeout. The costs,
accepted: a reorg can reach as deep as the claim is heavy, and weight is no longer a
propagated capability — the contract alone is.
