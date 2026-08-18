const test = require('brittle')
const { create, encode } = require('./helpers')

test('close settles before a parked drain has requested its blocks', async function (t) {
  const auto1 = await create(t)

  for (let i = 0; i < 50; i++) {
    await auto1.append(encode({ value: 'a' + i }))
  }

  const to = auto1.system.bee.head()
  const auto2 = await create(t, auto1.key, { bootFrom: to })

  auto2.update().catch(noop)

  let timer = null
  const result = await Promise.race([
    auto2.close().then(() => 'closed'),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve('timed out'), 10000)
    })
  ])
  clearTimeout(timer)

  t.is(result, 'closed')
})

function noop() {}
