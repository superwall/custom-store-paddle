// The Paddle API calls the forwarder makes (developer.paddle.com/api-reference): reading the
// entities a notification omits, canceling a refunded subscription, and creating the
// transaction a checkout pays.
import type { PaddleSubscription, PaddleTransaction } from "./mapping.ts"

export type PaddleApiOptions = {
  readonly apiKey: string
  readonly apiUrl: string
  /** Aborts the call; defaults to a timeout of its own. */
  readonly signal?: AbortSignal
}

/** A Paddle API call that failed: `status` 0 when no response arrived (network, timeout). */
export class PaddleApiError extends Error {
  readonly status: number
  readonly code: string | undefined
  constructor(status: number, code: string | undefined) {
    super(
      status === 0
        ? `Paddle unreachable: ${code}`
        : `Paddle responded ${status}${code ? ` ${code}` : ""}`
    )
    this.status = status
    this.code = code
  }
}

export type PaddleEnvironment = "production" | "sandbox"

/**
 * The environment a Paddle API key (`pdl_sdbx_apikey_...` / `pdl_live_apikey_...`) and a
 * client-side token (`test_...` / `live_...`) belong to. Throws unless both name the same
 * one, so a sandbox purchase can never be reported as production, nor the reverse.
 */
export const environmentOf = (apiKey: string, clientToken: string): PaddleEnvironment => {
  const fromKey = apiKey.startsWith("pdl_sdbx_")
    ? "sandbox"
    : apiKey.startsWith("pdl_live_")
      ? "production"
      : undefined
  const fromToken = clientToken.startsWith("test_")
    ? "sandbox"
    : clientToken.startsWith("live_")
      ? "production"
      : undefined
  if (!fromKey) throw new Error("PADDLE_API_KEY must start with pdl_sdbx_ or pdl_live_")
  if (!fromToken) throw new Error("PADDLE_CLIENT_TOKEN must start with test_ or live_")
  if (fromKey !== fromToken) {
    throw new Error(`PADDLE_API_KEY is for ${fromKey} but PADDLE_CLIENT_TOKEN is for ${fromToken}`)
  }
  return fromKey
}

/** Paddle's API origin for the environment, unless PADDLE_API_URL overrides it. */
export const paddleApiUrl = (environment: "production" | "sandbox", override?: string): string =>
  (
    override ??
    (environment === "sandbox" ? "https://sandbox-api.paddle.com" : "https://api.paddle.com")
  ).replace(/\/+$/, "")

/**
 * Used when the caller passes no signal of its own (the checkout endpoint): inside the 10
 * seconds Superwall waits for a checkout URL.
 */
const TIMEOUT_MS = 8_000

const request = async <T>(
  method: "GET" | "POST",
  path: string,
  options: PaddleApiOptions,
  body?: unknown
): Promise<T> => {
  let response: Response
  try {
    response = await fetch(`${options.apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: options.signal ?? AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    throw new PaddleApiError(0, error instanceof Error ? error.name : "fetch failed")
  }
  const payload = (await response.json().catch(() => ({}))) as {
    data?: T
    error?: { code?: string }
  }
  if (!response.ok || payload.data === undefined) {
    throw new PaddleApiError(response.status, payload.error?.code)
  }
  return payload.data
}

export const getTransaction = (id: string, options: PaddleApiOptions) =>
  request<PaddleTransaction>("GET", `/transactions/${encodeURIComponent(id)}`, options)

export const getSubscription = (id: string, options: PaddleApiOptions) =>
  request<PaddleSubscription>("GET", `/subscriptions/${encodeURIComponent(id)}`, options)

export type CancelOutcome = "canceled" | "already_canceled"

/** Paddle's errors for an action on a subscription that is already canceled (400). */
const ALREADY_CANCELED = new Set([
  "subscription_is_canceled_action_invalid",
  "subscription_update_when_canceled",
])

/**
 * Cancels the subscription now (`POST /subscriptions/{id}/cancel`,
 * `{"effective_from":"immediately"}`), so a refunded customer is not billed again: Superwall
 * revokes access on a refund, and a later renewal would restore it. A subscription Paddle
 * already canceled counts as done, so a retried delivery is safe. Throws `PaddleApiError`
 * on anything else, for the delivery to be retried.
 */
export const cancelSubscription = async (
  subscriptionId: string,
  options: PaddleApiOptions
): Promise<CancelOutcome> => {
  try {
    await request("POST", `/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, options, {
      effective_from: "immediately",
    })
    return "canceled"
  } catch (error) {
    if (error instanceof PaddleApiError && error.code && ALREADY_CANCELED.has(error.code)) {
      return "already_canceled"
    }
    throw error
  }
}

export type CheckoutInput = {
  readonly priceId: string
  readonly appUserId: string
  /** The SDK's `StoreProduct.customTransactionId`, when the caller has it (paywall attribution). */
  readonly customTransactionId?: string | undefined
}

/**
 * The `POST /transactions` body for a checkout: one item of the price, and the ids the
 * webhooks need in `custom_data`, which Paddle copies to the subscription it creates and
 * from there to every renewal.
 */
export const checkoutTransactionBody = (input: CheckoutInput) => ({
  items: [{ price_id: input.priceId, quantity: 1 }],
  collection_mode: "automatic",
  custom_data: {
    superwall_app_user_id: input.appUserId,
    ...(input.customTransactionId
      ? { superwall_custom_transaction_id: input.customTransactionId }
      : {}),
  },
})

/**
 * Creates the (draft) transaction a checkout collects payment for. Paddle answers with its
 * `checkout.url`: the account's default payment link plus `?_ptxn=<transaction id>`.
 */
export const createCheckoutTransaction = (input: CheckoutInput, options: PaddleApiOptions) =>
  request<{ id: string; checkout: { url: string | null } | null }>(
    "POST",
    "/transactions",
    options,
    checkoutTransactionBody(input)
  )
