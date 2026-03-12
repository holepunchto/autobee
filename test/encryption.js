const c = require('compact-encoding')
const sodium = require('sodium-universal')
const b4a = require('b4a')
const { Oplog } = require('../lib/encoding')

const key = b4a.from('384c8c0d1483fd8d81f3f0a0831b5c00d5566da5f480c0c06a4281b55dab0ca1', 'hex')
const legacy = b4a.from(
  '0185f3e80000000055378ef9e68d6732f95b5e20e146f9a522a0c5c99069b4e59b6ea13ca6db1df61626b6b1520d2385aee8f9605a9ed260df4b50862eef140e69010057eb39da419960fb18564187fb4e5ebbde57896f1d5fc6e486b91cea4907fa9208e103643c5422d6cc753c9a89968e88e7d0a2776c99ed993a3997f97d49dea1c66d305f3bf86fad8d17be161858ed58a3f81b14ff6662d765fe2aa3852db4a552d714fc465da7478fa7e44c0f7fa4528fe188682c38639a523cc8bcc28cea92c36d8cc26e7f8dba402ba49451c431c54a98becfff3feef20b9c69486e4bba1f91ab8332380a0e33593481fc1a729e77dc6bc76a33a6c0a58484a165c6b85f4f42935bbbae6cf6a3d0766333efd97e8c180f75a8d03af9371e60f8e478a2ebecbfdfd2d7878dc50244929df34e7f70e3ba94639525156c71e05bda9d6eba116d0116138714cb016cae20e87ed25a30bc145676bf586becb7cdbc495be500769faa6a142049353c314fb15b124627675c62c3d36ef07469f50a2a03491eae36919cd79910800def7788b8380a83b01679cabbaa3c31ae487d71e162fdd2601d1a77c6245c828ec93e6c8e897099b2ef738b93d9237a2d2ae3a5a7fe7b49e41d41d829afc98dfc3fb497d5ab584b0c2ec2cbc9611eed8d505bd2b5d38c71f05734a7588be67057bb6cdd02bc5842aec922bcbb374323786ca62c86460559fcb5fd7cfccd4aa4cfbcea086a26841b16ea19ef820b064fc6e93adb58462522a7655e73a51baf828cd972fc495f6029c30777abe9bad75ff202bcddc314b5cdd52308f520c93b861a8d1bb414493e44cc022c0559638478fc4c8910722ceebbcc8bd203dbd564478d59e15c2f3c70f01b8d8fc40c5acb932816090883c92eb4405e81eb672d4ada269bcc7d3ffe0894035e9ffe5bae83ace998a7835205d3f2',
  'hex'
)

const PADDING = 8
const nonce = b4a.alloc(sodium.crypto_stream_NONCEBYTES)

const decryptBlock = async (block) => {
  const padding = block.subarray(0, PADDING)
  block = block.subarray(PADDING)
  console.log(padding)

  const type = padding[0]
  switch (type) {
    case 0:
      return block // unencrypted

    case 1:
      break

    default:
      throw new Error('Unrecognised encryption type: ' + type)
  }

  const id = c.uint32.decode({ start: 4, end: 8, buffer: padding })

  c.uint64.encode({ start: 0, end: 8, buffer: nonce }, 0)
  nonce.set(padding, 8, 16)

  // Decrypt the block using the full nonce
  decrypt(block, nonce, key)

  return block
}

function encrypt(block, nonce, key) {
  sodium.crypto_stream_xor(block, block, nonce, key)
}

function decrypt(block, nonce, key) {
  return encrypt(block, nonce, key) // symmetric
}

decryptBlock(legacy).then((buf) => {
  const m = c.decode(Oplog, buf)
  console.log(m)
})
