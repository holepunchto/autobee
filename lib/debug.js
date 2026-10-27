const b4a = require('b4a')

const T0 = Date.now()

function tag(auto) {
  if (!auto) return '?'
  if (auto.debugName) return auto.debugName
  if (auto.local && auto.local.key) return b4a.toString(auto.local.key, 'hex').slice(0, 6)
  return '?'
}

function dbg(auto, ...args) {
  console.error('[dbg]', Date.now() - T0, tag(auto), ...args)
}

dbg.hex = (key) => (key ? b4a.toString(key, 'hex').slice(0, 6) : null)

module.exports = dbg
