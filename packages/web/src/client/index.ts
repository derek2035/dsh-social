/**
 * @dsh-social/web 浏览器半。
 *
 * 注册一个整页视图「广场」，和「对话」「轨迹」并列成一个 tab。
 *
 * 为什么不是独立页面：DSH 的 root 级槽只有 sidebar.* 和 settings.*，
 * 没有全屏路由这回事；而 sidebar.workspaces 是 single 且已被 ui-workspace
 * 占死，加不了侧边栏分组。conversation.view 是这个宿主里能拿到的最大画布。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// 仅类型导入：把 conversation.* 的槽名合并进槽表。声明槽的是 ui-conversation。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SquareView } from './SquareView.tsx'

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'social-square',
    // 排在轨迹（10）之后
    order: 20,
    label: () => '广场',
  }, SquareView))
}
