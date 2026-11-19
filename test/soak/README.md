# Writer-cap reclamation soak

Opt-in, seeded many-writer validation of pressure-driven writer reclamation. It
uses real Autobee/Corestore replication, real stores, real appends and real
network edges. It is not part of `npm test` and is not imported by
`test/all.js`.

The production modules are frozen. This directory owns only the runner, its
oracle/configuration checks and this document. Test-side delegates observe real
admissions, evictions and handoffs; they never fabricate ledger records or
change product schedules.

## Commands

```sh
# runner's own config/oracle/phase checks (no workload)
node test/soak/runner-test.js

# final smoke: 32 identities, cap 8, 60 s, two distinct seeds
SOAK_PROFILE=smoke SOAK_SEED=381 SOAK_DURATION_MS=60000 npm run test:writer-cap-soak
SOAK_PROFILE=smoke SOAK_SEED=382 SOAK_DURATION_MS=60000 npm run test:writer-cap-soak

# metadata saturation: fixed scenario, cap 4, budget 1, expected stall
SOAK_PROFILE=saturation npm run test:writer-cap-soak

# full approved soak: 128 identities, cap 16, 600 s (controller-owned)
SOAK_PROFILE=soak SOAK_SEED=381 SOAK_DURATION_MS=600000 npm run test:writer-cap-soak
```

The full command has an overall watchdog of
`240000 + 600000 + 240000 + 30000 = 1,110,000 ms` (18.5 minutes): setup
allowance, active duration, bounded final drain and cleanup. A healthy default
run normally finishes in roughly 11-13 minutes depending on host speed and disk
cache. A failed run exits nonzero; any expected saturation stall is printed as
`"kind": "saturation-result", "expectedStalled": true` and is **not** counted as
global convergence.

## Configuration

| Variable           | Default                      | Validation                                                               |
| ------------------ | ---------------------------- | ------------------------------------------------------------------------ |
| `SOAK_PROFILE`     | `soak`                       | exactly `soak`, `smoke` or `saturation`                                  |
| `SOAK_SEED`        | `381`                        | unsigned 32-bit integer string                                           |
| `SOAK_DURATION_MS` | `600000` soak, `60000` smoke | positive safe integer; rejected for saturation                           |
| `SOAK_WRITERS`     | `128` soak, `32` smoke       | positive safe integer, at least `readerCap + 4`; rejected for saturation |

Resolved values are printed before any storage is allocated. Invalid input
exits `2` with a `config-error` JSON line.

Profiles:

|              | writers | reader cap | metadata budget | active duration | live leaf bound |
| ------------ | ------: | ---------: | --------------: | --------------: | --------------: |
| `soak`       |     128 |         16 |            1024 |           600 s |              16 |
| `smoke`      |      32 |          8 |            1024 |            60 s |               8 |
| `saturation` |       6 |          4 |           **1** |  fixed scenario |               8 |

The reader is explicitly untrusted (only the admin identity is trusted), has
`fastForward: false`, and uses the configured session cap and metadata budget.
The hub, reference keeper and writer identities are trusted test peers, so they
do not impose the reader's cap.

## Workload and topology

All identities share one base (`room`), not 128 counted fixtures. Each identity
has its own persisted storage and local writer key. Live leaves are bounded by
the reader cap; the rest are closed and reopened in cohorts:

- setup grants all configured identities through the admin writer;
- the pressure phase fills every untrusted session slot with a caught-up idle
  logical head, then delivers a resident block that depends on a source writer
  the reader has not opened. A real `_reclaimOne` eviction must reserve the
  victim, and the runner holds the next hint flush while the cap is full. The
  victim appends a positive tail, the raw hint ingress capture remembers length
  2, the cap refuses its normal admission, and the runner isolates the victim's
  own announcer edge before the gate opens. At that point it records the
  remembered maximum as the isolation baseline and enforces it throughout the
  proof: the actual capture hook (called synchronously from the raw hint path,
  before coalescing or `wakeup`) records any later positive capture, and a
  fresh capture that raises the maximum, or any observed drop below the
  baseline, fails the proof. A same-length queued duplicate does not change the
  record and is reported separately rather than treated as fresh repair. The
  gate release then admits the victim only through the production retry path
  (`_retryReclaimedUnlocked`), with a victim-specific length-2 handoff; no
  harness `update`, `add`, `wakeup`, `hint` or fresh advancing announcement is
  allowed to explain that admission. The edge is reconnected only after the
  proof;
- regular cohorts author operations, partition and reconnect existing edges,
  restart the reader and at least one writer from the same storage/identity
  (asserting the key did not change), and close each cohort's frontier with a
  real closer merge;
- the last cohort churns until the full configured churn cutoff (there is no
  early workload stop or duration reserve). Its closer then syncs and appends
  the final frontier merge in an explicit, bounded 30 s merge closeout that is
  part of the existing 240 s drain allowance. The deadline guard checks the
  actual payload kind, so only the final administrative merge (`op:
"final-merge"`) may use that window; every workload append must start before
  the churn cutoff. An append may complete during the bounded drain (logged
  with start/completion timestamps); no append may start at or after its own
  deadline. If the cutoff lands inside a workload round, that round stops
  before starting any further append and the same bounded final closeout
  follows; this is accepted only when the slice's mandatory first round has
  already authored every configured identity and the stopping cohort is the
  final one. A partial first round, a non-final cohort that would leave later
  cohorts unrun, or any genuine update/append/phase failure still fails the
  run. Churn elapsed time and merge-closeout elapsed time are reported
  separately. If opening or sync exhausts the closeout, the schedule fails
  clearly instead of authoring late workload or relabelling it as drain work.

The topology is a hub/spoke: `admin-hub`, `hub-reference`, `hub-reader`, and up
to the live leaf bound of `hub-wN` edges. The hidden pressure source has one
direct edge to the resident. There is no all-to-all sync.

Resource samples are JSONL lines every 3 s throughout warm-up, active and drain,
plus one after-close sample. They include RSS, heap used/total, external and
array-buffer memory, CPU percent, event-loop lag, Linux FDs when available,
active sessions, ledger records, pending writers, open/close/drain counters,
live edges, live leaves, acknowledged operations and authored identities.

The runner asserts the configured session cap, metadata budget, live-leaf bound
and live-edge bound at delegating admission/eviction points and on every sample.
It does **not** assert constant process memory: reference history, persisted
state and appends legitimately grow. A sampled maximum is not proof that a
transient overshoot never happened; the admission/eviction observers cover the
important attach/detach boundaries, and the sample stream is the honest record
of everything between them.

## Oracle and checks

Every successful append is recorded in an independent ledger before it is
trusted: expected `key.length` reference, author, and acknowledged length. The
ledger is never derived from the reference or reader view.

At settled checkpoints and after the final drain the runner requires:

1. byte-for-byte ordered `#NNNNNN` apply history equality between the reference
   keeper and the reader (not merely equal sets);
2. exactly-once coverage of every independently authored operation, so two
   equally incomplete peers cannot pass;
3. no applied reference that the harness did not author;
4. per-writer applied lengths equal to the acknowledged lengths, and equal
   between reference and reader;
5. matching application state: `latest` and `clock` must both be present with
   equal bytes. Both absent is accepted only for the explicitly empty fixture
   (zero authored operations); a non-empty run with either value missing fails.

The pressure phase additionally requires observed eviction/reservation, a
refused positive tail, a remembered length-2 obligation, a real handoff, and
the applied victim/resident/source references. The victim-specific retry proof
requires at least one admission inside the production
`_retryReclaimedUnlocked` context, a length-2 handoff in that same context, no
non-retry admission of the victim, no positive announcement that advances the
remembered length after announcer isolation, and no observed drop below the
isolation baseline. The raw capture hook distinguishes a fresh positive
announcement from a same-length queued duplicate; an already-queued duplicate
that does not change the record is ignored and reported. Phase accounting
fails the run if any mandatory phase never actually ran.

## Saturation profile

The saturation profile is fixed and short. It fills the one-record metadata
budget with an actual pressure eviction, keeps the evicted victim as a logical
head, then presents a second dependency while the session cap is full and an
otherwise idle victim remains open. The runner proves the stalled resident
block is locally available and decoded with `wait: false`, that the decoded
link names the hidden dependency key at the exact missing length, and that the
real production dependency reclaim path was invoked and returned `null` with
the ledger at its one-record budget and the session cap full. At that attempt
it records an otherwise fully eligible idle victim under the same read-only
checks the product uses (`attached`, identity, not frozen, idle candidate,
head, fresh applied length at least live/hinted, no queued unknown/ahead hint,
not a reserved dependency), revalidated after its awaited reads. The new
eviction must then pause; the ledger keeps the existing obligation at its
original identity/length; opens, closes, drains, flushes, active sessions and
the obligation must not change over a three-second quiet window. That stall is
expected and is reported explicitly. It is not evidence of global convergence,
and there is no larger-budget rescue.

## Reading a failure

On failure the runner exits `1`, retains the owned temporary run directory and
prints one `soak-failure` JSON line with:

- profile, seed, exact replay invocation and the retained path;
- phase, action index and the bounded last-action ring;
- delegated eviction/admission/handoff/refusal counters;
- reader records, active/pending/core/hint lengths, reference/hub heads and
  per-writer applied lengths;
- recent resource samples, any observed bound violation, and the error.

The seed controls the runner's actions (partition victims, pauses, payload
nonces), not operating-system scheduling. Re-running the same seed and profile
is the required first reproduction attempt; timing-sensitive failures may still
need the surrounding logs and retained storage. The runner never removes a
directory it did not create and never recursively removes a general/user path.
A success removes its own run root after orderly close, using a natural process
exit (`process.exitCode`); a failure keeps the root and exits nonzero.

Teardown is part of the check, not a best-effort epilogue:

- a held hint-flush gate is released idempotently before failure diagnostics
  and again at the start of cleanup, so a held drain cannot block teardown;
- `closeStream` waits for the real `close` event, not just `destroy()`, removes
  its listeners and timer, and rejects a bounded close deadline. `unlink` and
  `closeAll` report those rejections, and cleanup turns them into a nonzero
  exit; a successful run never masks a live handle with `process.exit(0)`. An
  ordinary failure also arms a bounded forced termination, so a cleanup timeout
  or a retained live handle cannot keep the process alive forever; the natural
  success path is unchanged;
- an unexpected error on an active replication edge (including codes that were
  previously ignored such as `ECONNRESET`) fails the runner. Only a controlled
  `unlink` marks the pair closed before destroying its streams, so its
  destroy-induced errors are expected.

Known workload limits:

- a very short `SOAK_DURATION_MS` with the default 128 identities and seven
  regular cohorts can spend its whole slice budget opening cohorts; the runner
  fails that schedule rather than silently weakening identity coverage. The
  configured duration is the full workload period: there is no early stop or
  duration reserve. After the churn cutoff, only the final administrative merge
  may start, inside a separate bounded 30 s closeout that is part of the 240 s
  drain allowance. Use the approved 600 s default (or a duration with enough
  time per cohort; 240 s was used as an iterative scale check before the
  controller's full run);
- this wave proves one upfront actual pressure reclamation, one refused
  positive tail and one victim-specific autonomous retry. The later timed
  workload is many-writer convergence and resource churn with an empty
  reclaimed ledger; it is **not** sustained reclamation pressure and does not
  restart while an outstanding ledger obligation exists;
- the ledger is in-memory only. A reader restart starts with `_reclaimed` empty
  and recovers from persisted state and fresh real discovery, as the product
  contract requires; reservations are not pretended to survive;
- a saturated or all-busy reader may legitimately remain stalled. Only the
  saturation profile declares that expected; the normal soak still requires
  final ordered convergence;
- no product files, dependencies, tests from `test/` or `test/untrusted-writers.js`
  are imported or modified here.
