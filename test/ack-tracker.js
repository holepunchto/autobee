const test = require('brittle')
const b4a = require('b4a')
const AckTracker = require('../lib/ack-tracker.js')

const ROUND = 200

function key(fill) {
  return b4a.alloc(32).fill(fill)
}

function tracker(opts) {
  return new AckTracker({ round: ROUND, ...opts })
}

// deterministically find a local key whose first lottery win for `entry`
// matches `match(round)` - keys are fixed buffers so results are stable
function localWithFirstWin(acks, entry, members, match) {
  for (let i = 1; i < 1000; i++) {
    const local = key(i)
    for (let r = 0; ; r++) {
      const [prob] = acks._hash(entry.key, entry.length, local, r)
      const chance = 2 ** Math.min(r, 32)
      if (chance < Math.max(members, 1) && prob % Math.max(members, 1) >= chance) continue
      if (match(r)) return { local, round: r }
      break
    }
  }
  throw new Error('no key found')
}

test('ack-tracker - defaults', function (t) {
  const acks = new AckTracker()
  t.is(acks.round, 30_000, 'default round')
  t.is(acks.size, 0)
  t.is(acks.timer, null)

  acks.clear() // cancel with no timer is a noop
  t.is(acks.timer, null)
})

test('ack-tracker - add dedups per key and keeps max length and since', function (t) {
  const acks = tracker()

  acks.add(key('a'), 2, 100)
  acks.add(key('a'), 5, 900)
  acks.add(key('a'), 3, 900)
  acks.add(key('b'), 1, 200)

  t.is(acks.size, 2)
  t.is(acks.pending[0].length, 5, 'length only advances')
  t.is(acks.pending[0].since, 100, 'since is not restamped')
})

test('ack-tracker - settle pathways', function (t) {
  const acks = tracker()
  const a = key('a')
  const b = key('b')

  acks.settle({ key: b }, { key: a, length: 1 })
  t.is(acks.size, 0, 'empty tracker is a noop')

  acks.add(a, 3, 0)

  acks.settle({ key: a }, { key: a, length: 5 })
  t.is(acks.size, 1, 'self-advance is not a link')

  acks.settle({ key: b }, { key: b, length: 1 })
  t.is(acks.size, 1, 'unrelated head does not settle')

  acks.settle({ key: b }, { key: a, length: 2 })
  t.is(acks.size, 1, 'link below the owed length does not settle')

  acks.settle({ key: b }, { key: a, length: 3 })
  t.is(acks.size, 0, 'link at the owed length settles')
})

test('ack-tracker - optimistic link inherits the entry', function (t) {
  const acks = tracker()
  const a = key('a')
  const b = key('b')
  const d = key('d')

  acks.add(a, 1, 7)

  acks.settle({ key: b, length: 2, optimistic: true }, { key: d, length: 1 })
  t.is(acks.size, 1, 'optimistic link that settles nothing chains nothing')
  t.ok(b4a.equals(acks.pending[0].key, a))

  acks.settle({ key: b, length: 2, optimistic: true }, { key: a, length: 1 })
  t.is(acks.size, 1, 'entry transferred, not dropped')
  t.ok(b4a.equals(acks.pending[0].key, b), 'keyed to the linking node')
  t.is(acks.pending[0].since, 7, 'inherits the original since')

  acks.settle({ key: a, length: 5 }, { key: b, length: 2 })
  t.is(acks.size, 0, 'a non-optimistic link ends the chain')
})

test('ack-tracker - chaining inherits the earliest since of duplicates', function (t) {
  const acks = tracker()
  const a = key('a')
  const b = key('b')

  // add() dedups, so same-key duplicates can only enter via restore
  acks.restore([
    { key: a, length: 1, since: 50 },
    { key: a, length: 1, since: 20 },
    { key: a, length: 1, since: 60 }
  ])

  acks.settle({ key: b, length: 1, optimistic: true }, { key: a, length: 1 })
  t.is(acks.size, 1)
  t.is(acks.pending[0].since, 20, 'earliest since wins')
})

test('ack-tracker - snapshot is isolated from later mutation', function (t) {
  const acks = tracker()
  const a = key('a')

  acks.add(a, 1, 0)
  const snap = acks.snapshot()

  acks.add(a, 9, 0) // mutates the live entry's length in place
  acks.add(key('b'), 1, 0)

  t.is(snap.length, 1, 'snapshot membership is fixed')
  t.is(snap[0].length, 1, 'snapshot entries are copies')

  acks.restore(snap)
  t.is(acks.size, 1)
  t.is(acks.pending[0].length, 1)

  acks.restore([])
  t.is(acks.size, 0, 'restore to empty')
})

test('ack-tracker - delay is zero with nothing pending', function (t) {
  const acks = tracker()
  t.is(acks.delay(key('l'), 0, 10), 0)
  t.is(acks.timer, null, 'nothing scheduled')
})

test('ack-tracker - single member wins round zero', function (t) {
  const acks = tracker()
  acks.add(key('a'), 1, 0)

  const d = acks.delay(key('l'), 0, 1)
  t.ok(d < ROUND, 'due within the first round')

  // members <= 0 clamps to 1
  acks.clear()
  acks.add(key('a'), 1, 0)
  t.is(acks.delay(key('l'), 0, 0), d, 'zero members behaves as one')
  acks.clear()
})

test('ack-tracker - delay is deterministic and pays once due', function (t) {
  const acks = tracker()
  const local = key('l')
  acks.add(key('a'), 1, 1000)

  const d1 = acks.delay(local, 1000, 16)
  const d2 = acks.delay(local, 1000, 16)
  t.is(d1, d2, 'same inputs, same delay')

  t.is(acks.delay(local, 1000 + d1, 16), 0, 'due once the deadline passes')
  t.is(acks.delay(local, 1000 + d1 + 5 * ROUND, 16), 0, 'overdue stays due')
  acks.clear()
})

test('ack-tracker - a late win defers, the timer wakes within a round', function (t) {
  const acks = tracker()
  const entry = { key: key('a'), length: 1 }
  const members = 64

  // a local key that first wins in round 2 or later
  const { local, round } = localWithFirstWin(acks, entry, members, (r) => r >= 2)

  acks.add(entry.key, entry.length, 0)
  const d = acks.delay(local, 0, members)

  t.ok(d >= round * ROUND, 'due no earlier than the winning round')
  t.ok(d < (round + 1) * ROUND, 'due within the winning round')
  t.ok(acks.timer !== null, 'timer scheduled')
  acks.clear()
})

test('ack-tracker - earliest entry drives the delay', function (t) {
  const acks = tracker()
  const members = 64
  const a = { key: key('a'), length: 1 }
  const b = { key: key('b'), length: 1 }

  const late = localWithFirstWin(acks, a, members, (r) => r >= 3)
  acks.add(a.key, a.length, 0)
  const dLate = acks.delay(late.local, 0, members)

  acks.add(b.key, b.length, 0)
  const dBoth = acks.delay(late.local, 0, members)
  t.ok(dBoth <= dLate, 'a second entry can only move the due time in')
  acks.clear()
})

test('ack-tracker - participation saturates at the member count', function (t) {
  const acks = tracker()
  const local = key('l')
  const members = 1024
  const horizon = (Math.ceil(Math.log2(members)) + 1) * ROUND

  for (let i = 1; i <= 100; i++) {
    acks.add(key(i), 1, 0)
  }

  t.is(acks.delay(local, horizon, members), 0, 'every entry due within log2(members) rounds')
  acks.clear()
})

test('ack-tracker - the chance cap keeps huge member counts bounded', function (t) {
  const acks = tracker()
  acks.add(key('a'), 1, 0)

  // participation beyond round 32 is a coin flip at 2^32, never zero
  const d = acks.delay(key('l'), 0, 2 ** 33)
  t.ok(d >= 0 && Number.isFinite(d), 'terminates with a finite due time')
  acks.clear()
})

test('ack-tracker - scheduling keeps the earlier timer', function (t) {
  const acks = tracker()
  const members = 64
  const a = { key: key('a'), length: 1 }

  const { local } = localWithFirstWin(acks, a, members, (r) => r >= 2)

  acks.add(a.key, a.length, 0)
  acks.delay(local, 0, members)
  const timer = acks.timer
  t.ok(timer !== null)

  acks.delay(local, 0, members)
  t.is(acks.timer, timer, 'second call does not reschedule')

  acks.clear()
  t.is(acks.timer, null, 'clear cancels')
})

test('ack-tracker - settling the last entry cancels the timer, others keep it', function (t) {
  const acks = tracker()
  const members = 64
  const a = { key: key('a'), length: 1 }
  const o = key('o')

  const { local } = localWithFirstWin(acks, a, members, (r) => r >= 1)

  acks.add(a.key, a.length, 0)
  acks.add(key('b'), 1, 0)
  acks.delay(local, 0, members)
  t.ok(acks.timer !== null)

  acks.settle({ key: o }, { key: a.key, length: 1 })
  t.is(acks.size, 1)
  t.ok(acks.timer !== null, 'timer survives while entries remain')

  acks.settle({ key: o }, { key: key('b'), length: 1 })
  t.is(acks.size, 0)
  t.is(acks.timer, null, 'settling out cancels the timer')
})

test('ack-tracker - restore to empty cancels the timer', function (t) {
  const acks = tracker()
  const members = 64
  const a = { key: key('a'), length: 1 }

  const { local } = localWithFirstWin(acks, a, members, (r) => r >= 1)

  acks.add(a.key, a.length, 0)
  acks.delay(local, 0, members)
  t.ok(acks.timer !== null)

  acks.restore([])
  t.is(acks.timer, null)
})

test('ack-tracker - ontimeout fires when the hold-off elapses', async function (t) {
  let fired = false
  let timerAtFire = undefined

  const acks = new AckTracker({
    round: 5,
    ontimeout: () => {
      fired = true
      timerAtFire = acks.timer
    }
  })

  acks.add(key('a'), 1, Date.now())
  acks.delay(key('l'), Date.now(), 64)
  t.ok(acks.timer !== null, 'timer pending')

  // the tracker's timer is unref'd, so hold the loop open with a real one
  await new Promise((resolve) => setTimeout(resolve, 50))

  t.ok(fired, 'ontimeout fired')
  t.is(timerAtFire, null, 'timer cleared before ontimeout')
  acks.clear()
})

test('ack-tracker - default ontimeout is a safe noop', async function (t) {
  const acks = new AckTracker({ round: 5 })
  acks.add(key('a'), 1, Date.now())
  acks.delay(key('l'), Date.now(), 64)

  await new Promise((resolve) => setTimeout(resolve, 30))
  t.is(acks.timer, null, 'timer fired without a handler and without throwing')
  acks.clear()
})
