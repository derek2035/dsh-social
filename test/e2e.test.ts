/**
 * 端到端：真的 cloud provider ×  真的 HTTP × 真的服务端。
 *
 * cloud.test.ts 用替身 fetch 测客户端，server 那边的验签逻辑没人测。
 * 这个文件把两边接起来跑真实 HTTP —— 客户端签的名服务端验得过，
 * 才说明这套身份方案真的成立。签名/验签这类东西两边各自「自测通过」
 * 但接起来对不上，是最典型的失败方式。
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync, sign as cryptoSign, createPublicKey } from 'node:crypto'

import { Context, Service } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'

import { createSocialServer } from '../server/src/index.ts'
import * as socialCloud from '../packages/cloud/src/index.ts'
import { asCardId, topicVector, type OpinionCard } from '../packages/core/src/index.ts'

class MemoryCredentials extends Service {
  private readonly values = new Map<string, string>()
  constructor(ctx: Context) { super(ctx, 'credentials') }
  async resolve(ref: CredentialRef) {
    const value = this.values.get(String(ref))
    return value === undefined ? undefined : { value, source: 'memory' }
  }
  async set(ref: CredentialRef, value: string) { this.values.set(String(ref), value) }
  async unset(ref: CredentialRef) { this.values.delete(String(ref)) }
  async describe(ref: CredentialRef) {
    return { configured: this.values.has(String(ref)), writable: true }
  }
}

let app: ReturnType<typeof createSocialServer>
let endpoint: string

before(async () => {
  // k=1：单机测试里只有一个发布者，用默认的 5 会让 relevant() 永远返回空
  app = createSocialServer({ kAnonymityThreshold: 1 })
  const port = await app.listen(0)
  endpoint = `http://127.0.0.1:${port}`
})

after(async () => { await app.close() })

/** 每个用例一个独立客户端 = 一台独立设备（各自的密钥）。 */
async function client() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-social-e2e-'))
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(socialCloud, {
    endpoint,
    decisionStorePath: join(dir, 'decisions.json'),
    timeoutMs: 5000,
  })
  return ctx
}

/**
 * 手工构造一个已签名的请求，用来测客户端不会犯但攻击者会犯的错。
 * 签名的拼法必须和 identity.ts 一致：`${timestamp}.${body}`。
 */
function signedFetch(path: string, body: string, opts: {
  method?: string
  key?: { publicKey: string, privateKey: import('node:crypto').KeyObject }
  claimedTimestamp?: string
  signedTimestamp?: string
} = {}) {
  const key = opts.key ?? freshKey()
  const signedAt = opts.signedTimestamp ?? String(Date.now())
  const sent = opts.claimedTimestamp ?? signedAt
  const signature = cryptoSign(
    null,
    Buffer.from(`${signedAt}.${body}`, 'utf8'),
    key.privateKey,
  ).toString('base64url')

  return fetch(`${endpoint}${path}`, {
    method: opts.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      'x-social-key': key.publicKey,
      'x-social-signature': signature,
      'x-social-timestamp': sent,
    },
    body,
  })
}

function freshKey() {
  const { privateKey } = generateKeyPairSync('ed25519')
  const publicKey = (createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' }) as Buffer).toString('base64url')
  return { privateKey, publicKey }
}

const approved = (claim: string): OpinionCard => ({
  id: asCardId('00000000-0000-0000-0000-000000000001'),
  claim,
  topicVector: topicVector(claim),
  userApproved: true,
  createdAt: Date.now(),
})

describe('端到端：客户端签名 ↔ 服务端验签', () => {
  test('发布 → 服务端收下 → 能查到 → 撤回真删', async () => {
    const ctx = await client()
    const id = await ctx.social.publish(approved('把勤奋当品质来夸是有害的，真正拉开差距的是方向'))

    assert.ok(app.store.get(String(id)), '服务端应该存下了')

    const found = await ctx.social.relevant(topicVector('勤奋 方向 差距'), 10)
    assert.ok(found.some(c => String(c.id) === String(id)), '应该能按话题查到')

    assert.equal(await ctx.social.retract(id), true)
    assert.equal(app.store.get(String(id)), undefined, '必须真删，不是打标记')
    assert.equal(await ctx.social.retract(id), false, '删过之后服务端明确说没有')
  })

  test('★ 别人删不掉你的卡（这是契约原本的洞）', async () => {
    const alice = await client()
    const mallory = await client()

    const id = await alice.social.publish(approved('这是 Alice 的观点，别人不该能删掉它'))

    // Mallory 拿得到 cardId —— relevant() 返回的就是它。
    // 只凭 cardId 就能删的话，等于把删除权发给了所有读者。
    await assert.rejects(() => mallory.social.retract(id), /403/)
    assert.ok(app.store.get(String(id)), '卡片必须还在')

    // 本人还是删得掉
    assert.equal(await alice.social.retract(id), true)
  })

  test('★ 服务端不把发布者身份返回给客户端', async () => {
    const ctx = await client()
    await ctx.social.publish(approved('查得到内容，但查不到是谁发的'))

    const res = await fetch(`${endpoint}/v1/cards/relevant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topicVector: topicVector('查得到 内容 是谁'), limit: 10 }),
    })
    const json = await res.json() as { cards: Record<string, unknown>[] }
    assert.ok(json.cards.length > 0)
    for (const card of json.cards) {
      assert.equal(card['publisher'], undefined, '返回发布者公钥等于公开谁发了什么')
      assert.equal(card['topicVector'], undefined, '向量也不该回传')
    }
  })

  test('★ 冒名发布被拒：ephemeralId 必须等于验签公钥', async () => {
    const key = freshKey()
    // 签名是真的，但正文里声称的身份是别人的
    const res = await signedFetch('/v1/cards', JSON.stringify({
      claim: '冒充别人发的',
      topicVector: topicVector('冒充'),
      ephemeralId: 'someone-elses-key',
    }), { key })
    assert.equal(res.status, 400)
  })

  test('★ 改了正文的请求验签失败', async () => {
    const key = freshKey()
    const timestamp = String(Date.now())
    const signed = JSON.stringify({
      claim: '原文', topicVector: topicVector('原文'), ephemeralId: key.publicKey,
    })
    const tampered = JSON.stringify({
      claim: '被改过', topicVector: topicVector('原文'), ephemeralId: key.publicKey,
    })
    const res = await fetch(`${endpoint}/v1/cards`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-social-key': key.publicKey,
        'x-social-timestamp': timestamp,
        'x-social-signature': cryptoSign(
          null, Buffer.from(`${timestamp}.${signed}`), key.privateKey,
        ).toString('base64url'),
      },
      body: tampered,
    })
    assert.equal(res.status, 401)
  })

  test('无签名的请求一律拒绝', async () => {
    const res = await fetch(`${endpoint}/v1/cards`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claim: '裸奔', topicVector: [1], ephemeralId: 'x' }),
    })
    assert.equal(res.status, 401)
  })

  test('★ k-匿名：发布者数量不够时返回空', async () => {
    // 这个用例自己起一个 k=3 的服务端，不动共享的那个
    const strict = createSocialServer({ kAnonymityThreshold: 3 })
    const port = await strict.listen(0)
    try {
      const dir = await mkdtemp(join(tmpdir(), 'dsh-social-k-'))
      const ctx = new Context()
      await ctx.plugin(MemoryCredentials)
      await ctx.plugin(socialCloud, {
        endpoint: `http://127.0.0.1:${port}`,
        decisionStorePath: join(dir, 'd.json'),
      })

      // 同一个人发三张同话题的卡
      for (const claim of ['远程办公对新人不利', '远程办公缺少反馈', '远程办公适合资深的人']) {
        await ctx.social.publish(approved(claim))
      }

      const found = await ctx.social.relevant(topicVector('远程办公 新人'), 10)
      assert.deepEqual(found, [], '一个人发三张卡不该让自己的话题变得可推荐')
    } finally {
      await strict.close()
    }
  })

  test('被封禁的公钥发不出东西', async () => {
    const ctx = await client()
    const id = await ctx.social.publish(approved('封禁前发的一条正常观点内容'))
    const card = app.store.get(String(id))
    assert.ok(card)

    app.store.ban(card.publisher)
    await assert.rejects(() => ctx.social.publish(approved('封禁后还想发的内容')), /403/)
  })

  // ── 这轮补强的部分 ────────────────────────────────────────────

  test('★ 放大模长的查询向量不能绕过相似度阈值', async () => {
    // 用一个独立的服务端，免得被其它用例的卡片干扰
    const own = createSocialServer({ kAnonymityThreshold: 1, similarityFloor: 0.25 })
    const port = await own.listen(0)
    try {
      const dir = await mkdtemp(join(tmpdir(), 'dsh-social-norm-'))
      const ctx = new Context()
      await ctx.plugin(MemoryCredentials)
      await ctx.plugin(socialCloud, {
        endpoint: `http://127.0.0.1:${port}`,
        decisionStorePath: join(dir, 'd.json'),
      })
      await ctx.social.publish(approved('勤奋崇拜是有害的'))

      // 这两段文本的点积约 0.126，低于 0.25 的阈值 —— 正常查询匹配不到。
      // core 的 cosine() 其实是点积（省掉了除以模长），所以把查询向量整体
      // 放大 1000 倍，点积就变成约 126，轻松越过阈值。
      // 服务端不重新归一化的话，攻击者靠放大模长就能把任意弱相关的卡片全捞出来。
      const probe = topicVector('创业和打工的权衡')
      const amplified = probe.map(n => n * 1000)

      const query = async (vec: number[]) => {
        const res = await fetch(`http://127.0.0.1:${port}/v1/cards/relevant`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ topicVector: vec, limit: 50 }),
        })
        return (await res.json() as { cards: unknown[] }).cards
      }

      assert.equal((await query(probe)).length, 0, '正常查询本来就匹配不到')
      assert.equal(
        (await query(amplified)).length,
        0,
        '放大 1000 倍后仍然匹配不到 —— 说明服务端重新归一化了',
      )
    } finally {
      await own.close()
    }
  })

  test('维度不对的向量被拒', async () => {
    const res = await fetch(`${endpoint}/v1/cards/relevant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topicVector: [1, 2, 3], limit: 10 }),
    })
    assert.equal(res.status, 400)
  })

  test('NaN / Infinity 在入口被挡下', async () => {
    for (const bad of [null, 'x']) {
      const vec = new Array(64).fill(0)
      vec[0] = bad
      const res = await fetch(`${endpoint}/v1/cards/relevant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topicVector: vec, limit: 10 }),
      })
      assert.equal(res.status, 400, `${String(bad)} 应该被拒`)
    }
  })

  test('★ 重放同一个签名被拒', async () => {
    const key = freshKey()
    const body = JSON.stringify({
      claim: '这条会被重放一次',
      topicVector: topicVector('这条会被重放一次'),
      ephemeralId: key.publicKey,
    })
    const timestamp = String(Date.now())
    const signature = cryptoSign(
      null, Buffer.from(`${timestamp}.${body}`), key.privateKey,
    ).toString('base64url')
    const headers = {
      'content-type': 'application/json',
      'x-social-key': key.publicKey,
      'x-social-signature': signature,
      'x-social-timestamp': timestamp,
    }

    const first = await fetch(`${endpoint}/v1/cards`, { method: 'POST', headers, body })
    assert.equal(first.status, 200)

    const replay = await fetch(`${endpoint}/v1/cards`, { method: 'POST', headers, body })
    assert.equal(replay.status, 409, '一模一样的请求第二次必须被拒')
  })

  test('★ 时间窗外的请求被拒（即使签名有效）', async () => {
    const old = String(Date.now() - 10 * 60 * 1000)
    const body = JSON.stringify({ claim: '很久以前签的', topicVector: topicVector('旧'), ephemeralId: 'x' })
    const res = await signedFetch('/v1/cards', body, { signedTimestamp: old })
    assert.equal(res.status, 401)
  })

  test('★ 改时间戳给旧请求续期会验签失败', async () => {
    const body = JSON.stringify({ claim: '续期尝试', topicVector: topicVector('续期'), ephemeralId: 'x' })
    // 签名覆盖的是旧时间戳，发出去的是新的 —— 时间戳参与签名就是为了挡这个
    const res = await signedFetch('/v1/cards', body, {
      signedTimestamp: String(Date.now() - 10 * 60 * 1000),
      claimedTimestamp: String(Date.now()),
    })
    assert.equal(res.status, 401)
  })

  test('超长 claim 被拒', async () => {
    const key = freshKey()
    const body = JSON.stringify({
      claim: 'x'.repeat(501),
      topicVector: topicVector('长'),
      ephemeralId: key.publicKey,
    })
    assert.equal((await signedFetch('/v1/cards', body, { key })).status, 400)
  })

  test('★ 写入限流：突发额度用完后返回 429', async () => {
    const limited = createSocialServer({ kAnonymityThreshold: 1, writeBurst: 3, writePerSec: 0 })
    const port = await limited.listen(0)
    try {
      const key = freshKey()
      const statuses: number[] = []
      for (let i = 0; i < 5; i++) {
        const body = JSON.stringify({
          claim: `第 ${i} 条`,
          topicVector: topicVector(`第 ${i} 条`),
          ephemeralId: key.publicKey,
        })
        const timestamp = String(Date.now() + i)
        const res = await fetch(`http://127.0.0.1:${port}/v1/cards`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-social-key': key.publicKey,
            'x-social-timestamp': timestamp,
            'x-social-signature': cryptoSign(
              null, Buffer.from(`${timestamp}.${body}`), key.privateKey,
            ).toString('base64url'),
          },
          body,
        })
        statuses.push(res.status)
      }
      assert.deepEqual(statuses, [200, 200, 200, 429, 429], `实际：${statuses.join(',')}`)
    } finally {
      await limited.close()
    }
  })

  test('★ 持久化：重启后卡片还在', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-social-db-'))
    const dbPath = join(dir, 'social.db')

    const first = createSocialServer({ kAnonymityThreshold: 1, dbPath })
    const p1 = await first.listen(0)
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(socialCloud, {
      endpoint: `http://127.0.0.1:${p1}`,
      decisionStorePath: join(dir, 'd.json'),
    })
    const id = await ctx.social.publish(approved('重启之后这条应该还在'))
    await first.close()

    // 同一个文件重新打开
    const second = createSocialServer({ kAnonymityThreshold: 1, dbPath })
    await second.listen(0)
    try {
      const card = second.store.get(String(id))
      assert.ok(card, '重启后卡片必须还在')
      assert.equal(card.claim, '重启之后这条应该还在')
    } finally {
      await second.close()
    }
  })
})
