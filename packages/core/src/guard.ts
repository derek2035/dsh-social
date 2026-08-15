/**
 * 过审守卫。
 *
 * ★ 这是整条链路上唯一的授权闸门，也是最该被测试覆盖的地方。
 *
 * 刻意放在一个**不依赖 cordis** 的独立模块里，理由有两个：
 *   1. 可以脱离框架直接单测。红线必须有测试守着，不能因为
 *      "要起整个框架才能测" 就不测了。
 *   2. 它是纯逻辑，不该知道 harness 的存在。将来换宿主、
 *      自建 App，这个文件原样搬走。
 */

import { UnapprovedCardError, type OpinionCard } from './types.ts'

/**
 * 校验一张卡片是否可以离开本机。
 *
 * 所有 provider 的 publish() 第一行都必须调用它。
 * 不通过就抛错，**不要 catch 掉再降级处理**——
 * 这里抛错意味着代码有 bug，不是运行时异常。
 */
export function assertApproved(card: OpinionCard): void {
  if (card.userApproved !== true) {
    throw new UnapprovedCardError(card.id)
  }

  // 空内容说明生成或编辑环节出了问题，不该被发出去
  if (typeof card.claim !== 'string' || card.claim.trim().length === 0) {
    throw new UnapprovedCardError(card.id)
  }

  // 向量缺失说明没走正常发布路径
  if (!Array.isArray(card.topicVector) || card.topicVector.length === 0) {
    throw new UnapprovedCardError(card.id)
  }
}
