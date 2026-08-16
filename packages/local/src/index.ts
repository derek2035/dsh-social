/**
 * @dsh-social/local — Service Provider（本地落盘）
 *
 * 为什么先写这个而不是 cloud：
 *   阶段 0 要测的那个生死线数字（AI 提议 → 用户确认的转化率）
 *   **不需要服务端，不需要第二个用户**。装上这个 provider 就能开测。
 *
 * 它同时也是 cloud 的行为基线：两者同接口，cordis.yml 换一行切换。
 *
 * 隐私性质：这个 provider 不碰网络。数据全在本机一个 JSON 文件里。
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

import type { Context } from '@deepseek-ai/cordis'
import {
  JsonStore,
  SocialService,
  asCardId,
  cluster,
  cosine,
  distinctPublishers,
  type CardId,
  type OpinionCard,
  type RemoteCard,
  type SquareGroup,
  type TopicMessage,
  type DecisionRecord,
} from '@dsh-social/core'


export interface LocalConfig {
  /** 存储路径。默认 ~/.dsh-social/local-store.json */
  readonly storePath?: string
  /**
   * 模拟 k-匿名门槛。
   *
   * 本地只有你一个人，卡片数永远不够门槛，relevant() 会永远返回空——
   * 这是**正确**的行为，不是 bug。想在单机看到推荐效果，
   * 把它调成 1，但要清楚你正在关掉一条隐私红线。
   */
  readonly kAnonymityThreshold?: number
  /** 相似度阈值，低于此值不算相关。 */
  readonly similarityFloor?: number
}

/**
 * 注意：这里刻意用 TypeScript 的 private 而不是 JS 的 # 私有字段。
 *
 * cordis 把 Service 实例通过 **Proxy** 交给消费方（ctx.social 拿到的是代理，
 * 不是实例本身）。# 私有字段依赖运行时的 brand check，接收者是代理时直接抛
 * `TypeError: Receiver must be an instance of class SocialLocal`。
 * 真机上第一次 /social-publish 就是这么炸的，单测里发现不了 ——
 * 单测直接 new 实例，没有代理这一层。
 *
 * DSH 自己的 service 全都用 TS 的 private（见 packages/llm/token-meter）。
 * private 只是编译期约束，运行时是普通属性，穿得过代理。
 */
class SocialLocal extends SocialService {
  private readonly store: JsonStore
  private readonly k: number
  private readonly floor: number

  constructor(ctx: Context, config: LocalConfig = {}) {
    super(ctx)
    this.store = new JsonStore(
      config.storePath ?? join(homedir(), '.dsh-social', 'local-store.json'),
    )
    this.k = config.kAnonymityThreshold ?? 5
    this.floor = config.similarityFloor ?? 0.25

    console.log(`[social/local] 存储位置 ${this.store.path}`)
    console.log(`[social/local] k-匿名门槛 ${this.k}（本机数据不足时 relevant() 返回空是正常的）`)
  }

  override async publish(card: OpinionCard): Promise<CardId> {
    // 架构红线：过审守卫必须是第一行。
    SocialLocal.assertApproved(card)

    return this.store.mutate(async (store) => {
      const id = card.id.length > 0 ? card.id : asCardId(randomUUID())
      store.cards.push({
        id,
        claim: card.claim,
        ...(card.reasoning === undefined ? {} : { reasoning: card.reasoning }),
        topicVector: card.topicVector,
        createdAt: card.createdAt,
      })
      console.log(`[social/local] 已发布卡片 ${id}`)
      return id
    })
  }

  override async retract(id: CardId): Promise<boolean> {
    return this.store.mutate(async (store) => {
      const before = store.cards.length
      // 真删，不是打标记。架构红线③：按引用渲染，删除必须传播。
      store.cards = store.cards.filter(c => c.id !== id)
      if (store.cards.length === before) {
        console.log(`[social/local] 撤回：未找到 ${id}`)
        return false
      }
      console.log(`[social/local] 已撤回 ${id}`)
      return true
    })
  }

  override async relevant(
    vector: readonly number[],
    limit: number,
  ): Promise<RemoteCard[]> {
    const store = await this.store.read()

    // k-匿名门槛：池子里卡片总数不足时，什么都不返回。
    // 设计文档 5.3：数据不足时整个隐藏，比展示一个空位更好。
    if (store.cards.length < this.k) {
      return []
    }

    return store.cards
      .map(c => ({ card: c, score: cosine(vector, c.topicVector) }))
      .filter(x => x.score >= this.floor)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ card }): RemoteCard => ({
        id: asCardId(card.id),
        claim: card.claim,
        ...(card.reasoning === undefined ? {} : { reasoning: card.reasoning }),
      }))
  }

  /**
   * 本地广场就是本机发过的全部卡片，同样按话题分组。
   *
   * 本地只有你一个人，所以每个分组的 voices 都是 1 —— 那是**正确**的，
   * 不是 bug。分组在这里的价值是把自己的想法按主题归拢。
   */
  override async square(limit: number): Promise<SquareGroup[]> {
    const store = await this.store.read()
    const recent = [...store.cards]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)

    return cluster(recent).map(c => ({
      title: c.cards[0]?.claim ?? '',
      voices: distinctPublishers(c),
      cards: c.cards.map(x => ({
        id: asCardId(x.id),
        claim: x.claim,
        ...(x.reasoning === undefined ? {} : { reasoning: x.reasoning }),
      })),
    }))
  }

  /**
   * 本地 provider 没有「别人」，话题讨论无处可去。
   *
   * 抛错而不是静默成功：静默成功会让用户以为发出去了，
   * 而实际上没有任何人收得到 —— 那是这个项目一直在避免的那类谎。
   */
  override async say(): Promise<void> {
    throw new Error('本地模式没有其他用户，话题讨论需要联网 provider（social-cloud）')
  }

  /** 本地模式恒为空。不是错误，是这个 provider 的定义。 */
  override async messages(): Promise<TopicMessage[]> {
    return []
  }


  override async join(topicId: CardId): Promise<void> {
    await this.store.mutate((store) => {
      if (!store.topics.includes(String(topicId))) store.topics.push(String(topicId))
    })
  }

  override async leave(topicId: CardId): Promise<void> {
    await this.store.mutate((store) => {
      store.topics = store.topics.filter(t => t !== String(topicId))
    })
  }

  override async joined(): Promise<readonly CardId[]> {
    return (await this.store.read()).topics.map(asCardId)
  }

  override async recordDecision(record: DecisionRecord): Promise<void> {
    await this.store.mutate((store) => {
      store.decisions.push(record)
    })
  }

  override async listDecisions(): Promise<readonly DecisionRecord[]> {
    const store = await this.store.read()
    return store.decisions
  }

}

export const name = 'social-local'

export function apply(ctx: Context, config: LocalConfig = {}): void {
  ctx.plugin(SocialLocal, config)
}

export { SocialLocal }
