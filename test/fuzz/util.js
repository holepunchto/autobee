const fs = require('fs')
const os = require('os')
const path = require('path')

exports.makeRunRoot = makeRunRoot
exports.makeTrialDir = makeTrialDir
exports.writerStorageFactory = writerStorageFactory
exports.gcTrial = gcTrial
exports.withTimeout = withTimeout
exports.makeRng = makeRng
exports.weightedPick = weightedPick

function makeRunRoot() {
  const base = process.env.TMPDIR || os.tmpdir()
  return fs.mkdtempSync(path.join(base, 'autobee-fuzz-'))
}

function makeTrialDir(runRoot, trial) {
  const dir = path.join(runRoot, `trial-${trial}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function writerStorageFactory(trialDir) {
  let n = 0
  return () => {
    const dir = path.join(trialDir, `w${n++}`)
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }
}

function gcTrial(trialDir) {
  fs.rmSync(trialDir, { recursive: true, force: true, maxRetries: 3 })
}

function withTimeout(promise, ms, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeRng(seed) {
  const next = mulberry32(seed)
  return {
    seed,
    float: () => next(),
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1))
    },
    pick(arr) {
      return arr[this.int(0, arr.length - 1)]
    },
    bool(p = 0.5) {
      return next() < p
    }
  }
}

function weightedPick(rng, options) {
  const total = options.reduce((sum, o) => sum + o.weight, 0)
  let r = rng.float() * total
  for (const o of options) {
    r -= o.weight
    if (r <= 0) return o
  }
  return options[options.length - 1]
}
