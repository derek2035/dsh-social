/**
 * 请求验签。
 *
 * 客户端对**原始请求体字符串**签名，公钥放 x-social-key，签名放 x-social-signature。
 * 服务端拿公钥验签就知道是不是本人，不需要会话状态、不需要账号。
 *
 * 防重放由两件事共同完成，缺一不可：
 *
 *   ① `x-social-timestamp` 参与签名，服务端拒绝时间窗外的请求
 *      —— 把可重放的时间压缩到一个很短的窗口
 *   ② 签名本身当作 nonce 记下来，窗口内重复出现即拒绝
 *      —— 堵住窗口内的重放
 *
 * 只做①的话，攻击者在窗口内仍可重放；只做②的话，nonce 表会无限增长。
 * 两个一起才既有界又完整。
 */

import { verify as cryptoVerify, createPublicKey } from 'node:crypto'

export type VerifyResult =
  | { readonly ok: true, readonly publicKey: string }
  | { readonly ok: false, readonly reason: string }

/** 允许的时钟偏差。太小会误伤时钟不准的客户端，太大等于没防。 */
export const CLOCK_SKEW_MS = 5 * 60 * 1000

export function verifyRequest(
  rawBody: string,
  publicKeyB64url: string | undefined,
  signatureB64url: string | undefined,
  timestampHeader: string | undefined,
  now: number,
): VerifyResult {
  if (!publicKeyB64url) return { ok: false, reason: '缺少 x-social-key' }
  if (!signatureB64url) return { ok: false, reason: '缺少 x-social-signature' }
  if (!timestampHeader) return { ok: false, reason: '缺少 x-social-timestamp' }

  const timestamp = Number(timestampHeader)
  if (!Number.isFinite(timestamp)) return { ok: false, reason: 'x-social-timestamp 不是数字' }
  if (Math.abs(now - timestamp) > CLOCK_SKEW_MS) {
    return { ok: false, reason: '请求时间戳超出允许窗口' }
  }

  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyB64url, 'base64url'),
      format: 'der',
      type: 'spki',
    })
    // Ed25519 验签不接受 digest 算法，第一个参数必须是 null
    // 时间戳必须参与签名，否则攻击者可以改时间戳把旧请求「续期」
    const signed = `${timestampHeader}.${rawBody}`
    const ok = cryptoVerify(
      null,
      Buffer.from(signed, 'utf8'),
      key,
      Buffer.from(signatureB64url, 'base64url'),
    )
    return ok ? { ok: true, publicKey: publicKeyB64url } : { ok: false, reason: '签名不匹配' }
  } catch (err) {
    return { ok: false, reason: `公钥或签名格式错误：${(err as Error).message}` }
  }
}
