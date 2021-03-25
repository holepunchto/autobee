const c = require('compact-encoding')

const Op = {
  Type: {
    Put: 1,
    Del: 2
  },

  preencode (state, op) {
    if (!op.type) throw new Error('Op must include a type field')
    c.uint.preencode(state, op.type)
    switch (op.type) {
      case Op.Type.Put:
        c.buffer.preencode(state, op.key)
        c.buffer.preencode(state, op.value)
        break
      case Op.Type.Del:
        c.buffer.preencode(state, op.key)
        break
      default:
        throw new Error('Unsupported operation type')
    }
    c.uint.preencode(state, op.batch || 0)
  },

  encode (state, op) {
    if (!op.type) throw new Error('Op must include a type field')
    c.uint.encode(state, op.type)
    switch (op.type) {
      case Op.Type.Put:
        c.buffer.encode(state, op.key)
        c.buffer.encode(state, op.value)
        break
      case Op.Type.Del:
        c.buffer.encode(state, op.key)
        break
      default:
        throw new Error('Unsupported operation type')
    }
    c.uint.encode(state, op.batch || 0)
  },

  decode (state) {
    const msg = {}
    msg.type = c.uint.decode(state)
    if (!msg.type) throw new Error('Op does not have a valid type')
    switch (msg.type) {
      case Op.Type.Put:
        msg.key = c.buffer.decode(state)
        msg.value = c.buffer.decode(state)
        break
      case Op.Type.Del:
        msg.key = c.buffer.decode(state)
        break
      default:
        throw new Error('Unsupported operation type')
    }
    msg.batch = c.uint.decode(state)
    return msg
  },

  fullEncode (op) {
    const state = c.state()
    Op.preencode(state, op)
    state.buffer = Buffer.allocUnsafe(state.end)
    Op.encode(state, op)
    return state.buffer
  },

  fullDecode (buf) {
    const state = { start: 0, end: buf.length, buffer: buf }
    return Op.decode(state)
  }
}

module.exports = {
  Op
}
