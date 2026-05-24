# Custom Views

By default, `db.view` is a raw Hyperbee. The `open` and `update` callbacks let you wrap it in a richer object — adding helper methods, secondary indexes, or a domain-specific API — without changing how Autobee stores data.

## The `open` callback

`open(bee, db)` is called once during initialization. Return whatever object you want `db.view` to be. The `bee` argument is the underlying Hyperbee instance.

```js
const db = new Autobee(store, null, { apply, open, update })

function open (bee, db) {
  // Wrap the raw Hyperbee in a friendlier API
  return {
    bee,
    async get (key) {
      const node = await bee.get(key)
      return node ? JSON.parse(node.value) : null
    },
    createReadStream (opts) {
      return bee.createReadStream(opts)
    }
  }
}
```

Now `db.view.get('key')` returns a parsed object instead of a raw buffer.

## The `update` callback

`update(view, changes)` is called after each apply cycle that modified the view. Use it to react to view changes: notify subscribers, update a cache, emit domain events.

```js
function update (view, changes) {
  // changes.length — number of nodes processed in this cycle
  // Notify any watchers that the view changed
  emitter.emit('change')
}
```

### UpdateChanges

The `changes` object carries metadata about what changed in the most recent apply cycle:

```js
{
  length: Number  // number of nodes processed
}
```

## Example: secondary index

A common pattern is maintaining a secondary index alongside the primary key-value store. Build it in `apply` and expose it through the custom view:

```js
function open (bee, db) {
  return {
    bee,
    byEmail: bee.sub('by-email'),   // a Hyperbee sub-database
    async getByEmail (email) {
      const node = await this.byEmail.get(email)
      if (!node) return null
      return this.bee.get(node.value.toString())
    }
  }
}

async function apply (nodes, view, host) {
  if (host.genesis) { host.addWriter(db.local.key); return }

  for (const node of nodes) {
    const op = JSON.parse(node.value)
    if (op.type === 'putUser') {
      const w = view.write()
      w.tryPut('user/' + op.id, JSON.stringify(op.user))
      // Also write the secondary index
      w.tryPut('by-email/' + op.user.email, op.id)
      await w.flush()
    }
  }
}
```

## The `close` callback

`close(view)` is called when the Autobee closes. Use it to clean up any resources your custom view holds.

```js
async function close (view) {
  await view.someResource.close()
}
```

---

[← Previous: Optimistic Writes](05-optimistic-writes.md) | [Index](../README.md) | [Next: Replication →](07-replication.md)
