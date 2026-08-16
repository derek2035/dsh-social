/**
 * 服务端存储。SQLite（node:sqlite，零第三方依赖）。
 *
 * ⚠️ 这里存的是**别人公开发表的内容**加上发布者的公钥。
 *    公钥 → 卡片的映射就是这个服务的全部权力：谁拿到这份数据，
 *    谁就能把一个人的所有发言串起来。部署时这份数据的归属要写清楚。
 *
 * 用 SQLite 而不是 JSON 文件：卡片会持续增长，而撤回必须是真删 ——
 * 每次撤回都重写整个文件，在几千张卡之后就会开始丢写。
 *
 * 传 ':memory:' 得到一个进程内数据库，测试用它，不落盘。
 */

import { DatabaseSync } from 'node:sqlite'

export interface ServerCard {
  readonly cardId: string
  readonly claim: string
  readonly reasoning?: string
  readonly topicVector: readonly number[]
  /** 发布者公钥。撤回鉴权和封禁都靠它。**绝不返回给客户端。** */
  readonly publisher: string
  readonly createdAt: number
}

interface CardRow {
  card_id: string
  claim: string
  reasoning: string | null
  topic_vector: string
  publisher: string
  created_at: number
}

export class ServerStore {
  private readonly db: DatabaseSync

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path)
    // WAL 让读写不互相阻塞；崩溃后能自恢复
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cards (
        card_id      TEXT PRIMARY KEY,
        claim        TEXT NOT NULL,
        reasoning    TEXT,
        topic_vector TEXT NOT NULL,
        publisher    TEXT NOT NULL,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cards_publisher ON cards (publisher);
      CREATE TABLE IF NOT EXISTS bans (public_key TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS seen_nonces (
        nonce   TEXT PRIMARY KEY,
        seen_at INTEGER NOT NULL
      );
    `)
  }

  add(card: ServerCard): void {
    this.db.prepare(
      `INSERT INTO cards (card_id, claim, reasoning, topic_vector, publisher, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      card.cardId,
      card.claim,
      card.reasoning ?? null,
      JSON.stringify(card.topicVector),
      card.publisher,
      card.createdAt,
    )
  }

  get(cardId: string): ServerCard | undefined {
    const row = this.db.prepare('SELECT * FROM cards WHERE card_id = ?').get(cardId) as
      CardRow | undefined
    return row === undefined ? undefined : toCard(row)
  }

  /** 真删，不是打标记。架构红线③：卡片按引用渲染，删除必须传播。 */
  remove(cardId: string): boolean {
    const info = this.db.prepare('DELETE FROM cards WHERE card_id = ?').run(cardId)
    return info.changes > 0
  }

  all(): readonly ServerCard[] {
    const rows = this.db.prepare('SELECT * FROM cards').all() as unknown as CardRow[]
    return rows.map(toCard)
  }

  countByPublisher(publicKey: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM cards WHERE publisher = ?')
      .get(publicKey) as { n: number }
    return row.n
  }

  ban(publicKey: string): void {
    this.db.prepare('INSERT OR IGNORE INTO bans (public_key) VALUES (?)').run(publicKey)
  }

  isBanned(publicKey: string): boolean {
    return this.db.prepare('SELECT 1 FROM bans WHERE public_key = ?').get(publicKey) !== undefined
  }

  /**
   * 记下一个已用过的签名，重复出现说明是重放。
   *
   * @returns true 表示第一次见（放行），false 表示见过（拒绝）
   */
  claimNonce(nonce: string, now: number): boolean {
    try {
      this.db.prepare('INSERT INTO seen_nonces (nonce, seen_at) VALUES (?, ?)').run(nonce, now)
      return true
    } catch {
      return false  // 主键冲突 = 见过
    }
  }

  /** 清掉早于时间窗的 nonce —— 超出窗口的请求已经被时间戳挡住了，不必再记。 */
  pruneNonces(before: number): void {
    this.db.prepare('DELETE FROM seen_nonces WHERE seen_at < ?').run(before)
  }

  close(): void {
    this.db.close()
  }
}

function toCard(row: CardRow): ServerCard {
  return {
    cardId: row.card_id,
    claim: row.claim,
    ...(row.reasoning === null ? {} : { reasoning: row.reasoning }),
    topicVector: JSON.parse(row.topic_vector) as number[],
    publisher: row.publisher,
    createdAt: row.created_at,
  }
}
