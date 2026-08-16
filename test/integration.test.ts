/**
 * 集成测试：插件 × cordis 的接缝。
 *
 * 为什么单独开一个文件 —— core.test.ts 和 guard.test.ts 测的都是纯函数，
 * 直接 new 实例、直接调函数，一次框架都不碰。而 2026-08-15 真机跑通那天
 * 暴露的五个 bug **全部**在这一层：
 *
 *   1. Service 用 # 私有字段 → 经 cordis 的 Proxy 访问时 brand check 抛错
 *   2. inject 写成 { required, optional } → 插件永远 PENDING，启动失败
 *   3. session/event 监听器签名少一个参数 → 所有事件都落进 default 分支
 *   4. 跨插件靠 (ctx as any) 挂属性传值 → 各插件 ctx 是不同代理，读到 undefined
 *   5. GenerateOptions 缺 provider/model → 运行期才炸
 *
 * 这五个单测一个都没抓到。所以这里的原则是：**用真的 cordis，走真的代理**，
 * 只 stub 掉需要网络或密钥的东西（llm 适配器）。
 *
 * 跑：node --test --experimental-strip-types test/integration.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context, Service } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

import * as socialLocal from '../packages/local/src/index.ts'
import * as socialCommands from '../packages/commands/src/index.ts'
import * as socialCurator from '../packages/curator/src/index.ts'
import { injectTopics } from '../packages/curator/src/inject.ts'
import { asCardId, topicVector, type OpinionCard } from '../packages/core/src/index.ts'

// ── 替身 ────────────────────────────────────────────────────────

/** 记录每次调用的 options，让测试能断言我们真的带上了 provider/model。 */
class FakeLlm extends Service {
  readonly calls: GenerateOptions[] = []
  /** 下一次 stream() 要吐出的正文。格式跟 buildSummaryPrompt 要求的一致：裸 JSON。 */
  reply = JSON.stringify({
    claim: '把勤奋当品质来夸是有害的',
    reasoning: '真正拉开差距的是方向和信息差',
  })

  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: this.reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.reply } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** 只记录注册，不做分派。同时用来守红线①：register 被调到就是违规。 */
class FakeCommands extends Service {
  readonly registered = new Map<string, (input: string) => Promise<unknown>>()

  constructor(ctx: Context) {
    super(ctx, 'commands')
  }

  register(def: {
    name: string
    handler: (invocation: { rawInput: string }) => Promise<unknown>
  }): () => void {
    this.registered.set(def.name, (input: string) => def.handler({ rawInput: input }))
    return () => { this.registered.delete(def.name) }
  }
}

/** 红线①的运行期哨兵：任何 tool 注册都会让测试当场失败。 */
class TripwireTools extends Service {
  registerCalled = false

  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  register(): () => void {
    this.registerCalled = true
    return () => {}
  }
}

// ── 装配 ────────────────────────────────────────────────────────

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-social-it-'))
  const storePath = join(dir, 'store.json')

  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(FakeLlm)
  await ctx.plugin(FakeCommands)
  await ctx.plugin(TripwireTools)

  // 加载顺序刻意和 cordis.yml 一致：provider 先于 consumer
  await ctx.plugin(socialLocal, { storePath, kAnonymityThreshold: 1 })
  await ctx.plugin(socialCurator, { probe: process.env.PROBE === "1" })
  await ctx.plugin(socialCommands)

  return { ctx, storePath, dir }
}

/**
 * 追加一轮「够格提议」的对话正文。
 *
 * user/message 和 assistant/message 是 surface-eligible 事件，append 时必须带
 * surfaceOp 标记，否则 SurfaceManager.validateNext 直接抛错。这是真实框架的约束——
 * 我们的插件只读不写，但测试要造事件就得守。
 */
function appendTurnBody(session: ReturnType<Context['sessions']['create']>): void {
  // 用真实的工厂函数造消息，而不是手写字面量：role / id / source 这些
  // 必填字段由工厂补齐，夹具跟着真实结构走，不会因为漏字段而假绿。
  //
  // source.kind 是 curator 区分真人输入和插件注入上下文的依据
  // （AGENTS.md、skill、cron 通知都走同一个事件）。
  session.append('user/message', createUserMessage({
    source: { kind: 'user' },
    content: [{
      type: 'text',
      text: '我觉得把勤奋当成一种品质来夸是有害的，它容易把成功解释成谁更能熬，'
        + '把失败解释成你还不够努力，从而掩盖了资源、运气、制度和选择质量的影响。'
        + '我倾向于认为，与其夸一个人能吃苦，不如夸他会选择、会复盘。',
    }],
  }), { surfaceOp: 'append' })

  // 注意 assistant 的正文嵌了一层 message —— 和 user/message 的结构不一样
  session.append('assistant/message', {
    turn: 0,
    step: 0,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'x'.repeat(300) }],
      source: { provider: 'test-provider', model: 'test-model' },
    }),
  }, { surfaceOp: 'append' })
}

/**
 * 取回替身实例。
 *
 * ctx.commands / ctx.llm 的静态类型来自 DSH 自己的 declare module，
 * 测试里挂的是替身，所以要显式转一次。这不是在绕类型 ——
 * 断言的对象确实是替身，被测的是我们的插件怎么用这些服务。
 */
const fakeCommands = (ctx: Context): FakeCommands =>
  ctx.get('commands') as unknown as FakeCommands
const fakeLlm = (ctx: Context): FakeLlm => ctx.get('llm') as unknown as FakeLlm

const approved = (claim: string): OpinionCard => ({
  id: asCardId('00000000-0000-0000-0000-000000000001'),
  claim,
  topicVector: topicVector(claim),
  userApproved: true,
  createdAt: 1,
})

// ── 测试 ────────────────────────────────────────────────────────

describe('插件 × cordis 接缝', () => {
  test('三个插件都能激活，ctx.social 就绪', async () => {
    const { ctx } = await harness()
    assert.ok(ctx.social, 'ctx.social 应该由 local provider 提供')
    // 激活失败时 inject 的 consumer 会永远 PENDING —— 回归 bug ②
    // 断言具体命令名而不是数量 —— 加一个命令不该让这条测试挂掉，
    // 但少了任何一个用户动作必须立刻发现
    const names = [...fakeCommands(ctx).registered.keys()].sort()
    for (const required of [
      'social-publish', 'social-discard', 'social-pending',
      'social-retract', 'social-stats',
      'social-join', 'social-leave', 'social-say',
    ]) {
      assert.ok(names.includes(required), `缺少命令 ${required}，实际：${names.join()}`)
    }
  })

  test('经 cordis 代理调用 service 不炸（回归：# 私有字段）', async () => {
    const { ctx, storePath } = await harness()

    // ctx.social 拿到的是代理，不是实例。用 # 私有字段的实现会在这里抛
    // TypeError: Receiver must be an instance of class SocialLocal
    const id = await ctx.social.publish(approved('测试观点'))
    assert.ok(id)

    const store = JSON.parse(await readFile(storePath, 'utf8'))
    assert.equal(store.cards.length, 1, '应该真的落盘了')
  })

  test('未过审的卡片被守卫挡下（红线②，经代理）', async () => {
    const { ctx } = await harness()
    // 刻意构造一个类型系统本该挡住的值：userApproved 的类型是字面量 true。
    // 编译期挡不住的场景（比如从 JSON 反序列化进来）正是守卫存在的理由。
    const card = { ...approved('未过审'), userApproved: false } as unknown as OpinionCard
    await assert.rejects(
      () => ctx.social.publish(card),
      /红线|架构/,
      '错误信息必须点明这是架构红线，否则接手的人会当成普通校验去绕过',
    )
  })

  test('撤回不存在的 id 返回 false，不撒谎', async () => {
    const { ctx } = await harness()
    assert.equal(await ctx.social.retract(asCardId('nope')), false)
  })

  test('session/event 监听器签名正确（回归：少一个参数）', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create()

    // 签名写成 (event) => 的话，下面这些事件全会落进 default 分支，
    // 一条 llm 调用都不会发生。
    session.append('turn/start', { turn: 0 })
    session.append('request/context', { provider: 'test-provider', model: 'test-model' })
    appendTurnBody(session)
    session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })

    await new Promise(r => setTimeout(r, 50))

    const llm = fakeLlm(ctx)
    assert.equal(llm.calls.length, 1, 'curator 应该为这一轮生成了草稿')
  })

  test('调模型时必须带 provider 和 model（回归：GenerateOptions 缺字段）', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 0 })
    session.append('request/context', { provider: 'test-provider', model: 'test-model' })
    appendTurnBody(session)
    session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
    await new Promise(r => setTimeout(r, 50))

    const llm = fakeLlm(ctx)
    const opts = llm.calls[0]
    assert.ok(opts, '应该调过一次')
    // 真实的 LlmRuntime 没有「用当前会话的模型」这种隐式默认，
    // 路由必须自己带上，否则运行期才炸
    assert.equal(opts.provider, 'test-provider', 'provider 应该跟着用户当前选的走')
    assert.equal(opts.model, 'test-model')
  })

  test('★ 红线①：commands 包一个 tool 都不注册', async () => {
    const { ctx } = await harness()
    const tools = ctx.get('tools') as unknown as TripwireTools
    assert.equal(
      tools.registerCalled,
      false,
      '发布是用户动作。注册成 tool 就等于模型能自己决定发布，违反「发出前必须用户过审」',
    )
  })

  test('草稿 → 发布 → 决定记录，跨插件链路通（回归：ctx 挂属性传值）', async () => {
    const { ctx, storePath } = await harness()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 0 })
    session.append('request/context', { provider: 'test-provider', model: 'test-model' })
    appendTurnBody(session)
    session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
    await new Promise(r => setTimeout(r, 50))

    // curator 生成的草稿，commands 必须能读到。
    // 靠 (ctx as any).__socialPendingDrafts 传值时这里会拿到空 Map，
    // /social-publish 回「没有待处理的草稿」，而日志里草稿明明已经生成。
    const publish = fakeCommands(ctx).registered.get('social-publish')
    assert.ok(publish, 'social-publish 应该注册了')
    const result = await publish('') as { kind: string, text?: string }
    assert.match(String(result.text ?? ''), /已发布/, `实际返回：${JSON.stringify(result)}`)

    const store = JSON.parse(await readFile(storePath, 'utf8'))
    assert.equal(store.cards.length, 1, '卡片应该落盘')
    assert.equal(store.decisions.length, 1, '决定记录应该落盘（转化率的唯一数据源）')
  })

  // ── 话题发言注入会话流 ────────────────────────────────────────

  test('★ 注入的是 plugin 来源的消息，不是伪装成用户说的话', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create()

    const injected = injectTopics(session, [{
      topicId: asCardId('card-1'),
      title: '远程办公',
      messages: [
        { messageId: 'm1', alias: 'afnd', text: '异步协作对新人更难', createdAt: 1 },
        { messageId: 'm2', alias: 'e48w', text: '门槛高不等于学不到', createdAt: 2 },
      ],
    }], 'social-curator')
    assert.equal(injected, true)

    const events = session.events
    const msg = [...events].reverse().find(e => e.type === 'user/message')
    assert.ok(msg, '应该往会话里写了一条 user/message')

    const source = (msg.data as { message?: { source?: Record<string, unknown> } }).message?.source
      ?? (msg.data as { source?: Record<string, unknown> }).source
    assert.equal(source?.['kind'], 'plugin',
      '必须是 plugin 来源。写成 kind:user 等于在日志里伪装成用户说的话')
    assert.equal(source?.['plugin'], 'social-curator')
    assert.equal(source?.['form'], 'snapshot',
      'snapshot 是可替换的，token 成本才有上界；逐条追加会无限增长')
  })

  test('没有新发言时不注入 —— 空快照会占 prompt 且留下一行空的注入痕迹', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create()
    const before = (session.events).length

    const injected = injectTopics(session, [
      { topicId: asCardId('card-1'), title: 't', messages: [] },
    ], 'social-curator')

    assert.equal(injected, false)
    assert.equal((session.events).length, before)
  })
})
