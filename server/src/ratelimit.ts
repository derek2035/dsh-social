/**
 * 按公钥的令牌桶限流。
 *
 * 为什么这层不能省：identity.ts 里写清楚了「删掉密钥就能绕过封禁」——
 * 身份层拦不住刷屏。真正的防滥用靠的是限流和内容审核，
 * 封禁只是给重复作恶加一点成本。
 *
 * 进程内状态，重启即清。多实例部署时要换成共享存储（Redis 之类），
 * 但那时候整个部署形态都变了，不提前设计。
 */

interface Bucket {
  tokens: number
  lastRefill: number
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>()

  private readonly capacity: number
  private readonly refillPerSec: number

  // 不用参数属性 —— node 的 --experimental-strip-types 是纯剥离，不支持
  constructor(capacity: number, refillPerSec: number) {
    this.capacity = capacity
    this.refillPerSec = refillPerSec
  }

  /** @returns true 放行，false 超限 */
  take(key: string, now: number): boolean {
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, lastRefill: now }
    const elapsedSec = Math.max(0, now - bucket.lastRefill) / 1000
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSec * this.refillPerSec)
    bucket.lastRefill = now

    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket)
      return false
    }
    bucket.tokens -= 1
    this.buckets.set(key, bucket)
    return true
  }
}
