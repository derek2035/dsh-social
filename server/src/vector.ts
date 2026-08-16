/**
 * 入站向量的校验与归一化。
 *
 * ★ 为什么必须有这一层：
 *
 * core 里的 `cosine()` 实际上是**点积**，它成立的前提是两个向量都已 L2 归一化
 * ——本地场景下成立，因为向量都是 topicVector() 自己算的。但服务端收的是
 * 客户端给的向量，前提不再自动成立：
 *
 *   - 查询时传一个模长很大的向量 → 和任何卡片的点积都超过相似度阈值
 *     → 话题范围形同虚设，一次请求就能把卡池当列表拉
 *   - 发布时存一个模长很大的向量 → 这张卡会匹配所有人的所有查询
 *
 * 所以入站向量一律：校验维度、校验有限性、**服务端自己重新归一化**。
 * 归一化而不是拒绝，是因为善意客户端的浮点误差不该被当成攻击；
 * 而对攻击者来说，归一化之后放大模长这条路就没有收益了。
 */

import { TOPIC_DIM } from '@dsh-social/core'

export type VectorResult =
  | { readonly ok: true, readonly vector: number[] }
  | { readonly ok: false, readonly reason: string }

export function normalizeIncoming(raw: unknown): VectorResult {
  if (!Array.isArray(raw)) return { ok: false, reason: 'topicVector 必须是数组' }
  if (raw.length !== TOPIC_DIM) {
    return { ok: false, reason: `topicVector 维度必须是 ${TOPIC_DIM}，收到 ${raw.length}` }
  }

  const vec = new Array<number>(TOPIC_DIM)
  let sumSquares = 0
  for (let i = 0; i < TOPIC_DIM; i++) {
    const n = raw[i]
    // NaN 和 Infinity 会污染后续所有比较，必须在入口挡掉
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      return { ok: false, reason: `topicVector[${i}] 不是有限数字` }
    }
    vec[i] = n
    sumSquares += n * n
  }

  const norm = Math.sqrt(sumSquares)
  // 零向量是合法输入（空文本的 topicVector 就是零向量），原样放行：
  // 它和任何向量的点积都是 0，匹配不到东西，无害。
  if (norm === 0) return { ok: true, vector: vec }

  for (let i = 0; i < TOPIC_DIM; i++) vec[i] = (vec[i] as number) / norm
  return { ok: true, vector: vec }
}
