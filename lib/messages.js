const c = require('compact-encoding')

const AutobeeMessageTypes = {
  Put: 1,
  Del: 2
}

const Put = {
  preencode (state, m) {
    c.buffer.preencode(state, m.key)
    c.buffer.preencode(state, m.value)
  },
  encode (state, m) {
    c.buffer.encode(state, m.key)
    c.buffer.encode(state, m.value)
  },
  decode (state) {
    return {
      key: c.buffer.decode(state),
      value: c.buffer.decode(state)
    }
  }
}

const Del = {
  preencode (state, m) {
    c.buffer.preencode(state, m.key)
  },
  encode (state, m) {
    c.buffer.encode(state, m.key)
  },
  decode (state) {
    return {
      key: c.buffer.decode(state)
    }
  }
}

const AutobeeMessage = {
  preencode (state, m) {
    c.uint.preencode(state, m.type)
    const enc = typeToEncoding(m.type)
    enc.preencode(state, m)
  },
  encode (state, m) {
    c.uint.encode(state, m.type)
    const enc = typeToEncoding(m.type)
    enc.encode(state, m)
  },
  decode (state) {
    const type = c.uint.decode(state)
    const enc = typeToEncoding(type)
    return { type, ...enc.decode(state) }
  }
}

module.exports = {
  AutobeeMessage,
  AutobeeMessageTypes
}

function typeToEncoding (type) {
  switch (type) {
    case AutobeeMessageTypes.Put:
      return Put
    case AutobeeMessageTypes.Del:
      return Del
    default:
      throw new Error('Unsupported message type')
  }
}
