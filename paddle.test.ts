// npm test
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import {
  CheckoutVerificationError,
  checkoutSecretKey,
  escapeHtml,
  parseCheckoutRequest,
  priceIdFor,
  readReturnLinks,
  renderPayPage,
  verifySuperwallRequest,
  withReturnLinks,
  returnLinkKey,
} from "./checkout.ts"
import {
  eventIdFor,
  mapPaddleNotification,
  requiredLookup,
  toDecimalAmount,
  type MappingConfig,
  type MappingContext,
  type PaddleAdjustment,
  type PaddleNotification,
  type PaddleSubscription,
  type PaddleTransaction,
} from "./mapping.ts"
import { sign, verifyWebhook, WebhookVerificationError } from "./signature.ts"

const fixture = (name: string): PaddleNotification =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"))

const transactionNotification = fixture("transaction-completed")
const subscriptionNotification = fixture("subscription-updated")
const adjustmentNotification = fixture("adjustment-updated")
const transaction = transactionNotification.data as PaddleTransaction
const subscription = subscriptionNotification.data as PaddleSubscription
const adjustment = adjustmentNotification.data as PaddleAdjustment
const PRICE = transaction.items[0]!.price.id
const config: MappingConfig = { products: { [PRICE]: "pro_monthly" }, environment: "production" }
const AT = "2026-10-01T10:00:06.155Z"

const mapTransaction = (overrides: Partial<PaddleTransaction>, context?: MappingContext) =>
  mapPaddleNotification(
    { ...transactionNotification, data: { ...transaction, ...overrides } },
    config,
    context
  )
const mapSubscription = (eventType: string, overrides: Partial<PaddleSubscription>) =>
  mapPaddleNotification(
    {
      ...subscriptionNotification,
      event_type: eventType,
      data: { ...subscription, ...overrides },
    },
    config
  )
const mapAdjustment = (overrides: Partial<PaddleAdjustment>, context?: MappingContext) =>
  mapPaddleNotification(
    { ...adjustmentNotification, data: { ...adjustment, ...overrides } },
    config,
    context
  )

const eventOf = (result: ReturnType<typeof mapPaddleNotification>) => {
  assert.equal(result.kind, "event", result.kind === "ignored" ? result.reason : "")
  return (result as Extract<typeof result, { kind: "event" }>).event
}
const reasonOf = (result: ReturnType<typeof mapPaddleNotification>) => {
  assert.equal(result.kind, "ignored")
  return (result as Extract<typeof result, { kind: "ignored" }>).reason
}

/** Totals for a transaction that charged `charged` before tax, plus `tax`. */
const totals = (charged: string, tax: string, currency = "USD") => ({
  ...transaction.details,
  totals: {
    ...transaction.details.totals,
    grand_total: String(BigInt(charged) + BigInt(tax)),
    grand_total_tax: tax,
    currency_code: currency,
  },
})

const freeTrialPrice = {
  ...transaction.items[0]!.price,
  trial_period: { interval: "day", frequency: 7, requires_payment_method: true },
}
const paidTrialPrice = {
  ...freeTrialPrice,
  trial_period: {
    ...freeTrialPrice.trial_period,
    unit_price: { amount: "199", currency_code: "USD" },
  },
}

describe("transaction.completed", () => {
  it("first checkout of a subscription -> initial_purchase priced before tax", () => {
    assert.deepEqual(eventOf(mapTransaction({})), {
      event_id: "paddle_evt_01k6g2v9w4x1yq7e3h8s5n0m2a",
      type: "initial_purchase",
      app_user_id: "user_8812",
      product_id: "pro_monthly",
      subscription_id: "sub_01k6g2v9b2n4m6k8j0h2g4f6d8",
      transaction_id: "txn_01k6g2s4p6r8t0v2x4z6b8d0f2",
      environment: "production",
      occurred_at: AT,
      purchased_at: "2026-10-01T10:00:00.635Z",
      expires_at: "2026-11-01T10:00:00.635Z",
      period_type: "normal",
      price: { amount: "9.99", currency: "USD" },
      custom_transaction_id: "9f2c1d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
    })
    assert.equal(eventOf(mapTransaction({ origin: "web" })).type, "initial_purchase")
  })

  it("prices after discounts and credits, before tax", () => {
    const discounted = eventOf(mapTransaction({ details: totals("799", "160") }))
    assert.deepEqual(discounted.price, { amount: "7.99", currency: "USD" })
  })

  it("formats zero-decimal currencies without a decimal point (JPY)", () => {
    const yen = eventOf(
      mapTransaction({ currency_code: "JPY", details: totals("1500", "150", "JPY") })
    )
    assert.deepEqual(yen.price, { amount: "1500", currency: "JPY" })
  })

  it("is reported as sandbox in the sandbox environment", () => {
    const sandbox = mapPaddleNotification(transactionNotification, {
      ...config,
      environment: "sandbox",
    })
    assert.equal(eventOf(sandbox).environment, "sandbox")
  })

  it("a free trial's zero-value checkout is left to subscription.created", () => {
    const result = mapTransaction({
      items: [{ price: freeTrialPrice, quantity: 1 }],
      details: totals("0", "0"),
    })
    assert.match(reasonOf(result), /subscription\.created/)
  })

  it("a paid trial's checkout -> priced intro initial_purchase", () => {
    const event = eventOf(
      mapTransaction({
        items: [{ price: paidTrialPrice, quantity: 1 }],
        details: totals("199", "40"),
      })
    )
    assert.equal(event.type, "initial_purchase")
    assert.equal(event.period_type, "intro")
    assert.deepEqual(event.price, { amount: "1.99", currency: "USD" })
  })

  it("subscription_recurring -> renewal without the custom transaction id", () => {
    const event = eventOf(mapTransaction({ origin: "subscription_recurring" }))
    assert.equal(event.type, "renewal")
    assert.equal(event.is_trial_conversion, undefined)
    assert.equal("custom_transaction_id" in event, false)
    assert.equal(
      requiredLookup({
        ...transactionNotification,
        data: { ...transaction, origin: "subscription_recurring" },
      }),
      undefined
    )
  })

  it("the first renewal after a trial is its conversion, read from the subscription", () => {
    const recurring = {
      origin: "subscription_recurring",
      items: [{ price: freeTrialPrice, quantity: 1 }],
    }
    assert.deepEqual(
      requiredLookup({ ...transactionNotification, data: { ...transaction, ...recurring } }),
      { subscriptionId: transaction.subscription_id }
    )
    const periodStart = transaction.billing_period!.starts_at
    // trial_dates still on the item
    const withTrialDates: PaddleSubscription = {
      ...subscription,
      items: [
        {
          ...subscription.items[0]!,
          trial_dates: { starts_at: "2026-09-24T10:00:00.635628Z", ends_at: periodStart },
        },
      ],
    }
    assert.equal(
      eventOf(mapTransaction(recurring, { subscription: withTrialDates })).is_trial_conversion,
      true
    )
    // or a subscription that started in trial and was first billed at this period
    const startedInTrial: PaddleSubscription = {
      ...subscription,
      started_at: "2026-09-24T10:00:00.635628Z",
      first_billed_at: periodStart,
    }
    assert.equal(
      eventOf(mapTransaction(recurring, { subscription: startedInTrial })).is_trial_conversion,
      true
    )
    // a later renewal of the same subscription is not
    const later = {
      ...recurring,
      billing_period: { starts_at: "2026-11-01T10:00:00Z", ends_at: "2026-12-01T10:00:00Z" },
    }
    assert.equal(
      eventOf(mapTransaction(later, { subscription: startedInTrial })).is_trial_conversion,
      undefined
    )
    // no subscription (a dry run whose lookup failed): no flag
    assert.equal(eventOf(mapTransaction(recurring)).is_trial_conversion, undefined)
  })

  it("a paid trial's first full-price renewal is not flagged as a trial conversion", () => {
    const recurring = {
      origin: "subscription_recurring",
      items: [{ price: paidTrialPrice, quantity: 1 }],
    }
    assert.equal(
      requiredLookup({ ...transactionNotification, data: { ...transaction, ...recurring } }),
      undefined
    )
    const withTrialDates: PaddleSubscription = {
      ...subscription,
      items: [
        {
          ...subscription.items[0]!,
          trial_dates: {
            starts_at: "2026-09-24T10:00:00.635628Z",
            ends_at: transaction.billing_period!.starts_at,
          },
        },
      ],
    }
    const event = eventOf(mapTransaction(recurring, { subscription: withTrialDates }))
    assert.equal(event.type, "renewal")
    assert.equal(event.is_trial_conversion, undefined)
  })

  it("a charged subscription_update -> priced renewal of the new price", () => {
    const newPrice = { ...transaction.items[0]!.price, id: "pri_01k5x1yearly000000000000000" }
    const event = eventOf(
      mapPaddleNotification(
        {
          ...transactionNotification,
          data: {
            ...transaction,
            origin: "subscription_update",
            items: [transaction.items[0]!, { price: newPrice, quantity: 1 }],
            details: {
              ...totals("1500", "300"),
              line_items: [
                { price_id: PRICE, totals: { subtotal: "-500" } },
                { price_id: newPrice.id, totals: { subtotal: "2000" } },
              ],
            },
          },
        },
        { ...config, products: { [PRICE]: "pro_monthly", [newPrice.id]: "pro_yearly" } }
      )
    )
    assert.equal(event.type, "renewal")
    assert.equal(event.product_id, "pro_yearly")
    assert.deepEqual(event.price, { amount: "15.00", currency: "USD" })
  })

  it("an uncharged subscription_update -> unpriced product_change", () => {
    const event = eventOf(
      mapTransaction({ origin: "subscription_update", details: totals("0", "0") })
    )
    assert.equal(event.type, "product_change")
    assert.equal(event.price, undefined)
  })

  it("a charged subscription_charge -> renewal; an uncharged one is ignored", () => {
    assert.equal(eventOf(mapTransaction({ origin: "subscription_charge" })).type, "renewal")
    assert.equal(
      mapTransaction({ origin: "subscription_charge", details: totals("0", "0") }).kind,
      "ignored"
    )
  })

  it("a payment method change is ignored", () => {
    assert.equal(
      mapTransaction({ origin: "subscription_payment_method_change", details: totals("0", "0") })
        .kind,
      "ignored"
    )
  })

  it("no subscription_id -> lifetime non_renewing_purchase keyed by the transaction", () => {
    const oneTime = { ...transaction.items[0]!.price, billing_cycle: null }
    const event = eventOf(
      mapTransaction({
        subscription_id: null,
        billing_period: null,
        items: [{ price: oneTime, quantity: 1 }],
      })
    )
    assert.equal(event.type, "non_renewing_purchase")
    assert.equal(event.subscription_id, transaction.id)
    assert.equal(event.expires_at, null)
    assert.equal(event.purchased_at, "2026-10-01T10:00:01.294Z")
    assert.equal(event.custom_transaction_id, "9f2c1d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f")
  })

  it("ignores a recurring price on a transaction without subscription_id", () => {
    assert.equal(mapTransaction({ subscription_id: null }).kind, "ignored")
  })
})

describe("subscription events", () => {
  it("subscription.created while in a free trial -> trial initial_purchase priced 0", () => {
    const trialEnd = "2026-10-08T10:00:00.635628Z"
    const event = eventOf(
      mapSubscription("subscription.created", {
        status: "trialing",
        first_billed_at: null,
        scheduled_change: null,
        current_billing_period: { starts_at: "2026-10-01T10:00:00.635628Z", ends_at: trialEnd },
        items: [{ ...subscription.items[0]!, status: "trialing", price: freeTrialPrice }],
      })
    )
    assert.equal(event.type, "initial_purchase")
    assert.equal(event.period_type, "trial")
    assert.deepEqual(event.price, { amount: "0.00", currency: "USD" })
    assert.equal(event.expires_at, "2026-10-08T10:00:00.635Z")
    assert.equal(event.transaction_id, subscription.transaction_id)
    assert.equal(event.custom_transaction_id, "9f2c1d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f")
  })

  it("subscription.created for a paid start or a paid trial is left to the transaction", () => {
    assert.equal(
      mapSubscription("subscription.created", { scheduled_change: null }).kind,
      "ignored"
    )
    assert.equal(
      mapSubscription("subscription.created", {
        status: "trialing",
        items: [{ ...subscription.items[0]!, status: "trialing", price: paidTrialPrice }],
      }).kind,
      "ignored"
    )
  })

  it("subscription.updated with a scheduled cancel -> cancellation, access until period end", () => {
    const event = eventOf(mapSubscription("subscription.updated", {}))
    assert.equal(event.type, "cancellation")
    assert.equal(event.expires_at, "2026-11-01T10:00:00.635Z")
    assert.equal(event.cancel_reason, "unknown")
    assert.equal(event.price, undefined)
    assert.equal(event.transaction_id, `${subscription.id}:2026-10-01T10:00:00.635Z`)
  })

  it("keys a cancellation by the scheduled change, so restatements are one event", () => {
    const first = eventOf(mapSubscription("subscription.updated", {}))
    assert.equal(
      first.event_id,
      "paddle_sub_01k6g2v9b2n4m6k8j0h2g4f6d8:cancel:2026-11-01T10:00:00.635Z"
    )
    // occurred_at is the subscription's updated_at, not the notification's
    assert.equal(first.occurred_at, "2026-10-10T08:00:00.761Z")
    // The same scheduled cancel in another delivery (another event id, a later notification
    // time) is the same event, body included.
    const again = mapPaddleNotification(
      {
        ...subscriptionNotification,
        event_id: "evt_01k6j9zzzzzzzzzzzzzzzzzzzz",
        occurred_at: "2026-10-10T08:05:00Z",
      },
      config
    )
    assert.deepEqual(eventOf(again), first)
    // A cancel scheduled for another date is another event.
    const rescheduled = eventOf(
      mapSubscription("subscription.updated", {
        scheduled_change: { action: "cancel", effective_at: "2026-12-01T10:00:00Z" },
      })
    )
    assert.notEqual(rescheduled.event_id, first.event_id)
  })

  it("subscription.updated without a scheduled cancel is ignored (no stateless uncancellation)", () => {
    assert.equal(
      mapSubscription("subscription.updated", { scheduled_change: null }).kind,
      "ignored"
    )
    assert.equal(
      mapSubscription("subscription.updated", {
        scheduled_change: { action: "pause", effective_at: "2026-11-01T10:00:00Z" },
      }).kind,
      "ignored"
    )
  })

  it("subscription.past_due -> billing_issue", () => {
    const event = eventOf(
      mapSubscription("subscription.past_due", { status: "past_due", scheduled_change: null })
    )
    assert.equal(event.type, "billing_issue")
  })

  it("subscription.canceled -> expiration at canceled_at", () => {
    const event = eventOf(
      mapSubscription("subscription.canceled", {
        status: "canceled",
        canceled_at: "2026-10-20T11:24:54.868Z",
        current_billing_period: null,
        scheduled_change: null,
      })
    )
    assert.equal(event.type, "expiration")
    assert.equal(event.expires_at, "2026-10-20T11:24:54.868Z")
    assert.equal(event.purchased_at, "2026-10-01T10:00:00.635Z")
  })

  it("subscription.paused -> expiration at paused_at", () => {
    const event = eventOf(
      mapSubscription("subscription.paused", {
        status: "paused",
        paused_at: "2026-10-15T12:43:43.214Z",
        current_billing_period: null,
        scheduled_change: null,
      })
    )
    assert.equal(event.type, "expiration")
    assert.equal(event.expires_at, "2026-10-15T12:43:43.214Z")
  })

  it("restating events are ignored", () => {
    for (const type of [
      "subscription.activated",
      "subscription.trialing",
      "subscription.resumed",
      "subscription.imported",
      "transaction.paid",
      "transaction.created",
      "customer.created",
    ]) {
      assert.equal(mapSubscription(type, {}).kind, "ignored", type)
    }
  })
})

describe("adjustments", () => {
  const refundContext = { transaction, subscription }

  it("an approved full refund -> refund keyed by the adjustment, needing its transaction and subscription", () => {
    assert.deepEqual(requiredLookup(adjustmentNotification), {
      transactionId: adjustment.transaction_id,
      subscriptionId: adjustment.subscription_id,
    })
    assert.deepEqual(eventOf(mapAdjustment({}, refundContext)), {
      event_id: "paddle_adj_01k6m2z8a0c2e4g6j8l0n2q4s6",
      type: "refund",
      environment: "production",
      occurred_at: "2026-10-12T08:48:20.239Z",
      app_user_id: "user_8812",
      product_id: "pro_monthly",
      subscription_id: "sub_01k6g2v9b2n4m6k8j0h2g4f6d8",
      transaction_id: "txn_01k6g2s4p6r8t0v2x4z6b8d0f2",
      purchased_at: "2026-10-01T10:00:00.635Z",
      expires_at: "2026-11-01T10:00:00.635Z",
      period_type: "normal",
      price: { amount: "9.99", currency: "USD" },
      cancel_reason: "unknown",
    })
  })

  it("the same refund announced by adjustment.created maps to the same event", () => {
    const created = mapPaddleNotification(
      { ...adjustmentNotification, event_id: "evt_other", event_type: "adjustment.created" },
      config,
      refundContext
    )
    assert.deepEqual(eventOf(created), eventOf(mapAdjustment({}, refundContext)))
  })

  it("an approved full chargeback is a refund too", () => {
    const chargeback = { action: "chargeback" }
    assert.ok(requiredLookup({ ...adjustmentNotification, data: { ...adjustment, ...chargeback } }))
    const event = eventOf(mapAdjustment(chargeback, refundContext))
    assert.equal(event.type, "refund")
    assert.equal(event.event_id, "paddle_adj_01k6m2z8a0c2e4g6j8l0n2q4s6")
  })

  it("ignores partial, pending, rejected, credit and chargeback-reversal adjustments", () => {
    for (const overrides of [
      { type: "partial" },
      { status: "pending_approval" },
      { status: "rejected" },
      { action: "credit" },
      { action: "chargeback_reverse" },
      { action: "chargeback", type: "partial" },
    ]) {
      assert.equal(
        mapAdjustment(overrides, refundContext).kind,
        "ignored",
        JSON.stringify(overrides)
      )
      assert.equal(
        requiredLookup({ ...adjustmentNotification, data: { ...adjustment, ...overrides } }),
        undefined
      )
    }
  })

  it("ignores a refund of a past period: refunding January on February 10 keeps February", () => {
    const january: PaddleTransaction = {
      ...transaction,
      billing_period: {
        starts_at: "2026-09-01T10:00:00.635628Z",
        ends_at: "2026-10-01T10:00:00.635628Z",
      },
    }
    assert.match(reasonOf(mapAdjustment({}, { transaction: january, subscription })), /past period/)
  })

  it("a plan change mid-period pays the current period", () => {
    const proration: PaddleTransaction = {
      ...transaction,
      billing_period: { starts_at: "2026-10-15T00:00:00Z", ends_at: "2026-11-01T10:00:00.635628Z" },
    }
    assert.equal(mapAdjustment({}, { transaction: proration, subscription }).kind, "event")
  })

  it("compares a canceled subscription with its most recent period", () => {
    const canceled: PaddleSubscription = {
      ...subscription,
      status: "canceled",
      current_billing_period: null,
      scheduled_change: null,
    }
    assert.equal(mapAdjustment({}, { transaction, subscription: canceled }).kind, "event")
  })

  it("a one-time purchase needs no subscription", () => {
    const oneTime: PaddleTransaction = {
      ...transaction,
      subscription_id: null,
      billing_period: null,
    }
    const notification = {
      ...adjustmentNotification,
      data: { ...adjustment, subscription_id: null },
    }
    assert.deepEqual(requiredLookup(notification), { transactionId: adjustment.transaction_id })
    const event = eventOf(mapPaddleNotification(notification, config, { transaction: oneTime }))
    assert.equal(event.subscription_id, transaction.id)
    assert.equal(event.expires_at, null)
  })

  it("a refund without its transaction or subscription is not guessed", () => {
    assert.equal(mapAdjustment({}).kind, "ignored")
    assert.equal(mapAdjustment({}, { transaction }).kind, "ignored")
  })
})

describe("app_user_id and products", () => {
  it("ignores events without an app user id, with a padded one, or for an unmapped price", () => {
    assert.match(reasonOf(mapTransaction({ custom_data: null })), /superwall_app_user_id/)
    assert.match(
      reasonOf(mapTransaction({ custom_data: { superwall_app_user_id: " u " } })),
      /whitespace/
    )
    assert.match(
      reasonOf(mapSubscription("subscription.updated", { custom_data: {} })),
      /app_user_id/
    )
    assert.match(
      reasonOf(mapPaddleNotification(transactionNotification, { ...config, products: {} })),
      /no mapped Paddle price/
    )
  })

  it("ignores placeholder and overlong app user ids", () => {
    for (const id of ["null", "Undefined", "(null)", "nil", "NONE", "x".repeat(256)]) {
      assert.equal(
        mapTransaction({ custom_data: { superwall_app_user_id: id } }).kind,
        "ignored",
        id
      )
    }
  })

  it("drops a custom transaction id the API would refuse", () => {
    const tooLong = eventOf(
      mapTransaction({
        custom_data: {
          superwall_app_user_id: "u",
          superwall_custom_transaction_id: "x".repeat(256),
        },
      })
    )
    assert.equal("custom_transaction_id" in tooLong, false)
  })

  it("derives an API-safe event id", () => {
    assert.equal(eventIdFor("evt_1/a+="), "paddle_evt_1_a__")
    assert.equal(eventIdFor("x".repeat(200)).length, 128)
  })

  it("formats lowest-denomination amounts as decimal strings", () => {
    assert.equal(toDecimalAmount("999", "USD"), "9.99")
    assert.equal(toDecimalAmount("5", "eur"), "0.05")
    assert.equal(toDecimalAmount("0", "USD"), "0.00")
    assert.equal(toDecimalAmount("123456789012", "USD"), "1234567890.12")
    assert.equal(toDecimalAmount("1500", "JPY"), "1500")
    assert.equal(toDecimalAmount("980", "KRW"), "980")
    assert.throws(() => toDecimalAmount("-1", "USD"), RangeError)
  })
})

describe("verifyWebhook", () => {
  const body = JSON.stringify(transactionNotification)
  const secret = "pdl_ntfset_01k6000000000000000000000_testsecret"
  const now = 1_790_000_000
  const header = (ts = String(now), key = secret) => `ts=${ts};h1=${sign(key, ts, body)}`

  it("accepts a valid signature", () => {
    assert.doesNotThrow(() => verifyWebhook(body, header(), secret, now))
  })

  it("accepts any h1 while a secret rotates", () => {
    const rotated = `ts=${now};h1=${"0".repeat(64)};h1=${sign(secret, String(now), body)}`
    assert.doesNotThrow(() => verifyWebhook(body, rotated, secret, now))
  })

  it("rejects a tampered body, a wrong secret, a stale timestamp and a missing header", () => {
    assert.throws(() => verifyWebhook(`${body} `, header(), secret, now), WebhookVerificationError)
    assert.throws(
      () => verifyWebhook(body, header(String(now), "pdl_ntfset_other"), secret, now),
      WebhookVerificationError
    )
    assert.throws(
      () => verifyWebhook(body, header(String(now - 6)), secret, now),
      WebhookVerificationError
    )
    assert.throws(() => verifyWebhook(body, undefined, secret, now), WebhookVerificationError)
    assert.throws(() => verifyWebhook(body, "h1=abc", secret, now), WebhookVerificationError)
    assert.throws(
      () => verifyWebhook(body, `ts=${now};h1=not-hex`, secret, now),
      WebhookVerificationError
    )
  })
})

describe("checkout helpers", () => {
  const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"
  const request = {
    type: "checkout.create",
    custom_store_id: "4821",
    product_id: "pro_monthly",
    app_user_id: "u",
    custom_transaction_id: "ctx_1",
    success_url: "https://sw.example.com/return?status=completed",
    cancel_url: "https://sw.example.com/return?status=closed",
  }

  it("verifies the Standard Webhooks reference signature", () => {
    // The vector every Standard Webhooks library is tested against.
    const headers = {
      id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
      timestamp: "1614265330",
      signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
    }
    const body = '{"test": 2432232314}'
    verifySuperwallRequest(body, headers, SECRET, 1614265330)
    // Any of several signatures (a rotating secret) matches.
    verifySuperwallRequest(
      body,
      { ...headers, signature: `v1,bm9wZQ== ${headers.signature}` },
      SECRET,
      1614265330
    )
    assert.throws(
      () => verifySuperwallRequest(`${body} `, headers, SECRET, 1614265330),
      CheckoutVerificationError
    )
    assert.throws(
      () => verifySuperwallRequest(body, headers, SECRET, 1614265330 + 301),
      CheckoutVerificationError
    )
    assert.throws(
      () => verifySuperwallRequest(body, { ...headers, signature: undefined }, SECRET, 1614265330),
      CheckoutVerificationError
    )
  })

  it("validates the checkout.create body", () => {
    assert.deepEqual(parseCheckoutRequest(request), {
      app_user_id: "u",
      product_id: "pro_monthly",
      custom_transaction_id: "ctx_1",
      success_url: request.success_url,
      cancel_url: request.cancel_url,
    })
    assert.equal(typeof parseCheckoutRequest({ ...request, type: "checkout.other" }), "string")
    assert.equal(typeof parseCheckoutRequest({ ...request, custom_transaction_id: 5 }), "string")
    assert.equal(typeof parseCheckoutRequest({ ...request, cancel_url: "javascript:x" }), "string")
    assert.equal(typeof parseCheckoutRequest([]), "string")
  })

  it("refuses ids Superwall would refuse: empty, overlong, padded or placeholders", () => {
    const problemOf = (body: Record<string, unknown>) => {
      const result = parseCheckoutRequest({ ...request, ...body })
      assert.equal(typeof result, "string", JSON.stringify(body))
      return result as string
    }
    assert.match(problemOf({ app_user_id: "" }), /app_user_id must be a non-empty string/)
    assert.match(problemOf({ app_user_id: "x".repeat(256) }), /at most 255/)
    assert.match(problemOf({ app_user_id: "null" }), /placeholder/)
    assert.match(problemOf({ app_user_id: "undefined" }), /placeholder/)
    assert.match(problemOf({ product_id: " pro" }), /product_id has surrounding whitespace/)
    assert.match(problemOf({ product_id: "None" }), /placeholder/)
    assert.match(problemOf({ custom_transaction_id: "x".repeat(256) }), /custom_transaction_id/)
  })

  it("finds the Paddle price for a Superwall product", () => {
    assert.equal(priceIdFor({ pri_a: "pro_monthly", pri_b: "pro_yearly" }, "pro_yearly"), "pri_b")
    assert.equal(priceIdFor({ pri_a: "pro_monthly" }, "missing"), undefined)
  })

  const LINK_KEY = returnLinkKey("pdl_ntfset_01k6000000000000000000000_testsecret")

  it("signs the return links into the pay page URL and reads back only its own", () => {
    const links = { completed: request.success_url, closed: request.cancel_url }
    const url = new URL(
      withReturnLinks("https://f.example.com/paddle/pay?_ptxn=txn_1", links, LINK_KEY)
    )
    assert.equal(url.searchParams.get("_ptxn"), "txn_1")
    assert.deepEqual(readReturnLinks(url.searchParams, LINK_KEY), links)
    url.searchParams.set(
      "sw_return",
      Buffer.from('{"completed":"https://evil","closed":"x"}').toString("base64url")
    )
    assert.equal(readReturnLinks(url.searchParams, LINK_KEY), undefined)
    assert.equal(readReturnLinks(new URLSearchParams("_ptxn=txn_1"), LINK_KEY), undefined)
  })

  it("does not accept one transaction's return links on another's pay page, or another key's", () => {
    const links = { completed: request.success_url, closed: request.cancel_url }
    const url = new URL(
      withReturnLinks("https://f.example.com/paddle/pay?_ptxn=txn_1", links, LINK_KEY)
    )
    assert.equal(readReturnLinks(url.searchParams, returnLinkKey("pdl_ntfset_other")), undefined)
    url.searchParams.set("_ptxn", "txn_2")
    assert.equal(readReturnLinks(url.searchParams, LINK_KEY), undefined)
  })

  it("accepts only a whsec_ secret with a key", () => {
    assert.equal(checkoutSecretKey(SECRET).length, 24)
    for (const bad of [
      "",
      "whsec_",
      "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
      "whsec_not base64!",
      "whsec_c2hvcnQ=",
    ]) {
      assert.throws(() => checkoutSecretKey(bad), /SUPERWALL_CHECKOUT_SECRET/)
    }
  })

  it("escapes every injected value on the pay page", () => {
    const hostile = `</script><script>alert("x")</script>&'`
    const page = renderPayPage({
      clientToken: hostile,
      environment: "sandbox",
      transactionId: "txn_<b>",
      returnLinks: { completed: `https://x.example.com/?"${hostile}`, closed: "https://x" },
    })
    assert.equal(page.includes("</script><script>alert"), false)
    assert.equal(page.includes("<b>"), false)
    assert.ok(page.includes("txn_&lt;b&gt;"))
    assert.ok(page.includes("\\u003c/script\\u003e"))
    assert.equal(escapeHtml(`<a href="x">'&`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;")
    // The injected config is valid JavaScript that round-trips to the original values.
    const json = /const config = (.*);\n/.exec(page)![1]!
    assert.equal(JSON.parse(json).token, hostile)
    const separator = String.fromCharCode(0x2028)
    const separated = renderPayPage({
      clientToken: `a${separator}b`,
      environment: "production",
      transactionId: "txn_1",
      returnLinks: undefined,
    })
    assert.equal(separated.includes(separator), false)
    assert.ok(separated.includes("a\\u2028b"))
  })

  it("loads Paddle.js v2, selects sandbox only in sandbox, and returns to Superwall", () => {
    const input = {
      clientToken: "test_abc",
      transactionId: "txn_1",
      returnLinks: { completed: request.success_url, closed: request.cancel_url },
    }
    const sandbox = renderPayPage({ ...input, environment: "sandbox" })
    assert.ok(sandbox.includes('<script src="https://cdn.paddle.com/paddle/v2/paddle.js">'))
    assert.ok(sandbox.includes('"sandbox":true'))
    assert.ok(sandbox.includes("checkout.completed"))
    assert.ok(sandbox.includes('"completedUrl":"https://sw.example.com/return?status=completed"'))
    assert.ok(renderPayPage({ ...input, environment: "production" }).includes('"sandbox":false'))
  })
})
