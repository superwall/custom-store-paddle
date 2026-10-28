// node --test 'scripts/custom-store/recipes/paddle/*.test.ts'
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { after, before, beforeEach, describe, it } from "node:test"
import type { PaddleNotification, PaddleSubscription, PaddleTransaction } from "./mapping.ts"
import { environmentOf } from "./paddle-api.ts"
import { createHmac } from "node:crypto"
import { configFromEnv, createForwarder, type ForwarderConfig } from "./server.ts"
import { sign } from "./signature.ts"

const fixture = (name: string): PaddleNotification =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"))
const transactionNotification = fixture("transaction-completed")
const adjustmentNotification = fixture("adjustment-updated")
const transaction = transactionNotification.data as PaddleTransaction
const subscription = fixture("subscription-updated").data as PaddleSubscription
const PRICE = transaction.items[0]!.price.id
const SECRET = "pdl_ntfset_01k6000000000000000000000_testsecret"
const CHECKOUT_URL = "https://forwarder.example.com/paddle/pay?_ptxn=txn_01k6new0000000000000000000"
const CHECKOUT_SECRET = `whsec_${Buffer.from("superwall-checkout-test-secret!!").toString("base64")}`

type Recorded = { method?: string; url?: string; authorization?: string; body: unknown }

/** One local server playing both the Paddle API and the Superwall API. */
const upstream: Recorded[] = []
let cancel: { status: number; hang: boolean }
let superwallStatus: number
let fake: Server
let fakeUrl: string

const listen = async (server: Server) => {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`
}

before(async () => {
  fake = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      upstream.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: raw ? JSON.parse(raw) : undefined,
      })
      const reply = (status: number, body: unknown) =>
        response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body))
      if (request.url === "/transactions" && request.method === "POST") {
        return reply(201, {
          data: {
            id: "txn_01k6new0000000000000000000",
            status: "draft",
            checkout: { url: CHECKOUT_URL },
          },
        })
      }
      if (request.url?.startsWith("/transactions/")) return reply(200, { data: transaction })
      if (request.url?.endsWith("/cancel")) {
        if (cancel.hang) return // never answers: the forwarder's deadline must
        return cancel.status === 200
          ? reply(200, { data: { status: "canceled" } })
          : reply(cancel.status, { error: { code: "subscription_is_canceled_action_invalid" } })
      }
      if (request.url?.startsWith("/subscriptions/")) return reply(200, { data: subscription })
      if (request.url?.startsWith("/v2/custom-stores/")) {
        return superwallStatus === 200
          ? reply(200, { results: [{ status: "accepted" }] })
          : reply(superwallStatus, { error: "nope" })
      }
      reply(404, { error: { code: "not_found" } })
    })
  })
  fakeUrl = await listen(fake)
})
after(() => {
  fake.closeAllConnections()
  fake.close()
})
beforeEach(() => {
  upstream.length = 0
  cancel = { status: 200, hang: false }
  superwallStatus = 200
})

const startForwarder = async (overrides: Partial<ForwarderConfig>) => {
  const logs: string[] = []
  const config: ForwarderConfig = {
    webhookSecret: SECRET,
    paddle: { apiKey: "pdl_sdbx_apikey_test", apiUrl: fakeUrl },
    clientToken: "test_client_token",
    environment: "sandbox",
    products: { [PRICE]: "pro_monthly" },
    superwall: { apiKey: "sk_test", storeId: "4821", apiUrl: fakeUrl },
    checkoutSecret: CHECKOUT_SECRET,
    dryRun: false,
    webhookBudgetMs: 4_000,
    log: (line) => logs.push(line),
    ...overrides,
  }
  const server = createServer(createForwarder(config))
  const url = await listen(server)
  return { url, logs, close: () => server.close() }
}

const deliver = (url: string, notification: PaddleNotification, signature?: string) => {
  const body = JSON.stringify(notification)
  const ts = String(Math.floor(Date.now() / 1000))
  return fetch(`${url}/paddle/webhooks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "paddle-signature": signature ?? `ts=${ts};h1=${sign(SECRET, ts, body)}`,
    },
    body,
  })
}

const calls = () => upstream.map((call) => `${call.method} ${call.url}`)

describe("environment", () => {
  it("comes from the API key and client token prefixes, which must agree", () => {
    assert.equal(environmentOf("pdl_sdbx_apikey_x", "test_x"), "sandbox")
    assert.equal(environmentOf("pdl_live_apikey_x", "live_x"), "production")
    assert.throws(() => environmentOf("pdl_sdbx_apikey_x", "live_x"), /sandbox.*production/)
    assert.throws(() => environmentOf("pdl_live_apikey_x", "test_x"), /production.*sandbox/)
    assert.throws(() => environmentOf("sk_x", "test_x"), /PADDLE_API_KEY/)
    assert.throws(() => environmentOf("pdl_sdbx_apikey_x", "tok_x"), /PADDLE_CLIENT_TOKEN/)
  })

  it("refuses to start with mismatched keys; picks the sandbox API for sandbox keys", () => {
    const env = {
      PADDLE_API_KEY: "pdl_sdbx_apikey_x",
      PADDLE_CLIENT_TOKEN: "test_x",
      PADDLE_WEBHOOK_SECRET: "pdl_ntfset_x",
      PADDLE_PRODUCTS: "{}",
      SUPERWALL_CHECKOUT_SECRET: CHECKOUT_SECRET,
      DRY_RUN: "1",
    }
    const config = configFromEnv(env)
    assert.equal(config.environment, "sandbox")
    assert.equal(config.paddle.apiUrl, "https://sandbox-api.paddle.com")
    assert.equal(
      configFromEnv({ ...env, PADDLE_API_KEY: "pdl_live_apikey_x", PADDLE_CLIENT_TOKEN: "live_x" })
        .paddle.apiUrl,
      "https://api.paddle.com"
    )
    assert.throws(() => configFromEnv({ ...env, PADDLE_CLIENT_TOKEN: "live_x" }))
  })

  it("refuses to start with a malformed checkout secret", () => {
    const env = {
      PADDLE_API_KEY: "pdl_sdbx_apikey_x",
      PADDLE_CLIENT_TOKEN: "test_x",
      PADDLE_WEBHOOK_SECRET: "pdl_ntfset_x",
      PADDLE_PRODUCTS: "{}",
      DRY_RUN: "1",
    }
    assert.throws(
      () => configFromEnv({ ...env, SUPERWALL_CHECKOUT_SECRET: "sk_not_a_whsec" }),
      /SUPERWALL_CHECKOUT_SECRET/
    )
  })

  it("refuses to start with a non-numeric store id", () => {
    const env = {
      PADDLE_API_KEY: "pdl_sdbx_apikey_x",
      PADDLE_CLIENT_TOKEN: "test_x",
      PADDLE_WEBHOOK_SECRET: "pdl_ntfset_x",
      PADDLE_PRODUCTS: "{}",
      SUPERWALL_CHECKOUT_SECRET: CHECKOUT_SECRET,
      SUPERWALL_API_KEY: "sk_x",
    }
    assert.equal(
      configFromEnv({ ...env, SUPERWALL_CUSTOM_STORE_ID: "4821" }).superwall?.storeId,
      "4821"
    )
    assert.throws(
      () => configFromEnv({ ...env, SUPERWALL_CUSTOM_STORE_ID: "cs_4821" }),
      /SUPERWALL_CUSTOM_STORE_ID/
    )
  })
})

describe("webhooks", () => {
  it("rejects an unsigned delivery with 403", async () => {
    const forwarder = await startForwarder({})
    const response = await deliver(forwarder.url, transactionNotification, "ts=1;h1=00")
    assert.equal(response.status, 403)
    assert.equal(upstream.length, 0)
    forwarder.close()
  })

  it("forwards a mapped event to Superwall as a one-event batch", async () => {
    const forwarder = await startForwarder({})
    const response = await deliver(forwarder.url, transactionNotification)
    assert.equal(response.status, 200)
    const [post] = upstream
    assert.equal(post?.url, "/v2/custom-stores/4821/events")
    assert.equal(post?.authorization, "Bearer sk_test")
    const { events } = post?.body as { events: Array<{ type: string; environment: string }> }
    assert.equal(events.length, 1)
    assert.equal(events[0]?.type, "initial_purchase")
    assert.equal(events[0]?.environment, "sandbox")
    forwarder.close()
  })

  it("answers 200 to an ignored event, so Paddle does not retry it", async () => {
    const forwarder = await startForwarder({})
    const response = await deliver(forwarder.url, {
      ...transactionNotification,
      event_type: "transaction.paid",
    })
    assert.equal(response.status, 200)
    assert.equal(upstream.length, 0)
    forwarder.close()
  })

  it("answers 200 when Superwall refuses the request itself, so Paddle stops retrying", async () => {
    const forwarder = await startForwarder({})
    for (const status of [400, 413, 422]) {
      superwallStatus = status
      assert.equal((await deliver(forwarder.url, transactionNotification)).status, 200, `${status}`)
    }
    assert.ok(forwarder.logs.some((line) => line.includes("Superwall refused it (422)")))
    forwarder.close()
  })

  it("fails the delivery on 5xx, 401, 403, 404, 408 and 429, so Paddle retries", async () => {
    const forwarder = await startForwarder({})
    for (const status of [500, 503, 401, 403, 404, 408, 429]) {
      superwallStatus = status
      assert.equal((await deliver(forwarder.url, transactionNotification)).status, 502, `${status}`)
    }
    forwarder.close()
  })

  it("a refund reads its transaction and subscription, then cancels the subscription", async () => {
    const forwarder = await startForwarder({})
    assert.equal((await deliver(forwarder.url, adjustmentNotification)).status, 200)
    const made = calls()
    // The two lookups run in parallel.
    assert.deepEqual(made.slice(0, 2).sort(), [
      `GET /subscriptions/${transaction.subscription_id}`,
      `GET /transactions/${transaction.id}`,
    ])
    assert.deepEqual(made.slice(2), [
      "POST /v2/custom-stores/4821/events",
      `POST /subscriptions/${transaction.subscription_id}/cancel`,
    ])
    assert.deepEqual(upstream[3]?.body, { effective_from: "immediately" })
    // A retried delivery finds the subscription already canceled.
    cancel = { status: 400, hang: false }
    assert.equal((await deliver(forwarder.url, adjustmentNotification)).status, 200)
    assert.ok(forwarder.logs.some((line) => line.endsWith("already_canceled")))
    forwarder.close()
  })

  it("answers within its deadline when the cancel hangs, failing the delivery loudly", async () => {
    const forwarder = await startForwarder({ webhookBudgetMs: 300 })
    cancel = { status: 200, hang: true }
    const started = Date.now()
    const response = await deliver(forwarder.url, adjustmentNotification)
    const elapsed = Date.now() - started
    assert.equal(response.status, 502)
    assert.ok(elapsed < 1_000, `answered after ${elapsed} ms`)
    assert.ok(forwarder.logs.some((line) => line.startsWith("CANCEL FAILED")))
    forwarder.close()
  })

  it("DRY_RUN logs the mapped event and calls neither Superwall nor Paddle's cancel", async () => {
    const forwarder = await startForwarder({ dryRun: true, superwall: undefined })
    assert.equal((await deliver(forwarder.url, transactionNotification)).status, 200)
    assert.equal((await deliver(forwarder.url, adjustmentNotification)).status, 200)
    // Only the refund's lookups reach the Paddle API.
    assert.deepEqual(calls().sort(), [
      `GET /subscriptions/${transaction.subscription_id}`,
      `GET /transactions/${transaction.id}`,
    ])
    const logged = forwarder.logs
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as { dry_run: boolean; event: { type: string } })
    assert.deepEqual(
      logged.map((entry) => [entry.dry_run, entry.event.type]),
      [
        [true, "initial_purchase"],
        [true, "refund"],
      ]
    )
    forwarder.close()
  })
})

const RETURN = "https://subscriptions-api.superwall.com/subscriptions-api/public/v1/checkout/custom-store/return?checkout=v1%3Ak%3Ax"
const checkoutCreate = (overrides: Record<string, unknown> = {}) => ({
  type: "checkout.create",
  custom_store_id: "4821",
  product_id: "pro_monthly",
  app_user_id: "user_8812",
  custom_transaction_id: "9f2c1d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
  success_url: `${RETURN}&status=completed`,
  cancel_url: `${RETURN}&status=closed`,
  ...overrides,
})

/** A `checkout.create` signed the way Superwall signs it (Standard Webhooks). */
const postCheckout = (url: string, body: string, options: { secret?: string; timestamp?: number } = {}) => {
  const id = "msg_test"
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000)
  const key = Buffer.from((options.secret ?? CHECKOUT_SECRET).slice("whsec_".length), "base64")
  const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")
  return fetch(`${url}/paddle/checkout`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": `v1,${signature}`,
    },
    body,
  })
}

describe("checkout", () => {
  it("answers a signed checkout.create with Paddle's checkout URL, carrying the return links", async () => {
    const forwarder = await startForwarder({})
    const response = await postCheckout(forwarder.url, JSON.stringify(checkoutCreate()))
    assert.equal(response.status, 200)
    const { url } = (await response.json()) as { url: string }
    const checkout = new URL(url)
    assert.equal(`${checkout.origin}${checkout.pathname}`, "https://forwarder.example.com/paddle/pay")
    assert.equal(checkout.searchParams.get("_ptxn"), "txn_01k6new0000000000000000000")
    assert.ok(checkout.searchParams.get("sw_return"))
    assert.ok(checkout.searchParams.get("sw_sig"))
    assert.equal(upstream[0]?.url, "/transactions")
    assert.equal(upstream[0]?.authorization, "Bearer pdl_sdbx_apikey_test")
    assert.deepEqual(upstream[0]?.body, {
      items: [{ price_id: PRICE, quantity: 1 }],
      collection_mode: "automatic",
      custom_data: {
        superwall_app_user_id: "user_8812",
        superwall_custom_transaction_id: "9f2c1d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
      },
    })

    // The pay page sends the buyer to exactly those return links.
    const page = await (
      await fetch(`${forwarder.url}/paddle/pay${checkout.search}`)
    ).text()
    const config = JSON.parse(/const config = (.*);\n/.exec(page)![1]!)
    assert.equal(config.completedUrl, `${RETURN}&status=completed`)
    assert.equal(config.closedUrl, `${RETURN}&status=closed`)
    forwarder.close()
  })

  it("refuses unsigned, wrongly signed and stale requests before calling Paddle", async () => {
    const forwarder = await startForwarder({})
    const body = JSON.stringify(checkoutCreate())
    const unsigned = await fetch(`${forwarder.url}/paddle/checkout`, { method: "POST", body })
    assert.equal(unsigned.status, 401)
    const otherSecret = `whsec_${Buffer.from("another-secret-another-secret!!!").toString("base64")}`
    assert.equal((await postCheckout(forwarder.url, body, { secret: otherSecret })).status, 401)
    const stale = Math.floor(Date.now() / 1000) - 6 * 60
    assert.equal((await postCheckout(forwarder.url, body, { timestamp: stale })).status, 401)
    assert.equal(upstream.length, 0)
    forwarder.close()
  })

  it("refuses unknown products and bad bodies", async () => {
    const forwarder = await startForwarder({})
    const post = (body: string) => postCheckout(forwarder.url, body)
    assert.equal((await post(JSON.stringify(checkoutCreate({ product_id: "nope" })))).status, 404)
    assert.equal((await post("{")).status, 400)
    assert.equal((await post(JSON.stringify(checkoutCreate({ type: "checkout.other" })))).status, 400)
    assert.equal((await post(JSON.stringify(checkoutCreate({ success_url: "nope" })))).status, 400)
    const placeholder = await post(JSON.stringify(checkoutCreate({ app_user_id: "null" })))
    assert.equal(placeholder.status, 400)
    assert.match(((await placeholder.json()) as { error: string }).error, /placeholder/)
    assert.equal(upstream.length, 0)
    forwarder.close()
  })

  it("serves the pay page, ignoring return links it did not sign, and the health check", async () => {
    const forwarder = await startForwarder({})
    const page = await fetch(`${forwarder.url}/paddle/pay?_ptxn=txn_x`)
    assert.equal(page.status, 200)
    assert.match(page.headers.get("content-type") ?? "", /text\/html/)
    const html = await page.text()
    assert.match(html, /Paddle\.Initialize/)
    assert.match(html, /"completedUrl":null/)
    const forged = Buffer.from(
      JSON.stringify({ completed: "https://evil.example.com", closed: "https://evil.example.com" })
    ).toString("base64url")
    const tampered = await (
      await fetch(`${forwarder.url}/paddle/pay?_ptxn=txn_x&sw_return=${forged}&sw_sig=bad`)
    ).text()
    assert.equal(tampered.includes("evil.example.com"), false)
    assert.equal((await fetch(`${forwarder.url}/paddle/pay?_ptxn=%3Cscript%3E`)).status, 400)
    assert.equal((await fetch(`${forwarder.url}/health`)).status, 200)
    assert.equal((await fetch(`${forwarder.url}/nope`)).status, 404)
    forwarder.close()
  })
})
