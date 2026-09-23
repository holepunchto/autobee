const path = require('path')
const fs = require('fs/promises')
const [root, out] = process.argv.slice(2)
const b4a = require('b4a')
const Corestore = require('corestore')
const Autobee = require(path.join(root, 'index.js'))

const SRC = path.join(root, 'test/fixtures/migration/autobase-v7.28.1-linux/a')
const BASE_KEY = b4a.from('7f22e8f8460095e563eb47a71843a6be852bd8c800d27904eef26068149b921a', 'hex')
const SECRET_KEY = b4a.alloc(32).fill('secret')
const ROUNDS = 6
const PER_ROUND = 30

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

;(async () => {
  await fs.rm(out, { recursive: true, force: true })
  await fs.mkdir(out, { recursive: true })
  await fs.cp(SRC, path.join(out, 'a'), { recursive: true })

  const store = new Corestore(path.join(out, 'a'), { allowBackup: true, manifestVersion: 2 })
  const auto = new Autobee(store, BASE_KEY, {
    apply,
    migrate: async () => {},
    legacyViews: ['not-a-view'],
    encrypted: true,
    encryptionKey: SECRET_KEY
  })

  await auto.ready()
  await auto.flush()

  if (auto.system.view.length !== 0) throw new Error('expected an empty migrated view')

  const versions = []

  for (let round = 0; round < ROUNDS; round++) {
    const puts = []
    const dels = []
    for (let i = 0; i < PER_ROUND; i++) {
      puts.push(['key' + pad(round * 20 + i), 'val' + round + '-' + i])
    }
    if (round > 0) {
      for (let i = 0; i < 10; i++) dels.push('key' + pad((round - 1) * 20 + i * 2))
    }
    await auto.append(b4a.from(JSON.stringify({ puts, dels })))
    await auto.update()
    versions.push(await entries(auto.view))
  }

  await auto.flush()

  const head = auto._workingBee.head()
  const core = store.get({ key: head.key })
  await core.ready()
  const cores = await auto._workingBee.cores()

  const meta = {
    generatedFrom: 'autobee main 5504fe9 + autobase-v7.28.1-linux/a',
    baseKey: b4a.toString(BASE_KEY, 'hex'),
    localKey: b4a.toString(auto.local.key, 'hex'),
    view: { key: b4a.toString(head.key, 'hex'), length: head.length, manifestVersion: core.manifest.version },
    viewCores: cores.length,
    systemView: { key: b4a.toString(auto.system.view.key, 'hex'), length: auto.system.view.length },
    rounds: ROUNDS,
    versions
  }

  await core.close()
  await auto.close()
  await store.close()

  await fs.writeFile(path.join(out, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')
  console.log(JSON.stringify({ ...meta, versions: versions.map((v) => v.length) }, null, 2))
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
