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
  name: 'oplog',
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
      name: 'value',
      type: 'buffer'
    }
  ]
})

Hyperschema.toDisk(schema)
