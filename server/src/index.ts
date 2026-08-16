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
import { verifyRequest } from './verify.ts'

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
}

const MAX_BODY_BYTES = 64 * 1024

export function createSocialServer(config: ServerConfig = {}) {
  const store = new ServerStore()
  const k = config.kAnonymityThreshold ?? 5
  const floor = config.similarityFloor ?? 0.25

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

  function publish(req: IncomingMessage, res: ServerResponse, raw: string): void {
    const auth = verifyRequest(raw, header(req, 'x-social-key'), header(req, 'x-social-signature'))
    if (!auth.ok) return send(res, 401, { error: auth.reason })
    if (store.isBanned(auth.publicKey)) return send(res, 403, { error: 'banned' })

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
    if (!Array.isArray(body.topicVector) || body.topicVector.some(n => typeof n !== 'number')) {
      return send(res, 400, { error: 'topicVector 必须是数字数组' })
    }
    // ephemeralId 声称的身份必须和验签用的公钥一致，否则可以冒名发布
    if (body.ephemeralId !== auth.publicKey) {
      return send(res, 400, { error: 'ephemeralId 与签名公钥不一致' })
    }

    const card: ServerCard = {
      cardId: randomUUID(),
      claim: body.claim,
      ...(typeof body.reasoning === 'string' ? { reasoning: body.reasoning } : {}),
      topicVector: body.topicVector as number[],
      publisher: auth.publicKey,
      createdAt: Date.now(),
    }
    store.add(card)
    send(res, 200, { cardId: card.cardId })
  }

  function retract(req: IncomingMessage, res: ServerResponse, raw: string, cardId: string): void {
    const auth = verifyRequest(raw, header(req, 'x-social-key'), header(req, 'x-social-signature'))
    if (!auth.ok) return send(res, 401, { error: auth.reason })

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
    if (card.publisher !== auth.publicKey) return send(res, 403, { error: '不是发布者' })

    store.remove(cardId)
    sendEmpty(res, 204)
  }

  function relevant(res: ServerResponse, raw: string): void {
    let body: { topicVector?: unknown, limit?: unknown }
    try { body = JSON.parse(raw) } catch { return send(res, 400, { error: 'bad json' }) }
    if (!Array.isArray(body.topicVector)) return send(res, 400, { error: 'topicVector 必填' })

    const vector = body.topicVector as number[]
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
    close: (): Promise<void> => new Promise((resolve) => { server.close(() => { resolve() }) }),
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
