/**
 * dsh-social 最小服务端。
 *
 * 零依赖（node:http + node:crypto），能在任何装了 Node 的地方跑。
 * 契约见 docs/02-技术架构.md 第 8 节，但注意 HANDOFF.md「cloud provider：
 * 契约里的四个洞」修正了其中两处 —— 以 HANDOFF 为准。
 *
 * 三条它必须做对的事：
 *   ① 撤回要验签且验所有权。只凭 cardId 就能删 = 把删除权发给所有读者
 *   ② k-匿名在服务端执行。客户端拿不到不足门槛的数据，不是「拿到了不显示」
 *   ③ 撤回是真删。卡片按引用渲染，删除后所有展示过它的地方同时失效
 *
 * 不做的事：不存对话（接口里根本没有上传对话这个入口）、
 * 不把 publisher 公钥返回给客户端（那等于公开谁发了什么）。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { cosine } from '@dsh-social/core'
import { ServerStore, type ServerCard } from './store.ts'
import { verifyRequest, CLOCK_SKEW_MS } from './verify.ts'
import { normalizeIncoming } from './vector.ts'
import { RateLimiter } from './ratelimit.ts'

export interface ServerConfig {
  readonly port?: number
  /**
   * k-匿名门槛：一次查询命中的**不同发布者**少于这个数就返回空。
   *
   * ⚠️ 这是逐查询的过滤，不是真正的 k-匿名保证 —— 攻击者可以变换查询向量
   *    逐步逼近。真实部署还需要查询频率限制和向量粒度约束。
   *    但它挡住了最基本的那条：单人自问自答式的信息回流。
   */
  readonly kAnonymityThreshold?: number
  readonly similarityFloor?: number
  /** SQLite 文件路径。默认 ':memory:'（重启即失，测试用）。 */
  readonly dbPath?: string
  /** 每个公钥的写操作配额：桶容量 / 每秒补充数。 */
  readonly writeBurst?: number
  readonly writePerSec?: number
}

/** claim 和 reasoning 的长度上限。卡片是一句观点，不是文章。 */
const MAX_CLAIM_CHARS = 500
const MAX_REASONING_CHARS = 1000

const MAX_BODY_BYTES = 64 * 1024

export function createSocialServer(config: ServerConfig = {}) {
  const store = new ServerStore(config.dbPath ?? ':memory:')
  const k = config.kAnonymityThreshold ?? 5
  const floor = config.similarityFloor ?? 0.25
  // 写操作限流：默认允许攒 10 次、每分钟回 6 次。
  // 正常用户一天发不了几条，这个额度绰绰有余；刷屏的会被卡住。
  const writeLimiter = new RateLimiter(config.writeBurst ?? 10, config.writePerSec ?? 0.1)

  // nonce 表只需要覆盖时间窗，定期清掉窗外的，避免无限增长
  const pruneTimer = setInterval(() => {
    store.pruneNonces(Date.now() - CLOCK_SKEW_MS)
  }, 60_000)
  pruneTimer.unref()

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      send(res, 500, { error: (err as Error).message })
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const raw = await readBody(req)

    if (req.method === 'POST' && url.pathname === '/v1/cards') {
      return publish(req, res, raw)
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/v1/cards/')) {
      return retract(req, res, raw, decodeURIComponent(url.pathname.slice('/v1/cards/'.length)))
    }
    if (req.method === 'POST' && url.pathname === '/v1/cards/relevant') {
      return relevant(res, raw)
    }
    send(res, 404, { error: 'not found' })
  }

  /**
   * 写操作的统一前置：验签 → 防重放 → 封禁 → 限流。
   *
   * 顺序是刻意的：先证明「你是谁」，才谈得上「你是不是被封了」和
   * 「你的配额还剩多少」。反过来会让未验签的请求也能消耗别人的配额。
   */
  function authorizeWrite(
    req: IncomingMessage,
    res: ServerResponse,
    raw: string,
  ): string | undefined {
    const now = Date.now()
    const signature = header(req, 'x-social-signature')
    const auth = verifyRequest(
      raw,
      header(req, 'x-social-key'),
      signature,
      header(req, 'x-social-timestamp'),
      now,
    )
    if (!auth.ok) { send(res, 401, { error: auth.reason }); return undefined }

    // 签名本身就是天然的 nonce：内容和时间戳都在里面
    if (!store.claimNonce(signature as string, now)) {
      send(res, 409, { error: '请求已被处理过（重放）' })
      return undefined
    }
    if (store.isBanned(auth.publicKey)) { send(res, 403, { error: 'banned' }); return undefined }
    if (!writeLimiter.take(auth.publicKey, now)) {
      send(res, 429, { error: '写入过于频繁' })
      return undefined
    }
    return auth.publicKey
  }

  function publish(req: IncomingMessage, res: ServerResponse, raw: string): void {
    const publisher = authorizeWrite(req, res, raw)
    if (publisher === undefined) return

    let body: {
      claim?: unknown
      reasoning?: unknown
      topicVector?: unknown
      ephemeralId?: unknown
    }
    try { body = JSON.parse(raw) } catch { return send(res, 400, { error: 'bad json' }) }

    if (typeof body.claim !== 'string' || body.claim.trim().length === 0) {
      return send(res, 400, { error: 'claim 必填' })
    }
    if (body.claim.length > MAX_CLAIM_CHARS) {
      return send(res, 400, { error: `claim 超过 ${MAX_CLAIM_CHARS} 字` })
    }
    if (typeof body.reasoning === 'string' && body.reasoning.length > MAX_REASONING_CHARS) {
      return send(res, 400, { error: `reasoning 超过 ${MAX_REASONING_CHARS} 字` })
    }

    // ★ 入站向量必须重新归一化，理由见 vector.ts
    const vector = normalizeIncoming(body.topicVector)
    if (!vector.ok) return send(res, 400, { error: vector.reason })

    // ephemeralId 声称的身份必须和验签用的公钥一致，否则可以冒名发布
    if (body.ephemeralId !== publisher) {
      return send(res, 400, { error: 'ephemeralId 与签名公钥不一致' })
    }

    const card: ServerCard = {
      cardId: randomUUID(),
      claim: body.claim,
      ...(typeof body.reasoning === 'string' ? { reasoning: body.reasoning } : {}),
      topicVector: vector.vector,
      publisher,
      createdAt: Date.now(),
    }
    store.add(card)
    send(res, 200, { cardId: card.cardId })
  }

  function retract(req: IncomingMessage, res: ServerResponse, raw: string, cardId: string): void {
    const requester = authorizeWrite(req, res, raw)
    if (requester === undefined) return

    // 签名覆盖的是请求体里的 cardId，必须和 URL 上的一致，
    // 否则一个签名可以被挪去删任意卡片
    let body: { cardId?: unknown }
    try { body = JSON.parse(raw) } catch { return send(res, 400, { error: 'bad json' }) }
    if (body.cardId !== cardId) {
      return send(res, 400, { error: '签名覆盖的 cardId 与路径不一致' })
    }

    const card = store.get(cardId)
    if (!card) return sendEmpty(res, 404)
    // 只有发布者能删。少了这一条，relevant() 返回的 cardId 就成了删除令牌。
    if (card.publisher !== requester) return send(res, 403, { error: '不是发布者' })

    store.remove(cardId)
    sendEmpty(res, 204)
  }

  function relevant(res: ServerResponse, raw: string): void {
    let body: { topicVector?: unknown, limit?: unknown }
    try { body = JSON.parse(raw) } catch { return send(res, 400, { error: 'bad json' }) }
    // ★ 查询向量同样必须归一化 —— 不然一个大模长向量就能匹配所有卡片，
    //   把话题范围整个绕过，把卡池当列表拉
    const normalized = normalizeIncoming(body.topicVector)
    if (!normalized.ok) return send(res, 400, { error: normalized.reason })

    const vector = normalized.vector
    const limit = typeof body.limit === 'number' ? Math.min(body.limit, 50) : 10

    const hits = store.all()
      .map(c => ({ card: c, score: cosine(vector, c.topicVector) }))
      .filter(h => h.score >= floor)
      .sort((a, b) => b.score - a.score)

    // ★ k-匿名：按**不同发布者**计数，不是按卡片数。
    //   一个人发 10 张卡不该让他自己的话题变得「可推荐」。
    const publishers = new Set(hits.map(h => h.card.publisher))
    if (publishers.size < k) return send(res, 200, { cards: [] })

    send(res, 200, {
      cards: hits.slice(0, limit).map(h => ({
        cardId: h.card.cardId,
        claim: h.card.claim,
        ...(h.card.reasoning === undefined ? {} : { reasoning: h.card.reasoning }),
        // 注意：publisher 不返回。返回了就等于公开谁发了什么。
      })),
    })
  }

  return {
    server,
    store,
    listen: (port = config.port ?? 0): Promise<number> =>
      new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => {
          const addr = server.address()
          const actual = typeof addr === 'object' && addr !== null ? addr.port : port
          console.log(`[social/server] http://127.0.0.1:${actual}  k-匿名门槛 ${k}`)
          resolve(actual)
        })
      }),
    close: (): Promise<void> => new Promise((resolve) => {
      clearInterval(pruneTimer)
      server.close(() => { store.close(); resolve() })
    }),
  }
}

// ── 工具 ────────────────────────────────────────────────────────

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(payload)
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status)
  res.end()
}
