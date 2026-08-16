/**
 * 把别人的发言注入会话流。
 *
 * ★★ 这是全项目唯一一处**主动往用户会话里写东西**的代码，改之前读完这段 ★★
 *
 * 机制：`user/message` + `source: { kind: 'plugin', form: 'snapshot' }`。
 * 这是 DSH 自己的上下文注入机制（time-context、tmux-context 都用它），
 * 渲染成「上下文注入」行。
 *
 * 三个必须知道的后果 —— 它们是这个开关默认关闭的全部理由：
 *
 *   ① **进模型上下文。** user/message 是三个 surface 事件之一，
 *      surface 的定义就是「模型可见」。别人的话会进 prompt，每轮都花 token。
 *   ② **AI 会接话。** 它看得见，就可能主动评论陌生人的观点 ——
 *      设计文档 7.3 说的「打断」。
 *   ③ **落进你本机的会话日志。** 别人的话被持久化在你的机器上，
 *      永久保留 —— 设计文档 7.1 列的第一条隐私顾虑。
 *
 * 用 `form: 'snapshot'` 而不是逐条追加，是为了让 token 成本有上界：
 * 快照是可替换的，只带「最近 N 条」而不是不断累积的完整记录。
 *
 * 设计文档第 7 节把「进模型上下文」划给了阶段 4 房间模式。
 * 这个开关就是那条线 —— 打开它等于进入房间模式，
 * 所以它必须是用户的显式选择，不能是我们替他做的决定。
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { CardId, TopicMessage } from '@dsh-social/core'

/** 一次快照最多带多少条。超了只保留最新的 —— 上下文是有成本的。 */
const MAX_IN_SNAPSHOT = 12

export interface TopicFeed {
  readonly topicId: CardId
  readonly title: string
  readonly messages: readonly TopicMessage[]
}

/**
 * 把若干话题的最新发言合成一条快照注入会话。
 *
 * 没有任何发言时**不注入** —— 空快照也会占 prompt，而且会在会话流里
 * 留下一行什么都没有的「上下文注入」，看着像坏了。
 */
export function injectTopics(
  session: Session,
  feeds: readonly TopicFeed[],
  plugin: string,
): boolean {
  const withMessages = feeds.filter(f => f.messages.length > 0)
  if (withMessages.length === 0) return false

  const sections = withMessages.map((feed) => {
    const recent = feed.messages.slice(-MAX_IN_SNAPSHOT)
    const body = recent
      .map(m => `路人${m.alias}：${m.text}`)
      .join('\n')
    return { name: `话题 · ${feed.title}`, text: body }
  })

  const text = [
    '以下是你关注的话题里其他人的发言。他们是匿名的陌生人，',
    '每个话题里的代号只在该话题内稳定，跨话题无法对应到同一个人。',
    '',
    ...sections.map(s => `【${s.name}】\n${s.text}`),
  ].join('\n')

  session.append('user/message', createUserMessage({
    source: { kind: 'plugin', plugin, form: 'snapshot', sections },
    content: [{ type: 'text', text }],
  }), { surfaceOp: 'append' })

  return true
}
