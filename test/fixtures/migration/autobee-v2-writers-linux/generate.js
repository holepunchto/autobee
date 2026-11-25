// node generate.js <autobee checkout at 5504fe9> <out dir>
// two writers on the release before the remap, each with a v2 view of its own
const path = require('path')
const fs = require('fs/promises')
const [root, out] = process.argv.slice(2)
// resolve everything from the checkout so no module is loaded twice
const b4a = require(path.join(root, 'node_modules/b4a'))
const Corestore = require(path.join(root, 'node_modules/corestore'))
const Autobee = require(path.join(root, 'index.js'))
const { replicate, sync } = require(path.join(root, 'test/helpers/index.js'))

const SECRET_KEY = b4a.alloc(32).fill('secret')
const ROUNDS = 6
const PER_ROUND = 10

async function apply(batch, view, base) {
  for (const { value } of batch) {
    if (!value) continue
    const data = JSON.parse(b4a.toString(value))
    if (!data || typeof data !== 'object') continue
    if (data.add) await base.addWriter(b4a.from(data.add, 'hex'), { indexer: !!data.indexer })
    if (data.puts || data.dels) {
      const w = view.write()
      for (const [k, v] of data.puts || []) w.tryPut(b4a.from(k), b4a.from(v))
      for (const k of data.dels || []) w.tryDelete(b4a.from(k))
      await w.flush()
    }
  }
}

function pad(n) {
  return String(n).padStart(4, '0')
}

async function entries(bee) {
  const out = []
  for await (const { key, value } of bee.createReadStream()) {
    out.push([b4a.toString(key), b4a.toString(value)])
  }
  return out
}

async function describe(auto, store) {
  const head = auto._workingBee.head()
  const core = store.get({ key: head.key })
  await core.ready()
  const manifestVersion = core.manifest.version
  await core.close()
  return {
    localKey: b4a.toString(auto.local.key, 'hex'),
    localLength: auto.local.length,
    view: { key: b4a.toString(head.key, 'hex'), length: head.length, manifestVersion },
    systemView: { key: b4a.toString(auto.system.view.key, 'hex'), length: auto.system.view.length },
    systemCore: b4a.toString(auto.system.bee.core.key, 'hex')
  }
}

;(async () => {
  await fs.rm(out, { recursive: true, force: true })
  await fs.mkdir(out, { recursive: true })

  const opts = { encrypted: true, encryptionKey: SECRET_KEY, ackThreshold: Infinity, apply }

  const storeA = new Corestore(path.join(out, 'a'), { manifestVersion: 2 })
  const a = new Autobee(storeA, null, opts)
  await a.ready()

  const storeB = new Corestore(path.join(out, 'b'), { manifestVersion: 2 })
  const b = new Autobee(storeB, a.key, opts)
  await b.ready()

  const done = replicate(a, b)

  await a.append(b4a.from(JSON.stringify({ add: b4a.toString(b.local.key, 'hex'), indexer: true })))
  await sync(a, b)

  for (let round = 0; round < ROUNDS; round++) {
    for (const [name, w] of [
      ['a', a],
      ['b', b]
    ]) {
      const puts = []
      for (let i = 0; i < PER_ROUND; i++) {
        puts.push([name + pad(round * PER_ROUND + i), 'val' + round + '-' + i])
      }
      await w.append(b4a.from(JSON.stringify({ puts })))
    }
    await sync(a, b)
  }

  await a.flush()
  await b.flush()
  await sync(a, b)
  await done()

  const versions = { a: await entries(a.view), b: await entries(b.view) }
  if (JSON.stringify(versions.a) !== JSON.stringify(versions.b)) throw new Error('views differ')

  const meta = {
    generatedFrom: 'autobee main 5504fe9',
    baseKey: b4a.toString(a.key, 'hex'),
    rounds: ROUNDS,
    a: await describe(a, storeA),
    b: await describe(b, storeB),
    entries: versions.a
  }

  await a.close()
  await b.close()
  await storeA.close()
  await storeB.close()

  await fs.writeFile(path.join(out, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')
  console.log(JSON.stringify({ ...meta, entries: meta.entries.length }, null, 2))
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
