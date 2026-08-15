/**
 * 轮次筛选启发式。
 *
 * 目标：在花钱调 LLM 之前挡掉绝大多数轮次。
 *
 * 设计文档的原则是「只在 AI 不擅长的地方引入人」：
 *   · 事实性问题（怎么修这个报错）→ AI 已经比人强，引入他人是噪音
 *   · 判断性问题（这个 offer 要不要接）→ 别人的处境和选择有用
 *
 * 而 DSH 当前的用户在写代码，所以这个过滤器会非常严。
 * **通过率本身就是一个信号**：如果 100 个轮次里 0 个够格，
 * 那不是 bug，是设计文档 10.1 那个宿主风险的实测证据。
 */

export interface TurnStats {
  readonly turnIndex: number
  readonly userText: string
  readonly assistantChars: number
  readonly toolCalls: number
}

export interface Verdict {
  readonly worth: boolean
  readonly reason: string
}

export interface HeuristicConfig {
  readonly minUserChars: number
  readonly minAssistantChars: number
  /** 两次提议之间至少间隔几个轮次。防止连续打扰。 */
  readonly cooldownTurns: number
}

export const DEFAULT_HEURISTICS: HeuristicConfig = {
  minUserChars: 80,
  minAssistantChars: 200,
  cooldownTurns: 3,
}

/** 判断性表述的弱信号。 */
const JUDGEMENTAL =
  /觉得|认为|应该|要不要|值不值|该不该|选择|建议|利弊|权衡|担心|纠结|后悔|倾向|宁可|不如|到底/

/** 干活的强信号——命中就直接排除。 */
const OPERATIONAL =
  /报错|error|exception|traceback|stack|编译|部署|安装|依赖|版本|语法|函数|变量|接口|重构|单元测试/i

export function judge(
  stats: TurnStats,
  turnsSinceLastDraft: number,
  config: HeuristicConfig = DEFAULT_HEURISTICS,
): Verdict {
  if (turnsSinceLastDraft < config.cooldownTurns) {
    return { worth: false, reason: `冷却中（距上次提议 ${turnsSinceLastDraft} 轮）` }
  }
  if (stats.toolCalls > 0) {
    return { worth: false, reason: '有工具调用，是在干活不是在表达观点' }
  }
  if (stats.userText.length < config.minUserChars) {
    return { worth: false, reason: `用户输入过短（${stats.userText.length} 字）` }
  }
  if (stats.assistantChars < config.minAssistantChars) {
    return { worth: false, reason: 'AI 回复过短，话题没展开' }
  }
  if (OPERATIONAL.test(stats.userText)) {
    return { worth: false, reason: '技术操作类话题' }
  }
  if (!JUDGEMENTAL.test(stats.userText)) {
    return { worth: false, reason: '不含判断性表述' }
  }
  return { worth: true, reason: '长度够、非操作类、含判断性表述' }
}
