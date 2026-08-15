/**
 * cloud provider 测试。
 *
 * 重点不在「HTTP 请求发对了没」——那是最容易写也最不值钱的部分。
 * 重点在四条一联网才出现、local 下根本不存在的性质：
 *
 *   ① 过审守卫仍然是网络出口前的第一道闸
 *   ② retract 的三态：真删 / 明确没有 / 不知道。超时绝不能当成「没有」
 *   ③ 决定记录不上网（它记的是用户拒绝公开的内容）
 *   ④ 请求体里只有该有的字段，没有夹带原始对话
 *
 * fetch 用替身，不起真服务端：这些性质跟服务端实现无关。
 */

import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context, Service } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'

import * as socialCloud from '../packages/cloud/src/index.ts'
import { asCardId, topicVector, type OpinionCard } from '../packages/core/src/index.ts'

// ── 替身 ────────────────────────────────────────────────────────

/** 内存版 credentials，够存一把设备密钥。 */
class MemoryCredentials extends Service {
  private readonly values = new Map<string, string>()

  constructor(ctx: Context) {
    super(ctx, 'credentials')
  }

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

interface Captured {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: unknown
}

const realFetch = globalThis.fetch
const captured: Captured[] = []
let respond: (c: Captured) => Response | Promise<Response>

function installFetch(): void {
  captured.length = 0
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const c: Captured = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      ),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    captured.push(c)

    // 真实 fetch 在 signal abort 时会 reject（AbortError）。替身必须照做，
    // 否则「超时」这条路径根本走不到，而它正是最需要测的一条。
    const signal = init?.signal
    if (!signal) return respond(c)
    return Promise.race([
      respond(c),
      new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        }, { once: true })
      }),
    ])
  }) as typeof globalThis.fetch
}

afterEach(() => { globalThis.fetch = realFetch })

async function harness(endpoint = 'https://social.example.com') {
  installFetch()
  const dir = await mkdtemp(join(tmpdir(), 'dsh-social-cloud-'))
  const decisionStorePath = join(dir, 'decisions.json')

  const ctx = new Context()
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(socialCloud, { endpoint, decisionStorePath, timeoutMs: 50 })
  return { ctx, decisionStorePath }
}

const approved = (claim: string): OpinionCard => ({
  id: asCardId('00000000-0000-0000-0000-000000000001'),
  claim,
  topicVector: topicVector(claim),
  userApproved: true,
  createdAt: 1,
})

const ok = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// ── 测试 ────────────────────────────────────────────────────────

describe('cloud provider', () => {
  test('★ 红线②：未过审的卡片在发出网络请求之前就被挡下', async () => {
    const { ctx } = await harness()
    respond = () => ok({ cardId: 'x' })
    const card = { ...approved('未过审'), userApproved: false } as unknown as OpinionCard

    await assert.rejects(() => ctx.social.publish(card), /红线|架构/)
    assert.equal(captured.length, 0, '守卫必须在 fetch 之前，一个字节都不能出去')
  })

  test('★ 红线⑤：请求体里只有卡片本身，没有夹带对话', async () => {
    const { ctx } = await harness()
    respond = () => ok({ cardId: 'card-1' })
    await ctx.social.publish(approved('把勤奋当品质来夸是有害的'))

    const req = captured[0]
    assert.ok(req)
    assert.equal(req.method, 'POST')
    assert.match(req.url, /\/v1\/cards$/)
    assert.deepEqual(
      Object.keys(req.body as object).sort(),
      ['claim', 'ephemeralId', 'topicVector'],
      '多一个字段就得问清楚它凭什么离开这台机器',
    )
  })

  test('发布带签名和公钥，签名随内容变化', async () => {
    const { ctx } = await harness()
    respond = () => ok({ cardId: 'card-1' })
    await ctx.social.publish(approved('观点一'))
    await ctx.social.publish({ ...approved('观点二'), claim: '观点二' })

    const [a, b] = captured
    assert.ok(a?.headers['x-social-signature'], '必须带签名，否则服务端无法验证所有权')
    assert.equal(a.headers['x-social-key'], b?.headers['x-social-key'], '同一台机器身份应稳定')
    assert.notEqual(
      a.headers['x-social-signature'],
      b?.headers['x-social-signature'],
      '签名必须绑定内容，否则可以被重放到别的卡片上',
    )
  })

  test('★ retract 三态：204 → true', async () => {
    const { ctx } = await harness()
    respond = () => new Response(null, { status: 204 })
    assert.equal(await ctx.social.retract(asCardId('card-1')), true)
  })

  test('★ retract 三态：404 → false（服务端明确说没有）', async () => {
    const { ctx } = await harness()
    respond = () => new Response(null, { status: 404 })
    assert.equal(await ctx.social.retract(asCardId('card-1')), false)
  })

  test('★ retract 三态：超时必须抛错，绝不能返回 false', async () => {
    const { ctx } = await harness()
    respond = () => new Promise<Response>(() => {})  // 永不 resolve

    // false 的含义是「本来就不存在」。把「不知道删没删」说成「不存在」，
    // 用户会以为东西已经没了，不会再删第二次——和之前修掉的那个撒谎 bug 同类。
    await assert.rejects(
      () => ctx.social.retract(asCardId('card-1')),
      /超时/,
    )
  })

  test('5xx 抛错而不是静默当成失败', async () => {
    const { ctx } = await harness()
    respond = () => new Response('boom', { status: 503 })
    await assert.rejects(() => ctx.social.publish(approved('观点')), /503/)
  })

  test('★ 决定记录只落本地，不发网络', async () => {
    const { ctx, decisionStorePath } = await harness()
    respond = () => ok({ cardId: 'card-1' })

    await ctx.social.recordDecision({
      draftId: 'd1' as never,
      decision: 'discarded',
      decidedAt: 1,
    })

    assert.equal(captured.length, 0, '用户丢弃了什么，服务端不需要知道')
    const store = JSON.parse(await readFile(decisionStorePath, 'utf8'))
    assert.equal(store.decisions.length, 1)
    assert.equal((await ctx.social.listDecisions()).length, 1)
  })

  test('relevant 解析返回，脏数据跳过而不是整批丢掉', async () => {
    const { ctx } = await harness()
    respond = () => ok({
      cards: [
        { cardId: 'a', claim: '观点 A', reasoning: '理由' },
        { cardId: 'b' },                        // 缺 claim，跳过
        { claim: '没有 id' },                    // 缺 id，跳过
        { cardId: 'c', claim: '观点 C' },
      ],
    })
    const cards = await ctx.social.relevant(topicVector('远程办公'), 10)
    assert.deepEqual(cards.map(c => String(c.id)), ['a', 'c'])
    assert.equal(cards[0]?.reasoning, '理由')
    assert.equal(cards[1]?.reasoning, undefined, '缺省字段不该变成 undefined 属性')
  })
})
