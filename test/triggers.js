const test = require('brittle')

const Triggers = require('../lib/triggers.js')

function writer() {
  return {
    waiting: null,
    bumps: 0,
    bump() {
      this.waiting = null
      this.bumps++
    }
  }
}

test('triggers - fires entries at or below the applied length, keeps the rest', function (t) {
  const triggers = new Triggers()
  const [a, b, c, d] = [writer(), writer(), writer(), writer()]

  a.waiting = triggers.add('x', 1, a)
  b.waiting = triggers.add('x', 5, b)
  c.waiting = triggers.add('x', 3, c)
  d.waiting = triggers.add('x', 9, d)

  triggers.trigger('x', 4)

  t.is(a.bumps, 1)
  t.is(c.bumps, 1)
  t.is(b.bumps, 0)
  t.is(d.bumps, 0)
  t.is(a.waiting, null, 'a bumped and cleared')
  t.is(c.waiting, null, 'c bumped and cleared')

  const left = triggers.get('x')
  t.is(left.length, 2, 'the two higher entries remain')
  t.ok(
    left.every((e, i) => e.index === i),
    'indexes stay dense after swap-remove'
  )
  t.ok(
    left.some((e) => e.writer === b),
    'b remains'
  )
  t.ok(
    left.some((e) => e.writer === d),
    'd remains'
  )

  triggers.trigger('x', 9)
  t.is(b.bumps, 1)
  t.is(d.bumps, 1)
  t.absent(triggers.has('x'), 'the id is dropped once empty')
})

test('triggers - trigger on an unknown id or below every entry is a noop', function (t) {
  const triggers = new Triggers()
  const a = writer()

  triggers.trigger('nope', 100)

  a.waiting = triggers.add('x', 10, a)
  triggers.trigger('x', 9)

  t.is(a.bumps, 0)
  t.ok(triggers.has('x'))
})

test('triggers - re-adding the same writer and id updates the length in place', function (t) {
  const triggers = new Triggers()
  const a = writer()

  const first = triggers.add('x', 10, a)
  a.waiting = first
  const second = triggers.add('x', 3, a)

  t.is(second, first, 'same entry')
  t.is(triggers.get('x').length, 1)

  triggers.trigger('x', 3)
  t.is(a.bumps, 1, 'fires at the updated length')
})

test("triggers - adding under a new id evicts the writer's previous entry", function (t) {
  const triggers = new Triggers()
  const a = writer()
  const b = writer()

  a.waiting = triggers.add('x', 10, a)
  b.waiting = triggers.add('x', 10, b)
  a.waiting = triggers.add('y', 2, a)

  t.is(triggers.get('x').length, 1, 'a left x')
  t.is(triggers.get('x')[0].writer, b, 'b still waits on x')
  t.is(triggers.get('y').length, 1, 'a waits on y')

  triggers.trigger('x', 10)
  t.is(a.bumps, 0, 'a is not bumped for the link it no longer waits on')
  t.is(b.bumps, 1)
})

test('triggers - remove is idempotent and tolerates removed entries', function (t) {
  const triggers = new Triggers()
  const [a, b] = [writer(), writer()]

  a.waiting = triggers.add('x', 1, a)
  b.waiting = triggers.add('x', 2, b)

  const entry = a.waiting
  triggers.remove(entry)
  triggers.remove(entry)
  t.is(entry.writer, null)
  t.is(triggers.get('x').length, 1)
  t.is(triggers.get('x')[0].index, 0, 'b moved down into the freed slot')

  triggers.trigger('x', 2)
  triggers.remove(b.waiting === null ? entry : b.waiting)
  t.absent(triggers.has('x'))
})

test('triggers - a bump that re-adds during trigger does not disturb the walk', function (t) {
  const triggers = new Triggers()
  const [a, b, c] = [writer(), writer(), writer()]

  // a re-registers on the same id when bumped, the way a writer would if the
  // node it waited for turned out to link further ahead
  a.bump = function () {
    this.bumps++
    this.waiting = triggers.add('x', 50, this)
  }

  a.waiting = triggers.add('x', 1, a)
  b.waiting = triggers.add('x', 2, b)
  c.waiting = triggers.add('x', 3, c)

  triggers.trigger('x', 3)

  t.is(a.bumps, 1)
  t.is(b.bumps, 1)
  t.is(c.bumps, 1)

  const left = triggers.get('x')
  t.is(left.length, 1, 'only the re-added entry remains')
  t.is(left[0].writer, a)
  t.is(left[0].length, 50)
  t.is(left[0].index, 0)
})
