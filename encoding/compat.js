const path = require('path')

module.exports = function buildAutobaseSchema(schema, DIR) {
  const autobase = schema.namespace('autobase-compat')

  autobase.require(path.join(DIR, 'legacy.js'))

  autobase.register({
    name: 'checkout',
    compact: true,
    fields: [
      {
        name: 'key',
        type: 'fixed32',
        required: true
      },
      {
        name: 'length',
        type: 'uint',
        required: true
      }
    ]
  })

  autobase.register({
    name: 'clock',
    array: true,
    compact: true,
    type: '@autobase-compat/checkout'
  })

  autobase.register({
    name: 'index-checkpoint',
    compact: true,
    fields: [
      {
        name: 'signature',
        type: 'fixed64',
        required: true
      },
      {
        name: 'length',
        type: 'uint',
        required: true
      }
    ]
  })

  autobase.register({
    name: 'boot-record-v0',
    external: 'BootRecordV0'
  })

  autobase.register({
    name: 'boot-record-raw',
    fields: [
      {
        name: 'key',
        type: 'fixed32',
        required: true
      },
      {
        name: 'systemLength',
        type: 'uint',
        required: true
      },
      {
        name: 'indexersUpdated',
        type: 'bool',
        required: false
      },
      {
        name: 'fastForwarding',
        type: 'bool',
        required: false
      },
      {
        name: 'recoveries',
        type: 'uint',
        required: false
      }
    ]
  })

  autobase.register({
    name: 'boot-record',
    versions: [
      {
        version: 0,
        type: '@autobase-compat/boot-record-v0'
      },
      {
        version: 3,
        type: '@autobase-compat/boot-record-raw'
      }
    ]
  })

  autobase.register({
    name: 'checkpointer',
    compact: true,
    fields: [
      {
        name: 'checkpointer',
        type: 'uint',
        required: false
      },
      {
        name: 'checkpoint',
        type: '@autobase-compat/index-checkpoint',
        required: false
      }
    ]
  })

  autobase.register({
    name: 'checkpoint',
    compact: false,
    fields: [
      {
        name: 'system',
        type: '@autobase-compat/checkpointer',
        required: false
      },
      {
        name: 'encryption',
        type: '@autobase-compat/checkpointer',
        required: false
      },
      {
        name: 'user',
        type: '@autobase-compat/checkpointer',
        array: true,
        required: false
      }
    ]
  })

  autobase.register({
    name: 'digest',
    compact: false,
    fields: [
      {
        name: 'pointer',
        type: 'uint',
        required: false
      },
      {
        name: 'key',
        type: 'fixed32',
        required: false
      }
    ]
  })

  autobase.register({
    name: 'node',
    compact: true,
    fields: [
      {
        name: 'heads',
        type: '@autobase-compat/clock',
        required: true
      },
      {
        name: 'batch',
        type: 'uint',
        required: true
      },
      {
        name: 'value',
        type: 'buffer',
        required: true
      }
    ]
  })

  autobase.register({
    name: 'user-view-trace',
    compact: true,
    fields: [
      {
        name: 'view',
        type: 'uint',
        required: true
      },
      {
        name: 'blocks',
        type: 'uint',
        array: true,
        required: true
      }
    ]
  })

  autobase.register({
    name: 'trace',
    compact: false,
    fields: [
      {
        name: 'system',
        type: 'uint',
        array: true,
        required: true
      },
      {
        name: 'encryption',
        type: 'uint',
        array: true,
        required: true
      },
      {
        name: 'user',
        type: '@autobase-compat/user-view-trace',
        array: true,
        required: true
      }
    ]
  })

  autobase.register({
    name: 'oplog-message-v0',
    external: 'OplogMessageV0'
  })

  autobase.register({
    name: 'oplog-message-v1',
    external: 'OplogMessageV1'
  })

  autobase.register({
    name: 'oplog-message-v2',
    compact: false,
    fields: [
      {
        name: 'node',
        type: '@autobase-compat/node',
        required: true
      },
      {
        name: 'checkpoint',
        type: '@autobase-compat/checkpoint',
        required: false
      },
      {
        name: 'digest',
        type: '@autobase-compat/digest',
        required: false
      },
      {
        name: 'optimistic',
        type: 'bool',
        required: false
      },
      {
        name: 'trace',
        type: '@autobase-compat/trace',
        required: false
      }
    ]
  })

  autobase.register({
    name: 'info-v1',
    fields: [
      {
        name: 'members',
        type: 'uint',
        required: true
      },
      {
        name: 'pendingIndexers',
        type: 'fixed32',
        array: true,
        required: true
      },
      {
        name: 'indexers',
        type: '@autobase-compat/clock',
        required: true
      },
      {
        name: 'heads',
        type: '@autobase-compat/clock',
        required: true
      },
      {
        name: 'views',
        type: '@autobase-compat/clock',
        required: true
      }
    ]
  })

  autobase.register({
    name: 'info-v2',
    fields: [
      {
        name: 'members',
        type: 'uint',
        required: true
      },
      {
        name: 'pendingIndexers',
        type: 'fixed32',
        array: true,
        required: true
      },
      {
        name: 'indexers',
        type: '@autobase-compat/clock',
        required: true
      },
      {
        name: 'heads',
        type: '@autobase-compat/clock',
        required: true
      },
      {
        name: 'views',
        type: '@autobase-compat/clock',
        required: true
      },
      {
        name: 'encryptionLength',
        type: 'uint',
        required: true
      },
      {
        name: 'entropy',
        type: 'fixed32',
        required: false
      }
    ]
  })

  autobase.register({
    name: 'member',
    external: 'SystemWriterV0'
  })
}
