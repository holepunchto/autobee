# TODO

## Claim re-issue after a failed claim

If a claim fails because its referrer no longer has capability in the
converged order (the granter was concurrently removed, so the grant never
fires at the referrer in the final ordering), the grant has probably been
actioned by another referrer anyway. The claimant should detect that its
claim failed to resolve and issue a NEW claim in a later block pointing at a
different referrer.

Related nuance: `system.addWriter` clamps grants to `max(requested, current)`
and deliberately keeps the ORIGINAL `referrer` stamp for non-increasing
grants (so existing claims stay backable). This means an equal-weight
confirmation (e.g. a member confirming an optimistic self-add at the same
value) does not update `referrer`, so the writer keeps claiming its own
self-grant as referrer and stays unbacked. The re-claim machinery
should cover this case - either by re-stamping `referrer` when an
equal-weight grant arrives from a DIFFERENT writer, or by letting the writer
point a fresh claim at the confirming grant's flush directly.

## Cleanup before landing the claims work

- test/fuzz.js is untracked - add it to git, and decide whether test/all.js
  should include it (it uses a RANDOM seed by default - pin a seed or keep
  it out of CI).
- Promote the scenario repros in .repro-scratch/ (verify-one-hop,
  verify-selfgrant-capped, verify-causal-ack) into a proper test/claims.js -
  the claim machinery currently has no dedicated test file.
- Consider re-enabling the isLinkingAll fast path in prepareBatch: with
  per-node deterministic weights it is provably equivalent to the slow path
  (a node linking all heads makes every popped entry `linked`, reinserted at
  its original index, so shared covers the prefix and the node lands on top)
  - it just skips the changes-stream walk that now runs on EVERY batch.

## Semantic properties to consciously ratify (not bugs, embedded decisions)

- Capability ceiling: effective weight can never exceed the trust anchor's
  weight (the min(maxWeight, backing limit) recursion grounds at genesis) - a
  weight-3 grant in a genesis-2 world resolves at 2 forever.
- No retroactivity: nodes written before backing arrived keep their
  at-the-time resolved weight permanently.
- Claim-less (legacy) blocks resolve at the writer's previous resolved
  weight, i.e. 0 for old data - no migration story yet.
- Offline append while genuinely under-backed: findBacker probes time out
  (750ms x up to 8 candidates) before the append proceeds without a backer.
- views only ride the tail of each local drain flush, so mid-drain flush
  heads can't serve as causal backers (fewer candidates; interaction-path
  backers unaffected).
