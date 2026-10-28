// The checkout half of the recipe: the endpoint Superwall calls when a paywall sells a Paddle
// product (a signed `checkout.create`), and the page Paddle's "default payment link" points at,
// which opens the checkout and sends the buyer back to Superwall. Pure apart from crypto.
import { createHmac, timingSafeEqual } from "node:crypto"
import { identifierProblem } from "./mapping.ts"

/** The `checkout.create` request Superwall sends (see the custom store checkout docs). */
export type CheckoutRequest = {
  readonly app_user_id: string
  readonly product_id: string
  readonly custom_transaction_id: string
  /** Where to send the buyer after paying. */
  readonly success_url: string
  /** Where to send the buyer when they leave without paying. */
  readonly cancel_url: string
}

export class CheckoutVerificationError extends Error {}

/** Standard Webhooks allows five minutes between signing and receiving. */
export const SIGNATURE_TOLERANCE_SECONDS = 5 * 60

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * The checkout secret's HMAC key: the base64 after `whsec_`. Throws on anything else, so
 * `configFromEnv` refuses a mistyped secret at startup rather than on every request.
 */
export const checkoutSecretKey = (secret: string): Buffer => {
  const encoded = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : undefined
  const key = encoded && BASE64.test(encoded) ? Buffer.from(encoded, "base64") : undefined
  if (!key || key.length < 16) {
    throw new Error("SUPERWALL_CHECKOUT_SECRET must be the whsec_... secret Superwall showed")
  }
  return key
}

const secretKey = checkoutSecretKey

/**
 * Checks the Standard Webhooks headers Superwall signs every `checkout.create` with:
 * `webhook-signature` lists `v1,<base64 HMAC-SHA256 of "<id>.<timestamp>.<body>">` (one per
 * secret while it rotates); any match, compared in constant time, is accepted.
 */
export const verifySuperwallRequest = (
  body: string,
  headers: {
    readonly id: string | undefined
    readonly timestamp: string | undefined
    readonly signature: string | undefined
  },
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): void => {
  const { id, timestamp, signature } = headers
  if (!id || !timestamp || !signature) throw new CheckoutVerificationError("missing signature")
  const sentAt = Number(timestamp)
  if (!Number.isInteger(sentAt) || Math.abs(nowSeconds - sentAt) > SIGNATURE_TOLERANCE_SECONDS) {
    throw new CheckoutVerificationError("timestamp outside the tolerance")
  }
  const expected = createHmac("sha256", secretKey(secret))
    .update(`${id}.${timestamp}.${body}`)
    .digest()
  const matches = signature.split(" ").some((entry) => {
    const [version, value] = entry.split(",", 2)
    if (version !== "v1" || !value) return false
    const candidate = Buffer.from(value, "base64")
    return candidate.length === expected.length && timingSafeEqual(candidate, expected)
  })
  if (!matches) throw new CheckoutVerificationError("invalid signature")
}

const absoluteUrl = (name: string, value: unknown): string | undefined => {
  if (typeof value !== "string") return `${name} must be a URL`
  try {
    const { protocol } = new URL(value)
    return protocol === "https:" || protocol === "http:" ? undefined : `${name} must be http(s)`
  } catch {
    return `${name} must be an absolute URL`
  }
}

/** Validates a verified `checkout.create` body; returns the problem as a string. */
export const parseCheckoutRequest = (body: unknown): CheckoutRequest | string => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "body must be a JSON object"
  }
  const fields = body as Record<string, unknown>
  if (fields.type !== "checkout.create") return `unsupported type ${JSON.stringify(fields.type)}`
  // The ids end up in the webhooks' events, which Superwall refuses for the same reasons:
  // refuse them here, before the customer pays.
  const problem =
    identifierProblem("app_user_id", fields.app_user_id) ??
    identifierProblem("product_id", fields.product_id) ??
    identifierProblem("custom_transaction_id", fields.custom_transaction_id) ??
    absoluteUrl("success_url", fields.success_url) ??
    absoluteUrl("cancel_url", fields.cancel_url)
  if (problem) return problem
  return {
    app_user_id: fields.app_user_id as string,
    product_id: fields.product_id as string,
    custom_transaction_id: fields.custom_transaction_id as string,
    success_url: fields.success_url as string,
    cancel_url: fields.cancel_url as string,
  }
}

/**
 * The Paddle price to sell for a Superwall product: the first PADDLE_PRODUCTS entry that
 * maps to it.
 */
export const priceIdFor = (
  products: Readonly<Record<string, string>>,
  productId: string
): string | undefined =>
  Object.entries(products).find(([, superwallProduct]) => superwallProduct === productId)?.[0]

/** Where the pay page sends the buyer: Superwall's return page for this checkout. */
export type ReturnLinks = { readonly completed: string; readonly closed: string }

// Covers the transaction too, so a checkout's links cannot be replayed onto another
// transaction's pay page.
const linkSignature = (transactionId: string, encoded: string, secret: string) =>
  createHmac("sha256", secretKey(secret))
    .update(`pay-return.${transactionId}.${encoded}`)
    .digest("base64url")

/**
 * Adds the return links to Paddle's checkout URL (which carries the transaction as `_ptxn`),
 * signed so the pay page only ever redirects where Superwall said to for that transaction (an
 * unsigned parameter would make it an open redirect).
 */
export const withReturnLinks = (checkoutUrl: string, links: ReturnLinks, secret: string) => {
  const url = new URL(checkoutUrl)
  const encoded = Buffer.from(JSON.stringify(links)).toString("base64url")
  url.searchParams.set("sw_return", encoded)
  url.searchParams.set("sw_sig", linkSignature(url.searchParams.get("_ptxn") ?? "", encoded, secret))
  return url.toString()
}

/** The return links of a pay page URL, or `undefined` when absent or not signed by us. */
export const readReturnLinks = (
  query: URLSearchParams,
  secret: string
): ReturnLinks | undefined => {
  const encoded = query.get("sw_return")
  const signature = query.get("sw_sig")
  if (!encoded || !signature) return undefined
  const expected = Buffer.from(linkSignature(query.get("_ptxn") ?? "", encoded, secret))
  const actual = Buffer.from(signature)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined
  try {
    const links = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as ReturnLinks
    return typeof links.completed === "string" && typeof links.closed === "string"
      ? links
      : undefined
  } catch {
    return undefined
  }
}

/** A Paddle transaction id. Loose on purpose: only its characters matter for the page. */
export const TRANSACTION_ID = /^txn_[A-Za-z0-9]{1,64}$/

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]!)

/**
 * JSON safe to embed in an inline `<script>`: no `</script>`, `<!--` or line separators
 * can end the script or the string early.
 */
export const scriptJson = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    // U+2028 and U+2029 end a line in older JavaScript parsers.
    .replace(/[\u2028\u2029]/g, (separator) => `\\u${separator.charCodeAt(0).toString(16)}`)

export type PayPageInput = {
  readonly clientToken: string
  readonly environment: "production" | "sandbox"
  readonly transactionId: string
  /** Absent when Paddle opened the payment link for something else (e.g. a card update). */
  readonly returnLinks: ReturnLinks | undefined
}

/**
 * The default payment link page. Paddle.js opens the overlay checkout for the `_ptxn`
 * transaction in the page URL by itself once initialized; the event callback sends the buyer
 * to Superwall's return page when the checkout completes or is closed.
 */
export const renderPayPage = (input: PayPageInput): string => {
  const config = {
    token: input.clientToken,
    sandbox: input.environment === "sandbox",
    completedUrl: input.returnLinks?.completed ?? null,
    closedUrl: input.returnLinks?.closed ?? null,
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Checkout</title>
<script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script>
</head>
<body>
<p id="status">Opening checkout for ${escapeHtml(input.transactionId)}...</p>
<script>
const config = ${scriptJson(config)};
let done = false;
const leave = (url, message) => {
  if (done) return;
  done = true;
  if (url) window.location.href = url;
  else document.getElementById("status").textContent = message;
};
if (config.sandbox) Paddle.Environment.set("sandbox");
Paddle.Initialize({
  token: config.token,
  eventCallback: (event) => {
    if (event.name === "checkout.completed") leave(config.completedUrl, "Payment complete. You can close this page.");
    else if (event.name === "checkout.closed") leave(config.closedUrl, "Checkout closed. You can close this page.");
  },
});
</script>
</body>
</html>
`
}
