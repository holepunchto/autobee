const test = require('brittle')
const { create, encode } = require('./helpers')

test('close settles while a drain waits on unavailable blocks', async function (t) {
  const auto1 = await create(t)

  for (let i = 0; i < 50; i++) {
    await auto1.append(encode({ value: 'a' + i }))
  }

  // boot a member from auto1's system head without any replication - the
  // first drain fast-forwards towards the head and fetches blocks that can
  // never arrive
  const to = auto1.system.bee.head()
  const auto2 = await create(t, auto1.key, { bootFrom: to })

  auto2.update().catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 200))

  let timer = null
  const started = Date.now()
  const result = await Promise.race([
    auto2.close().then(() => 'closed'),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve('timed out'), 10000)
    })
  ])
  clearTimeout(timer)

  t.is(result, 'closed')
  t.comment('close took ' + (Date.now() - started) + 'ms')
})
