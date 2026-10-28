# Paddle Billing as a Superwall custom store

A reference integration that sells [Paddle Billing](https://developer.paddle.com) subscriptions on
[Superwall](https://superwall.com) paywalls. It's one small Node server, with no dependencies, that:

- receives Paddle's webhooks, verifies them and reports each purchase, renewal, cancellation and
  refund to a Superwall [custom store](https://superwall.com/docs/integrations/custom-stores)
  (`POST /v2/custom-stores/:custom_store_id/events`), so Superwall grants and revokes the user's
  entitlements and counts the revenue;
- creates Paddle checkouts for your paywalls, either as the store's **checkout endpoint** (Superwall
  asks it for a checkout, so the app needs no purchase code) or for your app's
  **PurchaseController** (`POST /paddle/app-checkout`);
- serves the page Paddle's default payment link points at, which opens the checkout and sends the
  buyer back to the app.

The step-by-step guide is [Paddle](https://superwall.com/docs/integrations/custom-stores/paddle) in
the Superwall docs. This README is the reference for the code. Copy it into your own backend, or
run it as its own service.

| File            | What it does                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------ |
| `server.ts`     | The HTTP server, on port 8788.                                                                   |
| `mapping.ts`    | Paddle notification -> custom store event. Pure, no I/O.                                         |
| `signature.ts`  | Paddle webhook signature check (`Paddle-Signature`).                                             |
| `checkout.ts`   | The signed `checkout.create` request and the payment link page. Pure, no I/O.                    |
| `paddle-api.ts` | The Paddle API calls: reading a refund's transaction and subscription, reading a renewed         |
|                 | subscription, canceling a refunded subscription, creating a checkout transaction.                |
| `app-auth.ts`   | Who is buying, for `POST /paddle/app-checkout`. **Implement it** before you use that route.      |
| `*.test.ts`     | `npm test` (Node's test runner); `npm run typecheck` after `npm install`.                        |
| `ios-demo/`     | A SwiftUI app that buys through the checkout endpoint (needs an upcoming iOS SDK release).        |

Requires Node 22.18 or later, which runs the TypeScript files as is.

## Setup

1. **Create a custom store** in your Superwall project (dashboard: Integrations > Custom stores,
   or `POST /v2/projects/:id/custom-stores`).
2. **Add a product per Paddle price** to the store (`POST /v2/products` with `store: "custom"`,
   `application_id` = the store id) and attach it to an entitlement. Put the Paddle price id ->
   Superwall product identifier pairs in `PADDLE_PRODUCTS`: `{"pri_01...": "pro_monthly"}`.
   Prices, not products, are what Paddle sells: a Paddle product holds several prices (monthly,
   yearly, trial or not), each its own Superwall product, and every transaction and subscription
   item names its `price.id`. A checkout sells the first price listed for a product.
3. **Create a Superwall API key** with the `custom_store_events:write` scope
   (`SUPERWALL_API_KEY`), and a Paddle API key (`PADDLE_API_KEY`) with `transaction.read`,
   `transaction.write`, `subscription.read` and `subscription.write`: a refund ends the
   subscription, so the server cancels it in Paddle.
4. **Create a client-side token** (Paddle > My account > Settings > Authentication, or `POST /client-tokens`) for the payment
   page (`PADDLE_CLIENT_TOKEN`).
5. **Set the default payment link** to the server's pay page, `https://<server host>/paddle/pay`:
   Paddle > Checkout > Checkout configuration, under **Default payment link**. Live accounts need
   the domain approved first (Paddle > My account > Settings > Website approval); sandbox does not.
   Paddle refuses `localhost`, so expose a local server through a tunnel.
6. **Add a notification destination** pointing at the server (`/paddle/webhooks`), subscribed
   to `transaction.completed`, `subscription.created`, `subscription.updated`,
   `subscription.past_due`, `subscription.canceled`, `subscription.paused`, `adjustment.created`
   and `adjustment.updated`. Its secret key is `PADDLE_WEBHOOK_SECRET`.
7. **Choose how the app opens the checkout**:
   - **Checkout endpoint** (no purchase code in the app; needs an upcoming iOS SDK release): set
     the store's checkout endpoint to `https://<server host>/paddle/checkout` (dashboard: the
     custom store's Checkout section, or
     `PUT /v2/projects/:id/custom-stores/:custom_store_id/checkout-endpoint` with `{"url": ...}`).
     Superwall shows the signing secret (`whsec_...`) once: it is `SUPERWALL_CHECKOUT_SECRET`.
     See [Checkout endpoint](#checkout-endpoint).
   - **PurchaseController** (works with every SDK version that supports custom store products):
     implement `authenticateAppUser` in `app-auth.ts` and set `APP_RETURN_URL` to a URL that opens
     your app, such as `myapp://paddle-checkout`. See [App checkout](#app-checkout-purchasecontroller).
8. Run it:

```bash
PADDLE_API_KEY=pdl_sdbx_apikey_... PADDLE_CLIENT_TOKEN=test_... \
PADDLE_WEBHOOK_SECRET=pdl_ntfset_... PADDLE_PRODUCTS='{"pri_01...":"pro_monthly"}' \
SUPERWALL_API_KEY=sk_... SUPERWALL_CUSTOM_STORE_ID=4821 \
SUPERWALL_CHECKOUT_SECRET=whsec_... APP_RETURN_URL=myapp://paddle-checkout \
npm start   # listens on :8788
```

Both checkout settings are optional, and both can be set. Without `SUPERWALL_CHECKOUT_SECRET`,
`POST /paddle/checkout` answers 404; without `APP_RETURN_URL`, `POST /paddle/app-checkout` answers
501. A `SUPERWALL_CHECKOUT_SECRET` that is not a `whsec_` secret, or an `APP_RETURN_URL` that is not
an absolute URL or uses a scheme a browser runs itself (`javascript:`, `data:`, ...), stops the
server at startup.

**The environment comes from the keys.** A sandbox API key (`pdl_sdbx_...`) and client token
(`test_...`) select `https://sandbox-api.paddle.com`, open Paddle.js in sandbox and send
`environment: "sandbox"`; live ones (`pdl_live_...`, `live_...`) select production. The server
refuses to start when the two disagree, so sandbox purchases can never be reported as production.
Sandbox events show in revenue charts only when filtered to Sandbox and never set the store's
`reporting_since`.

Other settings: `PORT` (8788), `SUPERWALL_API_URL` (`https://api.superwall.com`),
`PADDLE_API_URL` (overrides the API origin).

`DRY_RUN=1` logs each mapped event as JSON instead of sending it, and never cancels anything in
Paddle; `SUPERWALL_API_KEY` and `SUPERWALL_CUSTOM_STORE_ID` are then optional. A refund still
reads its transaction and subscription from the Paddle API; if that fails, a dry run logs the
failure and maps without them (so the refund is ignored).

## App checkout (PurchaseController)

An app that sells custom store products with a `PurchaseController` starts the checkout itself:

1. In `purchase(product:)`, the app calls `POST /paddle/app-checkout` with its own credential and
   `{"product_id": "pro_monthly"}`, plus `"custom_transaction_id"` when the SDK exposes
   `StoreProduct.customTransactionId` (it links the revenue to the paywall).
2. The server authenticates the user with `authenticateAppUser` (`app-auth.ts`), creates a Paddle
   transaction for the product's price with `custom_data: {superwall_app_user_id, ...}`, and
   answers `{"url": "<checkout.url>&sw_return=...&sw_sig=...", "transaction_id": "txn_..."}`:
   Paddle's checkout URL with the return links to `APP_RETURN_URL`, signed like the checkout
   endpoint's.
3. The app opens `url` in an `ASWebAuthenticationSession` (or a Custom Tab on Android). The pay
   page opens Paddle's overlay; on `checkout.completed` it goes to
   `APP_RETURN_URL?status=completed&transaction_id=txn_...`, on `checkout.closed` to
   `...?status=closed&...`, which ends the session.
4. The webhooks report the purchase to Superwall as usual. The app sets
   `Superwall.shared.subscriptionStatus` from its own record of the user's access (a
   `PurchaseController` owns the status). The buyer can be back in the app before Paddle's webhook
   has arrived, so don't treat a status that is not active yet as a failed purchase.

`authenticateAppUser` must return the id your app passes to `Superwall.shared.identify(userId:)`,
from a credential your server verifies. The user id is never read from the request body: anyone
could then buy access for another user. Until you implement it, or without `APP_RETURN_URL`, the
route answers 501; a request
without a valid credential gets 401, an unknown product 404, a bad body 400, and a Paddle failure
502.

## Checkout endpoint

When a paywall sells one of the store's products, Superwall POSTs a `checkout.create` to the
checkout endpoint and opens the URL it answers with in the paywall's checkout destination (Safari
by default). Paddle's overlay takes the payment; its `checkout.completed` sends the buyer to
Superwall's return page, which opens the app again. The paywall finishes the purchase once
Superwall has the webhook's `initial_purchase` **carrying the checkout's
`custom_transaction_id`**, which the server copies from the transaction's `custom_data`. An event
without it still grants access, but the paywall keeps waiting.

- `POST /paddle/checkout` is the checkout endpoint. The request is signed the
  [Standard Webhooks](https://www.standardwebhooks.com) way: `webhook-signature` lists
  `v1,<base64 HMAC-SHA256 of "<webhook-id>.<webhook-timestamp>.<raw body>">` keyed with the
  secret's base64-decoded bytes, and any listed signature may match (a rotating secret). Requests
  more than five minutes old are refused. The body:

  ```json
  {
    "type": "checkout.create",
    "custom_store_id": "4821",
    "product_id": "pro_monthly",
    "app_user_id": "user_8812",
    "custom_transaction_id": "9f2c1d3e-...",
    "success_url": "https://.../checkout/custom-store/return?checkout=...&status=completed",
    "cancel_url": "https://.../checkout/custom-store/return?checkout=...&status=closed"
  }
  ```

  It creates a Paddle transaction (`POST /transactions`) for the product's price with
  `custom_data: {superwall_app_user_id, superwall_custom_transaction_id}` and answers
  `{"url": "<checkout.url>&sw_return=...&sw_sig=..."}`: Paddle's `checkout.url` (the default
  payment link plus `?_ptxn=txn_...`) with the two return links, signed (with a key derived from
  `PADDLE_WEBHOOK_SECRET`) together with the `_ptxn` transaction, so the pay page only ever redirects
  where Superwall said to for that transaction. `401` for a missing, wrong or stale
  signature, `400` for an invalid body (ids must be non-empty, at most 255 characters, without
  surrounding whitespace, and not a placeholder such as `null`: Superwall refuses such ids), `404`
  for a product no price maps to, `502` when Paddle refuses or returns no `checkout.url` (no
  default payment link set). Superwall waits ten seconds for the answer.
- `GET /paddle/pay?_ptxn=txn_...` is the default payment link page. It loads Paddle.js v2, calls
  `Paddle.Environment.set("sandbox")` in sandbox and `Paddle.Initialize({ token, eventCallback })`;
  Paddle.js then opens the overlay checkout for the `_ptxn` transaction by itself. On
  `checkout.completed` it goes to the signed completed link (`success_url`, or `APP_RETURN_URL` for an
  app checkout), on `checkout.closed` to the closed one. Paddle also opens the payment link for its own flows (a card update, for one);
  without signed return links the page just says it is done. Every injected value is HTML-escaped
  or embedded as script-safe JSON.
- `GET /health` answers `200`.

## Mapping

| Paddle                                                                     | Superwall event                                   | Notes                                                                                                           |
| -------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `transaction.completed`, origin `web`/`api`, with `subscription_id`        | `initial_purchase`                                | price = `grand_total - grand_total_tax` (after discounts and credits, before tax)                               |
| same, price with a free `trial_period` (zero-value)                        | ignored                                           | the trial starts from `subscription.created`                                                                    |
| same, price with a paid `trial_period`                                     | `initial_purchase`, `period_type: intro`          | priced at the trial price                                                                                       |
| `transaction.completed`, origin `subscription_recurring`                   | `renewal`                                         | `is_trial_conversion` when it ends a free trial (see below); never for a paid trial                             |
| `transaction.completed`, origin `subscription_update`, charged             | `renewal` of the new price                        | a `product_change` carries no price, so a charged plan change is a `renewal`                                    |
| `transaction.completed`, origin `subscription_update`, nothing charged     | `product_change`                                  | unpriced; the new price is the charged (non-negative) line item                                                 |
| `transaction.completed`, origin `subscription_charge`                      | `renewal` when charged, else ignored              | a one-time charge for a mapped price                                                                            |
| `transaction.completed`, no `subscription_id`, one-time price              | `non_renewing_purchase`                           | lifetime: `expires_at: null`, keyed by the transaction                                                          |
| `transaction.completed`, origin `subscription_payment_method_change`       | ignored                                           | a card update, not revenue                                                                                      |
| `subscription.created`, `status: trialing`, free trial                     | `initial_purchase`, `period_type: trial`, price 0 | `transaction_id` is the checkout transaction; a paid start or paid trial comes from its `transaction.completed` |
| `subscription.updated`, `scheduled_change.action: cancel`                  | `cancellation`                                    | one event per scheduled cancel (see below); access continues to the period end                                  |
| `subscription.updated`, anything else                                      | ignored                                           | includes a removed scheduled cancel: no `uncancellation` (see below)                                            |
| `subscription.past_due`                                                    | `billing_issue`                                   |                                                                                                                 |
| `subscription.canceled`                                                    | `expiration` at `canceled_at`                     |                                                                                                                 |
| `subscription.paused`                                                      | `expiration` at `paused_at`                       | access stops; the resumed subscription's next `transaction.completed` restores it                               |
| `adjustment.*`, `refund` or `chargeback`, `type: full`, `status: approved` | `refund`, then Paddle cancels the subscription    | only when it paid the current period (see below); price = the adjustment's `subtotal` (before tax)              |
| `adjustment.*`, partial, pending, rejected, `credit`, `chargeback_reverse` | ignored                                           | Superwall supports only full refunds, and a refund is final                                                     |
| `subscription.activated`/`trialing`/`resumed`/`imported`, `transaction.*`  | ignored                                           | they restate the events above                                                                                   |

- `event_id` is `paddle_<event_id>` (Paddle's `evt_...`). Paddle resends a failed delivery with
  the same `event_id` and tells receivers to deduplicate on it, so retries are idempotent, and the
  same event delivered to two destinations, or replayed, is one Superwall event. (`notification_id`
  is per destination, so it would not be.) Two exceptions, both so that one change is one event:
  - **A refund** is keyed by the adjustment, `paddle_adj_...`, with `occurred_at` its
    `created_at`. Paddle can announce one approved refund twice (an `adjustment.created` already
    approved, then an `adjustment.updated`), and two `refund` events would count the refunded
    revenue twice. Every field comes from the adjustment and its transaction, so a repeat has an
    identical body.
  - **A cancellation** is keyed by the scheduled change,
    `paddle_<subscription id>:cancel:<effective_at>`. Paddle sends `subscription.updated` for any
    change to a subscription, and each one restates the pending cancel; with this key they are all
    one event, and a cancel rescheduled to another date is a new one. `occurred_at` is the
    subscription's `updated_at`, which is identical on every retry and replay of a delivery.
    Paddle records no time for the scheduling itself, and the alternatives are worse: the
    notification time differs per delivery, and the period start is older than the period's own
    `renewal`, which would then win Superwall's `occurred_at` ordering and switch auto-renew back
    on. The one case where the body can move: Paddle changes something else on the subscription
    (a payment method, say) while the cancel is pending. That delivery has a later `updated_at`
    under the same `event_id`; Superwall applies the event once, but analytics may keep either
    copy.
- `subscription_id` is Paddle's `sub_...`; `transaction_id` is the `txn_...` (for subscription
  events, `<subscription id>:<period start>`). A one-time purchase uses its transaction id for both.
- `occurred_at` is otherwise the notification's `occurred_at`; Paddle does not guarantee delivery
  order. Timestamps are normalized to millisecond ISO 8601 (Paddle sends micro- and nanoseconds).
- `product_id` is the Superwall product of the first line item whose price is in
  `PADDLE_PRODUCTS`, preferring a charged one: a plan change credits the old price (a negative line
  item) and bills the new one. `price` is the whole transaction's charge, so one subscription price
  per transaction is assumed (add-ons are counted with it).
- Amounts: Paddle's lowest-denomination integer strings become decimal strings (`"999"` USD ->
  `"9.99"`; CLP, JPY, KRW and VND have no minor unit, so `"1500"` JPY -> `"1500"`).
- `app_user_id` (from `custom_data.superwall_app_user_id`) must pass the same checks as at
  checkout; an event without a usable one is ignored.
- **Trial conversion.** A transaction does not say it ends a trial, so for a
  `subscription_recurring` transaction of a price with a free `trial_period` the forwarder reads
  the subscription (`GET /subscriptions/{id}`): the renewal is the conversion when its
  `billing_period.starts_at` is (within a day) an item's `trial_dates.ends_at`, or the
  subscription's `first_billed_at` when it started in trial (`first_billed_at` is `null` during a
  free trial and is later than `started_at` once it converted). If that read fails the delivery
  fails and Paddle retries, so the event is never sent with and then without the flag. A paid trial
  was reported as an `intro` period, so its first full-price charge is a plain `renewal`.
- **Plan changes Paddle does not invoice at once** (`prorated_next_billing_period`, `do_not_bill`)
  create no transaction, and `subscription.updated` carries no previous values, so no
  `product_change` is sent; the next `renewal` carries the new product. A plan change during a trial
  is reported `period_type: normal`, as the transaction does not say the subscription is trialing.
- **No `uncancellation`.** Paddle sends `subscription.updated` for every change (renewals, payment
  methods, items) with no previous values, so a stateless forwarder cannot tell a removed scheduled
  cancel from any other update. Sending `uncancellation` on each would re-enable auto-renew
  harmlessly in Superwall's state (it projects to `willRenew: true`) but would emit an
  `uncancellation` webhook and event for every unrelated update. Ignoring it costs only that
  Superwall shows auto-renew off until the next `renewal`, which turns it back on; access is never
  affected. To report it, keep the last `scheduled_change` per subscription and send
  `uncancellation` when a `cancel` disappears while the subscription is still `active`.
- **A refund or chargeback ends the subscription, and only one of its current period does.**
  Superwall never restores a refunded `subscription_id`, so the forwarder sends a `refund` only
  when the refunded transaction paid the subscription's current period (or, once the subscription
  ended, its most recent one): the transaction's `billing_period` must reach more than an hour past
  that period's start, which a renewal of the period and a plan change within it both do. The
  forwarder reads the subscription (`GET /subscriptions/{id}`) to know the period. Refunding an
  older period is ignored: refunding January's renewal on February 10 leaves February, which the
  customer paid, active in both Paddle and Superwall. After Superwall accepts the `refund`, the
  forwarder cancels the subscription (`POST /subscriptions/{id}/cancel`,
  `{"effective_from":"immediately"}`), so Paddle never bills it again; the `subscription.canceled`
  that follows maps to an `expiration`. An already canceled subscription
  (`subscription_is_canceled_action_invalid`) counts as done. A customer who subscribes again gets
  a new subscription id, matching Paddle, where a canceled subscription cannot be reinstated.
  The period check runs on every delivery, so a refund whose delivery is still being retried when
  the next period starts is ignored too: access stays correct, but that refund's revenue is not
  reported.
- **A chargeback is final too.** Paddle reverses a chargeback it wins with a
  `chargeback_reverse` adjustment. That is ignored: the subscription was already ended in
  Superwall and canceled in Paddle, and neither can be restored, so the customer has to subscribe
  again.
- `cancel_reason` is `unknown`: Paddle's subscription has no cancellation reason.

### Responses to Paddle

- `403` for a bad signature.
- `200` for a forwarded event, an ignored one, one Superwall rejected as invalid, or a request
  Superwall refused with a 4xx other than 401, 403, 404, 408 and 429: Paddle retries any status but
  200, and retrying the same body cannot succeed. Each is logged.
- `502` when Superwall answers 5xx, 401, 403, 404, 408 or 429, cannot be reached, or a Paddle API
  call fails, so Paddle retries. A 401/403/404 is a configuration problem (API key, store id);
  fix it within Paddle's retry window (about two days live, two minutes in sandbox) and the
  retries succeed.

### Answering within five seconds

Paddle counts a delivery as failed when it gets no answer within five seconds. Every upstream call
a webhook makes (the Paddle lookups, the Superwall request and a refund's cancel) shares one
4-second deadline, so the forwarder always answers in time. The cancel runs before the answer, not
after it: if it fails or runs out of time, the delivery fails (`502`) and Paddle retries it, the
same `event_id` is a no-op in Superwall, and the cancel runs again. Canceling after answering would
need a queue of its own to retry a failed cancel; this way Paddle's retries are that queue. A
failed cancel is logged with a `CANCEL FAILED` prefix, as the subscription is refunded in Superwall
but still billing in Paddle until a retry succeeds; alert on it.

## Signatures

`Paddle-Signature: ts=<unix seconds>;h1=<hex>`. `h1` is the lowercase hex HMAC-SHA256 of
`<ts>:<raw body>`, keyed with the notification destination's secret key (`pdl_ntfset_...`) as UTF-8.
While a secret rotates Paddle sends one `h1` per secret, so any match is accepted, compared in
constant time. Like Paddle's SDKs, a `ts` more than five seconds from now is rejected.

## Checked against Paddle's docs (2026-10-21)

From developer.paddle.com (webhook reference examples, API reference, guides), without a live
account:

- Signature scheme and five-second SDK tolerance:
  [signature-verification](https://developer.paddle.com/webhooks/about/signature-verification).
- Retries resend the same `event_id`, any status other than 200 is retried, five-second deadline,
  no ordering guarantee (sandbox: 3 attempts in ~2 minutes; live: up to 60 over ~2 days):
  [respond-to-webhooks](https://developer.paddle.com/webhooks/about/respond-to-webhooks).
- API keys start `pdl_sdbx_` or `pdl_live_`
  ([authentication](https://developer.paddle.com/api-reference/about/authentication)); client-side
  tokens start `test_` or `live_`
  ([client-side tokens](https://developer.paddle.com/paddle-js/about/client-side-tokens)).
- Transaction `origin` values and `details.totals` (`grand_total`, `grand_total_tax`):
  [transaction.completed](https://developer.paddle.com/webhooks/transactions/transaction-completed).
- Transaction `custom_data` is copied to the created subscription and from it to renewals and
  plan-change transactions: [custom-data](https://developer.paddle.com/build/transactions/custom-data).
- Free trials create a `trialing` subscription with no charge, paid trials charge the trial price
  at checkout (same `price_id`), and both bill the base price when the trial ends:
  [create-trial](https://developer.paddle.com/build/trials/create-trial),
  [subscription.trialing](https://developer.paddle.com/webhooks/subscriptions/subscription-trialing).
- Adjustments: `action` (`refund`, `chargeback`, `chargeback_reverse`, ...), `type`
  (`full`/`partial`), `status` (`approved` is final; most live refunds start `pending_approval`):
  [adjustment.updated](https://developer.paddle.com/webhooks/adjustments/adjustment-updated).
- Canceling immediately, and the 400 for an already canceled subscription:
  [cancel-subscription](https://developer.paddle.com/api-reference/subscriptions/cancel-subscription),
  [subscription_is_canceled_action_invalid](https://developer.paddle.com/errors/subscriptions/subscription_is_canceled_action_invalid).
- A created transaction's `checkout.url` is the default payment link plus `?_ptxn=`, and Paddle.js
  on that page opens the checkout for it by itself; the setting is Paddle > Checkout > Checkout
  configuration > Default payment link:
  [default-payment-link](https://developer.paddle.com/build/transactions/default-payment-link),
  [pass-transaction-checkout](https://developer.paddle.com/build/transactions/pass-transaction-checkout).
- Zero-decimal currencies (CLP, JPY, KRW, VND):
  [supported-currencies](https://developer.paddle.com/concepts/sell/supported-currencies).

## Not verified against Paddle

Still unverified without live deliveries:

- The fixtures follow the docs' example payloads with the recipe's ids and amounts, not recorded
  webhooks.
- That a chargeback adjustment arrives `type: full` and `status: approved`.
- That `trial_dates` stays on a subscription item after the trial converts. The conversion check
  also accepts `first_billed_at`.
- Which `origin` the transaction of a trial activated early (`POST /subscriptions/{id}/activate`)
  has; as `subscription_update` it is reported as a `renewal` without `is_trial_conversion`.
- That a plan change's credited line item has a negative `subtotal`.
- That a subscription's `updated_at` does not change when Paddle only re-sends a notification.
- Whether `subscription_update_when_canceled` is also returned for a cancel; it is treated as
  already canceled too.
