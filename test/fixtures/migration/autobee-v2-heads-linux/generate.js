// node generate.js <autobee checkout at 5504fe9> <out dir>
const path = require('path')
const os = require('os')
const fs = require('fs/promises')
const [root, out] = process.argv.slice(2)
// resolve everything from the checkout so no module is loaded twice
const b4a = require(path.join(root, 'node_modules/b4a'))
const Corestore = require(path.join(root, 'node_modules/corestore'))
const Autobee = require(path.join(root, 'index.js'))
const { replicate, sync } = require(path.join(root, 'test/helpers/index.js'))

const SECRET_KEY = b4a.alloc(32).fill('secret')
const INFO_KEY = b4a.from([0])
const WRITERS = 40
const ROUNDS = 4
const FLUSHES = 3
const PER_FLUSH = 10

function makeApply(record) {
  return async function (batch, view, base) {
    for (const { value } of batch) {
      if (!value) continue
      const data = JSON.parse(b4a.toString(value))
      if (!data || typeof data !== 'object') continue
      if (data.add) await base.addWriter(b4a.from(data.add, 'hex'), { indexer: false })
      for (const puts of data.puts || []) {
        const w = view.write()
        for (const [k, v] of puts) w.tryPut(b4a.from(k), b4a.from(v))
        await w.flush()
        if (record) record.push(await entries(view))
      }
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

async function downloadAll(auto, keys) {
  for (const key of keys) {
    const core = auto.store.get({ key })
    await core.ready()
    await core.download({ start: 0, end: core.length }).done()
    await core.close()
  }
}

async function count(stream) {
  let n = 0
  for await (const data of stream) n++ // eslint-disable-line no-unused-vars
  return n
}

;(async () => {
  await fs.rm(out, { recursive: true, force: true })
  await fs.mkdir(out, { recursive: true })
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'autobee-heads-'))

  const versions = []
  const opts = { encrypted: true, encryptionKey: SECRET_KEY, ackThreshold: Infinity }

  const store = new Corestore(path.join(out, 'a'), { manifestVersion: 2 })
  const a = new Autobee(store, null, { ...opts, apply: makeApply(versions) })
  await a.ready()

  const writers = []
  for (let i = 0; i < WRITERS; i++) {
    const s = new Corestore(path.join(tmp, 'w' + i), { manifestVersion: 2 })
    const w = new Autobee(s, a.key, { ...opts, apply: makeApply(null) })
    await w.ready()
    writers.push(w)
  }

  // system flushes that never touch the view
  for (const w of writers) {
    await a.append(b4a.from(JSON.stringify({ add: b4a.toString(w.local.key, 'hex') })))
  }
  await a.update()

  // several view flushes per applied batch
  for (let round = 0; round < ROUNDS; round++) {
    const puts = []
    for (let f = 0; f < FLUSHES; f++) {
      const chunk = []
      for (let i = 0; i < PER_FLUSH; i++) {
        const n = round * FLUSHES * PER_FLUSH + f * PER_FLUSH + i
        chunk.push(['key' + pad(n), 'val' + round + '-' + f + '-' + i])
      }
      puts.push(chunk)
    }
    await a.append(b4a.from(JSON.stringify({ puts })))
    await a.update()
  }

  let done = replicate(a, ...writers)
  await sync(a, ...writers)
  // the writers append offline below, so they need the full history
  for (const w of writers) {
    await downloadAll(w, [w.system.bee.head().key, w._workingBee.head().key, a.local.key])
  }
  await done()

  // every writer appends offline, so none of their heads link each other
  for (let i = 0; i < WRITERS; i++) {
    await writers[i].append(b4a.from(JSON.stringify({ puts: [[['writer' + pad(i), 'hi']]] })))
    await writers[i].update()
  }

  done = replicate(a, ...writers)
  await sync(a, ...writers)
  await done()
  await a.flush()

  const head = a._workingBee.head()
  const core = store.get({ key: head.key })
  await core.ready()

  const info = await a.system.bee.get(INFO_KEY)

  const meta = {
    generatedFrom: 'autobee main 5504fe9',
    baseKey: b4a.toString(a.key, 'hex'),
    localKey: b4a.toString(a.local.key, 'hex'),
    writers: WRITERS,
    heads: a.system.heads.length,
    infoSize: info.value.byteLength,
    view: {
      key: b4a.toString(head.key, 'hex'),
      length: head.length,
      manifestVersion: core.manifest.version
    },
    systemView: { key: b4a.toString(a.system.view.key, 'hex'), length: a.system.view.length },
    systemChanges: await count(a.system.bee.createChangesStream()),
    viewChanges: await count(a._workingBee.createChangesStream()),
    versions
  }

  await core.close()
  await a.close()
  await store.close()
  for (const w of writers) await w.close()
  await fs.rm(tmp, { recursive: true, force: true })

  await fs.writeFile(path.join(out, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')
  console.log(JSON.stringify({ ...meta, versions: versions.length }, null, 2))
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
