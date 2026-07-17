# TODO

## Witness re-issue (mostly subsumed by the 2026-07 static-witness rework)

The old failure mode - a witness wedged on a referrer whose grant never fires
in the converged order - no longer exists: witnesses carry only {weight, backer}
and every append inside an open upgrade window (maxWeight > standing)
re-hunts a live backer (`witness.isLiveBacker` filters removed ones, both for
previous-witness reuse and hunt candidates). The remaining gap is a writer that
never appends again after its backer died: nothing re-witnesses on its behalf.
If that matters, a periodic/no-op re-witness append is the mechanism.

## Cleanup before landing the witness work

- test/fuzz.js is untracked - add it to git, and decide whether test/all.js
  should include it (it uses a RANDOM seed by default - pin a seed or keep
  it out of CI).
- Promote the lifecycle repro in .repro-scratch/verify-claims-lifecycle.js
  into a proper test/witness.js - the witness machinery has no dedicated test
  file.
- Consider re-enabling the isLinkingAll fast path in prepareBatch: with
  per-node deterministic weights it is provably equivalent to the slow path
  (a node linking all heads makes every popped entry `linked`, reinserted at
  its original index, so shared covers the prefix and the node lands on top)
  - it just skips the changes-stream walk that now runs on EVERY batch.

## Semantic properties to consciously ratify (not bugs, embedded decisions)

- Capability ceiling: effective weight can never exceed what our own order
  granted (min with the writer's maxWeight register) nor the backer's
  live standing at the node's position.
- Value provenance: witness.weight is sourced from the backer's committed
  snapshot (computed by the appender, === verified at ingest). A backer's
  snapshot witnessing a re-grant our order hasn't applied yet is usable -
  it just resolves capped until the grant lands (self-heals via next witness).
- Sort-position grief: a colluding pair can inflate a node's witnessed weight
  up to the backer's standing/own ceiling; the caps bound capability but the
  node still sorts (and forces reorgs) at the capped height.
- No retroactivity: nodes written before backing arrived keep their
  at-the-time resolved weight permanently.
- Witness-less (legacy) blocks resolve at the writer's previous resolved
  weight, i.e. 0 for old data - no migration story yet.
- Offline append while genuinely under-backed: probes (parallel, 750ms
  window) time out before the append proceeds witness-free at the floor.
- views only ride the tail of each local drain flush, so mid-drain flush
  heads can't serve as backers (fewer candidates, verified ones unaffected).
- Ingest verify is verify-or-wait: a witness whose backer block or committed
  system is unfetchable parks that writer (not the drain loop) until the
  read resolves; only a definitive snapshot mismatch freezes.
- Pre-rework v4 blocks that carried {weight, referrer, backer} claims
  misdecode under the new schema - breaking change, fresh stores only.
