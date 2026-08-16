/**
 * 对着一个**真实运行的服务端**跑一遍冒烟，验证部署有没有活着。
 *
 * 单测和 e2e 用的都是本进程起的服务端，证明不了「你线上那个地址是好的」。
 * 换服务端、重开隧道、改反向代理之后跑这个：
 *
 *   DSH_HOME=/tmp/smoke-home node --experimental-strip-types \
 *     scripts/smoke-remote.ts https://你的地址
 *
 * 用独立的 DSH_HOME 是刻意的：它会在那里生成一把全新的设备密钥，
 * 等于模拟「一个新用户刚装上插件」，而不是复用你自己的身份。
 *
 * 会在服务端留下一张卡片，跑完自己撤掉。
 */
import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as cloud from '../packages/cloud/src/index.ts'
import { asCardId, topicVector } from '../packages/core/src/index.ts'

const endpoint = process.argv[2]
if (endpoint === undefined) {
  console.error('用法：node --experimental-strip-types scripts/smoke-remote.ts <endpoint>')
  process.exit(2)
}

const dir = await mkdtemp(join(tmpdir(), 'dsh-social-smoke-'))
const ctx = new Context()
await ctx.plugin(LocalCredentialProvider, {})
await ctx.plugin(cloud, { endpoint, decisionStorePath: join(dir, 'd.json') })

let failed = false
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!ok) failed = true
}

const claim = `冒烟测试 ${new Date().toISOString()}`
const id = await ctx.social.publish({
  id: asCardId(''),
  claim,
  topicVector: topicVector(claim),
  userApproved: true,
  createdAt: Date.now(),
})
check('发布', String(id).length > 0, String(id))

const square = await ctx.social.square(10)
check('广场能看到刚发的', square.some(c => c.claim === claim),
  square.length === 0 ? '（广场是空的——服务端可能没开 --dev-square）' : `共 ${square.length} 张`)

check('撤回真删', await ctx.social.retract(id) === true)
check('重复撤回如实返回 false', await ctx.social.retract(id) === false)

console.log(failed ? '\n有检查未通过' : '\n全部通过')
process.exit(failed ? 1 : 0)
