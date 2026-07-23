const crypto = require('hypercore-crypto')

const LEGACY_OPLOG_VERSION = 2
const OPLOG_VERSION = 3
const LEGACY_AUTOBASE_VERSION = 2
const AUTOBEE_VERSION = 3

const [NS_WITNESS] = crypto.namespace('autobee-witness', 1)

module.exports = {
  LEGACY_OPLOG_VERSION,
  OPLOG_VERSION,
  LEGACY_AUTOBASE_VERSION,
  AUTOBEE_VERSION,
  NS_WITNESS
}
