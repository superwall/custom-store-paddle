// Paddle Billing webhook signature check
// (developer.paddle.com/webhooks/about/signature-verification).
//
// Header: `Paddle-Signature: ts=<unix seconds>;h1=<hex>[;h1=<hex>]`. Each `h1` is a lowercase
// hex HMAC-SHA256, keyed with the notification destination's secret key (`pdl_ntfset_...`,
// used as its UTF-8 bytes), over `${ts}:${raw body}`. While Paddle rotates a secret it sends
// one `h1` per secret, so any match is accepted.
import { createHmac, timingSafeEqual } from "node:crypto"

/**
 * Paddle's SDKs reject a `ts` further than five seconds from now (their default), so a
 * captured request cannot be replayed later. Paddle signs every delivery attempt afresh.
 */
export const TOLERANCE_SECONDS = 5

export class WebhookVerificationError extends Error {
  override readonly name = "WebhookVerificationError"
}

export const sign = (secret: string, timestamp: string, body: string): string =>
  createHmac("sha256", secret).update(`${timestamp}:${body}`).digest("hex")

/** Parses `ts=...;h1=...;h1=...`. Unknown keys are skipped, as Paddle may add some. */
const parseHeader = (header: string) => {
  let timestamp: string | undefined
  const signatures: Array<string> = []
  for (const part of header.split(";")) {
    const index = part.indexOf("=")
    if (index < 0) continue
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (key === "ts") timestamp = value
    else if (key === "h1") signatures.push(value)
  }
  return { timestamp, signatures }
}

/**
 * Throws `WebhookVerificationError` unless `body` (the raw request body, byte for byte)
 * carries a valid, fresh `Paddle-Signature`.
 */
export const verifyWebhook = (
  body: string,
  header: string | undefined,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  toleranceSeconds: number = TOLERANCE_SECONDS
): void => {
  if (!header) throw new WebhookVerificationError("missing Paddle-Signature")
  const { timestamp, signatures } = parseHeader(header)
  if (!timestamp || signatures.length === 0) {
    throw new WebhookVerificationError("Paddle-Signature lacks ts or h1")
  }
  const sentAt = Number(timestamp)
  if (!Number.isInteger(sentAt) || Math.abs(nowSeconds - sentAt) > toleranceSeconds) {
    throw new WebhookVerificationError("Paddle-Signature ts is outside the tolerance")
  }
  const expected = Buffer.from(sign(secret, timestamp, body), "hex")
  const matches = signatures.some((offered) => {
    if (!/^[0-9a-f]+$/i.test(offered)) return false
    const candidate = Buffer.from(offered, "hex")
    return candidate.length === expected.length && timingSafeEqual(candidate, expected)
  })
  if (!matches) throw new WebhookVerificationError("no matching h1 signature")
}
