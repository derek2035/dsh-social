/**
 * 架构红线的测试。
 *
 * 这些测试守护的不是功能正确性，是**隐私边界**。
 * 如果哪天有人为了方便把守卫放宽，这里必须红。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { assertApproved } from '../packages/core/src/guard.ts'
import { UnapprovedCardError, asCardId, type OpinionCard } from '../packages/core/src/types.ts'
import { topicVector } from '../packages/core/src/topic.ts'

function card(over: Partial<OpinionCard> = {}): OpinionCard {
  return {
    id: asCardId('test-card'),
    claim: '远程办公对初级员工不利，反馈回路太长',
    topicVector: topicVector('远程办公对初级员工不利'),
    createdAt: Date.now(),
    userApproved: true,
    ...over,
  } as OpinionCard
}

test('红线：过审的卡片放行', () => {
  assert.doesNotThrow(() => assertApproved(card()))
})

test('红线：userApproved 不为 true 一律拒绝', () => {
  // 类型上 userApproved 是字面量 true，但运行时数据可能来自 JSON、
  // 来自旧版本、来自 bug。守卫不能只依赖类型。
  for (const bad of [false, undefined, null, 1, 'true', 'yes', {}]) {
    assert.throws(
      () => assertApproved(card({ userApproved: bad as never })),
      UnapprovedCardError,
      `userApproved=${JSON.stringify(bad)} 应被拒绝`,
    )
  }
})

test('红线：空 claim 拒绝', () => {
  for (const bad of ['', '   ', '\n\t']) {
    assert.throws(() => assertApproved(card({ claim: bad })), UnapprovedCardError)
  }
})

test('红线：缺失话题向量拒绝（说明没走正常发布路径）', () => {
  assert.throws(() => assertApproved(card({ topicVector: [] })), UnapprovedCardError)
  assert.throws(
    () => assertApproved(card({ topicVector: undefined as never })),
    UnapprovedCardError,
  )
})

test('红线：错误信息必须明确指出这是架构红线', () => {
  try {
    assertApproved(card({ userApproved: false as never }))
    assert.fail('应该抛错')
  } catch (err) {
    assert.ok(err instanceof UnapprovedCardError)
    // 让下一个读到这个报错的人立刻明白不该绕过，而不是随手加个 try/catch
    assert.ok(err.message.includes('架构红线'), `实际信息：${err.message}`)
  }
})

test('守卫不依赖 cordis —— 本文件能跑起来本身就是证明', () => {
  // 这条测试的价值在于它存在：guard.ts 一旦 import 了框架，
  // 整个文件会在导入阶段就崩，这条测试就跑不起来。
  assert.equal(typeof assertApproved, 'function')
})
