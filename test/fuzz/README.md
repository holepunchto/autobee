# Fuzzer

A standalone node script (no brittle, no fixed step count) that runs
independent random trials against real Autobee/Corestore/Hyperbee
instances, forever, until one fails - then it dumps full diagnostic state
and stops. Inspired by `../../../autobase/test/fuzz`, adapted for the fact
that autobee's ordering depends on real system-bee state and real witness
block reads, not an in-memory linearizer alone - so storage is always real
disk I/O and trials are not microseconds-fast, even with a fully simulated
network (see "transports" below).

## Running it

```
node test/fuzz/run.js
```

Runs trials back to back until one fails or `FUZZ_TRIALS` is reached (0 =
forever, the default). Ctrl-C stops after the current trial finishes.

### Env vars

| var                                 | default      | meaning                                                                                         |
| ----------------------------------- | ------------ | ----------------------------------------------------------------------------------------------- |
| `FUZZ_SEED`                         | random       | base seed; trial N uses `(FUZZ_SEED + N) >>> 0`                                                 |
| `FUZZ_TRIALS`                       | 0 (infinite) | stop after this many clean trials                                                               |
| `FUZZ_MIN_STEPS` / `FUZZ_MAX_STEPS` | 80 / 200     | per-trial action count, randomized in this range (or set `FUZZ_STEPS` to fix both to one value) |
| `FUZZ_MAX_WRITERS`                  | 6            | writer pool cap per trial                                                                       |
| `FUZZ_MAX_WEIGHT`                   | 3            | max grantable weight                                                                            |
| `FUZZ_SYNC_EVERY`                   | 5            | full sync + oracle check every N steps                                                          |
| `FUZZ_SYNC_TIMEOUT_MS`              | 20000        | `sync()` timeout before a trial is failed                                                       |
| `FUZZ_MAX_DRIFT_MS`                 | 0            | per-writer clock drift (see "clock modes")                                                      |
| `FUZZ_ZERO_CLOCK`                   | off          | every stamp is 0 (see "clock modes")                                                            |
| `FUZZ_LOG_EVERY`                    | 20           | trials between progress lines                                                                   |
| `FUZZ_VERBOSE`                      | off          | print every action as it runs                                                                   |
| `FUZZ_TRANSPORT`                    | `sim`        | `sim` or `real` - see "transports" below                                                        |

## The oracle

Every sync round, two independent checks run over the whole pool (see
`oracle.js`):

1. **peer vs reference** - each peer's `replay()` is adapted to
   `reference/order.js`'s node shape and compared against the canonical
   order computed from that same node set. A mismatch is a **walk bug** -
   the insertion logic disagreeing with the definition of the order.
2. **peer vs peer** - two peers with the same causal history must produce
   byte-identical replay order and pinned weights. A mismatch here while
   both peers individually pass check 1 is a **resolution bug** (weight
   computation), not a walk bug - see the 2026-07-21 genesis-grant race in
   `../../TODO.md` for a worked example where this distinction is exactly
   what let it be diagnosed in one pass instead of an offline diff.

A frozen writer (`writer.isFrozen`) is also always a failure: honest fuzzing
must never trip witness verification.

### Byzantine actions

Two low-weight fault-injection actions each model ONE faulty writer acting
alone (byzantine-as-bug, not necessarily malice):

- **buggyBackerAttest** - a writer signs an attestation for a value no grant
  can ever support and ships it on an ordinary flush. Honest victims harvest
  it but must skip it at witness selection; one buggy backer alone must
  affect nothing.
- **buggyClaimantEmbed** - a writer force-embeds a witness `append()` would
  never produce: either its best harvested attestation with the
  claim-within-own-grant selection filter disabled (when a buggy backer's
  attestation has reached it, this composes into the independent two-fault
  case and exercises `resolveWeight`'s strict grant gate), or a
  grantable-range claim under a forged signature (exercises the
  verification floor, which is pure bytes and so epoch-independent).

Planted values are always unbackable (above `max(maxWeight, 2)`), so
flooring is permanent and deterministic and the ordinary oracles apply
unchanged. A _plausible_ planted value plus a later matching grant is the
documented residual corner (genuine collusion: divergent stamps on the
colluders' nodes until a reorg heals them) - deliberately out of scope until
a collusion action lands together with oracle support for its expected
divergence.

The oracle backs the fault model with one extra check: no replayed node may
pin a weight above the grantable ceiling (`inflated-weight`) - an unbacked
claim elevating anywhere is an immediate failure even if every peer agrees
on it.

## Transports

Storage is always real (corestore/hyperbee on disk - autobee's weight
resolution and witness verification read real system-bee state and real
blocks, so that part can't be simulated away). The **network** layer is
swappable, via `FUZZ_TRANSPORT`:

- **`sim`** (default) - `../../../replication-simulator`'s `Network`: every
  connection is a paired in-process `streamx` duplex routed through one
  seeded scheduler, no real sockets, no real timers. `network.flush()`
  drains delivery to quiescence instead of a wall-clock poll, and which
  pending message goes next (across connections) is picked by a seeded rng
  independent of the action rng (see `transport-sim.js`'s header comment for
  why they must be separate streams). This makes a trial's **delivery
  order**, not just its action schedule, a pure function of the seed - see
  "on determinism" below.
- **`real`** - `test/helpers`' actual corestore replication streams and a
  wall-clock-polling `sync()`. Kept for comparison/fallback
  (`FUZZ_TRANSPORT=real`).

**`pairSync` differs slightly between transports.** Under `real`, the old
mechanic (connect only the pair, sync only the pair) is exact. Under `sim`,
all writers already share one always-connected network, so isolating a pair
would need corking every other connection - instead `pairSync` advances the
scheduler by a small bounded number of rounds (`network.run(n)`) rather than
draining to quiescence, letting some but not necessarily all pending traffic
through. Different mechanic, same intent (uneven propagation stress before
some peers have fully caught up), and arguably a more natural fit for what
the simulator gives you than reproducing link-level isolation would be.

**On speed:** the sim transport does NOT make clean trials dramatically
faster in this environment - measured head-to-head (same seed, same steps,
avoiding the known finding below so both transports actually converge),
wall time was within ~3% either way. Real disk I/O (opening/closing several
real corestore/RocksDB instances per trial) dominates, not network timing,
for pool sizes this fuzzer uses. The proven win is **determinism** (below),
not throughput - don't expect trials-per-hour to jump from switching
transports.

## On failure

The trial's storage is **retained** (not GC'd) and a complete state dump is
written automatically to `test/fuzz/failures/<timestamp>-seed<N>.json`:
action log, system records for every writer as seen by every peer, and each
peer's adapted replay (ready to feed straight into `reference/order.js`).

On crash paths (action-error, sync-timeout, a stray async error, the oracle
itself throwing) the replay gather is **best-effort per peer**: one broken
or wedged writer costs only its own oplog - its `peers[i].error` field
records why (with a 30s/peer timeout so a replay against a dead transport
can't hang the dump) - and every other peer's full oplog still lands in the
dump. `replay-dump.js` prints errored peers and excludes them from the
comparisons.
The process prints the dump path, the retained storage path, and two
follow-up commands:

```
# re-run the SAME action schedule (seed pins the schedule, not IO timing -
# see "on determinism" below)
FUZZ_SEED=<N> FUZZ_TRIALS=1 FUZZ_MIN_STEPS=<n> FUZZ_MAX_STEPS=<n> FUZZ_VERBOSE=1 node test/fuzz/run.js

# re-check the frozen dump against the reference order - zero I/O, instant,
# safe to keep around and re-run after a fix
node test/fuzz/replay-dump.js test/fuzz/failures/<label>.json
```

`replay-dump.js` is the regression-test analog of a found failure: since the
dump is frozen data (not live replication), re-running it is fully
deterministic, unlike a live trial replay.

## On determinism

A trial's **action schedule** (which action fires on which step, for which
writer, with what parameters) is a pure function of its seed via the same
seeded RNG throughout - fully reproducible under **either** transport.

**Under `transport=sim`, that's the whole story: replay is byte-for-byte
deterministic.** Verified directly: the same seed, replayed three times,
produced an identical action log (writer identities normalized - key
material is still crypto-random, protocol logic doesn't depend on its
value) and failed at the exact same point every time, where the same seed
under `real` had previously been flaky (failed intermittently across
otherwise-identical invocations - see the git history of this file / TODO.md
for the specific case this was diagnosed against). This is what closes the
gap that used to exist here: delivery order, not just the action schedule,
is now a pure function of the seed, because there are no real sockets or
timers left to introduce timing-dependent interleaving.

**Under `transport=real`, it's still only a strong hint.** Real
corestore/hypercore/network timing decides the actual order blocks arrive
and get applied, and that timing is not part of the seed - some failures
may need several replay attempts, or the exact storage state from the
original dump (why storage is retained, not just the action log). If a
`real`-transport failure doesn't reproduce, try the same seed under
`FUZZ_TRANSPORT=sim` first before concluding it's gone.

## Clock modes

- **default** (`FUZZ_MAX_DRIFT_MS=0`): every writer uses the real wall
  clock. Reorgs stay small because the append clamp
  (`max(now, system.timestamp)`) keeps a reconnecting writer's stamp fresh.
- **drift** (`FUZZ_MAX_DRIFT_MS=<ms>`): half the writers keep a true clock,
  half drift by up to +/-N ms. Exercises the append clamp and the
  insertion-walk invariant under clock skew.
- **zero-clock** (`FUZZ_ZERO_CLOCK=1`): every stamp is 0, degenerating
  within-class order to pure `(weight, key)` - the harshest ordering
  configuration known. Both harsh modes reliably reproduced the
  2026-07-21 genesis-grant race (see TODO.md); keep them around as
  permanent regression tools, not just historical artifacts.

## Storage

Each trial gets its own subtree under a per-process run root
(`$TMPDIR/autobee-fuzz-*`, one dir per writer). A clean trial GCs its own
storage immediately; a failing trial's storage is retained next to its dump
so the raw corestore/hyperbee state is inspectable. This exists specifically
because brittle's `t.tmp()` leaves storage behind across many trials, which
under disk pressure caused real flakiness (RocksDB "Batch was not applied" /
ENOENT bursts) during this investigation - see TODO.md.

## Files

- `run.js` - CLI entrypoint: env parsing, the trial loop, progress
  logging, SIGINT handling. Nothing here is reusable/testable in isolation.
- `trial.js` - `runTrial(config, trial, seed, runRoot)`: one trial,
  start to finish. Never throws for an ordinary fuzz finding (oracle
  mismatch, sync timeout, thrown action error) - all captured and returned
  as `{ ok: false, failures, dumpFile, storageDir }`.
- `model.js` - the writer pool + actions (spawn, append, grant, remove,
  optimistic self-add, concurrent conflicting grants, partial pair sync).
  Talks only to `state.transport` (never to a concrete network layer), so
  the same action set runs under either transport unmodified.
- `transport-sim.js` / `transport-real.js` - the two transports, same
  interface (`attach`, `fullSync`, `pairSync`, `destroy`) - see "transports".
- `util.js` - the `withTimeout` wrapper both transports use to bound
  convergence waits.
- `oracle.js` - the two correctness checks above.
- `dump.js` / `replay-dump.js` - failure serialization / offline replay.
- `storage.js` - tmp directory lifecycle.
- `rng.js` - seeded PRNG + weighted action pick.
- `async-errors.js` - process-wide `uncaughtException`/`unhandledRejection`
  capture. autobee's drain loop (and the real transport's `sync()`
  background poll loop, once `Promise.race` abandons it on timeout) can
  throw/reject outside any awaited chain in the trial loop - without this
  it's an opaque top-level crash instead of an attributable, dumpable
  failure.

## Fixed (2026-07-21): durably-writable peers were rejecting fresh optimistic joins

While validating this harness, most fresh trials involving
`optimisticSelfAdd` failed with a sync timeout. Root cause, confirmed with
an isolated 2-writer repro (`.repro-scratch/verify-writable-optimistic-bug.js`,
no fuzzer involved): `lib/writers.js`'s `_next()` had

```js
if (this.writers.writable) node.optimistic = false
```

`this.writers.writable` is the **local peer's own** writable status, but
this runs for every `Writer` object the local peer tracks, including ones
for **foreign** cores. Once a peer is itself durably added (eg genesis,
after its first append), it forces `node.optimistic = false` on every
incoming node from every writer it tracks - including a fresh peer's
optimistic self-add, which then fails the very next gate
(`!isAdded && !optimistic && !genesis`) and returns null forever: no
`waiting`, no `verifying`, no freeze, just silent permanent non-progress.
Only peers that are _not yet_ durably added themselves are unaffected
(the line is a no-op for them), which is why the bug hid: it needs at
least one already-established writer plus one brand-new optimistic
self-join to manifest, and the original `test/fuzz.js`'s single
long-running 150-step trial spent most of its budget past that window.
git blame: the check used to be `this.writable` (a Writer's own flag,
inert/no-op via `undefined` before the typo `node.optimsitic` was ever
fixed) until `9130f1e` retargeted it to `this.writers.writable` as part of
an unrelated migration-handling change - almost certainly an unintended
side effect, not deliberate.

**Fixed** in `lib/writers.js` (scopes the clear to the local writer's own
tracked node, matching the pre-refactor variable's intent):

```js
if (this.writers.writable && this === this.writers.localWriter) node.optimistic = false
```

The isolated repro test goes from timing out (5s) to passing in ~300ms with
this change; `basic - optimistic` in the main suite (which hits the same
path) also depends on it. It's an autobee-level bug, not a transport
artifact - reproduces identically under both `FUZZ_TRANSPORT=sim` and
`FUZZ_TRANSPORT=real` before the fix.

One nuance worth recording: `HEAD` (the commit this branch was built on)
carries a typo one line up (`node.optimsitic`, misspelled) that made the
buggy check a silent no-op - so this bug was dormant/harmless in committed
history. It only activated when a since-superseded pass over this file
"cleaned up" the spelling without also adding the `localWriter` guard,
which is a trap worth flagging explicitly: **fixing this typo in isolation,
without the guard, reintroduces the bug** (confirmed directly - correcting
only the spelling breaks `basic - optimistic`). The fix above does both at
once.
