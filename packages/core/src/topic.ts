/**
 * 话题向量。
 *
 * 架构上的关键点：**向量在本地算，服务端只收向量和卡片正文，
 * 永远收不到原始对话。**
 *
 * 阶段 1 用一个确定性的本地哈希向量占位——够做"相似话题聚类"的
 * 粗筛，不需要 embedding 模型，不花 token，也不需要联网。
 *
 * ⚠️ 这个实现的语义能力很弱：它只能识别用词重叠，识别不了
 *    「远程办公」和「居家办公」是同一件事。真实版本应换成 embedding。
 *    换的时候注意：向量本身也可能泄露信息，维度越高越像指纹。
 */

export const TOPIC_DIM = 64

/** FNV-1a，32 位。确定性、无依赖。 */
function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * 中英文混合分词。
 * 中文按 2-gram，英文按空白＋标点切。够粗，但确定性好、无依赖。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []

  for (const m of text.matchAll(/[a-zA-Z][a-zA-Z0-9'-]*/g)) {
    const w = m[0].toLowerCase()
    if (w.length > 1) tokens.push(w)
  }

  const han = text.match(/[一-鿿]+/g) ?? []
  for (const run of han) {
    if (run.length === 1) {
      tokens.push(run)
      continue
    }
    for (let i = 0; i + 1 < run.length; i++) {
      tokens.push(run.slice(i, i + 2))
    }
  }

  return tokens
}

/** 生成 L2 归一化的话题向量。 */
export function topicVector(text: string, dim: number = TOPIC_DIM): number[] {
  const vec = new Array<number>(dim).fill(0)
  const tokens = tokenize(text)
  if (tokens.length === 0) return vec

  for (const t of tokens) {
    const h = hash32(t)
    const idx = h % dim
    // 符号位散列，减少不同词落同一维时的相互抵消偏差
    const sign = (h >>> 31) === 1 ? 1 : -1
    vec[idx] = (vec[idx] ?? 0) + sign
  }

  let norm = 0
  for (const v of vec) norm += v * v
  norm = Math.sqrt(norm)
  if (norm === 0) return vec

  for (let i = 0; i < dim; i++) {
    vec[i] = (vec[i] ?? 0) / norm
  }
  return vec
}

/** 余弦相似度。两个向量都已归一化时等价于点积。 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  for (let i = 0; i < n; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0)
  }
  return dot
}
