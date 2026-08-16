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

import type { Context } from '@deepseek-ai/cordis'
// 仅类型导入：解析 ctx.webServer 的 Context 声明合并
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const name = 'social-web'
export const inject = ['social', 'webServer']

/** 广场数据的路由前缀。和 DSH 自己的 /plugins、/api 都不冲突。 */
const ROUTE = '/social-api/square'

export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler: (_req: IncomingMessage, res: ServerResponse) => {
        void serve(ctx, res)
      },
    }),
    'social-web: 广场路由',
  )
  console.log(`[social/web] 广场数据路由 ${ROUTE}`)
}

async function serve(ctx: Context, res: ServerResponse): Promise<void> {
  try {
    const cards = await ctx.social.square(50)
    json(res, 200, { cards })
  } catch (err) {
    // 服务端没起来是常态（本地开发），不要让它变成一个吓人的红色报错。
    // 前端拿到 error 字段自己显示成「广场暂时连不上」。
    json(res, 200, { cards: [], error: (err as Error).message })
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
