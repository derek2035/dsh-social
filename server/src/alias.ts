/**
 * 每话题化名。
 *
 * ★ 这是让「对话」和「匿名」同时成立的关键设计，改之前先想清楚。
 *
 * 群聊要成立，必须能区分说话的人 —— 否则「他回的是谁」就没法读。
 * 但直接暴露公钥等于把一个人在所有话题里的发言串成一条线，
 * 那「默认匿名」就只剩服务端知道，用户之间全透明了。
 *
 * 折中：化名 = hash(公钥 + 话题 id + 服务端盐)，取前 4 位。
 *
 *   - **同一话题内**，同一个人永远是同一个化名 → 对话读得通
 *   - **跨话题**，同一个人是完全不同的化名 → 串不起来
 *   - 服务端有盐，所以就算别人猜到某人的公钥，也算不出他的化名
 *
 * 代价（必须写进产品说明，不能只留在这里）：
 *   服务端仍然持有 公钥 → 化名 的映射，它能串起来。
 *   这是「对用户匿名，对服务端实名」，不是端到端匿名。
 *   真要端到端得上零知识那一套，那是另一个量级的工程。
 */

import { createHash, randomBytes } from 'node:crypto'

/**
 * 进程级盐。
 *
 * 重启会换盐，于是所有化名都会变 —— 老对话里的「路人 a3f2」
 * 重启后会显示成别的名字，读起来会错乱。
 * 真实部署应该把它持久化（存进 DB 的配置表）。
 * 现在没做，因为它属于运维配置，而这一版要先验证形态对不对。
 */
const SALT = randomBytes(16).toString('hex')

/** 化名字符集刻意避开易混字符（0/O、1/l）。 */
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'

export function aliasFor(publicKey: string, topicId: string): string {
  const digest = createHash('sha256')
    .update(`${SALT} ${topicId} ${publicKey}`)
    .digest()

  let out = ''
  for (let i = 0; i < 4; i++) {
    out += ALPHABET[(digest[i] ?? 0) % ALPHABET.length]
  }
  return out
}
