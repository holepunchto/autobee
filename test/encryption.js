const test = require('brittle')
const b4a = require('b4a')

const { create, replicateAndSync, same, encode, decode } = require('./helpers')

const ENCRYPTION_KEY = b4a.alloc(32).fill('encryption key')

test('encryption', async function (t) {
  const auto = await create(t, { encryptionKey: ENCRYPTION_KEY })

  const val = encode({ hello: 'world' })
  await auto.append(val)

  const node = await auto.view.get(b4a.from('latest'))

  t.unlike(
    await auto.local.get(0, { valueEncoding: null }),
    await auto.local.get(0, { raw: true }),
    'writer encryption set'
  )

  t.unlike(
    await auto.view.core.get(0, { valueEncoding: null }),
    await auto.view.core.get(0, { raw: true }),
    'view encryption set'
  )

  t.alike(node.value, val)
})

test('encryption - replication', async function (t) {
  const auto1 = await create(t, { encryptionKey: ENCRYPTION_KEY })
  const auto2 = await create(t, auto1.key, { encryptionKey: ENCRYPTION_KEY })

  const val = encode({ hello: 'world' })
  await auto1.append(val)

  await replicateAndSync(auto1, auto2)

  t.unlike(
    await auto1.view.core.get(0, { valueEncoding: null }),
    await auto1.view.core.get(0, { raw: true }),
    'writer encryption set'
  )

  t.unlike(
    await auto2.view.core.get(0, { valueEncoding: null }),
    await auto2.view.core.get(0, { raw: true }),
    'view encryption set'
  )

  t.ok(await same(auto1, auto2))
})

// every core an autobee writes, read raw off the store
async function rawCores(auto, anchor) {
  const cores = {
    writer: auto.local,
    system: auto.system.bee.core,
    view: auto.view.core
  }

  if (anchor) cores.anchor = auto.store.get({ key: anchor.key })

  const blocks = {}
  for (const [name, core] of Object.entries(cores)) {
    await core.ready()
    blocks[name] = []
    for (let i = 0; i < core.length; i++) blocks[name].push(await core.get(i, { raw: true }))
  }

  if (anchor) await cores.anchor.close()
  return blocks
}

function leaked(blocks, markers) {
  const found = []
  for (const [name, marker] of Object.entries(markers)) {
    if (blocks.some((block) => b4a.includes(block, marker))) found.push(name)
  }
  return found
}

// an apply that also pins an anchor on request, so the anchor core gets inspected too
function anchoringApply() {
  const state = { anchor: null }

  state.apply = async function (nodes, view, host) {
    for (const node of nodes) {
      const data = decode(node.value)
      const w = view.write()

      if (data.anchor) state.anchor = await host.createAnchor(node.key, node.length)

      w.tryPut(b4a.from('clock'), b4a.from('' + node.length))
      w.tryPut(b4a.from('latest'), node.value)
      w.tryPut(b4a.from('#' + node.length), b4a.from(b4a.toString(node.key, 'hex')))
      await w.flush()
    }
  }

  return state
}

function markersFor(auto, value) {
  return {
    writer: { value, field: b4a.from('hello') },
    view: {
      value,
      clock: b4a.from('clock'),
      latest: b4a.from('latest'),
      writerHex: b4a.from(b4a.toString(auto.local.key, 'hex'))
    },
    system: { writerKey: auto.local.key, viewKey: auto.view.core.key },
    anchor: { writerKey: auto.local.key }
  }
}

test('encryption - unencrypted blocks carry the plaintext (control for the markers)', async function (t) {
  const anchoring = anchoringApply()
  // explicitly unencrypted, so the control still holds under --encrypt-all
  const auto = await create(t, null, {
    apply: anchoring.apply,
    encryptionKey: null,
    encrypted: false
  })

  const value = encode({ hello: 'world' })
  await auto.append(value)
  await auto.append(encode({ anchor: true }))
  await auto.updated()

  t.ok(anchoring.anchor, 'an anchor was created')

  const blocks = await rawCores(auto, anchoring.anchor)
  const markers = markersFor(auto, value)

  for (const name of Object.keys(markers)) {
    t.ok(blocks[name].length > 0, name + ' core has blocks')
    t.alike(
      leaked(blocks[name], markers[name]).sort(),
      Object.keys(markers[name]).sort(),
      name + ' blocks contain every marker when unencrypted'
    )
  }
})

test('encryption - no plaintext in any block of any core', async function (t) {
  const anchoring = anchoringApply()
  const auto = await create(t, null, { apply: anchoring.apply, encryptionKey: ENCRYPTION_KEY })

  const value = encode({ hello: 'world' })
  await auto.append(value)
  await auto.append(encode({ anchor: true }))
  await auto.updated()

  t.ok(anchoring.anchor, 'an anchor was created')
  t.alike(
    (await auto.view.get(b4a.from('latest'))).value,
    encode({ anchor: true }),
    'reads decrypt'
  )

  const blocks = await rawCores(auto, anchoring.anchor)
  const markers = markersFor(auto, value)

  for (const name of Object.keys(markers)) {
    t.ok(blocks[name].length > 0, name + ' core has blocks')
    t.alike(leaked(blocks[name], markers[name]), [], name + ' blocks leak no plaintext')
  }
})
