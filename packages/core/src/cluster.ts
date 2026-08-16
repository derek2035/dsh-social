/**
 * 话题聚类。
 *
 * 广场按时间倒序排是一条流水账 —— 同一个话题的观点散落在各处，看不出
 * 「有多少人在想同一件事」。而那恰恰是这个产品唯一的价值主张。
 *
 * 用的是最朴素的贪心聚类：按时间倒序扫，每张卡片要么归入某个已有簇
 * （与簇心相似度过阈值），要么自成一簇。不搞 k-means ——
 * 簇数事先未知，而且卡片量在很长一段时间内都是两位数。
 *
 * ★★ 先读这段再改阈值 ★★
 *
 * 2026-08-16 拿四条「远程办公」同话题卡片 + 两条无关卡片实测：
 *
 *   同话题两两相似度：-0.114  0.113  0.209  0.250  0.411  0.548
 *   跨话题两两相似度：-0.096  0.000  0.000  0.208
 *
 * **两个区间是重叠的**。0.209（同话题）和 0.208（跨话题）几乎相等，
 * 不存在能把它们分开的阈值。原因在 topic.ts 里已经写了：
 * 64 维哈希词袋只认用词重叠，认不出换了说法的同一件事。
 *
 * 所以这里的阈值取在**跨话题的上限之上**（0.45 > 0.208），姿态是：
 * 宁可漏合并，不可错合并。归到一起的必然是真的高度重合，
 * 代价是大部分同话题卡片仍然各自成组。
 *
 * 想要真正好用的话题聚合，得把 topicVector 换成 embedding —— 那是另一件事，
 * 而且会让已存的所有向量失效，需要迁移。别指望调这个数字能解决。
 *
 * ⚠️ 聚类**不在客户端做**。客户端拿不到向量（`relevant`/`square` 都不回传），
 *    这是刻意的：向量是话题指纹，回传等于把「这个人关心什么」也发出去。
 *    所以这个模块跑在服务端（cloud）或本机 provider（local）里。
 */

import { cosine } from './topic.ts'

/** 聚类只要求这两个字段，两个 provider 各自的卡片类型都满足。 */
export interface Clusterable {
  readonly topicVector: readonly number[]
  /** 发布者标识。本地 provider 没有这个概念，留空即可。 */
  readonly publisher?: string
}

export interface Cluster<T extends Clusterable> {
  /** 簇内卡片，时间倒序。 */
  readonly cards: readonly T[]
  /** 簇心（成员向量的均值，未归一化 —— 只用于簇内比较）。 */
  readonly centroid: readonly number[]
}

/**
 * @param floor 归簇阈值。默认 0.45 —— 理由见文件头那段实测数据，别凭感觉调。
 */
export function cluster<T extends Clusterable>(
  cards: readonly T[],
  floor = 0.45,
): Cluster<T>[] {
  const clusters: { cards: T[], centroid: number[] }[] = []

  for (const card of cards) {
    let best: { c: typeof clusters[number], score: number } | undefined
    for (const c of clusters) {
      const score = cosine(card.topicVector, normalize(c.centroid))
      if (score >= floor && (best === undefined || score > best.score)) {
        best = { c, score }
      }
    }
    if (best === undefined) {
      clusters.push({ cards: [card], centroid: [...card.topicVector] })
      continue
    }
    best.c.cards.push(card)
    // 增量更新簇心：新均值 = 旧均值 + (新值 - 旧均值) / n
    const n = best.c.cards.length
    for (let i = 0; i < best.c.centroid.length; i++) {
      const v = best.c.centroid[i] ?? 0
      best.c.centroid[i] = v + ((card.topicVector[i] ?? 0) - v) / n
    }
  }

  // 人多的话题排前面 —— 「三个人都在想这件事」比「某人昨天说了句话」重要
  return clusters.sort((a, b) => distinctPublishers(b) - distinctPublishers(a))
}

/**
 * 簇里有多少个不同的人。
 *
 * 注意是**人数**不是卡片数：一个人发五张同话题的卡，不该让这个话题
 * 显得很热闹。和 k-匿名门槛用的是同一个口径。
 */
export function distinctPublishers(c: { cards: readonly Clusterable[] }): number {
  return new Set(c.cards.map(x => x.publisher ?? '')).size
}

function normalize(v: readonly number[]): number[] {
  let sum = 0
  for (const n of v) sum += n * n
  const norm = Math.sqrt(sum)
  if (norm === 0) return [...v]
  return v.map(n => n / norm)
}
