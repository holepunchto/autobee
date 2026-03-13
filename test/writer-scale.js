const test = require('brittle')
const b4a = require('b4a')
const { create } = require('./helpers')

const COUNTS = [10, 25, 50, 100]
const BASE_TIMEOUT = 90_000

for (const writers of COUNTS) {
  test(`scale - ${writers} writers converges`, async function (t) {
    t.timeout(timeoutFor(writers))

    const started = Date.now()
    const primary = await create(t, { apply })
    const peers = []

    for (let i = 1; i < writers; i++) {
      peers.push(await create(t, primary.key, { apply }))
    }

    t.comment(`created ${writers} autobees in ${Date.now() - started}ms`)

    const stop = replicateStar(primary, peers)

    try {
      const bootstrapStart = Date.now()
      await primary.append(peers.map((peer) => 'add:' + peer.local.id))
      await waitFor(
        async () => allWritable(peers),
        [primary, ...peers],
        timeoutFor(writers),
        'all peers became writable'
      )

      t.comment(`bootstrap sync completed in ${Date.now() - bootstrapStart}ms`)

      const writeStart = Date.now()

      await Promise.all(peers.map((peer) => peer.append('ping')))

      await Promise.all(
        peers.map((peer) =>
          primary.wakeup({
            key: peer.local.key,
            length: peer.local.length
          })
        )
      )

      await waitFor(
        async () => hasAllWriterMarkers(primary, peers),
        [primary, ...peers],
        timeoutFor(writers),
        'primary observed all remote writer markers'
      )

      const stats = await collectStats(primary, peers)
      stats.elapsedMs = Date.now() - started
      stats.fanInMs = Date.now() - writeStart

      // t.comment(JSON.stringify(stats))
      t.comment('JS heap used (MB): ' + stats.heapUsedMb)
      t.comment('Total process memory (RSS MB): ' + stats.rssMb)
      t.comment('Time to convergence (ms): ' + stats.fanInMs)
      t.comment('Total test runtime (ms): ' + stats.elapsedMs)
      t.is(primary.writers.active.size, writers, 'primary tracks every writer core')
      t.pass('primary converged after concurrent writer converges')
    } finally {
      await stop()
    }
  })
}

async function apply(nodes, view, host) {
  const batch = view.write()

  for (const node of nodes) {
    const value = b4a.toString(node.value)

    if (value.startsWith('add:')) {
      await host.addWriter(value.slice(4))
    }

    const writerHex = b4a.toString(node.key, 'hex')
    batch.tryPut(b4a.from('writer/' + writerHex), b4a.from(String(node.length)))
  }

  await batch.flush()
}

function replicateStar(primary, peers) {
  const streams = []

  for (const peer of peers) {
    const s1 = primary.replicate(true)
    const s2 = peer.replicate(false)

    s1.on('error', noop)
    s2.on('error', noop)
    s1.pipe(s2).pipe(s1)

    streams.push(s1, s2)
  }

  return async function stop() {
    await Promise.all(
      streams.map((stream) => {
        return new Promise((resolve) => {
          stream.on('error', noop)
          stream.on('close', resolve)
          stream.destroy()
        })
      })
    )
  }
}

function allWritable(peers) {
  for (const peer of peers) {
    if (!peer.writable) return false
  }

  return true
}

async function hasAllWriterMarkers(primary, peers) {
  for (const peer of peers) {
    const key = b4a.from('writer/' + b4a.toString(peer.local.key, 'hex'))
    const node = await primary.view.get(key)
    if (node === null) return false
    if (Number(b4a.toString(node.value)) < peer.local.length) return false
  }

  return true
}

async function collectStats(primary, peers) {
  const lengths = []

  for (const peer of peers) {
    const info = await primary.system.get(peer.local.key)
    lengths.push({
      writer: peer.local.id,
      localLength: peer.local.length,
      systemLength: info ? info.length : -1
    })
  }

  return {
    writers: peers.length + 1,
    primaryActiveWriters: primary.writers.active.size,
    primaryPendingWriters: primary.writers.pending.length,
    rssMb: globalThis.process ? Math.round(process.memoryUsage().rss / 1024 / 1024) : 'unknown',
    heapUsedMb: globalThis.process
      ? Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
      : 'unknown',
    sample: lengths.slice(0, 5)
  }
}

async function waitFor(predicate, autos, timeout, label) {
  const start = Date.now()
  const sleeps = [10, 20, 40, 80, 120, 200, 300, 500]

  while (Date.now() - start < timeout) {
    if (await predicate()) {
      await flushAll(autos)
      if (await predicate()) return
    }

    await flushAll(autos)
    await new Promise((resolve) => setTimeout(resolve, sleeps.shift() || 750))
  }

  throw new Error(`${label} timed out after ${timeout}ms`)
}

async function flushAll(autos) {
  await Promise.all(autos.map((auto) => auto.flush()))
}

function timeoutFor(writers) {
  return BASE_TIMEOUT + writers * 1_000
}

function noop() {}
