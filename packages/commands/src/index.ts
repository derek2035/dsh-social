/**
 * @dsh-social/commands — Consumer（用户动作）
 *
 * ★ 本包最重要的性质是它**没有**注册任何 tool。
 *
 * 「发布」是用户的动作，不是模型的动作。做成模型可调用的 tool，
 * 就意味着模型可以自己决定发布，直接违反设计文档的红线④
 * （发出前必须用户过审）。
 *
 * ctx.commands 的文档承诺是「无需模型轮次即可分派」——发布路径
 * 根本不经过模型，也就不存在模型被诱导发布的可能。
 *
 * 把危险动作放在模型够不到的地方，比在 prompt 里叮嘱它可靠。
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import {
  asCardId,
  topicVector,
  SOCIAL_DECISION,
  SOCIAL_DRAFT,
  type CardId,
  type DecisionRecord,
  type Decision,
  type OpinionCard,
  type SocialDecisionEvent,
  type SocialDraftEvent,
} from '@dsh-social/core'

export const name = 'social-commands'

/**
 * ⚠️ cordis 的 inject 没有 `{ required, optional }` 形态（见 curator/src/index.ts
 *    的同名注释）。原来那份写法让本插件永远 PENDING，启动直接失败。
 *    'commands' 现在是硬依赖——命令注册不上的话这个包没有存在意义。
 */
export const inject = ['social', 'commands']

interface CommandSpec {
  readonly name: string
  readonly description: string
  /** 有参数的命令给个占位提示，UI 会显示。 */
  readonly hint?: string
  readonly run: (arg: string) => Promise<string>
}

export function apply(ctx: Context): void {
  const social = ctx.social

  /**
   * 待处理草稿。
   *
   * ⚠️ 原来这里是从 `(ctx as any).__socialPendingDrafts` 读 curator 挂上去的 Map。
   *    真机上第一次跑就暴露了：cordis 给每个插件的 ctx 是各自的代理，
   *    curator 挂在它自己的 ctx 上，commands 这边读到 undefined，
   *    于是 `?? new Map()` 永久绑定了一个空 Map ——
   *    /social-publish 一直回「没有待处理的草稿」，而日志里草稿明明已经生成。
   *
   *    改成监听 social/draft 事件。这本来就是 core 已经声明好的对外接口，
   *    两个 consumer 依旧只依赖 core、互不依赖，方向没变。
   *    Map 的插入顺序就是时间顺序，「最近一条」= 最后一条。
   */
  const pending = new Map<string, SocialDraftEvent>()
  ctx.on(SOCIAL_DRAFT, (draft) => {
    pending.set(draft.draftId, draft)
  })

  /**
   * 本进程内发布过的卡片 id，只为让 /social-retract 也能用 8 位前缀。
   *
   * 发布成功时提示的是 `/social-retract <前缀>`，但 retract 本身是全等匹配，
   * 照着提示复制过去会得到「未找到」——真机上试出来的。
   * service 没有「列出我发过的卡片」这个接口（cloud 版按设计也不该有，
   * 那等于让客户端能枚举自己的全部发言），所以在这里记一份进程内的映射。
   * 进程重启后前缀失效，那时用完整 id 仍然可以撤回。
   */
  const publishedIds = new Set<string>()

  /** 前缀解析：命中唯一一条才算数，命中多条要用户说清楚。 */
  function resolveCardId(input: string): { ok: true, id: CardId } | { ok: false, why: string } {
    if (publishedIds.has(input)) return { ok: true, id: asCardId(input) }
    const hits = [...publishedIds].filter(id => id.startsWith(input))
    if (hits.length === 1) return { ok: true, id: asCardId(hits[0] as string) }
    if (hits.length > 1) return { ok: false, why: `前缀 ${input} 命中 ${hits.length} 条，请给出更长的 id。` }
    // 本进程没见过：当成完整 id 交给 service，让它自己判断
    return { ok: true, id: asCardId(input) }
  }

  /** 支持用 draftId 前缀匹配，省得让用户复制整个 UUID。 */
  function resolveDraft(prefix: string): SocialDraftEvent | null {
    if (!prefix) {
      // 无参数时取最近一条（Map 保持插入顺序）
      let latest: SocialDraftEvent | null = null
      for (const d of pending.values()) latest = d
      return latest
    }
    for (const [id, draft] of pending) {
      if (id.startsWith(prefix)) return draft
    }
    return null
  }

  async function record(
    draft: SocialDraftEvent,
    decision: Decision,
    cardId?: CardId,
  ): Promise<void> {
    const rec: DecisionRecord = {
      draftId: draft.draftId,
      decision,
      ...(cardId === undefined ? {} : { cardId }),
      decidedAt: Date.now(),
    }
    await social.recordDecision(rec)

    const payload: SocialDecisionEvent = {
      draftId: draft.draftId,
      turn: draft.turn,
      step: draft.step,
      decision,
      ...(cardId === undefined ? {} : { cardId }),
    }
    ctx.emit(SOCIAL_DECISION, payload)
  }

  const commands: CommandSpec[] = [
    {
      name: 'social-publish',
      description: '发布 AI 提议的观点卡片（不带参数则发布最近一条）',
      hint: 'draftId 前缀，留空则发布最近一条',
      run: async (arg) => {
        const draft = resolveDraft(arg.trim())
        if (!draft) return '没有待处理的草稿。'

        const card: OpinionCard = {
          id: asCardId(randomUUID()),
          claim: draft.claim,
          ...(draft.reasoning === undefined ? {} : { reasoning: draft.reasoning }),
          topicVector: topicVector(`${draft.claim} ${draft.reasoning ?? ''}`),
          createdAt: Date.now(),
          // 这个 true 是用户此刻的点击。它是整条链路上唯一的授权来源。
          userApproved: true,
        }

        // 用户已经做出决定了。发布可能因为网络失败，但**决定本身发生了**，
        // 转化率要测的正是这个决定。所以两件事必须分开记：
        //   记了 cardId  → 用户决定发布，且真的发出去了
        //   没有 cardId  → 用户决定发布，但没送达
        // 只在成功时才 record，会让转化率在联网 provider 下系统性偏低。
        pending.delete(draft.draftId)
        let id: CardId
        try {
          id = await social.publish(card)
        } catch (err) {
          await record(draft, 'published')
          throw err
        }
        publishedIds.add(String(id))
        await record(draft, 'published', id)
        return `已发布。撤回：/social-retract ${String(id).slice(0, 8)}`
      },
    },

    {
      name: 'social-discard',
      description: '丢弃一条草稿',
      hint: 'draftId 前缀，留空则丢弃最近一条',
      run: async (arg) => {
        const draft = resolveDraft(arg.trim())
        if (!draft) return '没有待处理的草稿。'
        pending.delete(draft.draftId)
        await record(draft, 'discarded')
        return '已丢弃。'
      },
    },

    {
      name: 'social-pending',
      description: '列出待处理的草稿',
      run: async () => {
        if (pending.size === 0) return '没有待处理的草稿。'
        // Map 保持插入顺序，倒过来就是「最近的在前」
        const lines = [...pending.values()]
          .reverse()
          .map(d => `  ${d.draftId.slice(0, 8)}  [${d.riskHint}]  ${d.claim}`)
        return `待处理草稿 ${pending.size} 条：\n${lines.join('\n')}`
      },
    },

    {
      name: 'social-retract',
      description: '撤回已发布的卡片（真删，不是隐藏）',
      hint: 'cardId',
      run: async (arg) => {
        const input = arg.trim()
        if (!input) return '用法：/social-retract <cardId 或其前缀>'
        const resolved = resolveCardId(input)
        if (!resolved.ok) return resolved.why
        const removed = await social.retract(resolved.id)
        return removed
          ? '已撤回。'
          : `没找到 ${input} 对应的卡片，什么都没删。`
      },
    },

    {
      name: 'social-stats',
      description: '★ 转化率统计 —— 阶段 0 的生死线数字',
      run: async () => {
        const decisions: readonly DecisionRecord[] = await social.listDecisions()
        const total = decisions.length
        if (total === 0) {
          return '还没有任何决定记录。先聊几轮，等 AI 提议。'
        }
        const published = decisions.filter(d => d.decision === 'published').length
        const edited = decisions.filter(d => d.decision === 'edited').length
        const discarded = decisions.filter(d => d.decision === 'discarded').length
        const rate = ((published + edited) / total * 100).toFixed(1)

        return [
          '── 发布转化率 ──',
          `  AI 提议   ${total} 次`,
          `  直接发布  ${published}`,
          `  改后发布  ${edited}`,
          `  丢弃      ${discarded}`,
          '',
          `  转化率 ${rate}%`,
          '',
          '这个数字是整个产品的生死线（设计文档 阶段 0）。',
          '注意：如果样本是尝鲜用户，这个值不可信 —— 他们手上没有',
          '真实内容，数字会虚高或虚低。真实验证要找有真实使用场景的人。',
        ].join('\n')
      },
    },
  ]

  // ✅ 已核实（docs/subsystems/commands.md + packages/interaction/commands）：
  //    ctx.commands.register({ name, description, input?, recordInput?, handler })
  //    handler 收 CommandInvocation，返回 CommandResult。
  //    原来那份三路兜底里，第三条 `registry.define?.({...})` 在 define 不存在时
  //    只会返回 undefined 而不抛错，于是会打印「✔ 注册成功」——一个会骗人的兜底。
  for (const cmd of commands) {
    ctx.commands.register({
      name: cmd.name,
      description: cmd.description,
      ...(cmd.hint === undefined ? {} : { input: { hint: cmd.hint } }),
      handler: async (invocation): Promise<CommandResult> => {
        try {
          return { kind: 'success', text: await cmd.run(invocation.rawInput.trim()) }
        } catch (err) {
          // 命令失败要显示给用户，不能让它冒泡把 UI 请求打断
          return { kind: 'error', text: `/${cmd.name} 失败：${(err as Error).message}` }
        }
      },
    })
  }
}
