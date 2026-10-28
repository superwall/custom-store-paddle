// Maps Paddle Billing webhooks to Superwall custom store events
// (POST /v2/custom-stores/:custom_store_id/events). Pure: no I/O, no clock.
//
// Field names follow Paddle's webhook reference (developer.paddle.com/webhooks), whose
// payloads are the API entities in snake_case. Only the fields used here are typed.

type PaddleCustomData = Readonly<Record<string, unknown>> | null

type Period = { readonly starts_at: string; readonly ends_at: string }

export type PaddlePrice = {
  readonly id: string
  readonly product_id: string
  /** `null` for a one-time price. */
  readonly billing_cycle: { readonly interval: string; readonly frequency: number } | null
  /** `null` for no trial. `unit_price` is set for a paid trial, absent or `null` for a free one. */
  readonly trial_period: {
    readonly interval: string
    readonly frequency: number
    readonly unit_price?: { readonly amount: string; readonly currency_code: string } | null
  } | null
}

export type PaddleTransaction = {
  readonly id: string
  readonly status: string
  /** `web` (Paddle.js checkout), `api`, `subscription_recurring`, `subscription_update`, ... */
  readonly origin: string
  readonly subscription_id: string | null
  readonly currency_code: string
  readonly created_at: string
  readonly billed_at: string | null
  readonly billing_period: Period | null
  readonly custom_data: PaddleCustomData
  readonly items: ReadonlyArray<{ readonly price: PaddlePrice; readonly quantity: number }>
  readonly details: {
    readonly totals: {
      readonly grand_total: string
      readonly grand_total_tax: string
      readonly currency_code: string
    }
    readonly line_items: ReadonlyArray<{
      readonly price_id: string
      readonly totals: { readonly subtotal: string }
    }>
  }
}

export type PaddleSubscriptionItem = {
  readonly status: string
  readonly price: PaddlePrice
  readonly trial_dates: Period | null
  readonly previously_billed_at: string | null
}

export type PaddleSubscription = {
  readonly id: string
  readonly status: string
  readonly currency_code: string
  readonly started_at: string | null
  readonly first_billed_at: string | null
  readonly canceled_at: string | null
  readonly paused_at: string | null
  readonly updated_at?: string
  /** The checkout transaction that created the subscription. */
  readonly transaction_id?: string | null
  readonly current_billing_period: Period | null
  readonly scheduled_change: {
    readonly action: "cancel" | "pause" | "resume"
    readonly effective_at: string
  } | null
  readonly custom_data: PaddleCustomData
  readonly items: ReadonlyArray<PaddleSubscriptionItem>
}

export type PaddleAdjustment = {
  readonly id: string
  /** `refund`, `credit`, `chargeback`, ... */
  readonly action: string
  /** `full` adjusts the transaction's grand total; `partial` some line items. */
  readonly type: string | null
  /** `pending_approval`, `approved`, `rejected`, `reversed`. */
  readonly status: string
  readonly transaction_id: string
  readonly subscription_id: string | null
  readonly currency_code: string
  readonly created_at: string
  readonly totals: { readonly subtotal: string; readonly tax: string; readonly total: string }
}

/** The notification envelope Paddle POSTs. `event_id` is stable across delivery retries. */
export type PaddleNotification = {
  readonly event_id: string
  readonly event_type: string
  readonly occurred_at: string
  readonly notification_id: string
  readonly data: unknown
}

/** The request body item of POST /v2/custom-stores/:id/events. */
export type CustomStoreEvent = {
  event_id: string
  type:
    | "initial_purchase"
    | "renewal"
    | "product_change"
    | "cancellation"
    | "uncancellation"
    | "billing_issue"
    | "expiration"
    | "refund"
    | "non_renewing_purchase"
  app_user_id: string
  product_id: string
  subscription_id: string
  transaction_id: string
  environment: "production" | "sandbox"
  occurred_at: string
  purchased_at: string
  expires_at: string | null
  period_type: "normal" | "trial" | "intro"
  price?: { amount: string; currency: string }
  custom_transaction_id?: string
  cancel_reason?: "unsubscribe" | "billing_error" | "unknown"
  is_trial_conversion?: boolean
}

export type MappingConfig = {
  /** Paddle price id (`pri_...`) -> Superwall custom store product identifier. */
  readonly products: Readonly<Record<string, string>>
  readonly environment: "production" | "sandbox"
}

/**
 * Entities a notification does not carry but its mapping needs; the server fetches them
 * from the Paddle API before mapping.
 */
export type MappingContext = {
  /** For a refund: the refunded transaction (an adjustment has no items or custom data). */
  readonly transaction?: PaddleTransaction
  /** For a renewal of a price with a trial: the subscription, to spot the trial's conversion. */
  readonly subscription?: PaddleSubscription
}

export type MappingResult =
  | { readonly kind: "event"; readonly event: CustomStoreEvent }
  | { readonly kind: "ignored"; readonly reason: string }

const ignored = (reason: string): MappingResult => ({ kind: "ignored", reason })

/** Currencies Paddle bills in with no minor unit (developer.paddle.com supported currencies). */
const ZERO_DECIMAL = new Set(["CLP", "JPY", "KRW", "VND"])

/**
 * Paddle amounts are integer strings in the currency's lowest denomination; the event API
 * takes a decimal string in major units. String arithmetic, so no amount loses precision.
 */
export const toDecimalAmount = (lowest: string, currency: string): string => {
  if (!/^\d+$/.test(lowest)) throw new RangeError(`not a non-negative integer amount: ${lowest}`)
  const digits = lowest.replace(/^0+(?=\d)/, "")
  if (ZERO_DECIMAL.has(currency.toUpperCase())) return digits
  const padded = digits.padStart(3, "0")
  return `${padded.slice(0, -2)}.${padded.slice(-2)}`
}

const price = (lowest: string, currency: string) => ({
  amount: toDecimalAmount(lowest, currency),
  currency: currency.toUpperCase(),
})

/** Paddle amounts are integer strings; BigInt keeps the subtraction exact. */
const minus = (a: string, b: string): string => (BigInt(a) - BigInt(b)).toString()

/**
 * What the customer paid, after discounts and credits, before tax: `grand_total` (after
 * discount, tax and applied credit) less `grand_total_tax` (the tax included in it). This
 * also holds for tax-inclusive prices, whose `subtotal` contains tax.
 */
const chargedAmount = (transaction: PaddleTransaction): string => {
  const { grand_total, grand_total_tax } = transaction.details.totals
  const amount = minus(grand_total, grand_total_tax)
  return amount.startsWith("-") ? "0" : amount
}

/** Paddle's event id becomes the idempotency key: Paddle resends it unchanged on retries. */
export const eventIdFor = (paddleId: string): string =>
  `paddle_${paddleId}`.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 128)

/** Normalizes Paddle's microsecond timestamps to the millisecond ISO form. */
const iso = (value: string): string => new Date(value).toISOString()

const laterOf = (a: string, b: string) => (Date.parse(a) >= Date.parse(b) ? a : b)

/** The custom_data key holding the app user id passed to `Superwall.identify`. */
export const APP_USER_ID_KEY = "superwall_app_user_id"

/**
 * The custom_data key holding the SDK's `StoreProduct.customTransactionId`, which links
 * the subscription's revenue to the paywall that sold it.
 */
export const CUSTOM_TRANSACTION_ID_KEY = "superwall_custom_transaction_id"

/**
 * Placeholders Superwall refuses as user ids (matched trimmed and case-insensitively), the
 * same list as `AppUserId.DENYLISTED_VALUES` in `@open-revenue/schema`.
 */
const PLACEHOLDER_IDS = new Set(["null", "undefined", "(null)", "nil", "none"])

/**
 * Why `value` is not a usable identifier (an app user id or a product id), or `undefined`:
 * it must be a non-empty string of at most 255 characters with no surrounding whitespace,
 * and not a placeholder such as `"null"`.
 */
export const identifierProblem = (name: string, value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length === 0) return `${name} must be a non-empty string`
  if (value.length > 255) return `${name} must be at most 255 characters`
  if (value !== value.trim()) return `${name} has surrounding whitespace`
  if (PLACEHOLDER_IDS.has(value.toLowerCase())) return `${name} '${value}' is a placeholder`
  return undefined
}

const appUserIdOf = (customData: PaddleCustomData): string | { readonly reason: string } => {
  const value = customData?.[APP_USER_ID_KEY]
  if (value === undefined || value === null || value === "") {
    return { reason: `no app_user_id: set custom_data.${APP_USER_ID_KEY} on the checkout` }
  }
  const problem = identifierProblem("app_user_id", value)
  return problem ? { reason: problem } : (value as string)
}

const customTransactionIdOf = (customData: PaddleCustomData) => {
  // Attribution only: a value the API would refuse is dropped rather than failing the event.
  const value = customData?.[CUSTOM_TRANSACTION_ID_KEY]
  const id = typeof value === "string" ? value.trim() : ""
  return id.length > 0 && id.length <= 255 ? { custom_transaction_id: id } : {}
}

/**
 * The transaction's line item for a mapped price. A plan change bills the new price and
 * credits the old one (a negative line item), so a charged item wins over a credited one.
 */
const productItemOf = (transaction: PaddleTransaction, config: MappingConfig) => {
  const mapped = transaction.details.line_items.filter((line) => config.products[line.price_id])
  const line =
    mapped.find((candidate) => BigInt(candidate.totals.subtotal) > 0n) ??
    mapped.find((candidate) => BigInt(candidate.totals.subtotal) === 0n)
  if (!line) return undefined
  const item = transaction.items.find((candidate) => candidate.price.id === line.price_id)
  return item ? { price: item.price, product: config.products[line.price_id]! } : undefined
}

const describePrices = (transaction: PaddleTransaction) =>
  transaction.items.map((item) => item.price.id).join(", ") || "(none)"

const isPaidTrial = (price: PaddlePrice) => {
  const trialPrice = price.trial_period?.unit_price
  return trialPrice != null && BigInt(trialPrice.amount) > 0n
}

const DAY_MS = 24 * 60 * 60 * 1000
const near = (a: string | null | undefined, b: string) =>
  a != null && Math.abs(Date.parse(a) - Date.parse(b)) < DAY_MS

/**
 * Whether this renewal is the first charge after a trial. A transaction does not say, so the
 * server passes the subscription: the period it bills must start where an item's trial ended
 * (`items[].trial_dates.ends_at`), or, for a subscription that started in trial
 * (`first_billed_at` later than `started_at`; it is `null` during a free trial), at
 * `first_billed_at`, the moment Paddle first charged it.
 */
export const isTrialConversion = (
  transaction: PaddleTransaction,
  subscription: PaddleSubscription | undefined
): boolean => {
  const start = transaction.billing_period?.starts_at
  if (!subscription || !start) return false
  if (subscription.items.some((item) => near(item.trial_dates?.ends_at, start))) return true
  const startedInTrial =
    subscription.started_at != null &&
    subscription.first_billed_at != null &&
    Date.parse(subscription.first_billed_at) - Date.parse(subscription.started_at) >= DAY_MS
  return startedInTrial && near(subscription.first_billed_at, start)
}

/** Entities to fetch from the Paddle API before mapping; both may be needed at once. */
export type Lookup = { readonly transactionId?: string; readonly subscriptionId?: string }

/**
 * Which entities `mapPaddleNotification` needs fetched from the Paddle API for this
 * notification, if any: a refund's transaction and subscription, or the subscription of a
 * renewal that may end a free trial.
 */
export const requiredLookup = (notification: PaddleNotification): Lookup | undefined => {
  if (
    notification.event_type === "adjustment.created" ||
    notification.event_type === "adjustment.updated"
  ) {
    const adjustment = notification.data as PaddleAdjustment
    if (!isFullApprovedReversal(adjustment)) return undefined
    return {
      transactionId: adjustment.transaction_id,
      ...(adjustment.subscription_id ? { subscriptionId: adjustment.subscription_id } : {}),
    }
  }
  if (notification.event_type === "transaction.completed") {
    const transaction = notification.data as PaddleTransaction
    const hasFreeTrial = transaction.items.some(
      (item) => item.price.trial_period != null && !isPaidTrial(item.price)
    )
    return transaction.origin === "subscription_recurring" &&
      transaction.subscription_id &&
      hasFreeTrial
      ? { subscriptionId: transaction.subscription_id }
      : undefined
  }
  return undefined
}

/** Adjustments that take all of a transaction's money back: refunds and chargebacks. */
const REVERSALS = new Set(["refund", "chargeback"])

const isFullApprovedReversal = (adjustment: PaddleAdjustment) =>
  REVERSALS.has(adjustment.action) && adjustment.status === "approved" && adjustment.type === "full"

const mapTransaction = (
  notification: PaddleNotification,
  transaction: PaddleTransaction,
  config: MappingConfig,
  context: MappingContext
): MappingResult => {
  const item = productItemOf(transaction, config)
  if (!item) return ignored(`no mapped Paddle price among ${describePrices(transaction)}`)
  const appUserId = appUserIdOf(transaction.custom_data)
  if (typeof appUserId !== "string") return ignored(appUserId.reason)
  const charged = chargedAmount(transaction)
  const currency = transaction.details.totals.currency_code
  const base = {
    event_id: eventIdFor(notification.event_id),
    environment: config.environment,
    occurred_at: iso(notification.occurred_at),
    app_user_id: appUserId,
    product_id: item.product,
    transaction_id: transaction.id,
  }

  if (!transaction.subscription_id) {
    // A recurring price is always billed through a subscription; Paddle sets the id on
    // the completed checkout transaction.
    if (item.price.billing_cycle != null) {
      return ignored("recurring price on a transaction without subscription_id")
    }
    return {
      kind: "event",
      event: {
        ...base,
        type: "non_renewing_purchase",
        subscription_id: transaction.id,
        purchased_at: iso(transaction.billed_at ?? transaction.created_at),
        expires_at: null,
        period_type: "normal",
        price: price(charged, currency),
        ...customTransactionIdOf(transaction.custom_data),
      },
    }
  }

  const period = transaction.billing_period
  if (!period) return ignored("subscription transaction without billing_period")
  const common = {
    ...base,
    subscription_id: transaction.subscription_id,
    purchased_at: iso(period.starts_at),
    expires_at: iso(period.ends_at),
  }
  const isCharged = BigInt(charged) > 0n
  /** A charge that is not the subscription's start: a `renewal` of the charged price. */
  const chargedRenewal = (extra: Partial<CustomStoreEvent> = {}): MappingResult => ({
    kind: "event",
    event: {
      ...common,
      type: "renewal",
      period_type: "normal",
      price: price(charged, currency),
      ...extra,
    },
  })

  switch (transaction.origin) {
    // The checkout that created the subscription: Paddle.js (`web`) or a transaction
    // created through the API and paid at checkout (`api`, as this recipe's /paddle/checkout).
    case "web":
    case "api": {
      const inTrial = item.price.trial_period != null
      // A free trial's checkout is a zero-value transaction: the trial is reported from
      // subscription.created. A paid trial is charged its trial price here: an intro period.
      if (inTrial && !isCharged) return ignored("free trial start; subscription.created reports it")
      return {
        kind: "event",
        event: {
          ...common,
          type: "initial_purchase",
          period_type: inTrial ? "intro" : "normal",
          price: price(charged, currency),
          ...customTransactionIdOf(transaction.custom_data),
        },
      }
    }
    case "subscription_recurring":
      // Only a free trial converts: a paid trial was reported as an `intro` period, and its
      // first full-price charge is an ordinary renewal.
      return chargedRenewal(
        !isPaidTrial(item.price) && isTrialConversion(transaction, context.subscription)
          ? { is_trial_conversion: true }
          : {}
      )
    case "subscription_update":
      // A `product_change` carries no price, so a plan change Paddle charges for is
      // reported as a `renewal` of the new product: that is what moves money.
      if (isCharged) return chargedRenewal()
      return { kind: "event", event: { ...common, type: "product_change", period_type: "normal" } }
    case "subscription_charge":
      // A one-time charge on the subscription for a mapped price.
      if (!isCharged) return ignored("uncharged one-time subscription charge")
      return chargedRenewal()
    default:
      // subscription_payment_method_change: a (usually zero-value) card update, not revenue.
      return ignored(`transaction origin ${transaction.origin} is not mapped`)
  }
}

/** The subscription's mapped item: a recurring item that is billed or in trial. */
const subscriptionItemOf = (subscription: PaddleSubscription, config: MappingConfig) =>
  subscription.items.find((item) => config.products[item.price.id])

/** Start of the period that is ending or ended; a canceled subscription has no current one. */
const periodStartOf = (subscription: PaddleSubscription): string | undefined => {
  if (subscription.current_billing_period) return subscription.current_billing_period.starts_at
  const billed = subscription.items
    .map((item) => item.previously_billed_at)
    .filter((at): at is string => at != null)
    .sort((a, b) => Date.parse(b) - Date.parse(a))
  return billed[0] ?? subscription.first_billed_at ?? subscription.started_at ?? undefined
}

const mapSubscription = (
  notification: PaddleNotification,
  subscription: PaddleSubscription,
  config: MappingConfig
): MappingResult => {
  const item = subscriptionItemOf(subscription, config)
  if (!item) {
    const prices = subscription.items.map((entry) => entry.price.id).join(", ") || "(none)"
    return ignored(`no mapped Paddle price among ${prices}`)
  }
  const appUserId = appUserIdOf(subscription.custom_data)
  if (typeof appUserId !== "string") return ignored(appUserId.reason)
  const occurredAt = iso(notification.occurred_at)
  const start = periodStartOf(subscription)
  if (!start) return ignored("subscription has no billing period")
  const purchasedAt = iso(start)
  const trialing = subscription.status === "trialing"
  const common = {
    event_id: eventIdFor(notification.event_id),
    environment: config.environment,
    occurred_at: occurredAt,
    app_user_id: appUserId,
    product_id: config.products[item.price.id]!,
    subscription_id: subscription.id,
    // Subscription events carry no transaction; key them by the period.
    transaction_id: `${subscription.id}:${purchasedAt}`,
    purchased_at: purchasedAt,
    expires_at: subscription.current_billing_period
      ? iso(subscription.current_billing_period.ends_at)
      : null,
    period_type: trialing
      ? isPaidTrial(item.price)
        ? ("intro" as const)
        : ("trial" as const)
      : ("normal" as const),
  }

  switch (notification.event_type) {
    case "subscription.created":
      // A paid start (or a paid trial) is reported from its transaction.completed; only a
      // free trial, which has no charge, starts here.
      if (!trialing) return ignored("paid start; transaction.completed reports it")
      if (isPaidTrial(item.price)) return ignored("paid trial; transaction.completed reports it")
      if (!common.expires_at) return ignored("trial without a billing period")
      return {
        kind: "event",
        event: {
          ...common,
          type: "initial_purchase",
          transaction_id: subscription.transaction_id ?? common.transaction_id,
          price: price("0", subscription.currency_code),
          ...customTransactionIdOf(subscription.custom_data),
        },
      }
    case "subscription.updated":
      // Paddle sends subscription.updated for every change and no previous values, so only
      // a pending cancellation is recognizable. Its removal (an uncancellation) is not: see
      // the README. The next renewal turns auto-renew back on in Superwall.
      if (subscription.scheduled_change?.action !== "cancel") {
        return ignored("no scheduled cancellation")
      }
      if (subscription.status !== "active" && subscription.status !== "trialing") {
        return ignored(`scheduled cancellation on a ${subscription.status} subscription`)
      }
      if (!subscription.updated_at) return ignored("subscription without updated_at")
      return {
        kind: "event",
        event: {
          ...common,
          // Keyed by the scheduled change, so every subscription.updated that restates the
          // same pending cancel (Paddle sends one for any change) is the same event.
          event_id: eventIdFor(
            `${subscription.id}:cancel:${iso(subscription.scheduled_change.effective_at)}`
          ),
          // When Paddle last changed the subscription: the scheduling itself for the first
          // delivery, and identical on every retry or replay of it. Not the period start:
          // that is older than the period's own renewal, which would then win the
          // occurred_at ordering and turn auto-renew back on. See the README.
          occurred_at: iso(subscription.updated_at),
          type: "cancellation",
          expires_at: common.expires_at ?? iso(subscription.scheduled_change.effective_at),
          cancel_reason: "unknown",
        },
      }
    case "subscription.past_due":
      if (!common.expires_at) return ignored("past due without a billing period")
      return { kind: "event", event: { ...common, type: "billing_issue" } }
    case "subscription.canceled":
    case "subscription.paused": {
      // Canceled: access ends. Paused: access stops and Paddle bills nothing until the
      // subscription resumes, whose transaction.completed restores it. Superwall has no pause.
      const endedAt =
        notification.event_type === "subscription.canceled"
          ? subscription.canceled_at
          : subscription.paused_at
      return {
        kind: "event",
        event: {
          ...common,
          type: "expiration",
          period_type: "normal",
          expires_at: laterOf(iso(endedAt ?? notification.occurred_at), purchasedAt),
          cancel_reason: "unknown",
        },
      }
    }
    default:
      return ignored(`${notification.event_type} is not mapped`)
  }
}

const HOUR_MS = 60 * 60 * 1000

/**
 * Whether the refunded transaction paid for the subscription's current period (or, once it
 * ended, its most recent one): its billing period must reach past that period's start. A
 * renewal bills a whole period and a plan change bills the rest of one, so both overlap
 * it; an earlier period ends where the current one starts.
 */
export const paysCurrentPeriod = (
  transaction: PaddleTransaction,
  subscription: PaddleSubscription
): boolean => {
  const paid = transaction.billing_period
  const currentStart = periodStartOf(subscription)
  if (!paid || !currentStart) return false
  return Date.parse(paid.ends_at) - Date.parse(currentStart) > HOUR_MS
}

const mapRefund = (
  adjustment: PaddleAdjustment,
  config: MappingConfig,
  context: MappingContext
): MappingResult => {
  // `refund` revokes access, so only an approved full refund (or chargeback) maps to it.
  if (!REVERSALS.has(adjustment.action)) return ignored(`adjustment action ${adjustment.action}`)
  if (adjustment.type !== "full") {
    return ignored(`partial ${adjustment.action}; Superwall supports full refunds`)
  }
  if (adjustment.status !== "approved") {
    return ignored(`${adjustment.action} is ${adjustment.status}`)
  }
  const { transaction, subscription } = context
  if (!transaction || transaction.id !== adjustment.transaction_id) {
    return ignored("refunded transaction was not provided")
  }
  if (adjustment.subscription_id) {
    if (!subscription || subscription.id !== adjustment.subscription_id) {
      return ignored("refunded subscription was not provided")
    }
    // A refund ends the whole subscription in Superwall (and here in Paddle), so refunding
    // an older period (January's renewal on February 10) must not revoke the paid current
    // one: Paddle keeps billing the subscription, and so does Superwall.
    if (!paysCurrentPeriod(transaction, subscription)) {
      return ignored(`${adjustment.action} of a past period; the current period stays paid`)
    }
  }
  const item = productItemOf(transaction, config)
  if (!item) return ignored(`no mapped Paddle price among ${describePrices(transaction)}`)
  const appUserId = appUserIdOf(transaction.custom_data)
  if (typeof appUserId !== "string") return ignored(appUserId.reason)
  return {
    kind: "event",
    event: {
      // Keyed by the adjustment, not the notification: an approved refund can be announced
      // by adjustment.created (approved at once) and adjustment.updated, and a second
      // `refund` would count the refunded revenue twice. Every field is derived from the
      // adjustment and its transaction, so a repeat has an identical body.
      event_id: eventIdFor(adjustment.id),
      type: "refund",
      environment: config.environment,
      occurred_at: iso(adjustment.created_at),
      app_user_id: appUserId,
      product_id: item.product,
      subscription_id: adjustment.subscription_id ?? transaction.id,
      transaction_id: transaction.id,
      purchased_at: iso(
        transaction.billing_period?.starts_at ?? transaction.billed_at ?? transaction.created_at
      ),
      expires_at: transaction.billing_period ? iso(transaction.billing_period.ends_at) : null,
      period_type: "normal",
      // Before tax, like every other price this recipe reports.
      price: price(adjustment.totals.subtotal, adjustment.currency_code),
      cancel_reason: "unknown",
    },
  }
}

/**
 * Maps one Paddle notification. Money moves on `transaction.completed` (one per charge),
 * access changes on `subscription.*`, refunds arrive as `adjustment.*`. A free trial starts
 * on `subscription.created`; the other subscription events restate what transactions
 * already carry and are ignored, so revenue is never counted twice.
 */
export const mapPaddleNotification = (
  notification: PaddleNotification,
  config: MappingConfig,
  context: MappingContext = {}
): MappingResult => {
  switch (notification.event_type) {
    case "transaction.completed":
      return mapTransaction(notification, notification.data as PaddleTransaction, config, context)
    case "subscription.created":
    case "subscription.updated":
    case "subscription.past_due":
    case "subscription.canceled":
    case "subscription.paused":
      return mapSubscription(notification, notification.data as PaddleSubscription, config)
    case "adjustment.created":
    case "adjustment.updated":
      return mapRefund(notification.data as PaddleAdjustment, config, context)
    default:
      return ignored(`${notification.event_type} is not mapped`)
  }
}
