# Paddle custom store: iOS demo

A SwiftUI app that sells a Superwall **custom store** product through **Paddle** checkout, with
**no purchase code**: it configures Superwall without a `PurchaseController`.

- A Superwall paywall shows a product that lives on a Paddle custom store with a **checkout
  endpoint** (the forwarder's `/paddle/checkout`).
- Tapping buy: the paywall asks Superwall for a checkout, Superwall asks the forwarder, and the
  paywall opens Paddle's checkout in Safari, exactly like a Stripe web checkout.
- After paying, Paddle sends the buyer to Superwall's return page, which reopens the app. Paddle's
  webhook reaches the forwarder, the forwarder reports the purchase to Superwall, the SDK refreshes
  the user's entitlements, and the paywall closes as purchased.
- A refund in Paddle flows through the same path, so access ends on the next refresh.

The home screen shows the user ID, the live subscription status, the user's entitlements, and a log of SDK events (purchase start/complete/abandon, status changes), so you can narrate each step as it happens.

## Requirements

- Xcode 26 or later, iOS 17+ simulator or device
- [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`)
- The Superwall iOS SDK branch `feat/custom-store-sdk-checkout` (not released yet; stacked on [superwall/Superwall-iOS#552](https://github.com/superwall/Superwall-iOS/pull/552)). It runs the paywall's custom store checkout (the `custom_store_checkout` capability), and adds `refreshCustomerInfo()` and the post-purchase entitlement refresh.
- The Paddle forwarder from `../` running behind a public tunnel

## Setup

### 1. Superwall

In the Superwall dashboard, for an iOS app:

1. Create a **custom store** for Paddle and point the forwarder at it (see the forwarder README in `../`). In the store's **Checkout** section, set the checkout endpoint to `<tunnel URL>/paddle/checkout` and copy the signing secret into the forwarder's `SUPERWALL_CHECKOUT_SECRET`.
2. Add a **product** on that store. Its identifier is the `product_id` Superwall sends to the forwarder, so the forwarder has to map it to a Paddle price.
3. Attach an **entitlement** to the product (for example `pro`).
4. Build a **paywall** that shows the product, and add it to a campaign with the placement **`paddle_demo`**. You can use a different name if you also set `SUPERWALL_PLACEMENT`.
5. Set the iOS app's **URL scheme** to `superwallpaddledemo`, so the checkout's return page opens the app again (without it the page asks the buyer to switch back, and the purchase finishes when the app is foregrounded).
6. Copy the app's **public API key** (`pk_…`).

### 2. Forwarder and Paddle (sandbox)

1. Start the forwarder (it listens on port 8788) and expose it through a tunnel, for example `cloudflared tunnel --url http://localhost:8788`.
2. In Paddle sandbox, go to **Checkout > Checkout configuration** and set the **Default payment link** to `<tunnel URL>/paddle/pay`. Paddle returns that link as the transaction's `checkout.url`, which is the page the paywall opens, so it must point at the forwarder.
3. Point Paddle's notification destination (webhook) at the forwarder, as its README describes.

### 3. App config

```sh
cp Config/Config.example.xcconfig Config/Config.xcconfig
```

Fill in `SUPERWALL_API_KEY` and, if you changed it, `SUPERWALL_PLACEMENT`. `Config/Config.xcconfig` is gitignored. The app needs no forwarder URL: Superwall talks to the forwarder.

If `Config/Config.xcconfig` is missing, the app falls back to the placeholders in `Config/Base.xcconfig`. It still builds and launches, and the sign-in screen shows a warning.

## Run

```sh
xcodegen generate
open PaddleDemo.xcodeproj   # then run the PaddleDemo scheme
```

Or from the command line:

```sh
xcodegen generate
xcodebuild -scheme PaddleDemo -destination 'generic/platform=iOS Simulator' -derivedDataPath DerivedData build
xcrun simctl install booted DerivedData/Build/Products/Debug-iphonesimulator/PaddleDemo.app
xcrun simctl launch booted com.superwall.demo.paddle
```

The generated `.xcodeproj` is gitignored. Edit `project.yml` and regenerate the project instead of changing project settings in Xcode.

### Building against a local SDK checkout

`project.yml` gets SuperwallKit from GitHub (branch `feat/custom-store-sdk-checkout`). To use a local checkout instead, for example while changing the SDK:

```sh
SUPERWALL_SDK_PATH=/path/to/Superwall-iOS xcodegen generate --spec project.local.yml
```

`project.local.yml` includes `project.yml` and replaces only the package source. To go back to the remote branch, run `xcodegen generate`.

### Against the local Superwall stack

To demo without any deployed Superwall backend, run the stack from `scripts/custom-store/e2e-local`
(`up.sh`, `seed.sh`, `legacy-sdk-api/run.sh seed` and `run.sh host`), point the seeded iOS app's
`bundleId` at `com.superwall.demo.paddle` (otherwise the SDK opens Test Mode and skips the
purchase), set the store's checkout endpoint to the forwarder (`http://localhost:8788/paddle/checkout`
works: the local stack sets `CUSTOM_STORE_CHECKOUT_ALLOW_LOCAL_ENDPOINTS`), and build against a copy of the SDK patched with `e2e-local/ios/sdk-local-hosts.patch`.
In `Config/Config.xcconfig` set `SUPERWALL_NETWORK = local`, `SUPERWALL_PLACEMENT = pro` and the
seeded `pk_` key, then launch with the `SIMCTL_CHILD_SUPERWALL_LOCAL_*_HOST` variables listed in
`e2e-local/ios/README.md`. Run the forwarder with `SUPERWALL_API_URL` set to the local API and the
seeded store id, behind a tunnel that Paddle's notification destination and default payment link
point at.

## Demo script

1. **Sign in.** Keep the generated `demo-user-xxxx` ID or type your own. The app calls `Superwall.shared.identify(userId:)`, and the status changes from _Unknown_ to _Inactive_.
2. **Show paywall.** This registers `paddle_demo`, and the Paddle product's paywall appears.
3. **Buy.** The log shows _Purchase started_, and Safari opens Paddle's checkout. Pay with the test card **4242 4242 4242 4242**, any future expiry date, and any CVC.
4. Paddle sends Safari to Superwall's return page, which asks to open "Paddle Demo"; tap **Open**. Within a few seconds the log shows _Subscription status Inactive → Active (pro)_ and _Purchase complete_, and the paywall closes.
5. **Refund it.** In Paddle sandbox, refund the transaction, or cancel the subscription **immediately**. A cancel at the end of the billing period doesn't revoke anything until the period ends. Then tap **Refresh**, pull to refresh, or background and reopen the app (the SDK polls entitlements when the app comes to the foreground). The status goes back to _Inactive_.
6. **Restore** fetches the user's entitlements from Superwall again, which is how a Paddle purchase reaches a reinstall or a second device signed in as the same user.
7. **Sign out** calls `Superwall.shared.reset()`.

If you close the overlay, the return page reports it and the purchase is abandoned (_Purchase abandoned_).

## How it works

| File                          | What it does                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `PaddleDemo/DemoStore.swift`  | Configures Superwall (no purchase controller), the `SuperwallDelegate` event log, and the sign-in, refresh, restore and sign-out actions. |
| `PaddleDemo/PaddleDemoApp.swift` | Passes opened URLs to `Superwall.handleDeepLink`, so the return page's `superwallpaddledemo://superwall/return` link reaches the SDK. |
| `PaddleDemo/AppConfig.swift`  | Reads `SUPERWALL_API_KEY`, `SUPERWALL_PLACEMENT` and `SUPERWALL_NETWORK` from Info.plist. The values come from the xcconfig files.  |

Notes on how the purchase flow uses the SDK:

- **The paywall runs the checkout.** For a custom store product whose store has a checkout endpoint, the paywall asks Superwall for a checkout session, opens the URL the forwarder created, and polls until the return page reports the buyer came back. It then tells the SDK, which reports `transaction_complete` with the checkout's custom transaction id (Superwall uses it to attribute the revenue, renewals included, to the paywall that sold the product), refreshes the entitlements, and closes the paywall. Without a checkout endpoint the product would go to a `PurchaseController`, which this app does not have.
- **The SDK owns `subscriptionStatus`.** Without a purchase controller the SDK sets it from the user's entitlements, which it fetches at launch, on foreground, after a purchase, and on `refreshCustomerInfo()`. Refunds and renewals reach the app the same way.
- **Restore is a refresh.** Paddle purchases are recorded on Superwall's servers, so the Restore button calls `refreshCustomerInfo()`.
