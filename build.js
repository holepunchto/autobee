const Hyperschema = require('hyperschema')

const schema = Hyperschema.from('./spec/hyperschema', { versioned: false })
const auto = schema.namespace('autobee')

auto.register({
  name: 'system-info',
  fields: [
    {
      name: 'version',
      type: 'uint',
      required: true
    },
    {
      name: 'timestamp',
      type: 'uint',
      required: true
    },
    {
      name: 'flushes',
      type: 'uint',
      required: true
    },
    {
      name: 'view',
      type: '@autobee/link',
      required: true
    },
    {
      name: 'heads',
      type: '@autobee/link',
      array: true,
      required: true
    },
    {
      name: 'indexers',
      type: '@autobee/link',
      array: true // just for compat
    }
  ]
})

auto.register({
  name: 'system-writer',
  fields: [
    {
      name: 'length',
      type: 'uint',
      required: true
    },
    {
      name: 'isIndexer',
      type: 'bool'
    },
    {
      name: 'isRemoved',
      type: 'bool'
    },
    {
      name: 'isOplog',
      type: 'bool'
    }
  ]
})

auto.register({
  name: 'link',
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

auto.register({
  name: 'batch',
  compact: true,
  fields: [
    {
      name: 'start',
      type: 'uint',
      required: true
    },
    {
      name: 'end',
      type: 'uint',
      required: true
    }
  ]
})

auto.register({
  name: 'views',
  compact: true,
  fields: [
    {
      name: 'system',
      type: '@autobee/link',
      required: true
    },
    {
      name: 'flushes',
      type: 'uint',
      required: true
    },
    {
      name: 'view',
      type: '@autobee/link',
      required: false
    }
  ]
})

auto.register({
  name: 'oplog-message-v0',
  fields: [
    {
      name: 'timestamp',
      type: 'uint',
      required: true
    },
    {
      name: 'links',
      type: '@autobee/link',
      array: true,
      required: true
    },
    {
      name: 'batch',
      type: '@autobee/batch'
    },
    {
      name: 'views',
      type: '@autobee/views',
      inline: true
    },
    {
      name: 'optimistic',
      type: 'bool'
    },
    {
      name: 'value',
      type: 'buffer'
    }
  ]
})

// autobase compat
{
  const autobase = schema.namespace('autobase-compat')

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
}

auto.register({
  name: 'oplog',
  versions: [
    {
      version: 2,
      type: '@autobase-compat/oplog-message-v2'
    },
    {
      version: 4,
      type: '@autobee/oplog-message-v0'
    }
  ]
})

Hyperschema.toDisk(schema)
