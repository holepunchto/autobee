// Correctness checks run against a trial's writer pool. Two independent
// oracles, run every sync round:
//
//  1. peer vs reference (compareToReference): adapts a single peer's
//     replay() to reference/order.js's node shape and asserts the peer's
//     actual order equals the canonical order computed from the SAME node
//     set. A mismatch here is a WALK bug - the insertion logic disagreeing
//     with the definition of the order, independent of what any other peer
//     thinks.
//  2. peer vs peer (compareReplayPeers): the original oracle - two peers
//     that applied the same causal history must produce byte-identical
//     replay() + pinned weights. A mismatch here with BOTH peers still
//     individually matching the reference (oracle 1 clean on both) means
//     the peers resolved DIFFERENT weights for the same history - a
//     RESOLUTION bug (weight computation), not a walk bug. See the
//     2026-07-21 genesis-grant race in TODO.md for a worked example: the
//     walk was innocent, but the two peers were pinning genesis' weight
//     differently because of a register-read bug in the grant path.
//
// Every comparison operates on the ADAPTED (reference/order.js) node shape:
// { key: hexString, length, links, witness, ts, weight } - never on raw
// Buffer-keyed oplog nodes. adaptNode() is the only place that crosses that
// boundary, which is what lets replay-dump.js re-run these exact checks
// against a frozen dump with zero I/O: the dump already stores adapted
// nodes, so a dump replay and a live trial run identical code.

const b4a = require('b4a')
const referenceOrder = require('../../reference/order.js')
const { withTimeout } = require('./util.js')

exports.adaptNode = adaptNode
exports.collectReplays = collectReplays
exports.checkNoFrozenWriters = checkNoFrozenWriters
exports.compareToReference = compareToReference
exports.compareReplayPeers = compareReplayPeers
exports.runOracle = runOracle

function nodeRef(n) {
  return n ? `${n.key.slice(0, 8)}:${n.length}` : '<missing>'
}

function adaptNode(n) {
  return {
    key: b4a.toString(n.key, 'hex'),
    length: n.length,
    links: (n.links || []).map((l) => ({ key: b4a.toString(l.key, 'hex'), length: l.length })),
    witness: n.witness
      ? {
          link: {
            key: b4a.toString(n.witness.link.key, 'hex'),
            length: n.witness.link.length
          }
        }
      : null,
    ts: n.timestamp,
    weight: n.weight,
    // wire-batch bookkeeping: the engine orders BATCHES (cmp is always on
    // batch[0]), so the reference needs the grouping to model the same units
    batch: n.batch ? { start: n.batch.start, end: n.batch.end } : null
  }
}

// gathers everything a failure dump needs: adapted replay (reference shape)
// + system records for every writer in the pool (grant/bit asymmetries show
// up here before anywhere else - see TODO.md genesis-grant race)
//
// opts.bestEffort: never throw - salvage whatever each peer can still give
// us (per-record and per-replay errors are captured inline instead of
// aborting the whole gather). This is the crash-path mode: when a trial
// died mid-action the pool may hold half-broken writers, and one unreadable
// peer must not cost us every OTHER peer's oplog.
// opts.timeoutMs: cap each peer's replay() - a replay against a wedged
// core waits on network data forever, and the crash path must not hang the
// fuzzer on top of the original failure.
async function collectReplays(pool, opts = {}) {
  const bestEffort = !!opts.bestEffort
  const timeoutMs = opts.timeoutMs || 0

  const replays = []

  for (const { auto, name } of pool) {
    const entry = { name, records: {}, nodes: [], error: null }
    replays.push(entry)

    for (const other of pool) {
      let hex = null
      try {
        hex = b4a.toString(other.auto.local.key, 'hex')
        const rec = await auto.system.get(other.auto.local.key)
        entry.records[hex.slice(0, 8)] = rec
          ? {
              weight: rec.weight,
              maxWeight: rec.maxWeight,
              isGenesis: rec.isGenesis,
              isRemoved: rec.isRemoved,
              length: rec.length
            }
          : null
      } catch (err) {
        if (!bestEffort) throw err
        const id = hex ? hex.slice(0, 8) : `<unreadable peer ${other.name}>`
        entry.records[id] = { error: String((err && err.message) || err) }
      }
    }

    try {
      const replay = auto.replay()
      const raw = timeoutMs
        ? await withTimeout(replay, timeoutMs, `${name}.replay() timed out after ${timeoutMs}ms`)
        : await replay
      // replay() walks the system backwards and reverses, so a peer that
      // cannot reach its oldest history (fast-forwarded, or gc'd blocks)
      // returns a SUFFIX of the linearization, with null sentinels marking the
      // unreachable batches at the FRONT. keep everything after the last one -
      // that region is fully known. mapping the nulls through adaptNode is
      // what threw "Cannot read properties of null (reading 'key')"
      const last = raw.lastIndexOf(null)
      entry.truncated = last !== -1
      entry.nodes = (entry.truncated ? raw.slice(last + 1) : raw).map(adaptNode)
    } catch (err) {
      if (!bestEffort) throw err
      entry.error = String((err && err.stack) || err)
    }
  }

  return replays
}

// honest fuzzing must never freeze a writer: a freeze means witness
// verification rejected an honestly-constructed witness (the appender's and
// a verifier's reads of the same pinned snapshot disagreed) - and a frozen
// writer otherwise only surfaces as an opaque sync() timeout
function checkNoFrozenWriters(pool) {
  const failures = []
  for (const { auto, name } of pool) {
    for (const w of auto.writers) {
      if (w.isFrozen) {
        failures.push({
          kind: 'frozen-writer',
          message: `${name} froze writer ${w.id.slice(0, 8)} - honest witnesses must never freeze`
        })
      }
    }
  }
  return failures
}

// oracle 1: one peer's replay vs the canonical reference order over the
// SAME node set (peer's own pinned weights - resolution is not re-checked
// here, only whether the walk realized the order those weights imply)
function compareToReference(replay) {
  let canonical
  try {
    canonical = referenceOrder.order(replay.nodes)
  } catch (err) {
    return {
      kind: 'reference-error',
      message: `${replay.name}: reference order() threw on its own replay: ${err.message}`
    }
  }

  const actualIds = replay.nodes.map(referenceOrder.idOf)
  const canonicalIds = canonical.map(referenceOrder.idOf)

  for (let i = 0; i < actualIds.length; i++) {
    if (actualIds[i] !== canonicalIds[i]) {
      return {
        kind: 'walk-diverges-from-reference',
        message:
          `${replay.name}: replay diverges from the reference order at index ${i}/${actualIds.length}\n` +
          `  actual   : ...${actualIds.slice(Math.max(0, i - 2), i + 3).join(' ')}...\n` +
          `  reference: ...${canonicalIds.slice(Math.max(0, i - 2), i + 3).join(' ')}...`
      }
    }
  }

  return null
}

// oracle 2: two peers, same causal history => byte-identical replay order +
// pinned weights. distinguishes same-order-different-weight (a resolution
// determinism bug - system state computation itself disagreed) from
// same-history-different-order (a non-deterministic tiebreak in the walk -
// though if oracle 1 is clean on both peers, this case shouldn't be
// reachable: both would equal the SAME reference order and hence agree)
function compareReplayPeers(a, b) {
  const refsA = a.nodes.map(nodeRef)
  const refsB = b.nodes.map(nodeRef)

  // a partial replay is a SUFFIX of the full one, so a length difference on
  // its own is not divergence - compare what both peers actually know
  if (a.truncated || b.truncated) {
    const n = Math.min(a.nodes.length, b.nodes.length)
    const ta = a.nodes.slice(a.nodes.length - n)
    const tb = b.nodes.slice(b.nodes.length - n)

    for (let i = 0; i < n; i++) {
      if (nodeRef(ta[i]) !== nodeRef(tb[i])) {
        return {
          kind: 'peer-replay-divergence',
          message:
            `${a.name} and ${b.name} diverge in the shared replay tail at ${i}/${n}: ` +
            `${nodeRef(ta[i])} vs ${nodeRef(tb[i])}`
        }
      }
      if (ta[i].weight !== tb[i].weight) {
        return {
          kind: 'weight-mismatch-same-order',
          message:
            `${a.name} and ${b.name} agree on the shared tail order but disagree on pinned ` +
            `weight at ${i}: ${nodeRef(ta[i])} ${a.name}=${ta[i].weight} vs ${b.name}=${tb[i].weight}`
        }
      }
    }
    return null
  }

  let k = 0
  while (k < refsA.length && k < refsB.length && refsA[k] === refsB[k]) k++

  if (k === refsA.length && k === refsB.length) {
    for (let i = 0; i < k; i++) {
      if (a.nodes[i].weight !== b.nodes[i].weight) {
        return {
          kind: 'weight-mismatch-same-order',
          message:
            `${a.name} and ${b.name} agree on replay order but disagree on pinned weight at index ${i}: ` +
            `${nodeRef(a.nodes[i])} ${a.name}.weight=${a.nodes[i].weight} vs ${b.name}.weight=${b.nodes[i].weight}\n` +
            '  -> same history, same order, different weight: determinism bug in system state computation'
        }
      }
    }
    return null
  }

  let prefixWeightMismatch = null
  for (let i = 0; i < k; i++) {
    if (a.nodes[i].weight !== b.nodes[i].weight) {
      prefixWeightMismatch = i
      break
    }
  }

  const lines = [
    `${a.name} and ${b.name} diverge in replay() order at index ${k} (of ${refsA.length}/${refsB.length})`,
    `  common prefix [0, ${k}) identical in order: yes`
  ]

  if (prefixWeightMismatch !== null) {
    const i = prefixWeightMismatch
    lines.push(
      `  common prefix weight MISMATCH at index ${i}: ${nodeRef(a.nodes[i])} ` +
        `${a.name}.weight=${a.nodes[i].weight} vs ${b.name}.weight=${b.nodes[i].weight}`
    )
    lines.push('  -> same history, different weight: determinism bug in system state computation')
  } else {
    lines.push('  common prefix weight agreement: yes')
    lines.push(
      `  -> ${a.name} next: ${nodeRef(a.nodes[k])} weight=${a.nodes[k] && a.nodes[k].weight} ts=${a.nodes[k] && a.nodes[k].ts} | ` +
        `${b.name} next: ${nodeRef(b.nodes[k])} weight=${b.nodes[k] && b.nodes[k].weight} ts=${b.nodes[k] && b.nodes[k].ts}`
    )
    lines.push('  -> identical history, different ordering decision: non-deterministic tiebreak')
  }

  return { kind: 'peer-replay-divergence', message: lines.join('\n') }
}

// oracle 0: no node anywhere may pin a weight above the largest weight the
// trial can grant (action grants cap at maxWeight, genesis bootstrap is 2).
// the byzantine actions plant claims strictly above that ceiling, so any
// inflated pin means an unbacked claim elevated somewhere - an immediate
// failure even if every peer agrees on it
function checkInflatedWeights(replays, maxWeight) {
  const cap = Math.max(maxWeight, 2)
  const failures = []
  for (const replay of replays) {
    for (const n of replay.nodes) {
      if (n.weight > cap) {
        failures.push({
          kind: 'inflated-weight',
          message:
            `${replay.name}: node ${n.key.slice(0, 8)}:${n.length} pinned weight ${n.weight} ` +
            `above the grantable ceiling ${cap} - an unbacked claim elevated`
        })
      }
    }
  }
  return failures
}

// runs every oracle over the current pool state. always returns
// { failures, replays } - replays are collected regardless of outcome so a
// caller can dump full diagnostic state on ANY failure kind, including a
// frozen writer found before the (expensive) walk/peer comparisons run.
async function runOracle(pool, config = null) {
  const failures = checkNoFrozenWriters(pool)
  const replays = await collectReplays(pool)

  if (config && typeof config.maxWeight === 'number') {
    failures.push(...checkInflatedWeights(replays, config.maxWeight))
  }

  if (!failures.length) {
    for (const replay of replays) {
      // a suffix is not causally closed (its deps may be in the dropped
      // prefix), so the reference order cannot be evaluated on it -
      // peer-vs-peer still covers these
      if (replay.truncated) continue
      const f = compareToReference(replay)
      if (f) failures.push(f)
    }

    for (let i = 0; i < replays.length - 1; i++) {
      for (let j = i + 1; j < replays.length; j++) {
        const f = compareReplayPeers(replays[i], replays[j])
        if (f) failures.push(f)
      }
    }
  }

  return { failures, replays }
}
