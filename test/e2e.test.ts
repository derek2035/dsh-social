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
    const { privateKey } = generateKeyPairSync('ed25519')
    const publicKey = (createPublicKey(privateKey)
      .export({ format: 'der', type: 'spki' }) as Buffer).toString('base64url')

    // 签名是真的，但正文里声称的身份是别人的
    const body = JSON.stringify({
      claim: '冒充别人发的',
      topicVector: topicVector('冒充'),
      ephemeralId: 'someone-elses-key',
    })
    const res = await fetch(`${endpoint}/v1/cards`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-social-key': publicKey,
        'x-social-signature': cryptoSign(null, Buffer.from(body), privateKey).toString('base64url'),
      },
      body,
    })
    assert.equal(res.status, 400)
  })

  test('★ 改了正文的请求验签失败', async () => {
    const { privateKey } = generateKeyPairSync('ed25519')
    const publicKey = (createPublicKey(privateKey)
      .export({ format: 'der', type: 'spki' }) as Buffer).toString('base64url')

    const signed = JSON.stringify({ claim: '原文', topicVector: [1], ephemeralId: publicKey })
    const tampered = JSON.stringify({ claim: '被改过', topicVector: [1], ephemeralId: publicKey })

    const res = await fetch(`${endpoint}/v1/cards`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-social-key': publicKey,
        'x-social-signature': cryptoSign(null, Buffer.from(signed), privateKey).toString('base64url'),
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
})
