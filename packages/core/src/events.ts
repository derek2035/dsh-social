/**
 * 事件声明。
 *
 * ⚠️ 2026-08-15 在真实检出上验证后的结论（推翻了原来的计划）：
 *
 * 原计划是把 social/draft、social/decision 写进**会话日志**（Session.append），
 * 理由是 DSH 的「模型可见即已记录」不变式，以及 Conversation Node 靠回放日志重建 UI。
 *
 * 但真实代码不允许这么做：
 *   · packages/core/session/src/known-event-types.ts 里的 KNOWN_SESSION_EVENT_TYPES
 *     是一个**写死的白名单**，只含仓库内声明的事件类型。
 *   · session-persistence/src/coordinator.ts 的 assertEventsSupported() 在读日志时，
 *     遇到不在白名单、且没有 `ignorable: true` 标记的事件类型，会直接抛
 *     SessionFormatUnsupportedError，**拒绝解释整条日志**。
 *   · Session.append(type, data) 的签名里没有设置 `ignorable` 的入口，
 *     全仓库也没有任何一处写入它。
 *
 * 结论：外部插件往会话日志里 append 自定义事件，会让那条会话**永久打不开**。
 * 白名单文件自己的注释也承认了这点：「Downstream (out-of-repo) plugin events are
 * outside this list by construction; a registration surface for them is deferred
 * until such a consumer exists.」——注册入口还没开。
 *
 * 所以这里退回到 cordis 的进程内事件（ctx.emit）。代价是：
 *   · 事件不持久化，进程重启就没了
 *   · 转化率统计不能靠日志回放，只能靠 local provider 的 listDecisions()（已经这么做了）
 *   · Conversation Node 拿不到回放数据源，阶段 1 的 UI 只能读服务而不是读日志
 *
 * 想恢复原计划，需要 DSH 先开放 out-of-repo 事件的注册面。
 */

import type { RiskHint, Decision, DraftId, CardId } from './types.ts'

export interface SocialDraftEvent {
  readonly draftId: DraftId
  readonly turn: number
  readonly step: number
  readonly claim: string
  readonly reasoning?: string
  readonly riskHint: RiskHint
}

export interface SocialDecisionEvent {
  readonly draftId: DraftId
  readonly turn: number
  readonly step: number
  readonly decision: Decision
  /** 仅 decision === 'published' 时存在。 */
  readonly cardId?: CardId
}

export const SOCIAL_DRAFT = 'social/draft' as const
export const SOCIAL_DECISION = 'social/decision' as const

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** AI 生成了一条待用户过审的草稿。 */
    'social/draft'(payload: SocialDraftEvent): void
    /** 用户对草稿做出了决定。转化率指标的事件面。 */
    'social/decision'(payload: SocialDecisionEvent): void
  }
}
