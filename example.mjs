import Autobee from './index.js'
import Corestore from 'corestore'

const opts = {
  apply(auto, view, batch) {
    for (const node of batch) {
      const data = JSON.parse(node.value)
      // console.log(view.name, data)
      if (data.add) auto.system.addWriter(Buffer.from(data.add, 'hex'))
    }
  }
}

const auto = new Autobee(new Corestore('/tmp/autobee/1'), {
  name: 'a',
  ...opts
})
await auto.ready()

console.log('auto', auto.local.key.toString('hex'))

const other = new Autobee(new Corestore('/tmp/autobee/2'), auto.local.key, {
  name: 'b',
  ...opts
})
await other.ready()

console.log('other', other.local.key.toString('hex'))

console.log()
console.log()
console.log()

for await (const data of other.system.list()) {
  console.log(other.name, data)
}
console.log()
for await (const data of auto.system.list()) {
  console.log(auto.name, data)
}

console.log()
console.log()
console.log()

function repl() {
  const s1 = auto.store.replicate(true)
  const s2 = other.store.replicate(false)

  s1.pipe(s2).pipe(s1)

  s1.on('error', console.error)
  s2.on('error', console.error)

  return async () => {
    s1.destroy()
    s2.destroy()
    await new Promise((resolve) => s1.once('close', resolve))
  }
}

if (true) {
  const stop = repl()

  await other.booting

  await auto.append(JSON.stringify({ hello: 'world2' }))
  await auto.append(JSON.stringify({ add: other.local.key.toString('hex') }))
  await auto.append(JSON.stringify({ add: other.local.key.toString('hex') }))

  console.log('?')

  await auto.append(JSON.stringify({ hello: 'world2' }))
  await auto.append(JSON.stringify({ hello: 'world2' }))
  await auto.append(JSON.stringify({ hello: 'world2' }))
  await auto.append(JSON.stringify({ hello: 'world2' }))
  await auto.append(JSON.stringify({ hello: 'world2' }))
  await auto.append(JSON.stringify({ hello: 'world2' }))
  await auto.append(JSON.stringify({ hello: 'world2' }))
  await auto.append(JSON.stringify({ hello: 'world2' }))
  await auto.append(JSON.stringify({ hello: 'world2' }))
  await auto.append(JSON.stringify({ hello: 'world2' }))
  await auto.append(JSON.stringify({ hello: 'world2' }))
  await auto.append(JSON.stringify({ hello: 'world2' }))
  await auto.append(JSON.stringify({ hello: 'world2' }))
  await auto.append(JSON.stringify({ hello: 'world2' }))
  await auto.append(JSON.stringify({ hello: 'world2' }))
  await auto.append(JSON.stringify({ hello: 'world2' }))
  await auto.append(JSON.stringify({ hello: 'world2' }))
  await auto.append(JSON.stringify({ hello: 'world2' }))
  await auto.append(JSON.stringify({ hello: 'world2' }))

  await other._bump()
  await auto._bump()

  await stop()

  console.log()
  console.log()
  console.log()
  console.log()
  console.log('here...')
  console.log()
  console.log()
  console.log()
  console.log()

  console.log('auto', auto.local.key.toString('hex'))
  console.log('other', other.local.key.toString('hex'))

  console.log()
  console.log()
  console.log()
  console.log()

  await auto.append('{"name":"auto"}')
  await other.append('{"name":"other"}')

  repl()

  await other._bump()
  await auto._bump()

  await new Promise((r) => setTimeout(r, 2000))
  console.log('DONE')

  global.debug = true
  console.log(await other.writers.get(auto.key.toString('hex')).next(other.system))

  for await (const data of other.system.list()) {
    console.log(other.name, data)
  }
  console.log(other.name, 'view', other.system.view)
  console.log(other.name, 'heads', other.system.heads)
  console.log()
  for await (const data of auto.system.list()) {
    console.log(auto.name, data)
  }
  console.log(auto.name, 'view', auto.system.view)
  console.log(auto.name, 'heads', auto.system.heads)
  console.log()
}
