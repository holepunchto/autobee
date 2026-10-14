const test = require('brittle')
const TaskQueue = require('../lib/task-queue.js')

test('task queue - runs tasks one at a time in call order', async function (t) {
  const queue = new TaskQueue()
  const order = []

  const a = queue.queue(async () => {
    order.push('a:start')
    await new Promise((resolve) => setTimeout(resolve, 20))
    order.push('a:end')
    return 'a'
  })
  const b = queue.queue(() => {
    order.push('b')
    return 'b'
  })

  t.alike(await Promise.all([a, b]), ['a', 'b'])
  t.alike(order, ['a:start', 'a:end', 'b'])
})

test('task queue - a rejected task does not block the ones after it', async function (t) {
  const queue = new TaskQueue()

  const failed = queue.queue(() => Promise.reject(new Error('boom')))
  const next = queue.queue(() => 'ok')

  await t.exception(failed, /boom/)
  t.is(await next, 'ok')
})

test('task queue - flush settles once the queue is idle', async function (t) {
  const queue = new TaskQueue()
  let done = false

  queue.queue(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
    done = true
  })
  queue.queue(() => Promise.reject(new Error('ignored'))).catch(() => {})

  await queue.flush()
  t.ok(done)
})

test('task queue - destroy settles the tasks that have not started without running them', async function (t) {
  const queue = new TaskQueue()
  let ran = 0
  let started = null
  const firstStarted = new Promise((resolve) => {
    started = resolve
  })

  const running = queue.queue(async () => {
    started()
    await new Promise((resolve) => setTimeout(resolve, 20))
    ran++
    return 'running'
  })
  const waiting = queue.queue(() => {
    ran++
    return 'never'
  })

  await firstStarted
  queue.destroy()
  t.ok(queue.destroyed)

  t.is(await waiting, undefined, 'a queued task settles right away')
  t.is(await running, 'running', 'the task already in flight still finishes')
  await queue.flush()
  t.is(ran, 1, 'the queued task never ran')

  t.is(await queue.queue(() => 'late'), undefined, 'nothing runs after destroy')
  t.is(ran, 1)
})
