const test = require('tape')
const ram = require('random-access-memory')
const sodium = require('sodium-universal')
const Corestore = require('corestore')

const dht = require('@hyperswarm/dht')
const hyperswarm = require('hyperswarm')

const ImmutableStore = require('../../immutable-store')
const Omega = require('..')

test('bootstrapping flow', async t => {
  const { destroy, swarms } = await createTestDHT(2)
  const swarm1 = swarms[0]
  const swarm2 = swarms[1]

  const corestore1 = new Corestore(ram)
  const corestore2 = new Corestore(ram)
  const im1 = new ImmutableStore()
  const im2 = new ImmutableStore()

  const connectedPromise = new Promise(resolve => {
    let c = 0
    swarm1.on('connection', (socket, info) => {
      const stream = corestore1.replicate(!!info.peer)
      im1.register(stream)
      socket.pipe(stream).pipe(socket)
      if (info.peer && ++c === 2) return resolve()
    })
    swarm2.on('connection', (socket, info) => {
      const stream = corestore2.replicate(!!info.peer)
      im2.register(stream)
      socket.pipe(stream).pipe(socket)
      if (info.peer && ++c === 2) return resolve()
    })
  })

  // The first user is created, and their ID is stored in the immutable store
  const firstUser = await Omega.createUser(corestore1)
  const firstUserId = await im1.put(firstUser.encode())

  // The first user exchanges their ID with the second user through a separate channel.
  // Both users swarm around the hashed user ID
  swarm2.join(hash(firstUserId), { announce: true, lookup: true })
  // The first user, having received the Omega ID, joins the swarm.
  swarm1.join(hash(firstUserId), { announce: true, lookup: true })

  await connectedPromise

  // The second user creates an Omega containing user1 (loaded from the immutable store) and a new local user
  const secondUser = await Omega.createUser(corestore2)
  const omega2 = new Omega(corestore2, {
    users: [
      secondUser,
      await im2.get(firstUserId)
    ]
  }, secondUser)
  await omega2.ready()

  // The second user inserts the manifest ID into the immutable store, and shares the hash with the first user.
  const omegaId = await im2.put(omega2.manifest.encode())
  // Both users also swarm around the hashed Omega ID
  swarm2.join(hash(omegaId), { announce: true, lookup: true })
  // The first user, having received the Omega ID, joins the swarm.
  swarm1.join(hash(omegaId), { announce: true, lookup: true })

  // The first user loads the encoded Manifest from the immutable store, and creates an Omega.
  const omega1 = new Omega(corestore1, await im1.get(omegaId), firstUser)
  await omega1.ready()

  // TODO: Fix corestore timeouts so this isn't necessary.
  await new Promise(resolve => setTimeout(resolve, 50))

  // Bootstrapping complete!

  const vals = ['a', 'b', 'c', 'd']
  await omega1.input.append(Buffer.from(vals[0]))
  await omega1.input.append(Buffer.from(vals[1]))
  await omega1.input.append(Buffer.from(vals[2]))
  await omega2.input.append(Buffer.from(vals[3]))

  // omega1 should come second in the causal stream, since it's a longer fork (and there are no links)
  const refreshed = await omega1.refresh()

  for (let i = refreshed.output.length - 1; i >= 1; i--) {
    const indexNode = await refreshed.output.get(i)
    t.same(indexNode.node.value.toString('utf-8'), vals.pop())
  }
  t.same(vals.length, 0)

  await destroy()
  t.end()
})

async function createTestDHT (numSwarms) {
  const node = dht({ bootstrap: false })
  const isListening = new Promise(resolve => node.once('listening', resolve))
  node.listen()
  await isListening

  const bootstrap = [`localhost:${node.address().port}`]
  const swarms = []
  for (let i = 0; i < numSwarms; i++) {
    swarms.push(hyperswarm({ bootstrap }))
  }

  return {
    swarms,
    destroy
  }

  function destroy () {
    const destroyProm = new Promise(resolve => node.once('close', resolve))
    node.destroy()
    return Promise.all([destroyProm, ...swarms.map(s => new Promise(resolve => s.destroy(resolve)))])
  }
}

function hash (buf) {
  const digest = Buffer.allocUnsafe(32)
  sodium.crypto_generichash(digest, buf)
  return digest
}
