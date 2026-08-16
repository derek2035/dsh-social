/**
 * Service Definition：抽象服务接口。
 *
 * provider（local / cloud）实现它，consumer（curator / commands）消费它。
 * 三者只依赖本文件，彼此不依赖。
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { CardId, OpinionCard, RemoteCard, SquareGroup, DecisionRecord } from './types.ts'
import { assertApproved } from './guard.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 由 provider（local / cloud）提供。consumer 用 inject: ['social'] 等它就绪。 */
    social: SocialService
  }
}

export abstract class SocialService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'social')
  }

  /**
   * 发布一张已过审的卡片。
   *
   * 子类必须先调 assertApproved()。这是网络出口前的最后一道闸。
   */
  abstract publish(card: OpinionCard): Promise<CardId>

  /**
   * 撤回。
   *
   * 架构红线：必须真删，不是隐藏。卡片按引用渲染，删除后所有
   * 展示过它的地方同时失效。
   *
   * @returns 是否真的删掉了一张卡片。false 表示这个 id 本来就不存在。
   *
   * 为什么要返回值：撤回是用户对「我发出去的东西现在没了」的确认。
   * 如果 id 打错了却回一句「已撤回」，用户会以为东西删干净了 —— 
   * 这个方向的误报是不可逆的（他不会再去删第二次）。
   */
  abstract retract(id: CardId): Promise<boolean>

  /**
   * 按话题向量拉相关卡片。
   *
   * k-匿名门槛由服务端实现——命中人数不足 N 的话题直接不返回，
   * 客户端拿不到不足门槛的数据。
   */
  abstract relevant(vector: readonly number[], limit: number): Promise<RemoteCard[]>

  /**
   * 话题广场：拉最近的卡片，**不做话题过滤**。
   *
   * ⚠️ 它绕过 k-匿名，所以服务端默认关闭这个接口（返回 404）。
   *    存在的理由是「还没有用户时快速测通流程」：没有别人发卡，
   *    k-匿名门槛永远满足不了，relevant() 恒为空，链路没法验证。
   *
   * 对外开放前必须在服务端关掉。见 server/src/index.ts 的 devPublicSquare。
   */
  abstract square(limit: number): Promise<SquareGroup[]>

  /** 记录用户对草稿的决定。转化率指标的数据源。 */
  abstract recordDecision(record: DecisionRecord): Promise<void>

  /** 读回决定记录，用于统计。 */
  abstract listDecisions(): Promise<readonly DecisionRecord[]>

  /**
   * 过审守卫。所有 publish 实现的第一行都必须调用它。
   *
   * 真实逻辑在 guard.ts —— 那个模块不依赖 cordis，可以脱离框架单测。
   * 这里只是把它挂成 protected 静态方法，让「我忘了调」在 code review
   * 时一眼可见：publish 的第一行不是这个，就是 bug。
   */
  protected static readonly assertApproved = assertApproved
}
