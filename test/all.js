const test = require('tape')
const ram = require('random-access-memory')
const Corestore = require('corestore')

const Autobee = require('..')

test('simple single-writer', async t => {
  const store = new Corestore(ram)

  const input = store.get({ name: 'input1' })
  const output = store.get({ name: 'output1' })
  const manifest = {
    inputs: [input],
    outputs: [output],
    localInput: input,
    localOutput: output
  }

  const bee = new Autobee(store, manifest, {
    keyEncoding: 'utf-8',
    valueEncoding: 'utf-8'
  })
  await bee.ready()

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

  const input1 = store.get({ name: 'input1' })
  const input2 = store.get({ name: 'input2' })
  const output1 = store.get({ name: 'output1' })
  const output2 = store.get({ name: 'output2' })

  const sharedManifest = {
    inputs: [input1, input2],
    outputs: [output1, output2]
  }

  {
    const manifest = {
      ...sharedManifest,
      localInput: input1,
      localOutput: output1
    }
    const bee = new Autobee(store, manifest, {
      keyEncoding: 'utf-8',
      valueEncoding: 'utf-8'
    })
    await bee.ready()
    await bee.input.put('a', 'b')
  }

  {
    const manifest = {
      ...sharedManifest,
      localInput: input2,
      localOutput: output2
    }
    const bee = new Autobee(store, manifest, {
      keyEncoding: 'utf-8',
      valueEncoding: 'utf-8'
    })
    await bee.ready()
    await bee.input.put('c', 'd')
    await bee.refresh()

    const buf = []
    for await (const { key, value } of bee.output.createReadStream()) {
      buf.push([key, value])
    }

    t.same(buf, [['a', 'b'], ['c', 'd']])
  }

  t.end()
})
