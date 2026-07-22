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

- test/fuzz/ (moved from the untracked test/fuzz.js, 2026-07-21) is a
  standalone run-forever script now, not a brittle test - see
  test/fuzz/README.md. Still untracked; add it to git. Not wired into
  test/all.js (uses a random seed by default and doesn't fit a bounded CI
  run) - if a smoke-test hook is wanted, trial.js's runTrial() is the
  reusable, brittle-friendly entry point.
- Promote the lifecycle repro in .repro-scratch/verify-claims-lifecycle.js
  into a proper test/witness.js - the witness machinery has no dedicated test
  file.
- Consider re-enabling the isLinkingAll fast path in prepareBatch: with
  per-node deterministic weights it is provably equivalent to the slow path
  (a node linking all heads makes every popped entry `linked`, reinserted at
  its original index, so shared covers the prefix and the node lands on top)
  - it just skips the changes-stream walk that now runs on EVERY batch.

## Timestamps + ordering: genesis-grant race FOUND AND FIXED (2026-07-21)

Every observed drift/zero-clock divergence traced to ONE root cause, found
by diffing diverged replays against the reference order (reference/diff.js):
the walk was EXONERATED (both peers matched the canonical order for their
own pinned weights) - the divergence was in WEIGHT RESOLUTION. The genesis
bootstrap grant in applyBacklog was gated on system.isGenesis() (= "is my
bee empty right now" - an arrival-order register): a reorg that rewound to
empty and reapplied a drifted/old-stamped junk batch first left the system
non-empty when the genesis batch reapplied, so the grant never re-fired and
the bootstrap writer dropped to weight 0 on that peer only. Peers where the
genesis writer stayed heavy never saw junk sort above it - two
self-consistent fixed points, permanent divergence. The ingest-time
"optimistic cannot be genesis" guard cannot catch this: it gates ingest,
the race is in reapply. FIX: the grant is keyed purely on the bootstrap key
(pure function of the batch, idempotent via the addWriter clamp, reorg-proof).

Validated: drift sweep 0/12 (was intermittent), zero-clock sweep 0/12 (was
8/12 - FUZZ_ZERO_CLOCK=1 stamps everything 0, the harshest ordering config,
kept as a permanent fuzz mode), deep 400-step runs clean, suite green.

The weight-vs-timestamp-vs-causality cycle analysis (see git history of
this section) remains a THEORETICAL concern - the walk's stable-point break
at causally-stacked heavier entries is unsound on paper (shielding lemma) -
but no empirical reproduction survives the grant fix: zero-clock is the
maximally cycle-inducing configuration and sweeps clean. Guards in place if
an instance ever materializes: reference/order.js (canonical stratified
order + segment explain), reference/diff.js (dump differ), automatic
failure dumps in test/fuzz/ (moved from test/fuzz.js, now a standalone
run-forever harness - see test/fuzz/README.md). The strata/Kahn design work
is parked unless the oracle disagrees with the impl again.

Kept from this arc: the append clamp max(now, system.timestamp) +
handlers.now hook, per-record batch-head timestamps (window compares what
addSorted compares), drift + zero-clock fuzz modes, the reference oracle.

UPDATE 2026-07-21 (later same day): the new test/fuzz/ harness (see its
README) found the oracle disagreeing with the impl again - a
"non-deterministic tiebreak" peer-replay-divergence under FUZZ_ZERO_CLOCK,
roughly 1 in 10 seeds at 150 steps. NOT yet root-caused (found while
validating an unrelated sim-transport harness change, out of scope for that
task) - a dump is preserved at
.repro-scratch/interesting-dumps/2026-07-21T23-23-38-161Z-seed26.json.
Plausibly a fresh instance of the theoretical weight-vs-causality cycle
this section's Kahn-walk analysis describes (both diverging nodes were
weight-0, ts-0, at their own first entry - exactly the shape that analysis
predicts is unsound), surfaced by the new harness's action-sequence
distribution differing from the old one even for "the same seed number".
Re-run via `node test/fuzz/replay-dump.js <dump>` to re-verify against
reference/order.js before investing in root-causing it.

## lib/writers.js optimistic-clear bug: FOUND AND FIXED (2026-07-21)

`_next()`'s `if (this.writers.writable) node.optimsitic = false` (note: HEAD
has this exact typo - `optimsitic`, not `optimistic` - which makes it a
silent no-op) was fixed for spelling at some point this session without
also fixing its semantics, which activated a real bug: `this.writers.writable`
is the LOCAL peer's own writable status, checked while processing every
`Writer` object the local peer tracks, including FOREIGN ones - so once a
peer is itself durably added, it force-clears `node.optimistic` on every
foreign writer's incoming node too, including a fresh peer's optimistic
self-add, which then fails `!isAdded && !optimistic && !genesis` and returns
null forever (no freeze, no wait, silent permanent non-progress). Confirmed
against the COMMITTED suite, not just the fuzzer: `basic - optimistic` in
test/basic.js hits this exact path and times out with the naive spelling
fix. Properly fixed (spelling + a `this === this.writers.localWriter` guard,
both needed - the guard alone leaves the typo, the spelling alone
reintroduces this bug):
```js
if (this.writers.writable && this === this.writers.localWriter) node.optimistic = false
```
See test/fuzz/README.md's "known finding" section for the full writeup and
git-blame history (this.writable -> this.writers.writable, commit 9130f1e,
long predates this branch).

## Backer-standing cap: load-bearing via ANCHORING - drop proposal rejected

The WEIGHTS.md "drop the cap" proposal fails under the ratified views-trusted
posture: verification trusts the backer's flushed views, so a fabricated deep
flush can "witness" a grant it never saw. Without the cap, two fresh keys
collude - one plants a deep fake flush, the other cites it for weight 2 - and
the witnessed node's placement window spans its own grant (resolves 2 above
it, 0 below it): the two-fixed-point divergence class. The cap blocks this
because fresh chains have standing 0, so their testimony confers nothing:
the cap couples the weight of testimony to the anchoredness of the testifier
(NOT authority - anchoring). Residual attacker even with the cap: a
long-silent standing-2 writer with a deep tip planting fabricated views -
rare, already-trusted, removable.

Wipeout recovery alternative (unblocks weight-2 restore by a weight-1
survivor without reopening the hole): a GRANT-CLOCK check - record the flush
count at which maxWeight was granted, and only count a witness whose cited
backer flush is positioned at-or-after that point in OUR converged stream.
Compares two positions we computed ourselves (where the grant landed, where
the testimony landed) instead of trusting views content; deep fakes fail on
position regardless of content, and a flush that IS positioned after the
grant is necessarily recently anchored, so the raise's placement window sits
entirely above the grant. Requires the insertion-walk fix first (it reasons
about positions in a converged order). Fuzzer coverage to add with it: a
fabricated-views collusion action.

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
