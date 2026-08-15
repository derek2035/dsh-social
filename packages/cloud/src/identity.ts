/**
 * 设备级匿名身份。
 *
 * 服务端需要回答两个问题：「这张卡是不是你发的」（撤回鉴权）和
 * 「这个人是不是被封了」。传统做法是账号，但那和「默认匿名」冲突——
 * 账号意味着服务端持有一个能跨会话关联你全部发言的真实标识。
 *
 * 这里用一对本地生成的 Ed25519 密钥代替账号：
 *
 *   - 公钥就是身份。服务端只见公钥，见不到邮箱、设备信息、IP 之外的任何东西
 *   - 私钥永不离开本机，存在 ctx.credentials 里（不自己写文件，见技术架构第 8 节）
 *   - 发布和撤回都带签名，服务端验签即可确认是本人，不需要会话状态
 *   - 封禁按公钥执行
 *
 * 明确的代价，别假装它不存在：
 *
 *   1. 换电脑 = 换身份。你在旧机器上发的卡，新机器撤不回来。
 *      这是匿名的直接后果——没有账号就没有「找回」。
 *   2. 封禁可以靠删掉密钥绕过。这拦不住有心人，只是给刷屏加了点成本。
 *      真要防滥用得靠速率限制和内容审核，不能指望身份层。
 *
 * 这两条都应该写进产品的隐私说明，而不是留在代码注释里。
 */

import {
  generateKeyPairSync,
  sign as cryptoSign,
  createPrivateKey,
  createPublicKey,
} from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

/**
 * 私钥在 credentials 里的引用名。
 *
 * 必须匹配 /^[A-Za-z_][A-Za-z0-9_]*$/ —— 不能带斜杠或连字符。
 * credentials 的 ref 是按环境变量名的形状约束的，本地 provider 会把它
 * 映射到 env / file 等来源层，所以命名跟着环境变量的习惯走。
 */
const KEY_REF = credentialRef('DSH_SOCIAL_DEVICE_KEY')

export interface DeviceIdentity {
  /** base64url 的原始公钥，当作服务端可见的身份。 */
  readonly publicKey: string
  /** 对任意字节串签名，返回 base64url。 */
  sign(payload: string): string
}

/**
 * 取回本机身份，没有就生成一把。
 *
 * 注意这里**不**捕获 credentials 的错误：拿不到私钥就无法证明所有权，
 * 这时候继续发布会产生一张自己也撤不回来的卡片——
 * 那比直接失败糟糕得多。
 */
export async function loadIdentity(ctx: Context): Promise<DeviceIdentity> {
  const existing = await ctx.credentials.resolve(KEY_REF)
  const pkcs8 = existing?.value ?? await mint(ctx)
  const privateKey = createPrivateKey({
    key: Buffer.from(pkcs8, 'base64'),
    format: 'der',
    type: 'pkcs8',
  })

  // 从私钥导出公钥，而不是分开存两份——两份就有不同步的可能
  const publicKey = (createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' }) as Buffer)
    .toString('base64url')

  return {
    publicKey,
    sign: (payload: string) =>
      // Ed25519 的 sign 不接受 digest 算法，第一个参数必须是 null
      cryptoSign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64url'),
  }
}

async function mint(ctx: Context): Promise<string> {
  const { privateKey } = generateKeyPairSync('ed25519')
  const der = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer
  const encoded = der.toString('base64')
  await ctx.credentials.set(KEY_REF, encoded)
  console.log('[social/cloud] 已生成本机匿名身份（换设备后旧卡片将无法撤回）')
  return encoded
}
