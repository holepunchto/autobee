# TODO

## Claim re-issue (mostly subsumed by the 2026-07 static-claim rework)

The old failure mode - a claim wedged on a referrer whose grant never fires
in the converged order - no longer exists: claims carry only {weight, backer}
and every append inside an open upgrade window (maxWeight > standing)
re-hunts a live backer (`claims.isLiveBacker` filters removed ones, both for
previous-claim reuse and hunt candidates). The remaining gap is a writer that
never appends again after its backer died: nothing re-claims on its behalf.
If that matters, a periodic/no-op re-claim append is the mechanism.

## Cleanup before landing the claims work

- test/fuzz.js is untracked - add it to git, and decide whether test/all.js
  should include it (it uses a RANDOM seed by default - pin a seed or keep
  it out of CI).
- Promote the lifecycle repro in .repro-scratch/verify-claims-lifecycle.js
  into a proper test/claims.js - the claim machinery has no dedicated test
  file.
- Consider re-enabling the isLinkingAll fast path in prepareBatch: with
  per-node deterministic weights it is provably equivalent to the slow path
  (a node linking all heads makes every popped entry `linked`, reinserted at
  its original index, so shared covers the prefix and the node lands on top)
  - it just skips the changes-stream walk that now runs on EVERY batch.
- _verifiedClaims/_witnessCache on the Autobee instance grow unboundedly
  (one entry per claiming node / per probed snapshot). Claims are rare so
  this is slow growth, but long-lived instances may want pruning.

## Semantic properties to consciously ratify (not bugs, embedded decisions)

- Capability ceiling: effective weight can never exceed what our own order
  granted (min with the claimant's maxWeight register) nor the backer's
  live standing at the node's position.
- Value provenance: claim.weight is sourced from the backer's committed
  snapshot (computed by the appender, === verified at ingest). A backer's
  snapshot witnessing a re-grant our order hasn't applied yet is claimable -
  it just resolves capped until the grant lands (self-heals via next claim).
- Sort-position grief: a colluding pair can inflate a node's claimed weight
  up to the backer's standing/own ceiling; the caps bound capability but the
  node still sorts (and forces reorgs) at the capped height.
- No retroactivity: nodes written before backing arrived keep their
  at-the-time resolved weight permanently.
- Claim-less (legacy) blocks resolve at the writer's previous resolved
  weight, i.e. 0 for old data - no migration story yet.
- Offline append while genuinely under-backed: probes (parallel, 750ms
  window) time out before the append proceeds claim-free at the floor.
- views only ride the tail of each local drain flush, so mid-drain flush
  heads can't serve as backers (fewer candidates, verified ones unaffected).
- Ingest verify is verify-or-wait: a claim whose backer block or committed
  system is unfetchable parks that writer (not the drain loop) until the
  read resolves; only a definitive snapshot mismatch freezes.
- Pre-rework v4 blocks that carried {weight, referrer, backer} claims
  misdecode under the new schema - breaking change, fresh stores only.
