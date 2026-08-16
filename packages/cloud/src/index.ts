/**
 * @dsh-social/cloud — Service Provider（联网）
 *
 * 和 local 同接口，cordis.yml 换一行切换。local 是它的行为基线。
 *
 * ★ 这是全项目**唯一**发网络请求的地方（红线④）。出口收敛在一个文件里，
 *   审计时只需要读这一个文件就能回答「什么数据离开了这台机器」。
 *
 * 离开本机的东西，穷举如下：
 *
 *   publish   → claim、reasoning、topicVector、公钥、签名
 *   retract   → cardId、公钥、签名
 *   relevant  → topicVector、limit
 *
 * 不离开本机的东西：原始对话（红线⑤）、草稿、决定记录、私钥。
 *
 * ⚠️ 决定记录（DecisionRecord）刻意**不上传**。
 *    它记的是用户丢弃了哪些草稿——那是关于「用户拒绝公开的内容」的信息。
 *    转化率是我们自己要看的指标，不是服务端需要知道的事实。
 *    所以 cloud 复用本地存储来记它，只有卡片走网络。
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import {
  JsonStore,
  SocialService,
  asCardId,
  type CardId,
  type OpinionCard,
  type RemoteCard,
  type DecisionRecord,
} from '@dsh-social/core'
import { loadIdentity, type DeviceIdentity } from './identity.ts'

export interface CloudConfig {
  /** 服务端基址，例如 https://social.example.com */
  readonly endpoint: string
  /** 单次请求超时（毫秒）。 */
  readonly timeoutMs?: number
  /** 决定记录落在哪。默认跟 local provider 同一个文件。 */
  readonly decisionStorePath?: string
}

/** 网络请求失败。和「服务端明确说没有」是两回事，不能混。 */
export class SocialNetworkError extends Error {
  override readonly name = 'SocialNetworkError'
  constructor(op: string, cause: string) {
    super(`${op} 失败：${cause}`)
  }
}

const DEFAULT_TIMEOUT_MS = 10_000

/** 用 TS 的 private，不用 #：Service 经 cordis 的 Proxy 交出去，# 的 brand check 会炸。 */
class SocialCloud extends SocialService {
  private readonly endpoint: string
  private readonly timeoutMs: number
  private readonly decisions: JsonStore
  private identity: DeviceIdentity | undefined

  constructor(ctx: Context, config: CloudConfig) {
    super(ctx)
    this.endpoint = config.endpoint.replace(/\/+$/, '')
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.decisions = new JsonStore(
      config.decisionStorePath ?? join(homedir(), '.dsh-social', 'local-store.json'),
    )
    console.log(`[social/cloud] 服务端 ${this.endpoint}`)
  }

  override async publish(card: OpinionCard): Promise<CardId> {
    // 红线②：网络出口前的最后一道闸，必须是第一行
    SocialCloud.assertApproved(card)

    const id = await this.identify()
    const body = {
      claim: card.claim,
      ...(card.reasoning === undefined ? {} : { reasoning: card.reasoning }),
      topicVector: card.topicVector,
      // 契约里叫 ephemeralId。这里放公钥——它就是这台设备的身份，
      // 服务端靠它验签，也靠它执行封禁。
      ephemeralId: id.publicKey,
    }
    const payload = JSON.stringify(body)
    const signed = id.sign(payload)
    const res = await this.request('POST', '/v1/cards', {
      body: payload,
      signed,
      publicKey: id.publicKey,
    })

    const json = await res.json() as { cardId?: string }
    if (typeof json.cardId !== 'string') {
      throw new SocialNetworkError('publish', '服务端没有返回 cardId')
    }
    return asCardId(json.cardId)
  }

  /**
   * 撤回。
   *
   * 三态必须分清，这是刻意的：
   *   204     → true   真删掉了
   *   404     → false  服务端明确说没有这张卡
   *   超时/5xx → 抛错   我们**不知道**删没删
   *
   * 把超时当成 false 返回是在撒谎——用户会以为东西已经不存在了，
   * 不会再去删第二次。撤回方向的误报是不可逆的。
   */
  override async retract(id: CardId): Promise<boolean> {
    const identity = await this.identify()
    const payload = JSON.stringify({ cardId: String(id) })
    const res = await this.request('DELETE', `/v1/cards/${encodeURIComponent(String(id))}`, {
      body: payload,
      signed: identity.sign(payload),
      publicKey: identity.publicKey,
      allowStatus: [204, 404],
    })
    return res.status === 204
  }

  /**
   * 拉相关卡片。
   *
   * ⚠️ 调用时机是个隐私决定，不是性能决定。
   *
   * 传出去的向量来自**调用方给的文本**。如果拿用户当前正在聊的内容去查，
   * 就等于持续向服务端上传他从未同意公开的话题——一个从没发布过任何东西
   * 的用户，只要装了插件，服务端就能拿到他所有话题的指纹。
   *
   * topicVector 是 64 维哈希词袋，不可直接求逆，但对短文本做字典攻击
   * （枚举常见 2-gram 反解稀疏模式）能还原相当一部分。别把「不可逆」
   * 当成「安全」。
   *
   * 所以约定：**只在用户已经按下发布之后调用它，且只用那张已公开卡片的向量。**
   * 这样上传的向量和已上传的 claim 一一对应，零额外泄露。
   * 「边聊边推荐」需要持续上传未公开话题——那个功能的代价是整条隐私红线，
   * 要做也必须是用户显式打开的开关，不能是默认行为。
   */
  override async relevant(vector: readonly number[], limit: number): Promise<RemoteCard[]> {
    const res = await this.request('POST', '/v1/cards/relevant', {
      body: JSON.stringify({ topicVector: vector, limit }),
    })
    const json = await res.json() as { cards?: unknown }
    if (!Array.isArray(json.cards)) return []

    return json.cards.flatMap((raw): RemoteCard[] => {
      const c = raw as Record<string, unknown>
      if (typeof c['cardId'] !== 'string' || typeof c['claim'] !== 'string') return []
      return [{
        id: asCardId(c['cardId']),
        claim: c['claim'],
        ...(typeof c['reasoning'] === 'string' ? { reasoning: c['reasoning'] } : {}),
      }]
    })
  }

  override async square(limit: number): Promise<RemoteCard[]> {
    const res = await this.request('GET', `/v1/cards/square?limit=${limit}`, {
      allowStatus: [404],
    })
    // 404 = 服务端没开广场（默认姿态）。不是错误，是配置。
    if (res.status === 404) return []

    const json = await res.json() as { cards?: unknown }
    if (!Array.isArray(json.cards)) return []
    return json.cards.flatMap((raw): RemoteCard[] => {
      const c = raw as Record<string, unknown>
      if (typeof c['cardId'] !== 'string' || typeof c['claim'] !== 'string') return []
      return [{
        id: asCardId(c['cardId']),
        claim: c['claim'],
        ...(typeof c['reasoning'] === 'string' ? { reasoning: c['reasoning'] } : {}),
      }]
    })
  }

  /** 只落本地。理由见文件头。 */
  override async recordDecision(record: DecisionRecord): Promise<void> {
    await this.decisions.mutate((store) => {
      store.decisions.push(record)
    })
  }

  override async listDecisions(): Promise<readonly DecisionRecord[]> {
    return (await this.decisions.read()).decisions
  }

  // ── 内部 ──────────────────────────────────────────────────

  private async identify(): Promise<DeviceIdentity> {
    this.identity ??= await loadIdentity(this.ctx)
    return this.identity
  }

  private async request(
    method: string,
    path: string,
    opts: {
      body?: string
      signed?: { readonly signature: string, readonly timestamp: string }
      publicKey?: string
      allowStatus?: readonly number[]
    } = {},
  ): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, this.timeoutMs)
    try {
      const res = await fetch(`${this.endpoint}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...(opts.signed === undefined ? {} : {
            'x-social-signature': opts.signed.signature,
            'x-social-timestamp': opts.signed.timestamp,
          }),
          ...(opts.publicKey === undefined ? {} : { 'x-social-key': opts.publicKey }),
        },
        ...(opts.body === undefined ? {} : { body: opts.body }),
      })

      const allowed = opts.allowStatus ?? []
      if (!res.ok && !allowed.includes(res.status)) {
        throw new SocialNetworkError(`${method} ${path}`, `HTTP ${res.status}`)
      }
      return res
    } catch (err) {
      if (err instanceof SocialNetworkError) throw err
      const reason = (err as Error).name === 'AbortError'
        ? `超时（${this.timeoutMs}ms）`
        : (err as Error).message
      throw new SocialNetworkError(`${method} ${path}`, reason)
    } finally {
      clearTimeout(timer)
    }
  }
}

export const name = 'social-cloud'
export const inject = ['credentials']

export function apply(ctx: Context, config: CloudConfig): void {
  ctx.plugin(SocialCloud, config)
}

export { SocialCloud }
