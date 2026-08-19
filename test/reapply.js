const test = require('brittle')
const b4a = require('b4a')

const { create, replicate, replicateAndSync, sync, encode, same, apply } = require('./helpers')

const topo = require('../lib/topo.js')

// The reboot tip is the set of nodes that were linearized on top of the head we
// reboot onto - it must never contain a node the rebooted system already has,
// otherwise reapply runs the user apply handler twice for the same node.
test('reapply - tip excludes nodes already in the rebooted system', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)
  const trace = createTrace(t)
  const auto3 = await create(t, auto1.key, {
    apply: stalling(() => auto1, trace),
    onwakeup: () => ({ key: auto1.local.key, length: auto1.local.length })
  })

  trace.attach(auto3)

  await auto1.append(encode({ hello: 'world' }))
  await auto1.append(encode({ addWriter: auto2.local.id, weight: 1 }))

  await replicateAndSync(auto1, auto2, auto3)

  for (let i = 0; i < 100; i++) {
    await auto1.append(encode({ hello: 'world' + i }))
  }
  await auto3.writers.refresh()

  await replicateAndSync(auto1, auto2)

  const moved = onceMoveTo(auto3)

  await auto2.append(encode({ hello: 'from auto2' }))

  t.comment('sync 2<>3')
  await replicateAndSync(auto1, auto2, auto3)

  t.ok(await moved, 'rebooted')

  // sparse after the reboot, so keep replicating while we read it back
  t.teardown(replicate(auto1, auto2, auto3))

  t.is(trace.reapplies, 1, 'reapplied once')
  t.ok(trace.tipNodes > 0, 'tip was not empty (' + trace.tipNodes + ' nodes)')

  t.alike(trace.tipExisting, [], 'no tip node was already in the system')
  t.alike(trace.tipUnordered, [], 'tip is ordered oldest first')
  t.alike(trace.reapplied, [], 'no already-applied node was reapplied')

  t.ok(await same(auto2, auto3), 'converged with a peer that never rebooted')
  await sameClock(t, auto2, auto3)
})

// trusted === the announced head, so the head we reboot onto is already the
// newest linearization - the tip must come back empty rather than replaying
// the whole history on top of itself
test('reapply - empty tip when the trusted head is the newest head', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)
  const trace = createTrace(t)
  const auto3 = await create(t, auto1.key, {
    apply: stalling(() => auto1, trace),
    onwakeup: (head) => head
  })

  trace.attach(auto3)

  await auto1.append(encode({ hello: 'world' }))
  await auto1.append(encode({ addWriter: auto2.local.id, weight: 1 }))

  await replicateAndSync(auto1, auto2, auto3)

  for (let i = 0; i < 100; i++) {
    await auto1.append(encode({ hello: 'world' + i }))
  }
  await auto3.writers.refresh()

  await replicateAndSync(auto1, auto2)

  const moved = onceMoveTo(auto3)

  await auto2.append(encode({ hello: 'from auto2' }))

  t.comment('sync 2<>3')
  await replicateAndSync(auto1, auto2, auto3)

  t.ok(await moved, 'rebooted')

  // we rebooted onto auto2's cores, so it has to stay replicating too
  t.teardown(replicate(auto1, auto2, auto3))

  t.is(trace.reapplies, 1, 'reapplied once')
  t.is(trace.tipNodes, 0, 'tip is empty')
  t.alike(trace.reapplied, [], 'nothing reapplied')

  t.ok(await same(auto2, auto3), 'converged with a peer that never rebooted')
  await sameClock(t, auto2, auto3)
})

// the trusted head is deliberately behind the announced head, so the tip spans
// several writers - the classic shape where a duplicate would slip in
test('reapply - multi-writer tip excludes nodes already in the rebooted system', async function (t) {
  const auto1 = await create(t)
  const auto2 = await create(t, auto1.key)
  const auto4 = await create(t, auto1.key)

  let trusted = null

  const trace = createTrace(t)
  const auto3 = await create(t, auto1.key, {
    apply: stalling(() => auto1, trace),
    onwakeup: () => trusted
  })

  trace.attach(auto3)

  await auto1.append(encode({ hello: 'world' }))
  await auto1.append(encode({ addWriter: auto2.local.id, weight: 1 }))
  await auto1.append(encode({ addWriter: auto4.local.id, weight: 1 }))

  await replicateAndSync(auto1, auto2, auto4, auto3)

  for (let i = 0; i < 100; i++) {
    await auto1.append(encode({ hello: 'world' + i }))
  }

  await replicateAndSync(auto1, auto2, auto4)

  // pin the trusted head here, then keep writing so the tip has to span all
  // three writers on top of it
  trusted = { key: auto1.local.key, length: auto1.local.length }

  for (let i = 0; i < 10; i++) {
    await auto1.append(encode({ more: 'auto1.' + i }))
    await auto2.append(encode({ more: 'auto2.' + i }))
    await auto4.append(encode({ more: 'auto4.' + i }))
    await replicateAndSync(auto1, auto2, auto4)
  }

  await auto3.writers.refresh()

  const moved = onceMoveTo(auto3)

  t.comment('sync 3 in')
  await replicateAndSync(auto1, auto2, auto4, auto3)

  t.ok(await moved, 'rebooted')

  t.teardown(replicate(auto1, auto2, auto4, auto3))

  t.ok(trace.reapplies > 0, 'reapplied')
  t.ok(trace.tipNodes > 0, 'tip was not empty (' + trace.tipNodes + ' nodes)')
  t.ok(trace.tipWriters > 1, 'tip spans several writers (' + trace.tipWriters + ')')

  t.alike(trace.tipExisting, [], 'no tip node was already in the system')
  t.alike(trace.tipUnordered, [], 'tip is ordered oldest first')
  t.alike(trace.reapplied, [], 'no already-applied node was reapplied')

  await sync(auto1, auto2, auto4, auto3)

  t.ok(await same(auto2, auto3), 'converged with a peer that never rebooted')
  await sameClock(t, auto2, auto3)
})

// The tip is walked out of the announced peer's system, stopping at the head
// onwakeup returned as trusted - so that head has to be in it. An app is free to
// return a head the announcer has not applied yet: here w1's newest node, which
// w0 has never seen even though w0 is the announced head (it has the higher
// flush count, which is what rebootFromHeads picks best on). With no stop marker
// the walk runs off the start of history and the "tip" is the whole log, all of
// which the rebooted head already contains.
test('reapply - trusted head the announced system does not contain', async function (t) {
  const { follower, w0, w1, order } = await unshared(t)

  const res = await follower._rebootFromHead(
    { key: w0.local.key, length: w0.local.length },
    { key: w1.local.key, length: w1.local.length }
  )

  t.ok(res, 'rebooted')

  await sync(w0, w1, follower)

  const applied = await order(follower)
  t.alike(duplicates(applied), [], 'follower did not apply any node twice')
  t.alike(applied, await order(w0), 'follower applied the same nodes in the same order as w0')
})

// views.flushes is stamped when the appender flushes and never restamped, so it
// goes stale the moment that appender reorgs - the announced system then holds
// the verified head at a different flush count, and the walk from it describes a
// prefix the two peers do not share. Simulated here by handing back a stale
// stamp, which is exactly what the appender's own oplog would carry.
test('reapply - trusted head recorded at a stale flush count', async function (t) {
  const { follower, w0, w1, order } = await unshared(t)

  await replicateAndSync(w0, w1)

  const trusted = { key: w1.local.key, length: w1.local.length }
  const getOplog = follower._getOplog.bind(follower)

  follower._getOplog = async function (key, length, opts) {
    const res = await getOplog(key, length, opts)

    if (res && res.op.views && b4a.equals(key, trusted.key) && length === trusted.length) {
      res.op.views = { ...res.op.views, flushes: res.op.views.flushes - 1 }
    }

    return res
  }

  const res = await follower._rebootFromHead(
    { key: w0.local.key, length: w0.local.length },
    trusted
  )

  t.ok(res, 'rebooted')

  follower._getOplog = getOplog
  await sync(w0, w1, follower)

  const applied = await order(follower)
  t.alike(duplicates(applied), [], 'follower did not apply any node twice')
  t.alike(applied, await order(w0), 'follower applied the same nodes in the same order as w0')
})

// w0 ends up with the highest flush count while never having applied w1's
// newest node, and a follower far enough behind to fast-forward onto it
async function unshared(t) {
  const w0 = await create(t)
  const w1 = await create(t, w0.key)

  await w0.append(encode({ msg: 'genesis' }))
  await w0.append(encode({ addWriter: w1.local.id, weight: 1 }))

  const follower = await create(t, w0.key, { apply, onwakeup: () => null })

  await replicateAndSync(w0, w1, follower)

  // w1 follows along so it can apply what w0 writes
  for (let i = 0; i < 60; i++) await w0.append(encode({ msg: 'a' + i }))
  await replicateAndSync(w0, w1)

  // w1 flushes a head of its own that w0 never hears about
  await w1.append(encode({ msg: 'from w1' }))
  await w1.update()

  // and w0 keeps flushing, so it stays the best head by flush count
  for (let i = 0; i < 10; i++) await w0.append(encode({ msg: 'b' + i }))

  const w0HasW1 = await w0.system.get(w1.local.key)
  t.is(w0HasW1 ? w0HasW1.length : 0, 0, 'w0 has not applied w1s node')
  t.ok(w0.system.flushes > w1.system.flushes, 'w0 is the best head by flush count')

  await follower.writers.refresh()
  t.teardown(replicate(w0, w1, follower))

  return { follower, w0, w1, order: appliedOrder }
}

// the #NNNNNN keys the helper apply() writes - one per applied node, in order
async function appliedOrder(auto) {
  const order = []
  for await (const data of auto.view.createReadStream()) {
    if (b4a.toString(data.key)[0] !== '#') continue
    order.push(b4a.toString(data.value))
  }
  return order
}

function duplicates(order) {
  const seen = new Set()
  const dupes = []
  for (const ref of order) {
    if (seen.has(ref)) dupes.push(ref)
    seen.add(ref)
  }
  return dupes
}

// records, per reboot, whether the tip or the reapply touched a node the
// rebooted system already had
function createTrace(t) {
  const trace = {
    reapplies: 0,
    tipNodes: 0,
    tipWriters: 0,
    tipExisting: [], // tip nodes already present in the system
    tipUnordered: [], // tip nodes that arrived before an earlier node of the same writer
    reapplied: [], // nodes applied by reapply that the system already had
    undos: 0,
    stalls: 0,
    moved: false,
    attach
  }

  return trace

  function attach(auto) {
    const rollback = topo.rollback
    const reapply = Object.getPrototypeOf(auto)._reapply
    const applyBatch = auto._applyBatch.bind(auto)
    const undo = auto.system.undo.bind(auto.system)

    let inReapply = false
    let known = null

    auto.on('move-to', () => {
      trace.moved = true
    })

    topo.rollback = async function (target, system, verified) {
      const res = await rollback(target, system, verified)
      if (target !== auto) return res

      const writers = new Set()
      const seen = new Map()

      for (const batch of res.tip) {
        for (const node of batch) {
          if (node === null) continue

          const hex = b4a.toString(node.key, 'hex')
          trace.tipNodes++
          writers.add(hex)

          // reapply consumes the tip oldest first, so a writer's lengths have
          // to come back ascending
          if (seen.has(hex) && seen.get(hex) > node.length) trace.tipUnordered.push(id(node))
          seen.set(hex, node.length)

          if (await auto.system.has({ key: node.key, length: node.length })) {
            trace.tipExisting.push(id(node))
          }
        }
      }

      trace.tipWriters = Math.max(trace.tipWriters, writers.size)
      return res
    }

    t.teardown(() => {
      topo.rollback = rollback
    })

    auto._reapply = async function (tip) {
      trace.reapplies++
      // lengths the system already holds at the head we rebooted onto
      known = new Map()
      for await (const info of auto.system.list()) {
        known.set(b4a.toString(info.key, 'hex'), info.length)
      }

      inReapply = true
      try {
        return await reapply.call(auto, tip)
      } finally {
        inReapply = false
      }
    }

    auto.system.undo = function (head) {
      if (inReapply) trace.undos++
      return undo(head)
    }

    auto._applyBatch = function (batch, optimistic) {
      if (inReapply) {
        for (const node of batch) {
          const hex = b4a.toString(node.key, 'hex')
          const at = known.has(hex) ? known.get(hex) : 0
          if (at >= node.length) trace.reapplied.push(id(node))
        }
      }

      return applyBatch(batch, optimistic)
    }
  }

  function id(node) {
    return b4a.toString(node.key, 'hex').slice(0, 8) + '@' + node.length
  }
}

// keeps the peer from linearizing normally so it has to fast-forward - once it
// has rebooted we apply everything, otherwise the tip would be dropped on the
// floor and the peer could never converge
function stalling(getStalled, trace) {
  return function (nodes, view, host) {
    const stalled = getStalled()
    const node = nodes[0]

    if (!trace.moved && stalled && b4a.equals(node.key, stalled.local.key) && node.length > 3) {
      trace.stalls++
      return
    }

    return apply(nodes, view, host)
  }
}

function onceMoveTo(auto, ms = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    auto.once('move-to', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

// the helper apply bumps a counter per applied node, so a double apply shows up
// as a clock that ran ahead of a peer that linearized normally
async function sameClock(t, a, b) {
  const ca = await a.view.get(b4a.from('clock'))
  const cb = await b.view.get(b4a.from('clock'))

  t.alike(
    cb && b4a.toString(cb.value),
    ca && b4a.toString(ca.value),
    'apply ran the same number of times'
  )
}
