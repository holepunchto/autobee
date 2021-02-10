const test = require('tape')
const ram = require('random-access-memory')
const OmegaCore = require('omega')

const Autobee = require('..')

test('simple single-writer', async t => {
  const input = new OmegaCore(ram)
  const output = new OmegaCore(ram)
  const manifest = {
    inputs: [input],
    outputs: [output],
    localInput: input,
    localOutput: output
  }
  const bee = new Autobee(manifest, {
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
  const input1 = new OmegaCore(ram)
  const input2 = new OmegaCore(ram)
  const output1 = new OmegaCore(ram)
  const output2 = new OmegaCore(ram)

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
    const bee = new Autobee(manifest, {
      keyEncoding: 'utf-8',
      valueEncoding: 'utf-8'
    })
    await bee.input.put('a', 'b')
  }

  {
    const manifest = {
      ...sharedManifest,
      localInput: input2,
      localOutput: output2
    }
    const bee = new Autobee(manifest, {
      keyEncoding: 'utf-8',
      valueEncoding: 'utf-8'
    })
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
