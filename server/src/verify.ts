/**
 * 请求验签。
 *
 * 客户端对**原始请求体字符串**签名，公钥放 x-social-key，签名放 x-social-signature。
 * 服务端拿公钥验签就知道是不是本人，不需要会话状态、不需要账号。
 *
 * ⚠️ 已知缺口：没有 nonce 和时间戳，所以签名可重放。
 *    实际影响有限（重放 publish 产生重复卡片，重放 delete 是幂等的），
 *    但接入真实流量前应该加 `x-social-timestamp` 并拒绝过期请求。
 *    留着这条注释而不是假装它不存在。
 */

import { verify as cryptoVerify, createPublicKey } from 'node:crypto'

export type VerifyResult =
  | { readonly ok: true, readonly publicKey: string }
  | { readonly ok: false, readonly reason: string }

export function verifyRequest(
  rawBody: string,
  publicKeyB64url: string | undefined,
  signatureB64url: string | undefined,
): VerifyResult {
  if (!publicKeyB64url) return { ok: false, reason: '缺少 x-social-key' }
  if (!signatureB64url) return { ok: false, reason: '缺少 x-social-signature' }

  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyB64url, 'base64url'),
      format: 'der',
      type: 'spki',
    })
    // Ed25519 验签不接受 digest 算法，第一个参数必须是 null
    const ok = cryptoVerify(
      null,
      Buffer.from(rawBody, 'utf8'),
      key,
      Buffer.from(signatureB64url, 'base64url'),
    )
    return ok ? { ok: true, publicKey: publicKeyB64url } : { ok: false, reason: '签名不匹配' }
  } catch (err) {
    return { ok: false, reason: `公钥或签名格式错误：${(err as Error).message}` }
  }
}
