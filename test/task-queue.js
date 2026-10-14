const test = require('brittle')
const TaskQueue = require('../lib/task-queue.js')

test('task queue - runs tasks one at a time in call order', async function (t) {
  const queue = new TaskQueue()
  const order = []

  const a = queue.push(async () => {
    order.push('a:start')
    await new Promise((resolve) => setTimeout(resolve, 20))
    order.push('a:end')
    return 'a'
  })
  const b = queue.push(() => {
    order.push('b')
    return 'b'
  })

  t.alike(await Promise.all([a, b]), ['a', 'b'])
  t.alike(order, ['a:start', 'a:end', 'b'])
})

test('task queue - a rejected task does not block the ones after it', async function (t) {
  const queue = new TaskQueue()

  const failed = queue.push(() => Promise.reject(new Error('boom')))
  const next = queue.push(() => 'ok')

  await t.exception(failed, /boom/)
  t.is(await next, 'ok')
})

test('task queue - flush settles once the queue is idle', async function (t) {
  const queue = new TaskQueue()
  let done = false

  queue.push(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
    done = true
  })
  queue.push(() => Promise.reject(new Error('ignored'))).catch(() => {})

  await queue.flush()
  t.ok(done)
})
