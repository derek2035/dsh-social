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
import { cluster, cosine, distinctPublishers } from '@dsh-social/core'
import { ServerStore, type ServerCard } from './store.ts'
import { verifyRequest, CLOCK_SKEW_MS } from './verify.ts'
import { normalizeIncoming } from './vector.ts'
import { RateLimiter } from './ratelimit.ts'
import { aliasFor } from './alias.ts'

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
  /** 读操作配额（按来源 IP）。k-匿名是逐查询过滤，没有读限流就能被逐步逼近。 */
  readonly readBurst?: number
  readonly readPerSec?: number
  /**
   * ★ 话题广场：GET /v1/cards/square 返回全部卡片，**完全绕过 k-匿名**。
   *
   * 默认关闭。它存在的唯一理由是「还没有用户时快速测通流程」——
   * 没有别人发卡，k-匿名门槛永远满足不了，广场会一直是空的，没法验证链路。
   *
   * 开着它上公网 = 任何人都能拉到所有人发过的全部卡片。
   * 上线前必须关掉。启动时会大声警告，别把警告当噪音。
   */
  readonly devPublicSquare?: boolean
}

/** claim 和 reasoning 的长度上限。卡片是一句观点，不是文章。 */
const MAX_CLAIM_CHARS = 500
const MAX_REASONING_CHARS = 1000
/** 话题内一条发言的长度上限。是讨论不是长文。 */
const MAX_MESSAGE_CHARS = 800

const MAX_BODY_BYTES = 64 * 1024

export function createSocialServer(config: ServerConfig = {}) {
  const store = new ServerStore(config.dbPath ?? ':memory:')
  const k = config.kAnonymityThreshold ?? 5
  const floor = config.similarityFloor ?? 0.25
  // 写操作限流：默认允许攒 10 次、每分钟回 6 次。
  // 正常用户一天发不了几条，这个额度绰绰有余；刷屏的会被卡住。
  const writeLimiter = new RateLimiter(config.writeBurst ?? 10, config.writePerSec ?? 0.1)
  // 读操作按来源 IP 限流。k-匿名是逐查询过滤，攻击者可以变换查询向量逐步逼近，
  // 限流是把「逐步逼近」的成本抬上去的那一半。
  const readLimiter = new RateLimiter(config.readBurst ?? 60, config.readPerSec ?? 1)
  const publicSquare = config.devPublicSquare ?? false

  if (publicSquare) {
    console.warn('')
    console.warn('  ⚠️  话题广场已开启（devPublicSquare）')
    console.warn('     /v1/cards/square 会返回**所有人的全部卡片**，完全绕过 k-匿名。')
    console.warn('     这是给「还没有用户时测通流程」用的开关，对外开放前必须关掉。')
    console.warn('')
  }

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
      if (!allowRead(req, res)) return
      return relevant(res, raw)
    }
    if (req.method === 'GET' && url.pathname === '/v1/cards/square') {
      if (!allowRead(req, res)) return
      return square(res, url)
    }
    const msgMatch = /^\/v1\/cards\/([^/]+)\/messages$/.exec(url.pathname)
    if (msgMatch !== null) {
      const cardId = decodeURIComponent(msgMatch[1] ?? '')
      if (req.method === 'POST') return postMessage(req, res, raw, cardId)
      if (req.method === 'GET') {
        if (!allowRead(req, res)) return
        return listMessages(res, url, cardId)
      }
      return send(res, 405, { error: 'method not allowed' })
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
    // 讨论也是内容。卡片真删了，它下面的发言不能留着变成孤儿。
    store.removeMessagesOf(cardId)
    sendEmpty(res, 204)
  }

  /**
   * 话题广场：返回全部卡片，不做 k-匿名过滤。
   *
   * 关着的时候返回 404 而不是 403 —— 对外不暴露「这里有个开关」这件事。
   */
  function square(res: ServerResponse, url: URL): void {
    if (!publicSquare) return send(res, 404, { error: 'not found' })

    const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200)
    const all = store.all()
    const recent = [...all].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)

    // 按话题分组。时间流水账看不出「有多少人在想同一件事」，
    // 而那是这个产品唯一的价值主张。
    const groups = cluster(recent).map(c => ({
      // 用簇内最新那条的正文当话题名 —— 不做关键词抽取：
      // 64 维哈希词袋抽出来的「关键词」多半是噪音，不如直接给人看原句
      title: c.cards[0]?.claim ?? '',
      /** 有多少个**不同的人**在这个话题下发过。和 k-匿名同口径。 */
      voices: distinctPublishers(c),
      cards: c.cards.map(x => ({
        cardId: x.cardId,
        claim: x.claim,
        ...(x.reasoning === undefined ? {} : { reasoning: x.reasoning }),
        createdAt: x.createdAt,
        // publisher 和 topicVector 都不返回 —— 广场绕过的是 k-匿名，
        // 不是匿名本身。「谁发的」和「话题指纹」在任何模式下都不出服务端。
      })),
    }))

    send(res, 200, { groups, total: all.length })
  }

  /**
   * 在一个话题下发言。
   *
   * 话题 id 就是那张卡片的 id —— 话题不是独立实体，它是「一张卡片
   * 加上它引发的讨论」。这样撤回卡片就自然地带走整场讨论，
   * 不需要额外的生命周期管理。
   */
  function postMessage(
    req: IncomingMessage,
    res: ServerResponse,
    raw: string,
    cardId: string,
  ): void {
    const author = authorizeWrite(req, res, raw)
    if (author === undefined) return

    if (store.get(cardId) === undefined) {
      return send(res, 404, { error: '话题不存在（卡片可能已被撤回）' })
    }

    let body: { text?: unknown, cardId?: unknown }
    try { body = JSON.parse(raw) } catch { return send(res, 400, { error: 'bad json' }) }
    // 签名覆盖的是 body 里的 cardId，必须和路径一致，否则一个签名能被挪到别的话题
    if (body.cardId !== cardId) {
      return send(res, 400, { error: '签名覆盖的 cardId 与路径不一致' })
    }
    if (typeof body.text !== 'string' || body.text.trim().length === 0) {
      return send(res, 400, { error: 'text 必填' })
    }
    if (body.text.length > MAX_MESSAGE_CHARS) {
      return send(res, 400, { error: `发言超过 ${MAX_MESSAGE_CHARS} 字` })
    }

    const message = {
      messageId: randomUUID(),
      cardId,
      publisher: author,
      text: body.text,
      createdAt: Date.now(),
    }
    store.addMessage(message)
    send(res, 200, { messageId: message.messageId, alias: aliasFor(author, cardId) })
  }

  /**
   * 拉一个话题的发言。
   *
   * 不验签：话题内容本来就是公开的（能看到卡片就能看到讨论）。
   * 但**绝不返回 publisher**，只返回每话题化名 —— 见 alias.ts 文件头。
   */
  function listMessages(res: ServerResponse, url: URL, cardId: string): void {
    const since = Number(url.searchParams.get('since') ?? 0) || 0
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200)
    const messages = store.messages(cardId, since, limit).map(m => ({
      messageId: m.messageId,
      alias: aliasFor(m.publisher, cardId),
      text: m.text,
      createdAt: m.createdAt,
    }))
    send(res, 200, { messages })
  }

  /** 读限流按来源 IP —— 读操作不验签，没有公钥可依。 */
  function allowRead(req: IncomingMessage, res: ServerResponse): boolean {
    const ip = req.socket.remoteAddress ?? 'unknown'
    if (readLimiter.take(ip, Date.now())) return true
    send(res, 429, { error: '查询过于频繁' })
    return false
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
