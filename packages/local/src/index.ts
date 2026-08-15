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

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

import type { Context } from '@deepseek-ai/cordis'
import {
  SocialService,
  asCardId,
  cosine,
  type CardId,
  type OpinionCard,
  type RemoteCard,
  type DecisionRecord,
} from '@dsh-social/core'

interface StoredCard {
  readonly id: string
  readonly claim: string
  readonly reasoning?: string
  readonly topicVector: readonly number[]
  readonly createdAt: number
}

interface Store {
  version: 1
  cards: StoredCard[]
  decisions: DecisionRecord[]
}

const EMPTY: Store = { version: 1, cards: [], decisions: [] }

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
  private readonly path: string
  private readonly k: number
  private readonly floor: number
  /** 串行化写入，避免并发 publish 互相覆盖。 */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, config: LocalConfig = {}) {
    super(ctx)
    this.path = config.storePath
      ?? join(homedir(), '.dsh-social', 'local-store.json')
    this.k = config.kAnonymityThreshold ?? 5
    this.floor = config.similarityFloor ?? 0.25

    console.log(`[social/local] 存储位置 ${this.path}`)
    console.log(`[social/local] k-匿名门槛 ${this.k}（本机数据不足时 relevant() 返回空是正常的）`)
  }

  override async publish(card: OpinionCard): Promise<CardId> {
    // 架构红线：过审守卫必须是第一行。
    SocialLocal.assertApproved(card)

    return this.serialize(async () => {
      const store = await this.read()
      const id = card.id.length > 0 ? card.id : asCardId(randomUUID())
      store.cards.push({
        id,
        claim: card.claim,
        ...(card.reasoning === undefined ? {} : { reasoning: card.reasoning }),
        topicVector: card.topicVector,
        createdAt: card.createdAt,
      })
      await this.write(store)
      console.log(`[social/local] 已发布卡片 ${id}`)
      return id
    })
  }

  override async retract(id: CardId): Promise<boolean> {
    return this.serialize(async () => {
      const store = await this.read()
      const before = store.cards.length
      // 真删，不是打标记。架构红线③：按引用渲染，删除必须传播。
      store.cards = store.cards.filter(c => c.id !== id)
      if (store.cards.length === before) {
        console.log(`[social/local] 撤回：未找到 ${id}`)
        return false
      }
      await this.write(store)
      console.log(`[social/local] 已撤回 ${id}`)
      return true
    })
  }

  override async relevant(
    vector: readonly number[],
    limit: number,
  ): Promise<RemoteCard[]> {
    const store = await this.read()

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

  override async recordDecision(record: DecisionRecord): Promise<void> {
    return this.serialize(async () => {
      const store = await this.read()
      store.decisions.push(record)
      await this.write(store)
    })
  }

  override async listDecisions(): Promise<readonly DecisionRecord[]> {
    const store = await this.read()
    return store.decisions
  }

  // ── 内部 ──────────────────────────────────────────────────

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    // 吞掉链上的错误，避免一次失败毒化后续所有写入
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  private async read(): Promise<Store> {
    try {
      const raw = await readFile(this.path, 'utf8')
      const parsed = JSON.parse(raw) as Partial<Store>
      return {
        version: 1,
        cards: Array.isArray(parsed.cards) ? parsed.cards : [],
        decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return structuredClone(EMPTY)
      // 文件损坏时不要静默重置——那会悄悄抹掉用户数据
      console.error(`[social/local] 存储读取失败 ${this.path}:`, err)
      throw err
    }
  }

  private async write(store: Store): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    // 原子写：先写临时文件再 rename，避免崩溃时留下半个 JSON
    const tmp = `${this.path}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(store, null, 2), 'utf8')
    await rename(tmp, this.path)
  }
}

export const name = 'social-local'

export function apply(ctx: Context, config: LocalConfig = {}): void {
  ctx.plugin(SocialLocal, config)
}

export { SocialLocal }
