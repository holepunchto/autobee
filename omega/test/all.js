const test = require('tape')
const ram = require('random-access-memory')
const sodium = require('sodium-universal')
const Corestore = require('corestore')

const dht = require('@hyperswarm/dht')
const hyperswarm = require('hyperswarm')

const ImmutableStore = require('../../immutable-store')
const Omega = require('..')

test('bootstrapping flow', async t => {
  const { destroy, bootstrap } = await createTestDHT()
  const corestore1 = new Corestore(ram)
  const corestore2 = new Corestore(ram)
  const im1 = new ImmutableStore()
  const im2 = new ImmutableStore()

  const swarm1 = hyperswarm({ bootstrap })
  const swarm2 = hyperswarm({ bootstrap })
  swarm1.on('connection', (socket, info) => {
    console.log('swarm 1 got connection')
    const stream = corestore1.replicate(!!info.peer)
    im1.register(stream)
    socket.pipe(stream).pipe(socket)
  })
  swarm2.on('connection', (socket, info) => {
    console.log('swarm 2 got connection')
    const stream = corestore2.replicate(!!info.peer)
    im2.register(stream)
    socket.pipe(stream).pipe(socket)
  })

  // The first user is created, and their ID is stored in the immutable store
  const user1 = await Omega.createUser(corestore1)
  const userId1 = await im1.put(user1.encode())

  // The first user exchanges their ID with the second user through a separate channel.
  // Both users swarm around the hashed user ID
  swarm2.join(hash(userId1), { announce: true, lookup: true })
  // The first user, having received the Omega ID, joins the swarm.
  swarm1.join(hash(userId1), { announce: true, lookup: true })

  await new Promise(resolve => setImmediate(resolve))

  // The second user creates an Omega containing user1 (loaded from the immutable store) and a new local user
  const omega2 = await Omega.create(corestore2, [
    await Omega.createUser(corestore2),
    await im2.get(userId1)
  ])

  // The second user inserts the manifest ID into the immutable store, and shares the hash with the first user.
  const omegaId = await im2.put(omega2.manifest.encode())
  // Both users also swarm around the hashed Omega ID
  swarm2.join(hash(omegaId), { announce: true, lookup: true })
  // The first user, having received the Omega ID, joins the swarm.
  swarm1.join(hash(omegaId), { announce: true, lookup: true })

  // The first user loads the encoded Manifest from the immutable store, and creates an Omega.
  const omega1 = await Omega.create(corestore1, await im1.get(omegaId))

  // Bootstrapping complete!

  await omega1.input.append(Buffer.from('hello'))
  await omega2.input.append(Buffer.from('world'))

  console.log('omega2 block 1:', await omega2.output.get(1))

  await destroy()
  t.end()
})

async function createTestDHT () {
  const node = dht({ bootstrap: false })
  const isListening = new Promise(resolve => node.once('listening', resolve))
  node.listen()
  await isListening
  return {
    destroy: () => {
      const destroyProm = new Promise(resolve => node.once('close', resolve))
      node.destroy()
      return destroyProm
    },
    bootstrap: [`localhost:${node.address().port}`]
  }
}

function hash (buf) {
  const digest = Buffer.allocUnsafe(32)
  sodium.crypto_generichash(digest, buf)
  return digest
}
