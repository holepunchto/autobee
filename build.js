const Hyperschema = require('hyperschema')

const schema = Hyperschema.from('./spec/hyperschema', { versioned: false })
const auto = schema.namespace('autobee')

auto.register({
  name: 'system-info',
  fields: [
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
      name: 'key',
      type: 'fixed32',
      required: true
    },
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
      name: 'view',
      type: '@autobee/link',
      required: true
    }
  ]
})

auto.register({
  name: 'oplog',
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
      name: 'batch',
      type: '@autobee/batch',
      required: true
    },
    {
      name: 'links',
      type: '@autobee/link',
      array: true,
      required: true
    },
    {
      name: 'views',
      type: '@autobee/views'
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

Hyperschema.toDisk(schema)
