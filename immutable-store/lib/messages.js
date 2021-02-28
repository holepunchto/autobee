const c = require('compact-encoding')

const Request = {
  preencode (state, req) {
    c.buffer.preencode(state, req.discoveryKey)
    c.buffer.preencode(state, req.capability)
  },
  encode (state, req) {
    c.buffer.encode(state, req.discoveryKey)
    c.buffer.encode(state, req.capability)
  },
  decode (state) {
    return {
      discoveryKey: c.buffer.decode(state),
      capability: c.buffer.decode(state)
    }
  }
}

const Response = {
  preencode (state, rsp) {
    c.buffer.preencode(state, rsp.discoveryKey)
    if (rsp.hash) {
      c.bool.preencode(state, 1)
      c.buffer.preencode(state, rsp.hash)
      c.buffer.preencode(state, rsp.value)
    } else {
      c.bool.preencode(state, 0)
    }
  },
  encode (state, rsp) {
    c.buffer.encode(state, rsp.discoveryKey)
    if (rsp.hash) {
      c.bool.encode(state, 1)
      c.buffer.encode(state, rsp.hash)
      c.buffer.encode(state, rsp.value)
    } else {
      c.bool.encode(state, 0)
    }
  },
  decode (state) {
    const discoveryKey = c.buffer.decode(state)
    const hasAnswer = c.bool.decode(state)
    if (!hasAnswer) return { discoveryKey }
    return {
      hash: c.buffer.decode(state),
      value: c.buffer.decode(state),
      discoveryKey
    }
  }
}

const Message = {
  preencode (state, msg) {
    if (msg.request) {
      c.uint.preencode(state, 1)
      Request.preencode(state, msg.request)
    } else if (msg.response) {
      c.uint.preencode(state, 2)
      Response.preencode(state, msg.response)
    }
  },
  encode (state, msg) {
    if (msg.request) {
      c.uint.encode(state, 1)
      Request.encode(state, msg.request)
    } else if (msg.response) {
      c.uint.encode(state, 2)
      Response.encode(state, msg.response)
    }
  },
  decode (state) {
    switch (c.uint.decode(state)) {
      case 1:
        return { request: Request.decode(state) }
      case 2:
        return { response: Response.decode(state) }
      default:
        return null
    }
  }
}

module.exports = {
  Request,
  Response,
  Message
}
