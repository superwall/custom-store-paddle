// Reference forwarder: Paddle Billing webhooks -> Superwall custom store events, plus the
// custom store checkout endpoint Superwall calls to sell through Paddle, and its pay page.
// Node >= 22.18 runs it as is (built-in type stripping); no dependencies.
//
//   PADDLE_API_KEY=pdl_sdbx_apikey_... PADDLE_WEBHOOK_SECRET=pdl_ntfset_... \
//   PADDLE_CLIENT_TOKEN=test_... PADDLE_PRODUCTS='{"pri_...":"pro_monthly"}' \
//   SUPERWALL_API_KEY=sk_... SUPERWALL_CUSTOM_STORE_ID=4821 SUPERWALL_CHECKOUT_SECRET=whsec_... \
//   node scripts/custom-store/recipes/paddle/server.ts
//
// See ./README.md. Secrets are read from the environment and never logged.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  CheckoutVerificationError,
  checkoutSecretKey,
  parseCheckoutRequest,
  priceIdFor,
  readReturnLinks,
  renderPayPage,
  TRANSACTION_ID,
  verifySuperwallRequest,
  withReturnLinks,
} from "./checkout.ts"
import {
  mapPaddleNotification,
  requiredLookup,
  type MappingContext,
  type PaddleAdjustment,
  type PaddleNotification,
} from "./mapping.ts"
import {
  cancelSubscription,
  createCheckoutTransaction,
  environmentOf,
  getSubscription,
  getTransaction,
  PaddleApiError,
  paddleApiUrl,
  type PaddleApiOptions,
  type PaddleEnvironment,
} from "./paddle-api.ts"
import { verifyWebhook, WebhookVerificationError } from "./signature.ts"

/**
 * Paddle counts a delivery as failed when it gets no answer within five seconds. Every
 * upstream call a webhook makes (Paddle lookups, Superwall, the refund's cancel) shares
 * this budget, so the forwarder always answers in time, if need be with a 502 that Paddle
 * retries.
 */
export const WEBHOOK_BUDGET_MS = 4_000

export type ForwarderConfig = {
  readonly webhookSecret: string
  readonly paddle: PaddleApiOptions
  readonly clientToken: string
  /** From the API key and client token prefixes, which must agree. */
  readonly environment: PaddleEnvironment
  /** Paddle price id -> Superwall product identifier. */
  readonly products: Readonly<Record<string, string>>
  /** Absent in dry run. */
  readonly superwall:
    | { readonly apiKey: string; readonly storeId: string; readonly apiUrl: string }
    | undefined
  /**
   * The custom store checkout endpoint's signing secret (`whsec_...`), shown when the endpoint
   * was set in Superwall. Verifies `checkout.create` requests and signs the pay page's links.
   */
  readonly checkoutSecret: string
  /** Log each mapped event instead of sending it, and never cancel in Paddle. */
  readonly dryRun: boolean
  readonly webhookBudgetMs: number
  readonly log: (line: string) => void
}

// Superwall answers a malformed store id with a 400, which the forwarder treats as final, so
// every event would be dropped. Fail at startup instead.
const storeIdFrom = (value: string): string => {
  if (!/^\d+$/.test(value)) {
    throw new Error(`SUPERWALL_CUSTOM_STORE_ID must be the numeric store id, got "${value}"`)
  }
  return value
}

const validCheckoutSecret = (secret: string): string => {
  checkoutSecretKey(secret)
  return secret
}

const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]
  if (!value) throw new Error(`set ${name}`)
  return value
}

export const configFromEnv = (env: NodeJS.ProcessEnv): ForwarderConfig => {
  const dryRun = env.DRY_RUN === "1" || env.DRY_RUN === "true"
  const apiKey = required(env, "PADDLE_API_KEY")
  const clientToken = required(env, "PADDLE_CLIENT_TOKEN")
  // Throws when the key and token belong to different environments: sandbox purchases must
  // never be reported as production.
  const environment = environmentOf(apiKey, clientToken)
  return {
    webhookSecret: required(env, "PADDLE_WEBHOOK_SECRET"),
    paddle: { apiKey, apiUrl: paddleApiUrl(environment, env.PADDLE_API_URL) },
    clientToken,
    environment,
    products: JSON.parse(required(env, "PADDLE_PRODUCTS")),
    superwall: dryRun
      ? undefined
      : {
          apiKey: required(env, "SUPERWALL_API_KEY"),
          storeId: storeIdFrom(required(env, "SUPERWALL_CUSTOM_STORE_ID")),
          apiUrl: (env.SUPERWALL_API_URL ?? "https://api.superwall.com").replace(/\/+$/, ""),
        },
    checkoutSecret: validCheckoutSecret(required(env, "SUPERWALL_CHECKOUT_SECRET")),
    dryRun,
    webhookBudgetMs: WEBHOOK_BUDGET_MS,
    log: (line) => console.log(line),
  }
}

type Reply = {
  readonly status: number
  readonly body: string
  readonly contentType?: string
}

const text = (status: number, body: string): Reply => ({ status, body })
const json = (status: number, body: unknown): Reply => ({
  status,
  body: JSON.stringify(body),
  contentType: "application/json",
})

/** Fetches what the notification omits (a refund's transaction, a renewal's subscription). */
const lookUp = async (
  notification: PaddleNotification,
  paddle: PaddleApiOptions
): Promise<MappingContext> => {
  const lookup = requiredLookup(notification)
  if (!lookup) return {}
  const [transaction, subscription] = await Promise.all([
    lookup.transactionId ? getTransaction(lookup.transactionId, paddle) : undefined,
    lookup.subscriptionId ? getSubscription(lookup.subscriptionId, paddle) : undefined,
  ])
  return {
    ...(transaction ? { transaction } : {}),
    ...(subscription ? { subscription } : {}),
  }
}

/**
 * Superwall answers that Paddle should retry: nothing was recorded (5xx), the request was
 * not authorized or the store was not found (a configuration to fix, after which the
 * retries succeed), or it timed out or was rate limited.
 */
const RETRYABLE_STATUSES = new Set([401, 403, 404, 408, 429])
const isRetryable = (status: number) => status >= 500 || RETRYABLE_STATUSES.has(status)

const handleWebhook = async (
  body: string,
  signature: string | undefined,
  config: ForwarderConfig
): Promise<Reply> => {
  try {
    verifyWebhook(body, signature, config.webhookSecret)
  } catch (error) {
    if (error instanceof WebhookVerificationError) return text(403, "invalid signature")
    throw error
  }

  const notification = JSON.parse(body) as PaddleNotification
  const label = `${notification.event_id} ${notification.event_type}`
  // One deadline for every upstream call below.
  const signal = AbortSignal.timeout(config.webhookBudgetMs)
  const paddle = { ...config.paddle, signal }

  let context: MappingContext
  try {
    context = await lookUp(notification, paddle)
  } catch (error) {
    if (!(error instanceof PaddleApiError)) throw error
    if (!config.dryRun) {
      // The event's body depends on it: fail the delivery so Paddle retries, rather than
      // sending a body that a retry could not reproduce.
      config.log(`${label}: Paddle lookup failed: ${error.message}`)
      return text(502, "lookup failed")
    }
    config.log(`${label}: Paddle lookup failed (${error.message}); dry run maps without it`)
    context = {}
  }

  const result = mapPaddleNotification(
    notification,
    { products: config.products, environment: config.environment },
    context
  )
  if (result.kind === "ignored") {
    config.log(`${label}: ignored (${result.reason})`)
    // Paddle retries anything but 200, and something that will never map never will.
    return text(200, "ignored")
  }

  if (!config.superwall) {
    config.log(JSON.stringify({ dry_run: true, event: result.event }))
    return text(200, "dry run")
  }

  const { apiKey, storeId, apiUrl } = config.superwall
  let response: Response
  try {
    response = await fetch(`${apiUrl}/v2/custom-stores/${encodeURIComponent(storeId)}/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ events: [result.event] }),
      signal,
    })
  } catch (error) {
    config.log(`${label}: Superwall unreachable: ${error instanceof Error ? error.name : error}`)
    return text(502, "forward failed")
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    if (isRetryable(response.status)) {
      // Nothing was recorded. Fail the delivery so Paddle retries it; the event_id derived
      // from Paddle's ids keeps it idempotent.
      config.log(`${label}: Superwall responded ${response.status}; Paddle will retry`)
      return text(502, "forward failed")
    }
    // Any other 4xx refuses the request itself: retrying the same body cannot succeed.
    config.log(`${label}: Superwall refused it (${response.status}): ${detail.slice(0, 500)}`)
    return text(200, "refused")
  }
  const batch = (await response.json()) as {
    results: Array<{ status: string; error?: { code: string; message: string } }>
  }
  const [outcome] = batch.results
  if (outcome?.status === "rejected") {
    // A validation error: retrying the same payload cannot succeed.
    config.log(`${label}: rejected ${outcome.error?.code}: ${outcome.error?.message}`)
    return text(200, "rejected")
  }
  config.log(`${label} -> ${result.event.type}: accepted`)

  // A refund ends the subscription: Superwall has revoked access, and Paddle must not bill
  // again (a renewal would restore it). Canceled after Superwall recorded the refund, still
  // inside the deadline, before answering: a failure fails the delivery, and Paddle's retry
  // re-sends the same event_id (a no-op) and cancels again, or finds it canceled.
  const refundedSubscription =
    result.event.type === "refund" ? (notification.data as PaddleAdjustment).subscription_id : null
  if (refundedSubscription) {
    try {
      const canceled = await cancelSubscription(refundedSubscription, paddle)
      config.log(`${label}: Paddle subscription ${refundedSubscription} ${canceled}`)
    } catch (error) {
      if (!(error instanceof PaddleApiError)) throw error
      config.log(
        `CANCEL FAILED ${label}: Paddle subscription ${refundedSubscription} is refunded in ` +
          `Superwall but still billing (${error.message}); Paddle will retry the delivery`
      )
      return text(502, "cancel failed")
    }
  }
  return text(200, "ok")
}

/**
 * The custom store checkout endpoint: Superwall POSTs a signed `checkout.create` when a
 * paywall sells one of the store's products, and opens the URL this answers with.
 */
const handleCheckout = async (
  body: string,
  headers: IncomingMessage["headers"],
  config: ForwarderConfig
): Promise<Reply> => {
  const header = (name: string) => {
    const value = headers[name]
    return Array.isArray(value) ? value[0] : value
  }
  try {
    verifySuperwallRequest(
      body,
      {
        id: header("webhook-id"),
        timestamp: header("webhook-timestamp"),
        signature: header("webhook-signature"),
      },
      config.checkoutSecret
    )
  } catch (error) {
    if (error instanceof CheckoutVerificationError) return json(401, { error: error.message })
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return json(400, { error: "body must be JSON" })
  }
  const input = parseCheckoutRequest(parsed)
  if (typeof input === "string") return json(400, { error: input })
  const priceId = priceIdFor(config.products, input.product_id)
  if (!priceId) return json(404, { error: `no Paddle price maps to ${input.product_id}` })
  try {
    const transaction = await createCheckoutTransaction(
      {
        priceId,
        appUserId: input.app_user_id,
        customTransactionId: input.custom_transaction_id,
      },
      config.paddle
    )
    // The default payment link (this forwarder's /paddle/pay) plus `?_ptxn=<id>`.
    const url = transaction.checkout?.url
    if (!url) {
      config.log(`checkout ${transaction.id}: no checkout.url; set the default payment link`)
      return json(502, { error: "Paddle returned no checkout URL" })
    }
    config.log(`checkout ${transaction.id} for ${input.product_id} (${priceId})`)
    return json(200, {
      url: withReturnLinks(
        url,
        { completed: input.success_url, closed: input.cancel_url },
        config.checkoutSecret
      ),
    })
  } catch (error) {
    if (!(error instanceof PaddleApiError)) throw error
    config.log(`checkout for ${input.product_id}: ${error.message}`)
    return json(502, { error: "Paddle could not create the transaction" })
  }
}

const MAX_BODY_BYTES = 1024 * 1024

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((done, fail) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        fail(new Error("body too large"))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on("end", () => done(Buffer.concat(chunks).toString("utf8")))
    request.on("error", fail)
  })

const route = async (request: IncomingMessage, config: ForwarderConfig): Promise<Reply> => {
  const url = new URL(request.url ?? "/", "http://localhost")
  const key = `${request.method} ${url.pathname}`
  switch (key) {
    case "GET /health":
      return text(200, "ok")
    case "POST /paddle/webhooks": {
      const signature = request.headers["paddle-signature"]
      return handleWebhook(
        await readBody(request),
        Array.isArray(signature) ? signature[0] : signature,
        config
      )
    }
    case "POST /paddle/checkout":
      return handleCheckout(await readBody(request), request.headers, config)
    case "GET /paddle/pay": {
      const transactionId = url.searchParams.get("_ptxn") ?? ""
      if (!TRANSACTION_ID.test(transactionId)) return text(400, "missing or invalid _ptxn")
      return {
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: renderPayPage({
          clientToken: config.clientToken,
          environment: config.environment,
          transactionId,
          returnLinks: readReturnLinks(url.searchParams, config.checkoutSecret),
        }),
      }
    }
    default:
      return text(404, "not found")
  }
}

/** The request listener; `server.ts` run directly serves it on PORT. */
export const createForwarder =
  (config: ForwarderConfig) => (request: IncomingMessage, response: ServerResponse) => {
    route(request, config)
      .catch((error: unknown) => {
        config.log(`request failed: ${error instanceof Error ? error.message : String(error)}`)
        return text(500, "error")
      })
      .then(({ status, body, contentType }) =>
        response
          .writeHead(status, { "content-type": contentType ?? "text/plain; charset=utf-8" })
          .end(body)
      )
  }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = configFromEnv(process.env)
  const port = Number(process.env.PORT ?? 8788)
  createServer(createForwarder(config)).listen(port, () =>
    console.log(
      `Paddle forwarder on :${port} (${config.environment}${config.dryRun ? ", dry run" : ""})`
    )
  )
}
