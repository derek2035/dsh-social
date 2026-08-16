/**
 * dsh-social · Service Definition 的类型层
 *
 * 这个文件零运行时依赖，只有类型和纯函数。
 * provider 和 consumer 都只依赖它，彼此不依赖（DSH 的 seam 约定）。
 */

/** 名义类型，防止 id 串用。 */
declare const brand: unique symbol
type Branded<T, B extends string> = T & { readonly [brand]: B }

export type CardId = Branded<string, 'CardId'>
export type DraftId = Branded<string, 'DraftId'>
export type EphemeralId = Branded<string, 'EphemeralId'>

export const asCardId = (s: string): CardId => s as CardId
export const asDraftId = (s: string): DraftId => s as DraftId
export const asEphemeralId = (s: string): EphemeralId => s as EphemeralId

// ───────────────────────────────────────────────────────────────
// 草稿：AI 提议但用户未确认。永不出本机。
// ───────────────────────────────────────────────────────────────

/**
 * 本地自评的隐私风险。
 *
 * 注意：这个字段只用于 UI 提示和排序，**绝不用于拦截**。
 * 设计文档明确否决了「AI 拦截敏感内容」的方向——失败不对称，
 * 漏报是不可逆泄露。这里的默认是私密，AI 只负责提议。
 */
export type RiskHint = 'low' | 'medium' | 'high'

export interface CardDraft {
  readonly draftId: DraftId
  /** AI 生成的观点正文，已剥离处境细节。 */
  readonly claim: string
  /** 支撑理由。 */
  readonly reasoning?: string
  readonly riskHint: RiskHint
  /** 会话坐标，Conversation Node 靠它定位渲染位置。 */
  readonly turn: number
  readonly step: number
  readonly createdAt: number
}

// ───────────────────────────────────────────────────────────────
// 卡片：发布的唯一单位
// ───────────────────────────────────────────────────────────────

export interface OpinionCard {
  readonly id: CardId
  readonly claim: string
  readonly reasoning?: string
  /** 话题向量，本地算好再上传；服务端不做二次抽取。 */
  readonly topicVector: readonly number[]
  readonly createdAt: number
  /**
   * 用户已过审的证明。
   *
   * 看起来冗余（反正只有用户点了才会调 publish），但把它放进类型里，
   * 就让「未过审的东西被发出去」变成编译期 + 运行期都挡得住的错误，
   * 而不是靠开发者记性。publish() 必须在 !== true 时抛错。
   */
  readonly userApproved: true
}

/** 从服务端拿回的、别人的卡片。刻意不含作者信息。 */
export interface RemoteCard {
  readonly id: CardId
  readonly claim: string
  readonly reasoning?: string
}

/** 广场里的一个话题分组。 */
export interface SquareGroup {
  /** 话题名。用簇内最新那条的正文——不做关键词抽取，64 维哈希词袋抽出来的多半是噪音。 */
  readonly title: string
  /** 有多少个**不同的人**在这个话题下发过。和 k-匿名同口径：一个人发五张不算五个人。 */
  readonly voices: number
  readonly cards: readonly RemoteCard[]
}

// ───────────────────────────────────────────────────────────────
// 用户决定
// ───────────────────────────────────────────────────────────────

export type Decision = 'published' | 'edited' | 'discarded'

/** 阶段 0 那个生死线指标的原始记录。 */
export interface DecisionRecord {
  readonly draftId: DraftId
  readonly decision: Decision
  readonly cardId?: CardId
  readonly decidedAt: number
}

// ───────────────────────────────────────────────────────────────
// 错误
// ───────────────────────────────────────────────────────────────

/** publish 收到未过审内容时抛出。这是防线，不该被 catch 掉。 */
export class UnapprovedCardError extends Error {
  override readonly name = 'UnapprovedCardError'
  constructor(cardId: string) {
    super(
      `拒绝发布未经用户过审的卡片 (${cardId})。` +
      `userApproved 必须为 true —— 这是架构红线，不要绕过。`,
    )
  }
}
