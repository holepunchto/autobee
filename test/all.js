const test = require('tape')

const ram = require('random-access-memory')
const Corestore = require('corestore')
const Autobase = require('autobase')

const Autobee = require('..')

test('simple get/put', async function (t) {
  const store = new Corestore(ram)

  const input1 = store.get({ name: 'input-1' })
  const input2 = store.get({ name: 'input-2' })
  const index1 = store.get({ name: 'index-1' })
  const index2 = store.get({ name: 'index-2' })

  const base1 = new Autobase([input1, input2], {
    input: input1,
    index: index1
  })
  const base2 = new Autobase([input1, input2], {
    input: input2,
    index: index2
  })

  const bee1 = new Autobee(base1, {
    keyEncoding: 'utf-8',
    valueEncoding: 'utf-8'
  })
  const bee2 = new Autobee(base2, {
    keyEncoding: 'utf-8',
    valueEncoding: 'utf-8'
  })

  await bee1.put('a', 'b') // Each Autobase input writes a record
  await bee2.put('c', 'd')

  const expected = [['a', 'b'], ['c', 'd']]
  const vals = []
  for await (const node of bee2.createReadStream()) { // bee2 sees both records
    vals.push([node.key, node.value])
  }

  t.same(expected.length, vals.length)

  while (vals.length) {
    const node = vals.pop()
    const e = expected.pop()
    t.same(node[0], e[0])
    t.same(node[1], e[1])
  }

  t.same(expected.length, 0)
  t.same(vals.length, 0)

  t.end()
})

test('simple history stream', async function (t) {
  const store = new Corestore(ram)

  const input1 = store.get({ name: 'input-1' })
  const input2 = store.get({ name: 'input-2' })
  const index1 = store.get({ name: 'index-1' })
  const index2 = store.get({ name: 'index-2' })

  const base1 = new Autobase([input1, input2], {
    input: input1,
    index: index1
  })
  const base2 = new Autobase([input1, input2], {
    input: input2,
    index: index2
  })

  const bee1 = new Autobee(base1, {
    keyEncoding: 'utf-8',
    valueEncoding: 'utf-8'
  })
  const bee2 = new Autobee(base2, {
    keyEncoding: 'utf-8',
    valueEncoding: 'utf-8'
  })

  await bee1.put('a', '1')
  await bee2.put('a', '2')
  await bee1.put('a', '3')
  await bee2.put('a', '4')

  const expected = [['a', '1'], ['a', '2'], ['a', '3'], ['a', '4']]
  const vals = []
  for await (const node of bee2.createHistoryStream()) { // bee2 sees both records
    vals.push([node.key, node.value])
  }

  t.same(expected.length, vals.length)

  while (vals.length) {
    const node = vals.pop()
    const e = expected.pop()
    t.same(node[0], e[0])
    t.same(node[1], e[1])
  }

  t.same(expected.length, 0)
  t.same(vals.length, 0)

  t.end()
})

test('live history stream', async function (t) {
  const store = new Corestore(ram)

  const input1 = store.get({ name: 'input-1' })
  const input2 = store.get({ name: 'input-2' })
  const index1 = store.get({ name: 'index-1' })
  const index2 = store.get({ name: 'index-2' })

  const base1 = new Autobase([input1, input2], {
    input: input1,
    index: index1
  })
  const base2 = new Autobase([input1, input2], {
    input: input2,
    index: index2
  })

  const bee1 = new Autobee(base1, {
    keyEncoding: 'utf-8',
    valueEncoding: 'utf-8'
  })
  const bee2 = new Autobee(base2, {
    keyEncoding: 'utf-8',
    valueEncoding: 'utf-8'
  })

  const historyStream = bee2.createHistoryStream({ live: true })
  const vals = []
  drainHistoryStream(historyStream, vals)

  await bee1.put('a', '1')
  await bee2.put('a', '2')
  await bee1.put('a', '3')
  await bee2.put('a', '4')

  // vals should be fully populated now

  const expected = [['a', '1'], ['a', '2'], ['a', '3'], ['a', '4']]
  t.same(expected.length, vals.length)

  while (vals.length) {
    const node = vals.pop()
    const e = expected.pop()
    t.same(node[0], e[0])
    t.same(node[1], e[1])
  }

  t.same(expected.length, 0)
  t.same(vals.length, 0)

  t.end()

  async function drainHistoryStream (stream, res) {
    for await (const node of stream) {
      res.push([node.key, node.value])
    }
  }
})

test.only('simple sub', async function (t) {
  const store = new Corestore(ram)

  const input1 = store.get({ name: 'input-1' })
  const input2 = store.get({ name: 'input-2' })
  const index1 = store.get({ name: 'index-1' })
  const index2 = store.get({ name: 'index-2' })

  const base1 = new Autobase([input1, input2], {
    input: input1,
    index: index1
  })
  const base2 = new Autobase([input1, input2], {
    input: input2,
    index: index2
  })

  const bee1 = new Autobee(base1, {
    keyEncoding: 'utf-8',
    valueEncoding: 'utf-8'
  })
  const bee2 = new Autobee(base2, {
    keyEncoding: 'utf-8',
    valueEncoding: 'utf-8'
  })

  await bee1.sub('hello').put('a', 'b') // Each Autobase input writes a record
  await bee2.sub('world').put('c', 'd')

  await validateReadStream(t, [['a', 'b']], bee1.sub('hello').createReadStream())
  await validateReadStream(t, [['c', 'd']], bee1.sub('world').createReadStream())
  await validateReadStream(t, [
    [bee1._keyEncoding.decode(bee1.sub('hello')._encodeKey('a')), 'b'],
    [bee1._keyEncoding.decode(bee1.sub('world')._encodeKey('c')), 'd']
  ], bee1.createReadStream())

  t.end()
})

async function validateReadStream (t, expected, stream) {
  const vals = []
  for await (const node of stream) {
    vals.push([node.key, node.value])
  }

  t.same(expected.length, vals.length)

  while (vals.length) {
    const node = vals.pop()
    const e = expected.pop()
    t.same(node[0], e[0])
    t.same(node[1], e[1])
  }

  t.same(expected.length, 0)
  t.same(vals.length, 0)
}
