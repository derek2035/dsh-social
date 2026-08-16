/**
 * @dsh-social/web 浏览器半：往会话头部塞一个「广场」按钮。
 *
 * 走的是和 dsh-client-ui-jobs 一样的路子（slots.inject + slots.register），
 * 那是仓库里已经跑通的模式，不自己发明。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// 仅类型导入：把 'conversation.session.header.actions' 这个槽名合并进槽表。
// 声明槽的是 ui-conversation，不导入它这个名字在类型上不存在。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SquarePanel } from './SquarePanel.tsx'

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  // 这个槽是**会话作用域**的：没打开会话时头部不渲染，按钮自然也不出现。
  // 调试时别把这个当成挂载失败 —— register 早就成功了。
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'social-square',
      order: 30,
    }, SquarePanel),
  )
}
