const Hyperschema = require('hyperschema')
const path = require('path')

const buildAutobaseSchema = require('./encoding/compat.js')

const DIR = path.join(__dirname, 'encoding')
const SPEC = path.join(DIR, 'spec', 'autobee')

const schema = Hyperschema.from(SPEC, { versioned: false })
const auto = schema.namespace('autobee')

auto.require(path.join(DIR, 'legacy.js'))

buildAutobaseSchema(schema, DIR)

auto.register({
  name: 'system-info-v3',
  fields: [
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
  name: 'system-info',
  versions: [
    {
      version: 1,
      type: '@autobase-compat/info-v1',
      map: 'infoLegacyMap'
    },
    {
      version: 2,
      type: '@autobase-compat/info-v2'
    },
    {
      version: 3,
      type: '@autobee/system-info-v3'
    }
  ]
})

auto.register({
  name: 'system-writer-v4',
  fields: [
    {
      name: 'isRemoved',
      type: 'bool',
      required: true
    },
    {
      name: 'isOplog',
      type: 'bool',
      required: true
    },
    {
      name: 'weight',
      type: 'uint',
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
  name: 'system-writer',
  versions: [
    {
      version: 3, // hack: autobase member max flag is 2, so buffer[0] < 4
      type: '@autobase-compat/member',
      map: 'memberLegacyMap'
    },
    {
      version: 4,
      type: '@autobee/system-writer-v4'
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
  name: 'oplog-message-v3',
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

auto.register({
  name: 'oplog',
  versions: [
    {
      version: 0,
      type: '@autobase-compat/oplog-message-v0'
    },
    {
      version: 1,
      type: '@autobase-compat/oplog-message-v1'
    },
    {
      version: 2,
      type: '@autobase-compat/oplog-message-v2'
    },
    {
      version: 3,
      type: '@autobee/oplog-message-v3'
    }
  ]
})

auto.register({
  name: 'manifest-data',
  compact: false,
  fields: [
    {
      name: 'version',
      type: 'uint',
      required: true
    },
    {
      name: 'legacyBlocks',
      type: 'uint',
      required: false
    },
    {
      name: 'namespace',
      type: 'fixed32',
      required: false
    }
  ]
})

Hyperschema.toDisk(schema, SPEC)
