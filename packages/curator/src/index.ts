/**
 * @dsh-social/curator — Consumer
 *
 * 职责：观察对话 → 判断时机 → 生成草稿 → 发事件。
 * **到此为止。** 它不发布、不联网、不注册 tool。
 *
 * 三条刻意的不作为：
 *   1. 不 inject 'tools' —— 发布是用户动作，模型不该够得着
 *   2. 不调 agent.inject() —— 阶段 1 不进模型上下文（技术架构第 7 节）
 *   3. 不碰网络 —— 网络出口收敛在 provider
 *
 * 这个包是唯一消耗 token 的包，必须能被单独关掉（改 cordis.yml 删掉这一行）。
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
// 值不用，但这个 import 带来 dsh-session 对 cordis Events 的声明合并，
// 没有它 ctx.on('session/event', ...) 通不过类型检查。
import type {} from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  asDraftId,
  assessRisk,
  buildSummaryPrompt,
  parseSummary,
  SOCIAL_DRAFT,
  type CardDraft,
  type SocialDraftEvent,
} from '@dsh-social/core'
import { judge, DEFAULT_HEURISTICS, type HeuristicConfig, type TurnStats } from './heuristics.ts'
import { callModel, type Route } from './llm.ts'
import { injectTopics, type TopicFeed } from './inject.ts'

export interface CuratorConfig {
  readonly heuristics?: Partial<HeuristicConfig>
  /** 探针模式：打印轮次统计与事件类型直方图。 */
  readonly probe?: boolean
  /** 关掉自动提议，只保留手动命令。不确定 LLM 计费时先用这个。 */
  readonly manualOnly?: boolean
  /**
   * 把关注话题里别人的发言注入会话流。**默认关闭。**
   *
   * 打开它意味着接受三件事：花 token、AI 会接话、别人的话落进你本机日志。
   * 详见 inject.ts 文件头 —— 那三条是设计文档第 7 节明确权衡过的，
   * 所以这必须是用户的显式选择。
   */
  readonly injectTopics?: boolean
}

export const name = 'social-curator'

/**
 * ⚠️ cordis 的 inject 只有两种形态：数组，或 `{ 服务名: 拦截配置 }`。
 *    **没有 `{ required, optional }` 这种写法**（vendor/cordis/src/registry.ts
 *    的 Inject<M> = (keyof M)[] | { [K in keyof M]?: M[K] }）。
 *    原来那份 `{ required: [], optional: ['llm','jobs'] }` 被解析成
 *    「等两个叫 required 和 optional 的服务」，插件因此永远 PENDING，
 *    启动直接报 `2 entries did not activate`。真机跑一次才暴露出来。
 */
export const inject = ['llm']

/** 当前轮次的累积器。 */
interface Accumulator {
  turn: number
  userMessages: string[]
  assistantChars: number
  toolCalls: number
  lastStep: number
}

export function apply(ctx: Context, config: CuratorConfig = {}): void {
  const heuristics: HeuristicConfig = { ...DEFAULT_HEURISTICS, ...config.heuristics }
  const probe = config.probe ?? true

  /** 每个会话一份状态——Web UI 可以同时开多个会话。 */
  const accumulators = new WeakMap<Session, Accumulator>()
  const lastDraftTurn = new WeakMap<Session, number>()
  /** 后台调用要跟着用户当前选的模型走，路由从会话日志里捡。 */
  const routes = new WeakMap<Session, Route>()

  let eventCount = 0
  const histogram = new Map<string, number>()

  /**
   * 本地留一份草稿，只为打印和调试。
   *
   * ⚠️ 原来这个 Map 是通过 `(ctx as any).__socialPendingDrafts` 递给 commands 包的。
   *    真机上不成立：cordis 给每个插件的 ctx 是各自的代理，属性不串门。
   *    commands 现在改成监听 social/draft 事件，这里不再承担传递职责。
   */
  const pending = new Map<string, CardDraft>()

  // ⚠️ 监听器签名是 (session, event) 两个参数，不是一个。
  //    原来写成 (event) => ... 会把 Session 当成事件读，event.type 恒为
  //    undefined，所有分支都落进 default，整个插件静默失效。
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    eventCount++
    histogram.set(event.type, (histogram.get(event.type) ?? 0) + 1)

    switch (event.type) {
      case 'request/context': {
        // { provider, model } —— 当前解析出的模型路由
        routes.set(session, { provider: event.data.provider, model: event.data.model })
        return
      }

      case 'request/header': {
        // 兜底：request/context 只在路由变化时才写，header 带着完整 config
        const { provider, model } = event.data.header.config
        routes.set(session, { provider, model })
        return
      }

      case 'turn/start':
        accumulators.set(session, {
          turn: event.data.turn,
          userMessages: [],
          assistantChars: 0,
          toolCalls: 0,
          lastStep: 0,
        })
        return

      case 'user/message': {
        const acc = accumulators.get(session)
        if (!acc) return
        // source.kind 区分真人输入和插件注入的上下文（AGENTS.md、skill、
        // cron 通知都走同一个事件）。只有真人说的话才算数。
        if (event.data.source.kind !== 'user') return
        const text = blocksToText(event.data.content)
        if (text) acc.userMessages.push(text)
        return
      }

      case 'assistant/message': {
        const acc = accumulators.get(session)
        if (!acc) return
        acc.assistantChars += blocksToText(event.data.message.content).length
        return
      }

      case 'step/start': {
        const acc = accumulators.get(session)
        if (acc) acc.lastStep = event.data.step
        return
      }

      case 'tool/call': {
        const acc = accumulators.get(session)
        if (acc) acc.toolCalls += 1
        return
      }

      case 'turn/end': {
        const acc = accumulators.get(session)
        accumulators.delete(session)
        if (!acc) return
        // 只有正常结束的轮次才算。中断/失败的轮次内容不完整。
        if (event.data.reason.kind !== 'completed') {
          if (probe) console.log(`[social/turn ${acc.turn}] 跳过（轮次以 ${event.data.reason.kind} 结束）`)
          return
        }
        void handleTurnEnd(session, acc)
        // 轮次结束是注入的自然边界：不打断进行中的对话，也不需要定时器。
        if (config.injectTopics === true) void pumpTopics(session)
        return
      }

      default:
        return
    }
  })

  /** 每个话题上次注入到哪条时间戳。避免同一条发言被重复注入。 */
  const topicCursor = new Map<string, number>()

  /**
   * 拉关注话题的新发言并注入会话流。
   *
   * 整段吞错：这是附加功能，网络抖一下不该影响用户的正常对话。
   */
  async function pumpTopics(session: Session): Promise<void> {
    try {
      const topics = await ctx.social.joined()
      if (topics.length === 0) return

      const feeds: TopicFeed[] = []
      for (const topicId of topics) {
        const key = String(topicId)
        const since = topicCursor.get(key) ?? 0
        const messages = await ctx.social.messages(topicId, since)
        if (messages.length === 0) continue
        topicCursor.set(key, Math.max(...messages.map(m => m.createdAt)))
        feeds.push({ topicId, title: key.slice(0, 8), messages })
      }

      if (injectTopics(session, feeds, name) && probe) {
        const n = feeds.reduce((sum, f) => sum + f.messages.length, 0)
        console.log(`[social] 已注入 ${n} 条话题发言到会话流`)
      }
    } catch (err) {
      if (probe) console.log(`[social] 拉取话题发言失败：${(err as Error).message}`)
    }
  }

  async function handleTurnEnd(session: Session, a: Accumulator): Promise<void> {
    const stats: TurnStats = {
      turnIndex: a.turn,
      userText: a.userMessages.join('\n'),
      assistantChars: a.assistantChars,
      toolCalls: a.toolCalls,
    }
    const since = a.turn - (lastDraftTurn.get(session) ?? -Infinity)
    const verdict = judge(stats, since, heuristics)

    if (probe) {
      console.log(
        `[social/turn ${a.turn}] `
        + `用户${stats.userText.length}字 AI${stats.assistantChars}字 工具${stats.toolCalls}次 `
        + `→ ${verdict.worth ? '★ 值得提议' : '跳过'}（${verdict.reason}）`,
      )
    }

    if (!verdict.worth) return
    if (config.manualOnly) {
      console.log('[social] manualOnly 已开启，跳过自动生成。用 /social-draft 手动触发。')
      return
    }

    const route = routes.get(session)
    if (!route) {
      console.log('[social] 还没看到 request/context 或 request/header，拿不到模型路由，跳过本轮')
      return
    }

    lastDraftTurn.set(session, a.turn)
    await generateDraft(ctx, route, stats.userText, a.turn, a.lastStep, pending, probe)
  }

  // 卸载时打印直方图——DSH 事件系统最快的地图
  ctx.effect(() => () => {
    if (!probe) return
    console.log(`[social] ── 事件类型直方图（共 ${eventCount} 条）──`)
    for (const [t, n] of [...histogram].sort((x, y) => y[1] - x[1])) {
      console.log(`[social]   ${String(n).padStart(5)}  ${t}`)
    }
  })

  if (probe) console.log('[social-curator] 已挂载（探针模式）')
}

/**
 * 生成草稿并发事件。
 *
 * 事件走 ctx.emit 而不是 session.append —— 原因见 core/src/events.ts 顶部：
 * 外部插件的自定义事件类型会让会话日志在重新打开时被拒绝解释。
 */
async function generateDraft(
  ctx: Context,
  route: Route,
  conversation: string,
  turn: number,
  step: number,
  pending: Map<string, CardDraft>,
  probe: boolean,
): Promise<void> {
  const raw = await callModel(ctx, route, buildSummaryPrompt(conversation), probe)
  if (raw === null) {
    console.log('[social] 摘要生成失败，跳过本轮')
    return
  }

  const summary = parseSummary(raw)
  if (!summary) {
    if (probe) console.log('[social] 模型判定无可提取观点（NONE），跳过')
    return
  }

  const risk = assessRisk(`${summary.claim}\n${summary.reasoning ?? ''}`)
  const draft: CardDraft = {
    draftId: asDraftId(randomUUID()),
    claim: summary.claim,
    ...(summary.reasoning === undefined ? {} : { reasoning: summary.reasoning }),
    riskHint: risk.level,
    turn,
    step,
    createdAt: Date.now(),
  }

  pending.set(draft.draftId, draft)

  const payload: SocialDraftEvent = {
    draftId: draft.draftId,
    turn: draft.turn,
    step: draft.step,
    claim: draft.claim,
    ...(draft.reasoning === undefined ? {} : { reasoning: draft.reasoning }),
    riskHint: draft.riskHint,
  }
  ctx.emit(SOCIAL_DRAFT, payload)

  console.log('')
  console.log('┌─ AI 提议发布一个观点 ────────────────────────')
  console.log(`│ ${draft.claim}`)
  if (draft.reasoning) console.log(`│ 理由：${draft.reasoning}`)
  if (risk.reasons.length > 0) {
    console.log(`│ ⚠️  ${risk.level.toUpperCase()}：${risk.reasons.join('；')}`)
  }
  console.log(`│ /social-publish ${draft.draftId.slice(0, 8)}   发布`)
  console.log(`│ /social-discard ${draft.draftId.slice(0, 8)}   不用了`)
  console.log('└──────────────────────────────────────────────')
  console.log('')
}

/**
 * 把 ContentBlock[] 压成纯文本。
 *
 * 已核实（packages/llm/llm/src/types.ts）：文本块是 { type: 'text', text }。
 * reasoning / tool-call / image 块一律丢掉——我们要的是「他说了什么」。
 */
function blocksToText(content: readonly ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map(b => b.text)
    .join('')
}
