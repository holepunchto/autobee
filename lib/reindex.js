const b4a = require('b4a')
const { ChangesStream } = require('hyperbee2/lib/changes.js')
const { encodeBlock, TYPE_COMPAT } = require('hyperbee2/lib/encoding.js')
const { inflateValue } = require('hyperbee2/lib/inflate.js')

exports.collect = async function collect(
  bee,
  until,
  { head = null, timeout = bee.config.timeout, wait = bee.config.wait, prefetch = 128 } = {}
) {
  const changes = []

  for await (const data of new ChangesStream(bee, { head, timeout, wait, prefetch })) {
    if (await until(data)) break
    changes.push(data)
  }

  return changes
}

exports.Copier = class Copier {
  constructor(bee, { timeout = bee.config.timeout, wait = bee.config.wait } = {}) {
    if (!bee.writable) throw new Error('Not writable')

    this.bee = bee
    this.config = bee.config.options({ timeout, wait })
    this.local = bee.context.getLocalContext()
    this.copied = new Map()
    this.heads = new Map()
    this.blocks = []
    this.base = -1
    this.locked = false
    this.appended = 0
  }

  get key() {
    return this.local.core.key
  }

  get(head) {
    return this.heads.get(headId(head)) || null
  }

  head() {
    return { key: this.key, length: this.local.core.length }
  }

  async append(changes, { rewrite = null } = {}) {
    if (changes.length === 0) return

    if (!this.locked) {
      await this.local.lock.lock()
      this.locked = true

      await this.local.core.ready()
      await this.local.update(this.config)
      this.base = this.local.core.length
    }

    await this._append(changes, rewrite)
  }

  async flush() {
    const { local, blocks } = this

    try {
      if (blocks.length === 0) return

      if (local.changed) {
        local.checkpoint = this.base + blocks.length
        blocks[blocks.length - 1].metadata = local.flush()
      }

      const buffers = new Array(blocks.length)

      for (let i = 0; i < blocks.length; i++) {
        blocks[i].checkpoint = local.checkpoint
        buffers[i] = encodeBlock(blocks[i])
      }

      await local.core.append(buffers)

      this.appended += blocks.length
      this.blocks = []
    } finally {
      this.release()
    }
  }

  release() {
    this.blocks = []
    if (!this.locked) return
    this.locked = false
    this.local.lock.unlock()
  }

  async _append(changes, rewrite) {
    const { bee, config, local, copied, heads, blocks, base } = this

    for (let i = changes.length - 1; i >= 0; i--) {
      const change = changes[i]
      const src = bee.context.getContextByKey(change.head.key)
      const srcHex = b4a.toString(src.core.key, 'hex')
      const batch = change.batch
      const start = base + blocks.length
      const first = change.head.length - batch.length

      for (let j = 0; j < batch.length; j++) copied.set(srcHex + ':' + (first + j), start + j)

      for (let j = 0; j < batch.length; j++) {
        const blk = batch[j]

        if (blk.type === TYPE_COMPAT) throw new Error('Cannot index compat blocks')

        if (blk.tree !== null) {
          for (const t of blk.tree) {
            for (const d of t.keys) await remap(src, d.pointer, blk)
            for (const d of t.children) await remap(src, d.pointer, blk)
          }
        }

        if (blk.cohorts !== null) {
          for (const cohort of blk.cohorts) {
            for (const d of cohort) await remap(src, d.pointer, blk)
          }
        }

        if (blk.keys !== null) {
          for (const k of blk.keys) {
            if (rewrite !== null && (await rewriteValue(src, k))) continue
            await remap(src, k.valuePointer, blk)
          }
        }

        blk.metadata = null
        blk.previous = null

        blocks.push(blk)
      }

      batch[batch.length - 1].previous = await previous(change.tail)

      heads.set(headId(change.head), { key: local.core.key, length: start + batch.length })
    }

    async function rewriteValue(src, k) {
      if (!b4a.equals(k.key, rewrite.key)) return false

      const value = k.valuePointer
        ? await inflateValue(
            { value: null, valuePointer: { ...k.valuePointer, context: src } },
            config
          )
        : k.value

      if (value === null) return false

      const next = await rewrite.map(value)
      if (next === null) return false

      k.value = next
      k.valuePointer = null

      return true
    }

    async function remap(src, p, origin) {
      if (p === null) return

      if (p.core !== 0 && !src.hasCore(p.core)) await src.updateMaybe(config, p.core, origin)

      const key = src.getCoreKey(p.core)
      const seq = copied.get(b4a.toString(key, 'hex') + ':' + p.seq)

      if (seq !== undefined) {
        p.core = 0
        p.seq = seq
        return
      }

      p.core = local.getCoreOffsetLocal(src, p.core)
    }

    async function previous(tail) {
      if (tail === null) return null

      const to = heads.get(headId(tail))
      if (to) return { core: 0, seq: to.length - 1 }

      const core = await local.getCoreOffsetByKey(tail.key, config)
      return { core, seq: tail.length - 1 }
    }
  }
}

function headId(head) {
  return b4a.toString(head.key, 'hex') + ':' + head.length
}
