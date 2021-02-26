const test = require('tape')
const ram = require('random-access-memory')
const Corestore = require('corestore')

const Autobee = require('..')

test('simple single-writer', async t => {
  const store = new Corestore(ram)
  const bee = await Autobee.create(store, {
    keyEncoding: 'utf-8',
    valueEncoding: 'utf-8'
  })

  const b = bee.input.batch()
  await b.put('a', 'b')
  await b.put('c', 'd')
  await b.flush()

  await bee.refresh()

  const buf = []
  for await (const { key, value } of bee.output.createReadStream()) {
    buf.push([key, value])
  }

  t.same(buf, [['a', 'b'], ['c', 'd']])
  t.end()
})

test('simple multi-writer', async t => {
  const store = new Corestore(ram)

  const bee1 = await Autobee.create(store.namespace('bee1'), {
    keyEncoding: 'utf-8',
    valueEncoding: 'utf-8'
  })
  const bee2 = await Autobee.join(store.namespace('bee2'), bee1, {
    keyEncoding: 'utf-8',
    valueEncoding: 'utf-8'
  })

  await bee1.input.put('a', 'b')
  await bee2.input.put('c', 'd')
  await bee2.refresh()

  const buf = []
  for await (const { key, value } of bee2.output.createReadStream()) {
    buf.push([key, value])
  }

  t.same(buf, [['a', 'b'], ['c', 'd']])

  t.end()
})
