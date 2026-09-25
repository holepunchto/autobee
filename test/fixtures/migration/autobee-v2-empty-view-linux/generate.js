// node generate.js <autobee checkout at 5504fe9> <out dir>
const path = require('path')
const fs = require('fs/promises')
const [root, out] = process.argv.slice(2)
// resolve everything from the checkout so no module is loaded twice
const b4a = require(path.join(root, 'node_modules/b4a'))
const Corestore = require(path.join(root, 'node_modules/corestore'))
const Autobee = require(path.join(root, 'index.js'))

const SECRET_KEY = b4a.alloc(32).fill('secret')
const INFO_KEY = b4a.from([0])
const WRITERS = 3

// the view is never written, so every system record carries an empty view
async function apply(batch, view, base) {
  for (const { value } of batch) {
    if (!value) continue
    const data = JSON.parse(b4a.toString(value))
    if (data.add) await base.addWriter(b4a.from(data.add, 'hex'), { indexer: false })
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

  const store = new Corestore(path.join(out, 'a'), { manifestVersion: 2 })
  const a = new Autobee(store, null, {
    apply,
    encrypted: true,
    encryptionKey: SECRET_KEY,
    ackThreshold: Infinity
  })
  await a.ready()

  for (let i = 0; i < WRITERS; i++) {
    const key = b4a.toString(b4a.alloc(32).fill(i + 1), 'hex')
    await a.append(b4a.from(JSON.stringify({ add: key })))
  }
  await a.update()
  await a.flush()

  const head = a._workingBee.head()
  const info = await a.system.bee.get(INFO_KEY)

  const meta = {
    generatedFrom: 'autobee main 5504fe9',
    baseKey: b4a.toString(a.key, 'hex'),
    localKey: b4a.toString(a.local.key, 'hex'),
    writers: WRITERS,
    infoSize: info.value.byteLength,
    view: { key: b4a.toString(head.key, 'hex'), length: head.length },
    systemView: { key: b4a.toString(a.system.view.key, 'hex'), length: a.system.view.length },
    systemChanges: await count(a.system.bee.createChangesStream()),
    viewChanges: await count(a._workingBee.createChangesStream())
  }

  await a.close()
  await store.close()

  await fs.writeFile(path.join(out, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')
  console.log(JSON.stringify(meta, null, 2))
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
