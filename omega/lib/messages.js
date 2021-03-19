const c = require('compact-encoding')

const User = {
  preencode (state, u) {
    c.buffer.preencode(state, u.output)
    c.bool.preencode(state, !!u.input)
    if (u.input) c.buffer.preencode(state, u.input)
  },
  encode (state, u) {
    c.buffer.encode(state, u.output)
    c.bool.encode(state, !!u.input)
    if (u.input) c.buffer.encode(state, u.input)
  },
  decode (state) {
    const output = c.buffer.decode(state)
    const input = c.bool.decode(state) ? c.buffer.decode(state) : null
    return {
      input,
      output
    }
  },
  fullDecode (buf) {
    const state = { start: 0, end: buf.length, buffer: buf }
    return User.decode(state)
  },
  fullEncode (u) {
    const state = c.state()
    User.preencode(state, u)
    state.buffer = Buffer.alloc(state.end)
    User.encode(state, u)
    return state.buffer
  }
}
const UserArray = c.array(User)

const Manifest = {
  preencode (state, m) {
    UserArray.preencode(state, m.users)
  },
  encode (state, m) {
    // Copied so that the encoder input isn't mutated.
    const sortedUsers = [...m.users].sort(userSort)
    UserArray.encode(state, sortedUsers)
  },
  decode (state) {
    const users = UserArray.decode(state)
    return {
      users
    }
  },
  fullDecode (buf) {
    const state = { start: 0, end: buf.length, buffer: buf }
    return Manifest.decode(state)
  },
  fullEncode (m) {
    const state = c.state()
    Manifest.preencode(state, m)
    state.buffer = Buffer.alloc(state.end)
    Manifest.encode(state, m)
    return state.buffer
  }
}

// Since all Users are required to have unique outputs, we sort on that key.
function userSort (u1, u2) {
  return Buffer.compare(u1.output, u2.output)
}

module.exports = {
  Manifest,
  User
}
