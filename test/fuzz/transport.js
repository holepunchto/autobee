// Two interchangeable transports - model.js talks to `state.transport`,
// never to a concrete network layer, so either works underneath the same
// action set.
//
// Real transport: today's corestore/hypercore replication over real
// in-process duplex pairs, convergence checked by polling with a real
// setTimeout backoff (test/helpers' replicate()/sync()).

const b4a = require('b4a')
const { Network } = require('replication-simulator')
const { makeRng, withTimeout } = require('./util.js')
const { replicate, sync } = require('../helpers')

exports.createRealTransport = createRealTransport
exports.createSimTransport = createSimTransport

// private to each trial's own Network instance - no cross-trial namespace
// to collide in, so a fixed topic is fine
const TOPIC = b4a.alloc(32, 0x42)

// Streams stay up for the whole trial. Connecting inside fullSync/pairSync
// and destroying every stream afterwards left each peer with ZERO peers
// between sync windows, so a drain read for a block the peer did not already
// hold had no possible source: a hypercore get() with no peers and no timeout
// neither settles nor keeps the event loop alive, so node exited 0 SILENTLY
// mid-trial. That is also not what a partition is - a real partition leaves a
// pending request against an open connection. To model staleness, withhold
// delivery (cork / stop pumping), never tear the connection down.
function createRealTransport() {
  const attached = []
  const teardowns = []

  return {
    async attach(auto) {
      for (const other of attached) teardowns.push(replicate(auto, other))
      attached.push(auto)
    },

    async fullSync(autos, { timeoutMs }) {
      await withTimeout(
        sync(...autos),
        timeoutMs,
        `sync() did not converge within ${timeoutMs}ms - a writer is likely stranded (granted by no one, never removed)`
      )
    },

    async pairSync(a, b, { timeoutMs }) {
      await withTimeout(sync(a, b), timeoutMs, `pair sync did not converge within ${timeoutMs}ms`)
    },

    async destroy() {
      for (const done of teardowns.splice(0)) {
        try {
          await done()
        } catch {}
      }
      attached.length = 0
    }
  }
}

function createSimTransport(seed) {
  const netRng = makeRng((seed ^ 0x9e3779b9) >>> 0)
  const network = new Network({ rng: () => netRng.float() })

  let pump = null
  let pumping = false

  // the simulator is a PASSIVE scheduler: nothing is delivered unless someone
  // drives tick/run/flush. without this nothing moves outside a sync window,
  // so a drain read for a block the peer does not hold can never be served -
  // the same shape as the real transport destroying its streams. NOT unref'd
  // on purpose: it also keeps the event loop alive.
  function startPump() {
    if (pump) return
    pump = setInterval(() => {
      if (pumping) return
      pumping = true
      Promise.resolve(network.run(1))
        .catch(() => {})
        .then(() => {
          pumping = false
        })
    }, 5)
  }

  return {
    async attach(auto) {
      const swarm = network.swarm()
      swarm.on('connection', (conn) => auto.replicate(conn))
      swarm.join(TOPIC)
      await network.flush()
      startPump()
    },

    async fullSync(autos, { timeoutMs }) {
      await withTimeout(
        waitForConvergence(network, () => allAgree(autos)),
        timeoutMs,
        `sim network did not converge within ${timeoutMs}ms - a writer is likely stranded (granted by no one, never removed)`
      )
    },

    // bounded partial delivery rather than full quiescence: advances the
    // scheduler a small random number of rounds, so some but not
    // necessarily all pending traffic (including third parties') gets
    // delivered - the sim-native analog of the old pairSync's "uneven
    // propagation" stress. Full link isolation via corking every other
    // connection is possible too, but partial-tick delivery already
    // produces staggered knowledge without per-pair connection bookkeeping.
    async pairSync(a, b, { timeoutMs }) {
      const rounds = 3 + Math.floor(netRng.float() * 12)
      await network.run(rounds)
      await withTimeout(
        waitForConvergence(network, () => agreePair(a, b)),
        timeoutMs,
        `sim pair sync did not converge within ${timeoutMs}ms`
      )
    },

    async destroy() {
      if (pump) clearInterval(pump)
      pump = null
      await network.destroy()
    }
  }
}

// flush() drains NETWORK messages only - it doesn't wait for whatever
// internal reprocessing delivering them triggers (canApply retries, drain
// re-bumps). loop flush+check; the 20ms yield is a cheap fallback for the
// rare case flush() alone doesn't leave enough room for that reprocessing
// to run before the next check
async function waitForConvergence(network, agree) {
  while (true) {
    await network.flush()
    if (await agree()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
    if (await agree()) return
  }
}

async function allAgree(autos) {
  for (const a of autos) {
    await a.updated()
    for (const b of autos) {
      if (a === b) continue
      await b.updated()
      const info = await b.system.get(a.local.key)
      const length = info ? info.length : 0
      if (length !== a.local.length) return false
    }
  }
  return true
}

async function agreePair(a, b) {
  await a.updated()
  await b.updated()
  const ib = await b.system.get(a.local.key)
  const ia = await a.system.get(b.local.key)
  return (ib ? ib.length : 0) === a.local.length && (ia ? ia.length : 0) === b.local.length
}
