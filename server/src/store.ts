/**
 * 服务端存储（内存 + 可选 JSON 落盘）。
 *
 * 刻意不接数据库：换主机时存储方案会跟着变（SQLite / Postgres / KV），
 * 现在选一个只会绑死。这一层的接口很窄，换实现时改这个文件就够。
 *
 * ⚠️ 这里存的是**别人公开发表的内容**加上发布者的公钥。
 *    公钥 → 卡片的映射就是这个服务的全部权力：谁拿到这份数据，
 *    谁就能把一个人的所有发言串起来。部署时这份数据的归属要写清楚。
 */

export interface ServerCard {
  readonly cardId: string
  readonly claim: string
  readonly reasoning?: string
  readonly topicVector: readonly number[]
  /** 发布者公钥。撤回鉴权和封禁都靠它。**不对客户端暴露。** */
  readonly publisher: string
  readonly createdAt: number
}

export class ServerStore {
  private readonly cards = new Map<string, ServerCard>()
  private readonly banned = new Set<string>()

  add(card: ServerCard): void {
    this.cards.set(card.cardId, card)
  }

  get(cardId: string): ServerCard | undefined {
    return this.cards.get(cardId)
  }

  /** 真删，不是打标记。架构红线③：卡片按引用渲染，删除必须传播。 */
  remove(cardId: string): boolean {
    return this.cards.delete(cardId)
  }

  all(): readonly ServerCard[] {
    return [...this.cards.values()]
  }

  ban(publicKey: string): void {
    this.banned.add(publicKey)
  }

  isBanned(publicKey: string): boolean {
    return this.banned.has(publicKey)
  }
}
