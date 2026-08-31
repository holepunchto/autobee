const test = require('brittle')
const b4a = require('b4a')

const Autobee = require('../index.js')
const { create, replicateAndSync, encode, decode, encryptionKey } = require('./helpers')

test('anchor - optimistic node linking an anchor sorts after the anchored node', async function (t) {
  let anchor = null

  async function apply(nodes, view, host) {
    for (const node of nodes) {
      const data = decode(node.value)

      if (data.join) {
        host.addWriter(node.key, { weight: 2 })
      }

      const w = view.write()

      if (data.pending) {
        anchor = await host.createAnchor(node.key, node.length)
        w.tryPut(b4a.from('pending'), b4a.from('1'))
      }

      if (data.resolve) {
        const pending = await view.get(b4a.from('pending'))
        w.tryPut(b4a.from('resolved'), b4a.from(pending ? 'saw-pending' : 'missed-pending'))
      }

      await w.flush()
    }
  }

  const a = await create(t, null, { apply })
  const b = await create(t, a.key, { apply })

  await a.append(encode({ setup: true }))
  await replicateAndSync(a, b)

  // the bootstrap goes away for good before b joins - b admits itself with an
  // optimistic op, so the only attestation for its grant is self-signed and
  // resolveWeight rejects it: b's entire history pins at sort weight 0. this
  // is the recovery situation (the sole prior indexer no longer exists)
  await a.close()

  await b.append(encode({ join: true }), { optimistic: true })
  await b.updated()
  t.ok(b.writable, 'b admitted itself optimistically')

  // b writes the node the anchor pins
  await b.append(encode({ pending: true }))
  await b.updated()

  t.ok(anchor, 'anchor was created during apply')
  t.ok(await b.bee.get(b4a.from('pending')), 'anchored node applied')

  // a response crafted the way self-verifying ops are: an optimistic node in
  // a non-writer core, timestamp 0, causally linked to the anchor only
  const block = Autobee.encodeValue(encode({ resolve: true }), {
    optimistic: true,
    timestamp: 0,
    links: [anchor],
    encrypted: !!encryptionKey
  })

  const core = b.store.get({ name: 'anchor-ordering-response' })
  await core.ready()
  await core.append(block)

  await b.wakeup({ key: core.key, length: 1 })
  await b.update()
  await b.updated()

  const resolved = await b.bee.get(b4a.from('resolved'))
  t.ok(resolved, 'resolve op applied')
  t.is(
    b4a.toString(resolved.value),
    'saw-pending',
    'resolve op sorted after the node its anchor pins'
  )
})
