const b4a = require('b4a')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const { NS_WITNESS } = require('./constants.js')

exports.currentWeight = currentWeight
exports.resolveWeight = resolveWeight
exports.verifyWitness = verifyWitness
exports.attestationMessage = attestationMessage
exports.signAttestation = signAttestation

// resolved current weight of a writer
function currentWeight(rec) {
  if (!rec) return 0
  if (rec.maxWeight > 0 && rec.isGenesis) return rec.maxWeight
  return rec.weight
}

// resolve witness weight to sort weight according to current system
async function resolveWeight(auto, node) {
  const rec = await auto.system.get(node.key)
  const prev = currentWeight(rec)

  const witness = node.witness
  if (!witness || witness.weight <= prev) return prev

  const limit = rec ? rec.maxWeight : 0
  if (witness.weight > limit) return prev

  // a node never influences its own sort key
  if (b4a.equals(witness.backer.key, node.key)) return prev

  const backer = await auto.system.get(witness.backer.key)
  if (!backer || backer.length < witness.backer.length) return prev

  if (!verifyWitness(node)) return prev

  return Math.max(prev, witness.weight)
}

// a pure function of the node's own bytes - no core session, no store
// lookup, no IO at all, so it returns the same verdict on every peer at
// every point in time, including peers that fast-forwarded past the
// backer's history and never ingested its blocks. the inlined manifest is
// bound to the cited backer key (a v1+ core key is the manifest hash), the
// signer public key read out of it, and the signature checked against that
function verifyWitness(node) {
  const witness = node.witness
  if (!witness || !witness.backer || witness.weight === 0) return false
  if (b4a.equals(witness.backer.key, node.key)) return false

  const publicKey = signerFromRawManifest(witness.backer.key, witness.backer.manifest)
  if (!publicKey) return false

  const message = attestationMessage(
    witness.backer.key,
    node.key,
    witness.backer.length,
    witness.weight
  )
  return crypto.verify(message, witness.backer.signature, publicKey)
}

function signerFromRawManifest(backerKey, raw) {
  if (!raw || !raw.length) return null

  let manifest
  try {
    // throws on malformed bytes AND when the manifest does not match the key
    manifest = Hypercore.parseManifest(raw, backerKey)
  } catch {
    return null
  }

  // single-signer backers only: an attestation is one writer's testimony
  if (!manifest || !manifest.signers || manifest.signers.length !== 1) return null

  return manifest.signers[0].publicKey
}

function attestationMessage(backerKey, key, length, weight) {
  return b4a.concat([
    NS_WITNESS,
    backerKey,
    key,
    c.encode(c.uint, length),
    c.encode(c.uint, weight)
  ])
}

function signAttestation(secretKey, backerKey, key, length, weight) {
  return crypto.sign(attestationMessage(backerKey, key, length, weight), secretKey)
}
