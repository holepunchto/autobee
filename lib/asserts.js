exports.heads = function (heads, node) {
  for (const h of this.heads) {
    if (h.key.equals(node.key)) {
      exports.bail('Same node included twice')
    }
  }
}

exports.systemFlush = function (w) {
  for (const op of w.ops) {
    if (op.applied && op.key[0] === 1) return
  }

  exports.bail('Invalid system batch')
}

exports.assert = function (cond, msg) {
  if (cond) exports.bail(msg)
}

exports.bail = function (msg) {
  const err = new Error('ERR_ASSERTION: ' + msg)
  err.code = 'ERR_ASSERTION'
  throw err
}
