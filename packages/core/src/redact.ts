/**
 * 处境剥离与本地风险自评。
 *
 * 设计文档 4.2 ⑥：只留观点，剥掉处境。
 *   ✅「远程办公对初级员工不利，反馈回路太长」—— 有价值且安全
 *   ❌「我们公司要求返岗，我在犹豫」—— 有情境、可识别
 *
 * 这里的实现是**启发式**，不是保障。真正的保障是「用户过审」那一步。
 * 一定要记住失败的不对称性：这些规则漏掉一条，不是事故；
 * 但如果哪天有人把它们改成「自动放行」的依据，那就是事故。
 */

/** 第一人称处境的强信号。命中越多，越像在讲自己的事而不是讲观点。 */
const SITUATIONAL_PATTERNS: readonly RegExp[] = [
  /我(们)?(的)?(公司|团队|老板|领导|同事|下属|客户|导师)/,
  /我(的)?(老婆|老公|妻子|丈夫|孩子|儿子|女儿|父母|爸|妈)/,
  /我(在|去|从)[一-龥]{2,6}(工作|上班|读书|上学|生活)/,
  /(上|这|下)(周|个月|季度|年)我/,
  /我(刚|才|已经|正在)[一-龥]{0,4}(离职|入职|辞职|跳槽|确诊|分手|离婚)/,
]

/** 可识别的具体实体。 */
const IDENTIFYING_PATTERNS: readonly RegExp[] = [
  /\d{4}年\d{1,2}月/,           // 精确日期
  /\d+\s*(人|名)(的)?(团队|公司)/, // 团队规模
  /[A-Z][a-zA-Z]{2,}\s*(公司|科技|集团)/,
  /\d{6,}/,                     // 长数字：工号、手机号、身份证片段
  /[\w.+-]+@[\w-]+\.[\w.]+/,    // 邮箱
]

export interface RiskAssessment {
  readonly level: 'low' | 'medium' | 'high'
  /** 命中的规则说明，给用户看的，不是给机器判断用的。 */
  readonly reasons: readonly string[]
}

/**
 * 本地风险自评。零网络、零 token。
 *
 * 返回值只用于：
 *   1. UI 上给用户一个提示（「这条里可能有你公司的信息」）
 *   2. 排序，把低风险的排前面
 *
 * **绝不用于自动拦截或自动放行。**
 */
export function assessRisk(text: string): RiskAssessment {
  const reasons: string[] = []

  for (const re of SITUATIONAL_PATTERNS) {
    if (re.test(text)) {
      reasons.push('含第一人称处境描述')
      break
    }
  }

  for (const re of IDENTIFYING_PATTERNS) {
    if (re.test(text)) {
      reasons.push('含可识别的具体信息（日期／规模／联系方式等）')
      break
    }
  }

  // 组合泄露：设计文档反复强调，单句安全不代表拼起来安全。
  // 这里只能提示单条内的组合，跨条组合本地测不出来——
  // 那一层必须靠服务端的 k-匿名门槛兜。
  const level: RiskAssessment['level'] =
    reasons.length >= 2 ? 'high' : reasons.length === 1 ? 'medium' : 'low'

  return { level, reasons }
}

/**
 * 生成给模型的摘要指令。
 *
 * 把「剥离处境」这条规则写进 prompt，而不是事后正则清洗——
 * 让模型一开始就不产出处境细节，比产出后再删干净。
 */
export function buildSummaryPrompt(conversation: string): string {
  return [
    '下面是一段用户与 AI 的对话。请提取用户表达出的**一个**核心观点。',
    '',
    '严格要求：',
    '1. 只写观点和理由，不写任何处境细节。',
    '   ✅「远程办公对初级员工不利，因为反馈回路太长」',
    '   ❌「我们公司要求返岗，我在犹豫」',
    '2. 删掉一切可识别信息：公司名、人名、地名、日期、团队规模、职位。',
    '3. 不要写「用户认为」，直接写观点本身，用第一人称陈述。',
    '4. 观点 60 字以内，理由 80 字以内。',
    '5. 如果这段对话里没有可提取的判断性观点（比如只是在写代码、查资料），',
    '   只输出 NONE 三个字母，不要编造。',
    '',
    '输出 JSON，不要包裹在代码块里：',
    '{"claim": "...", "reasoning": "..."} 或 {"claim": "NONE"}',
    '',
    '--- 对话开始 ---',
    conversation,
    '--- 对话结束 ---',
  ].join('\n')
}

/** 解析模型返回。模型不听话是常态，这里必须扛得住。 */
export function parseSummary(raw: string): { claim: string, reasoning?: string } | null {
  const text = raw.trim()
  if (text === 'NONE' || text.includes('"NONE"')) return null

  // 模型经常无视「不要包裹代码块」
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')

  let parsed: unknown
  try {
    parsed = JSON.parse(unfenced)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>

  const claim = typeof obj['claim'] === 'string' ? obj['claim'].trim() : ''
  if (claim.length === 0 || claim === 'NONE') return null

  const reasoning = typeof obj['reasoning'] === 'string' ? obj['reasoning'].trim() : ''
  return reasoning.length > 0 ? { claim, reasoning } : { claim }
}
