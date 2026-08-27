const test = require('brittle')
const { order, explain, idOf } = require('./order.js')

// ---- helpers ----------------------------------------------------------

function n(key, length, { links = [], ts = 0, weight = 0, witness = null } = {}) {
  return { key, length, links, ts, weight, witness }
}

function ids(nodes) {
  return nodes.map(idOf)
}

function pos(out) {
  const map = new Map()
  out.forEach((node, i) => map.set(idOf(node), i))
  return map
}

// ---- hand vectors ------------------------------------------------------

test('seed-5 shape: unacked old-stamped light node sorts after the heavy block', function (t) {
  // gF (w0) -> g2 (w2, links gF); X (w0) concurrent with an ANCIENT stamp.
  // mixed-cmp ordering has the cycle gF->g2 (causal), g2->X (weight),
  // X->gF (ts). here X is simply unclaimed: it sorts in the tail.
  const gF = n('g', 1, { ts: 1000, weight: 0 })
  const g2 = n('g', 2, { links: [{ key: 'g', length: 1 }], ts: 1001, weight: 2 })
  const X = n('x', 1, { ts: 1, weight: 0 })

  t.alike(ids(order([gF, g2, X])), ['g:1', 'g:2', 'x:1'])
  t.alike(ids(order([X, g2, gF])), ['g:1', 'g:2', 'x:1'], 'input order irrelevant')
})

test('closure grouping beats timestamp interleave', function (t) {
  // H acknowledges L2 but not L1. mixed Kahn would emit [L1, L2, H] by ts;
  // strata groups the closure: [L2, H, L1]
  const L1 = n('a', 1, { ts: 5, weight: 0 })
  const L2 = n('b', 1, { ts: 10, weight: 0 })
  const H = n('h', 1, { links: [{ key: 'b', length: 1 }], ts: 20, weight: 2 })

  t.alike(ids(order([L1, L2, H])), ['b:1', 'h:1', 'a:1'])
})

test('within-class anti-Kahn: causal tie-inversion resolves top-down', function (t) {
  // A(P ts100) <- B(Q ts100, links A), keys Q < X < P, X concurrent ts100.
  // bottom-up Kahn would give [X, A, B]; the walk's fixed point (and this
  // definition) is [A, B, X]
  const A = n('p', 1, { ts: 100, weight: 1 })
  const B = n('q', 1, { links: [{ key: 'p', length: 1 }], ts: 100, weight: 1 })
  const X = n('t', 1, { ts: 100, weight: 1 })

  t.alike(ids(order([A, B, X])), ['p:1', 'q:1', 't:1'])
})

test('first acknowledger claims; later acknowledgers do not regroup', function (t) {
  const L = n('a', 1, { ts: 5, weight: 0 })
  const H1 = n('h', 1, { links: [{ key: 'a', length: 1 }], ts: 10, weight: 2 })
  const H2 = n('k', 1, { links: [{ key: 'a', length: 1 }], ts: 20, weight: 2 })

  const out = ids(order([L, H1, H2]))
  t.alike(out, ['a:1', 'h:1', 'k:1'], 'L sits in H1 closure, not H2')
})

test('multi-strata nesting: closures resolve recursively per class', function (t) {
  // w0 m <- w1 mid (links m) <- w2 top (links mid). one chain of claims:
  // top's closure contains mid, whose own (nested) closure contains m
  const m = n('a', 1, { ts: 1, weight: 0 })
  const mid = n('b', 1, { links: [{ key: 'a', length: 1 }], ts: 2, weight: 1 })
  const top = n('c', 1, { links: [{ key: 'b', length: 1 }], ts: 3, weight: 2 })
  // and an unclaimed straggler of each class
  const s0 = n('d', 1, { ts: 0, weight: 0 })
  const s1 = n('e', 1, { ts: 0, weight: 1 })

  const out = ids(order([m, mid, top, s0, s1]))
  t.alike(out, ['a:1', 'b:1', 'c:1', 'e:1', 'd:1'])

  const tree = explain([m, mid, top, s0, s1])
  t.is(tree.weight, 2, 'top stratum is w2')
  t.is(tree.entries.length, 1)
  t.is(tree.entries[0].closure.weight, 1, 'nested closure stratum is w1')
  t.is(tree.tail.weight, 1, 'tail recursion starts at next class down')
})

test('witness backer is a causal dep', function (t) {
  const flush = n('b', 1, { ts: 10, weight: 1 })
  const heavy = n('w', 1, { ts: 5, weight: 2, witness: { backer: { key: 'b', length: 1 } } })

  const out = ids(order([flush, heavy]))
  t.alike(out, ['b:1', 'w:1'], 'backdated heavy still sorts above its backer')
})

test('input must be causally closed', function (t) {
  const b = n('b', 1, { links: [{ key: 'missing', length: 3 }] })
  t.exception(() => order([b]), /causally closed/)
})

// ---- property fuzz -----------------------------------------------------

const SEED = envInt('REF_SEED', (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0)
const RUNS = envInt('REF_RUNS', 200)
const STEPS = envInt('REF_STEPS', 60)

test('property fuzz: determinism, causality, strata invariants', function (t) {
  t.comment(`seed=${SEED} runs=${RUNS} steps=${STEPS}`)
  const rng = makeRng(SEED)

  for (let run = 0; run < RUNS; run++) {
    const nodes = randomDag(rng, STEPS)
    let out
    try {
      out = order(nodes)
    } catch (err) {
      t.fail(`run ${run}: order threw: ${err.message}`)
      break
    }

    if (out.length !== nodes.length) {
      t.fail(`run ${run}: dropped nodes (${out.length}/${nodes.length})`)
      break
    }

    const p = pos(out)

    // causality: every dep strictly before its dependent
    let ok = true
    for (const node of nodes) {
      for (const dep of depsOf(node)) {
        if (!(p.get(dep) < p.get(idOf(node)))) {
          t.fail(`run ${run}: causality violated: ${dep} !< ${idOf(node)}`)
          ok = false
        }
      }
      if (!ok) break
    }
    if (!ok) break

    // determinism: input permutation cannot matter
    const shuffled = shuffle(rng, nodes.slice())
    const out2 = order(shuffled)
    for (let i = 0; i < out.length; i++) {
      if (idOf(out[i]) !== idOf(out2[i])) {
        t.fail(`run ${run}: input order changed output at ${i}`)
        ok = false
        break
      }
    }
    if (!ok) break

    // strata: a node outside every top-class past sorts after the whole
    // top class; a claimed node sits between its acknowledger and the
    // previous top-class node
    const W = Math.max(...nodes.map((x) => x.weight))
    const heavies = out.filter((x) => x.weight === W).map(idOf)
    const pastSets = pastAll(nodes)

    for (const node of nodes) {
      if (node.weight === W) continue
      const id = idOf(node)
      const coveringInOrder = heavies.filter((h) => pastSets.get(h).has(id))

      if (coveringInOrder.length === 0) {
        for (const h of heavies) {
          if (!(p.get(id) > p.get(h))) {
            t.fail(`run ${run}: unclaimed ${id} sorted before top-class ${h}`)
            ok = false
            break
          }
        }
      } else {
        const ack = coveringInOrder.reduce((a, b) => (p.get(a) < p.get(b) ? a : b))
        if (!(p.get(id) < p.get(ack))) {
          t.fail(`run ${run}: ${id} not before its acknowledger ${ack}`)
          ok = false
        }
        const before = heavies.filter((h) => p.get(h) < p.get(ack))
        for (const h of before) {
          if (!(p.get(id) > p.get(h))) {
            // permitted only if a heavier-still... no heavier exists (W is max):
            // a claimed node must sit inside its acknowledger's segment
            t.fail(`run ${run}: ${id} escaped its closure segment (before ${h})`)
            ok = false
            break
          }
        }
      }
      if (!ok) break
    }
    if (!ok) break
  }

  t.pass(`property fuzz completed (seed=${SEED})`)
})

// ---- random DAG generator ----------------------------------------------
// writers with chains, partial visibility (gossip), climbs, stamp ties and
// backdates. always causally closed by construction.

function randomDag(rng, steps) {
  const writers = 2 + rng.int(0, 3)
  const nodes = []
  const state = []

  for (let w = 0; w < writers; w++) {
    state.push({
      key: 'w' + String.fromCharCode(97 + w),
      length: 0,
      weight: rng.int(0, 1) === 0 ? 0 : rng.int(1, 2),
      view: new Map() // writer key -> length known
    })
  }

  let clock = 1000

  for (let i = 0; i < steps; i++) {
    clock += rng.int(1, 3)
    const roll = rng.int(0, 9)

    if (roll < 2 && nodes.length) {
      // gossip: one writer learns another's view
      const a = state[rng.int(0, writers - 1)]
      const b = state[rng.int(0, writers - 1)]
      for (const [k, l] of b.view) {
        if ((a.view.get(k) || 0) < l) a.view.set(k, l)
      }
      if ((a.view.get(b.key) || 0) < b.length) a.view.set(b.key, b.length)
      continue
    }

    if (roll === 2) {
      // climb: a writer's resolved weight rises
      const w = state[rng.int(0, writers - 1)]
      if (w.weight < 2) w.weight++
      continue
    }

    // append
    const w = state[rng.int(0, writers - 1)]
    const links = []
    for (const [k, l] of w.view) {
      if (k === w.key || l === 0) continue
      if (rng.int(0, 2) === 0) continue // partial linking
      links.push({ key: k, length: l })
    }

    // stamps: mostly fresh, sometimes tied, sometimes backdated hard
    let ts = clock
    const stampRoll = rng.int(0, 9)
    if (stampRoll === 0) {
      ts = 1 + rng.int(0, 5) // ancient
    } else if (stampRoll === 1) {
      ts = clock - rng.int(0, 20) // mildly stale
    } else if (stampRoll === 2 && nodes.length) {
      ts = nodes[nodes.length - 1].ts // tie
    }

    w.length++
    w.view.set(w.key, w.length)
    nodes.push(n(w.key, w.length, { links, ts, weight: w.weight }))
  }

  return nodes
}

function depsOf(node) {
  const d = []
  if (node.length > 1) d.push(node.key + ':' + (node.length - 1))
  for (const link of node.links) if (link.length) d.push(idOf(link))
  if (node.witness && node.witness.backer && node.witness.backer.length) {
    d.push(idOf(node.witness.backer))
  }
  return d
}

function pastAll(nodes) {
  const byId = new Map(nodes.map((x) => [idOf(x), x]))
  const past = new Map()
  const resolve = (id) => {
    if (past.has(id)) return past.get(id)
    const set = new Set()
    for (const dep of depsOf(byId.get(id))) {
      set.add(dep)
      for (const anc of resolve(dep)) set.add(anc)
    }
    past.set(id, set)
    return set
  }
  for (const id of byId.keys()) resolve(id)
  return past
}

function shuffle(rng, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.int(0, i)
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

function envInt(name, fallback) {
  const v = process.env[name]
  return v ? Number(v) : fallback
}

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeRng(seed) {
  const next = mulberry32(seed)
  return {
    float: () => next(),
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1))
    }
  }
}
