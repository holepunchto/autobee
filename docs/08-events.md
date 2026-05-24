# Events

Autobee extends `EventEmitter`. All standard EventEmitter methods (`on`, `once`, `off`, etc.) are available.

## Event reference

### `ready`

Emitted once when the instance has fully initialized. Equivalent to awaiting `db.ready()`.

```js
db.on('ready', () => {
  console.log('db is ready')
})

// Or just await it:
await db.ready()
```

### `update`

Emitted after each apply cycle that modified the view. This is the primary hook for reacting to new data — update your UI, invalidate a cache, notify subscribers.

```js
db.on('update', () => {
  console.log('view updated')
  refreshUI()
})
```

### `writable`

Emitted when this instance gains write permission — either by being added as a writer through the apply function, or by being the genesis writer.

```js
db.on('writable', () => {
  console.log('can now append operations')
  enableWriteUI()
})
```

### `unwritable`

Emitted when this instance loses write permission — when `host.removeWriter(db.local.key)` is processed by the apply function.

```js
db.on('unwritable', () => {
  console.log('write access revoked')
  disableWriteUI()
})
```

### `interrupt`

Emitted when the apply function calls `host.interrupt(reason)`. The apply cycle is paused. Use the event to fetch whatever external data you need, then call `db.update()` to resume.

```js
db.on('interrupt', async (reason) => {
  console.log('apply interrupted:', reason)
  await fetchExternalData(reason)
  db.update() // resume the apply cycle
})
```

See [Interrupts](09-interrupts.md) for the full pattern.

### `rotate-local-writer`

Emitted when `db.setLocal()` completes and the local writer has been rotated to a new key.

```js
db.on('rotate-local-writer', () => {
  console.log('local writer key has changed')
  console.log('new key:', db.local.id)
})
```

### `error`

Emitted on fatal errors. If unhandled, the process will throw.

```js
db.on('error', (err) => {
  console.error('autobee error:', err)
})
```

### `close`

Emitted when the instance closes.

```js
db.on('close', () => {
  console.log('db closed')
})
```

## Waiting for state changes

For one-time waits, use `once`:

```js
// Wait until writable
await new Promise(resolve => db.once('writable', resolve))

// Or just poll db.writable after update
await db.updated()
if (db.writable) { /* ... */ }
```

---

[← Previous: Replication](07-replication.md) | [Index](../README.md) | [Next: Interrupts →](09-interrupts.md)
