// Canonical stratified order - the reference definition of autobee's
// converged linearization, computed batch-wise as a pure function of the
// node set. The incremental walk (lib/topo.js) must realize exactly this
// order under every causal arrival schedule: differential-fuzz it against
// this module.
//
// Definition (recursive):
//
//   order(D):
//     W = highest resolved weight present in D
//     H = the weight-W members of D, sequenced by anti-Kahn:
//         repeatedly extract the cmp-GREATEST causally-maximal member,
//         building the sequence from the END (cmp = ts, key, length -
//         within one class only)
//     for each h in that sequence:
//       closure(h) = the not-yet-emitted causal past of h within D
//       emit order(closure(h)), then h      // first acknowledger claims
//     emit order(unclaimed remainder)       // the unacked tail
//
// Cross-class relations are causal only (closure membership). cmp is only
// ever applied between nodes of one weight class. That is the point: no
// weight-vs-timestamp comparison exists, so the weight/causality cycle
// that makes the mixed-cmp walk arrival-dependent cannot form here.
//
// The unit of ordering is the WIRE BATCH, not the node: the engine's walk
// compares batch[0] everywhere and applies a batch atomically, so a batch
// sorts as one unit keyed by its head's (ts, key, length) and its members
// are always emitted contiguously. Nodes without batch bookkeeping are
// singleton units (which is also every batch under uniform timestamps, so
// pre-batch dumps replay identically).
//
// Node shape (adapter's job to produce from real oplog nodes):
//   {
//     key: string,            // writer id (eg hex)
//     length: number,         // >= 1, position in the writer's chain
//     links: [{key, length}], // causal deps (length 0 entries ignored)
//     witness: { link: {key, length} } | null,  // the cited grant op is a dep too
//     ts: number,             // wire timestamp
//     weight: number,         // RESOLVED sort weight (input, not computed)
//     batch: { start, end } | null  // wire-batch bookkeeping, if any
//   }
//
// The input set must be causally closed (every dep present) and acyclic -
// both are guaranteed for real ingested DAGs and asserted here.

exports.order = order
exports.explain = explain
exports.flatten = flatten
exports.cmpNodes = cmpNodes
exports.idOf = idOf

function idOf(ref) {
  return ref.key + ':' + ref.length
}

// within-class total order: ts, then key, then length. > 0 means a sorts
// AFTER b. never applied across weight classes.
function cmpNodes(a, b) {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1
  if (a.key !== b.key) return a.key < b.key ? -1 : 1
  if (a.length !== b.length) return a.length < b.length ? -1 : 1
  return 0
}

function order(nodes) {
  return flatten(explain(nodes))
}

function flatten(tree) {
  const out = []
  walk(tree)
  return out

  function walk(seg) {
    if (!seg) return
    for (const entry of seg.entries) {
      walk(entry.closure)
      // a unit's members emit contiguously, chain order
      out.push(...entry.node.members)
    }
    walk(seg.tail)
  }
}

// returns the segment tree: { weight, entries: [{ node, closure }], tail }
// where closure and tail are nested segment trees (or null)
function explain(nodes) {
  const g = buildGraph(nodes)
  const emitted = new Set()
  return build(g, g.ids, emitted)
}

function build(g, subsetIds, emitted) {
  const live = subsetIds.filter((id) => !emitted.has(id))
  if (live.length === 0) return null

  let weight = -Infinity
  for (const id of live) {
    const w = g.byId.get(id).weight
    if (w > weight) weight = w
  }

  const classIds = live.filter((id) => g.byId.get(id).weight === weight)
  const seq = antiKahn(g, classIds)

  const liveSet = new Set(live)
  const entries = []

  for (const h of seq) {
    if (emitted.has(h)) {
      throw new Error('class member emitted out of sequence: ' + h)
    }

    const closureIds = []
    for (const id of g.past.get(h)) {
      if (!liveSet.has(id) || emitted.has(id)) continue
      if (g.byId.get(id).weight >= weight) {
        // an equal-weight ancestor must already have been emitted by the
        // anti-Kahn sequence (it respects causality) - anything else is a
        // bug in this module, not in the input
        throw new Error('unclaimed same-or-heavier ancestor: ' + id + ' of ' + h)
      }
      closureIds.push(id)
    }

    const closure = build(g, closureIds, emitted)
    entries.push({ node: g.byId.get(h), closure })
    emitted.add(h)
  }

  const rest = live.filter((id) => !emitted.has(id))
  const tail = rest.length ? build(g, rest, emitted) : null

  return { weight, entries, tail }
}

// within-class anti-Kahn: repeatedly extract the cmp-greatest member that
// is causally maximal among the remaining members, building from the end.
// reference implementation - clarity over speed (O(k^2) per step)
function antiKahn(g, ids) {
  const remaining = new Set(ids)
  const result = []

  while (remaining.size) {
    let best = null

    for (const id of remaining) {
      let maximal = true
      for (const other of remaining) {
        if (other !== id && g.past.get(other).has(id)) {
          maximal = false
          break
        }
      }
      if (!maximal) continue
      if (best === null || cmpNodes(g.byId.get(id), g.byId.get(best)) > 0) {
        best = id
      }
    }

    if (best === null) throw new Error('causal cycle within weight class')

    result.unshift(best)
    remaining.delete(best)
  }

  return result
}

function buildGraph(nodes) {
  const units = groupUnits(nodes)

  // unit id = head's id; every member's id resolves to its unit
  const byId = new Map()
  const memberIndex = new Map()
  for (const u of units) {
    const id = idOf(u)
    if (byId.has(id)) throw new Error('duplicate unit: ' + id)
    byId.set(id, u)
    for (const m of u.members) memberIndex.set(idOf(m), id)
  }

  const deps = new Map()
  for (const u of units) {
    const raw = []
    if (u.length > 1) raw.push(u.key + ':' + (u.length - 1))
    for (const m of u.members) {
      for (const link of m.links || []) {
        if (!link.length) continue
        raw.push(idOf(link))
      }
      if (m.witness && m.witness.link && m.witness.link.length) {
        raw.push(idOf(m.witness.link))
      }
    }

    const d = []
    const id = idOf(u)
    for (const rid of raw) {
      const unitId = memberIndex.get(rid)
      if (unitId === undefined) {
        throw new Error('input not causally closed: ' + id + ' depends on missing ' + rid)
      }
      if (unitId === id) continue // intra-unit chain is internal
      if (!d.includes(unitId)) d.push(unitId)
    }
    deps.set(id, d)
  }

  // memoized transitive causal past per node, with cycle detection
  const past = new Map()
  const visiting = new Set()

  const resolve = (id) => {
    if (past.has(id)) return past.get(id)
    if (visiting.has(id)) throw new Error('causal cycle through ' + id)
    visiting.add(id)

    const set = new Set()
    for (const dep of deps.get(id)) {
      set.add(dep)
      for (const anc of resolve(dep)) set.add(anc)
    }

    visiting.delete(id)
    past.set(id, set)
    return set
  }

  for (const id of byId.keys()) resolve(id)

  return { ids: [...byId.keys()], byId, deps, past }
}

// group nodes into wire-batch units: a batch is a contiguous chain segment
// [head (batch.start === 0) .. tail (batch.end === 0)] frozen into the oplog
// at append time. nodes without bookkeeping are singleton units.
function groupUnits(nodes) {
  const byWriter = new Map()
  for (const n of nodes) {
    let arr = byWriter.get(n.key)
    if (!arr) byWriter.set(n.key, (arr = []))
    arr.push(n)
  }

  const units = []
  for (const arr of byWriter.values()) {
    arr.sort((a, b) => a.length - b.length)

    let open = null
    for (const n of arr) {
      const b = n.batch

      if (!b || (b.start === 0 && b.end === 0)) {
        if (open) throw new Error('truncated batch before ' + idOf(n))
        units.push(makeUnit([n]))
        continue
      }

      if (b.start === 0) {
        if (open) throw new Error('truncated batch before ' + idOf(n))
        open = [n]
      } else {
        if (!open) throw new Error('batch member without head: ' + idOf(n))
        const prev = open[open.length - 1]
        if (n.length !== prev.length + 1 || b.start !== open.length) {
          throw new Error('inconsistent batch bookkeeping at ' + idOf(n))
        }
        open.push(n)
      }

      if (b.end === 0) {
        units.push(makeUnit(open))
        open = null
      }
    }

    if (open) throw new Error('truncated batch at tail of writer ' + open[0].key)
  }

  return units
}

// a unit sorts by its head's (ts, key, length), mirroring the engine's
// cmp-on-batch[0]; members must share the batch-wide resolved weight
function makeUnit(members) {
  const head = members[0]
  for (const m of members) {
    if (m.weight !== head.weight) {
      throw new Error('batch with non-uniform weight at ' + idOf(m))
    }
  }
  return { key: head.key, length: head.length, ts: head.ts, weight: head.weight, members }
}
