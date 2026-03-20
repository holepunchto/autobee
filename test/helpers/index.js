const Autobee = require('../../index.js')
const Corestore = require('corestore')
const b4a = require('b4a')

const argv = typeof global.Bare !== 'undefined' ? global.Bare.argv : process.argv
const encryptionKey = argv.includes('--encrypt-all')
  ? b4a.alloc(32).fill('autobase-encryption-test')
  : undefined

exports.create = create
exports.sync = sync
exports.same = same
exports.replicate = replicate
exports.replicateAndSync = replicateAndSync
exports.apply = apply
exports.encode = encode
exports.decode = decode
exports.dump = dump
exports.encryptionKey = encryptionKey

function encode(val) {
  return b4a.from(JSON.stringify(val))
}

function decode(val) {
  return JSON.parse(b4a.toString(val))
}

async function same(...autos) {
  for (let i = 0; i < autos.length - 1; i++) {
    const a = autos[i]
    const b = autos[i + 1]

    if ((await dump(a)) !== (await dump(b))) {
      return false
    }
  }

  return true
}

async function dump(auto, enc = 'hex') {
  let all = ''
  for await (const data of auto.bee.createReadStream()) {
    all += 'key: ' + b4a.toString(data.key, enc) + '\n'
    all += 'value: ' + b4a.toString(data.value, enc) + '\n'
  }
  return all
}

async function apply(nodes, view, host) {
  for (const node of nodes) {
    const data = decode(node.value)

    if (data.addWriter) {
      host.addWriter(data.addWriter)
    }

    if (data.removeWriter) {
      host.removeWriter(data.removeWriter)
    }

    const oplog = b4a.toString(node.key, 'hex') + '.' + node.length

    const w = view.write()

    w.tryPut(b4a.from('latest'), node.value)
    w.tryPut(b4a.from('oplog/' + oplog), node.value)

    await w.flush()
  }
}

async function create(t, key, opts) {
  if (key && !b4a.isBuffer(key) && typeof key !== 'string') return create(t, null, key)

  // hack, should land in brittle
  if (!t.tick) t.tick = 0

  const storage = (opts && opts.storage) || (await t.tmp())
  const auto = new Autobee(new Corestore(storage), key, {
    encryptionKey,
    name: '#' + t.tick++,
    apply,
    ...opts
  })

  t.teardown(() => auto.close())
  await auto.ready()

  if (!opts || !opts.name) {
    auto.name += '-' + auto.local.id
    auto.system.name = auto.name
  }

  return auto
}

function replicate(...autos) {
  const teardowns = []

  for (let i = 0; i < autos.length - 1; i++) {
    const a = autos[i]
    const b = autos[i + 1]

    const s1 = a.replicate(true)
    const s2 = b.replicate(false)

    s1.pipe(s2).pipe(s1)

    s1.on('error', console.error)
    s2.on('error', console.error)

    teardowns.push(async () => {
      s1.destroy()
      s2.destroy()
      await Promise.all([
        new Promise((resolve) => s1.once('close', resolve)),
        new Promise((resolve) => s2.once('close', resolve))
      ])
    })
  }

  return async () => {
    for (const teardown of teardowns) await teardown()
  }
}

async function sync(...autos) {
  const scale = [10, 10, 20, 30, 40, 50]

  while (true) {
    if (await check()) {
      for (const a of autos) await a.flush()
      if (await check()) return
    }
    await new Promise((resolve) => setTimeout(resolve, scale.shift() || 100))
  }

  async function check() {
    for (const a of autos) {
      for (const b of autos) {
        if (a === b) continue

        const info = await b.system.get(a.local.key)
        if (!info) continue
        if (info.isRemoved) continue
        const length = info.length
        if (length !== a.local.length) return false
      }
    }

    return true
  }
}

async function replicateAndSync(...autos) {
  const done = replicate(...autos)
  await sync(...autos)
  await done()
}
