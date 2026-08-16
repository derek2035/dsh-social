/**
 * @dsh-social/web — 宿主半
 *
 * 只做一件事：把话题广场需要的数据，通过宿主自己的 webserver 暴露给浏览器。
 *
 * 为什么不让浏览器直接打社交服务端：
 *   ① 那要求服务端配 CORS，等于把 API 对任意网页开放
 *   ② 服务端地址是配置项，浏览器不该知道它 —— 换 endpoint 不该动前端
 *   ③ 网络出口收敛在 provider 是红线④，浏览器直连等于开了第二个出口
 *
 * 所以浏览器只跟自己的宿主说话，宿主转发给 provider。
 */

import { asCardId } from '@dsh-social/core'
import type { Context } from '@deepseek-ai/cordis'
// 仅类型导入：解析 ctx.webServer 的 Context 声明合并
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const name = 'social-web'
export const inject = ['social', 'webServer']

/** 广场数据的路由。和 DSH 自己的 /plugins、/api 都不冲突。 */
const SQUARE = '/social-api/square'
/** 撤回。POST，body 是 { cardId }。 */
const RETRACT = '/social-api/retract'

export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: SQUARE,
      handler: (_req: IncomingMessage, res: ServerResponse) => { void serveSquare(ctx, res) },
    }),
    'social-web: 广场路由',
  )
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: RETRACT,
      handler: (req: IncomingMessage, res: ServerResponse) => { void serveRetract(ctx, req, res) },
    }),
    'social-web: 撤回路由',
  )
  console.log(`[social/web] 广场数据路由 ${SQUARE}`)
}

async function serveSquare(ctx: Context, res: ServerResponse): Promise<void> {
  try {
    const [groups, decisions] = await Promise.all([
      ctx.social.square(50),
      ctx.social.listDecisions(),
    ])
    // 「我发的」由**本地决定记录**推导，不给服务端加「列出我的卡片」接口。
    // 那种接口等于让客户端能枚举自己的全部发言，是多余的攻击面 ——
    // 发布者本来就知道自己发过什么，这份记录一直在本机躺着。
    const mine = decisions
      .filter(d => d.decision === 'published' && d.cardId !== undefined)
      .map(d => String(d.cardId))
    json(res, 200, { groups, mine })
  } catch (err) {
    // 服务端没起来是常态（本地开发），不要让它变成一个吓人的红色报错。
    // 前端拿到 error 字段自己显示成「广场暂时连不上」。
    json(res, 200, { groups: [], mine: [], error: (err as Error).message })
  }
}

/**
 * 撤回。
 *
 * 这是**用户动作**，不是模型动作 —— 它走的是浏览器点击到宿主的 HTTP 路由，
 * 模型够不到（红线①的同一条理由：危险动作要放在模型够不到的地方）。
 */
async function serveRetract(
  ctx: Context,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const { cardId } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { cardId?: string }
    if (typeof cardId !== 'string') return json(res, 400, { error: 'cardId 必填' })

    const removed = await ctx.social.retract(asCardId(cardId))
    // removed=false 表示服务端明确说没有这张卡；抛错才是「不知道删没删」。
    // 这两种情况前端要分开显示，不能都说成「已撤回」。
    json(res, 200, { removed })
  } catch (err) {
    json(res, 200, { error: (err as Error).message })
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
