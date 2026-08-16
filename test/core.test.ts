import test from 'node:test'
import assert from 'node:assert/strict'

import { assessRisk, buildSummaryPrompt, parseSummary } from '../packages/core/src/redact.ts'
import { topicVector, cosine, tokenize } from '../packages/core/src/topic.ts'
import { cluster, distinctPublishers } from '../packages/core/src/cluster.ts'
import { judge, DEFAULT_HEURISTICS } from '../packages/curator/src/heuristics.ts'
import type { TurnStats } from '../packages/curator/src/heuristics.ts'

// ── 风险自评 ────────────────────────────────────────────────

test('assessRisk: 纯观点判为 low', () => {
  const r = assessRisk('远程办公对初级员工不利，因为反馈回路太长。')
  assert.equal(r.level, 'low')
})

test('assessRisk: 第一人称处境被识别', () => {
  const r = assessRisk('我们公司要求返岗，我在犹豫要不要接受。')
  assert.notEqual(r.level, 'low')
  assert.ok(r.reasons.some(x => x.includes('处境')))
})

test('assessRisk: 可识别信息被识别', () => {
  const r = assessRisk('联系我 someone@example.com 聊聊。')
  assert.notEqual(r.level, 'low')
})

test('assessRisk: 处境 + 可识别信息叠加为 high', () => {
  const r = assessRisk('我们团队就 5 人的团队，2025年3月我刚离职。')
  assert.equal(r.level, 'high')
})

test('assessRisk 只提示不拦截：high 也返回结构而非抛错', () => {
  // 这条测试守护一条架构红线：风险评估绝不能变成自动拦截。
  const r = assessRisk('我老板批评我，我们公司 20 人的团队，2024年1月')
  assert.equal(typeof r.level, 'string')
  assert.ok(Array.isArray(r.reasons))
})

// ── 摘要解析 ────────────────────────────────────────────────

test('parseSummary: 正常 JSON', () => {
  const r = parseSummary('{"claim":"远程办公不利于新人","reasoning":"反馈太慢"}')
  assert.deepEqual(r, { claim: '远程办公不利于新人', reasoning: '反馈太慢' })
})

test('parseSummary: 模型套了代码块也能解析', () => {
  const r = parseSummary('```json\n{"claim":"甲","reasoning":"乙"}\n```')
  assert.deepEqual(r, { claim: '甲', reasoning: '乙' })
})

test('parseSummary: NONE 返回 null', () => {
  assert.equal(parseSummary('NONE'), null)
  assert.equal(parseSummary('{"claim":"NONE"}'), null)
})

test('parseSummary: 垃圾输入返回 null 而不抛错', () => {
  assert.equal(parseSummary('这不是 JSON'), null)
  assert.equal(parseSummary(''), null)
  assert.equal(parseSummary('{"claim":""}'), null)
})

test('parseSummary: 缺 reasoning 时不产生 undefined 字段', () => {
  const r = parseSummary('{"claim":"甲"}')
  assert.deepEqual(r, { claim: '甲' })
  assert.ok(!('reasoning' in (r as object)))
})

test('buildSummaryPrompt 含剥离处境的指令', () => {
  const p = buildSummaryPrompt('随便什么')
  assert.ok(p.includes('不写任何处境细节'))
  assert.ok(p.includes('NONE'))
})

// ── 话题向量 ────────────────────────────────────────────────

test('tokenize: 中英混合', () => {
  const t = tokenize('远程办公 remote work')
  assert.ok(t.includes('remote'))
  assert.ok(t.includes('远程'))
})

test('topicVector: 归一化', () => {
  const v = topicVector('远程办公对初级员工不利')
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  assert.ok(Math.abs(norm - 1) < 1e-9, `范数应为 1，实际 ${norm}`)
})

test('topicVector: 空串安全', () => {
  const v = topicVector('')
  assert.equal(v.length, 64)
  assert.ok(v.every(x => x === 0))
})

test('cosine: 同文本相似度为 1', () => {
  const a = topicVector('远程办公对初级员工不利')
  assert.ok(Math.abs(cosine(a, a) - 1) < 1e-9)
})

test('cosine: 相近话题高于无关话题', () => {
  const base = topicVector('远程办公对初级员工不利，反馈回路太长')
  const near = topicVector('远程办公让初级员工的反馈回路变长')
  const far = topicVector('红烧肉要先焯水再上色')
  assert.ok(cosine(base, near) > cosine(base, far),
    `相近应更高：near=${cosine(base, near)} far=${cosine(base, far)}`)
})

// ── 轮次启发式 ──────────────────────────────────────────────

// 注意：夹具必须超过 minUserChars（80），否则会被长度规则先拦下，
// 测不到后面的规则。写这几条测试时就在这里踩了一次。
const longJudgemental =
  '我最近一直在纠结要不要接受这个新的工作安排，觉得对刚入行没多久的人来说不太公平，' +
  '但又说不清楚到底问题出在哪个环节上，想听听其他人是怎么看待这件事情的，' +
  '应该从哪几个角度去权衡比较好，实在是拿不定主意。'

function stats(over: Partial<TurnStats> = {}): TurnStats {
  return {
    turnIndex: 10,
    userText: longJudgemental,
    assistantChars: 500,
    toolCalls: 0,
    ...over,
  }
}

test('judge: 典型判断性轮次通过', () => {
  assert.equal(judge(stats(), 99, DEFAULT_HEURISTICS).worth, true)
})

test('judge: 有工具调用一律排除', () => {
  const v = judge(stats({ toolCalls: 1 }), 99)
  assert.equal(v.worth, false)
  assert.ok(v.reason.includes('工具'))
})

test('judge: 冷却期内不提议', () => {
  const v = judge(stats(), 1)
  assert.equal(v.worth, false)
  assert.ok(v.reason.includes('冷却'))
})

test('judge: 技术话题被排除（即使含判断性词且够长）', () => {
  const v = judge(stats({
    userText:
      '我觉得这个报错应该是依赖版本冲突导致的问题，要不要先升级一下再试试看呢，' +
      '纠结了好久实在没有头绪，也不知道应该从哪里入手排查比较合适，' +
      '想听听有经验的人一般是怎么处理这种情况的。',
  }), 99)
  assert.equal(v.worth, false)
  assert.ok(v.reason.includes('技术'), `实际原因：${v.reason}`)
})

test('judge: 短输入被排除', () => {
  const v = judge(stats({ userText: '要不要辞职' }), 99)
  assert.equal(v.worth, false)
  assert.ok(v.reason.includes('过短'), `实际原因：${v.reason}`)
})

test('judge: 无判断性表述被排除（够长但只是叙事）', () => {
  const v = judge(stats({
    userText:
      '今天天气不错阳光很好，我出门散了个步，然后顺路买了点菜回家做饭，' +
      '吃完之后看了会电视就睡了，中间还接了个朋友打来的电话聊了几句，' +
      '晚上又整理了一下房间，把冬天的衣服都收了起来，总的来说真是平静的一天。',
  }), 99)
  assert.equal(v.worth, false)
  assert.ok(v.reason.includes('判断性'), `实际原因：${v.reason}`)
})

// ── 话题聚类 ──────────────────────────────────────────────────

test('cluster: 高度重合的卡片归到一组', () => {
  const a = { topicVector: topicVector('远程办公对新人不利'), publisher: 'p1' }
  const b = { topicVector: topicVector('远程办公对新人不利，对资深的人有利'), publisher: 'p2' }
  const groups = cluster([a, b])
  assert.equal(groups.length, 1, `实际相似度 ${cosine(a.topicVector, b.topicVector).toFixed(3)}`)
})

test('cluster: 无关话题不会被揉到一起', () => {
  const a = { topicVector: topicVector('创业最大的成本是时间窗口'), publisher: 'p1' }
  const b = { topicVector: topicVector('把勤奋当成品质来夸是有害的'), publisher: 'p2' }
  assert.equal(cluster([a, b]).length, 2)
})

test('cluster: voices 数的是人不是卡片', () => {
  // 同一个人发两张几乎一样的卡，不该让这个话题显得有两个人在想
  const one = { topicVector: topicVector('远程办公对新人不利'), publisher: 'same' }
  const two = { topicVector: topicVector('远程办公对新人不利，对资深有利'), publisher: 'same' }
  const groups = cluster([one, two])
  assert.equal(groups.length, 1)
  assert.equal(distinctPublishers(groups[0]!), 1)
})

test('cluster: 空输入安全', () => {
  assert.deepEqual(cluster([]), [])
})

