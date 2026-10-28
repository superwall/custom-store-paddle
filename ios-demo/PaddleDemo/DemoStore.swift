import Foundation
import Observation
import SuperwallKit

/// App state for the demo: who's signed in, what Superwall says they're entitled to, and a
/// log of the SDK events worth narrating.
///
/// There is no purchase code: the Paddle store has a checkout endpoint in Superwall, so the
/// paywall runs the checkout and Superwall grants the entitlement once Paddle's webhook reports
/// the purchase. Without a purchase controller the SDK owns `subscriptionStatus`.
@MainActor
@Observable
final class DemoStore {
  let config: AppConfig
  @ObservationIgnored private var delegateProxy: DelegateProxy?

  private(set) var userId: String?
  private(set) var subscriptionStatus: SubscriptionStatus = .unknown
  private(set) var customerInfo: CustomerInfo?
  private(set) var events: [DemoEvent] = []
  private(set) var isRefreshing = false
  private(set) var isRestoring = false

  private static let maxEvents = 100

  init(config: AppConfig) {
    self.config = config
  }

  /// Configures Superwall, with no purchase controller. Call once, at launch.
  func configureSuperwall() {
    Superwall.configure(apiKey: config.superwallAPIKey)
    let proxy = DelegateProxy(store: self)
    delegateProxy = proxy
    Superwall.shared.delegate = proxy

    subscriptionStatus = Superwall.shared.subscriptionStatus
    customerInfo = Superwall.shared.customerInfo
    userId = Superwall.shared.isLoggedIn ? Superwall.shared.userId : nil

    if config.isPlaceholder {
      record(.error("Placeholder config", "Set SUPERWALL_API_KEY in Config/Config.xcconfig."))
    }
  }

  // MARK: - Actions

  func signIn(as id: String) async {
    let id = id.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !id.isEmpty else {
      return
    }
    Superwall.shared.identify(userId: id)
    userId = id
    record(.info("Identified", id))
    // The previous user's entitlements were cleared; fetch this user's.
    await refresh()
  }

  func signOut() {
    Superwall.shared.reset()
    userId = nil
    customerInfo = Superwall.shared.customerInfo
    events.removeAll()
  }

  func showPaywall() {
    record(.info("Register placement", config.placement))
    Superwall.shared.register(placement: config.placement)
  }

  func refresh() async {
    isRefreshing = true
    defer { isRefreshing = false }
    let info = await Superwall.shared.refreshCustomerInfo()
    customerInfo = info
    let active = info.entitlements.filter(\.isActive).map(\.id).sorted()
    record(.status("Customer info refreshed", active.isEmpty ? "No active entitlements" : active.joined(separator: ", ")))
  }

  /// Paddle purchases are recorded on Superwall's servers, so restoring is a refresh: it is how
  /// a purchase reaches a reinstall or a second device signed in as the same user.
  func restore() async {
    isRestoring = true
    defer { isRestoring = false }
    let info = await Superwall.shared.refreshCustomerInfo()
    customerInfo = info
    let active = info.entitlements.filter(\.isActive).map(\.id).sorted()
    if active.isEmpty {
      record(.error("Nothing to restore", "No active Paddle purchases for this user."))
    } else {
      record(.status("Restored", active.joined(separator: ", ")))
    }
  }

  // MARK: - Delegate callbacks

  fileprivate func subscriptionStatusChanged(from old: SubscriptionStatus, to new: SubscriptionStatus) {
    subscriptionStatus = new
    record(.status("Subscription status", "\(old.label) → \(new.label)"))
  }

  fileprivate func customerInfoChanged(to info: CustomerInfo) {
    // Superwall fetched new entitlements (purchase, refund, foreground poll).
    customerInfo = info
  }

  fileprivate func handle(_ event: SuperwallEvent) {
    switch event {
    case .transactionStart(let product, _):
      record(.purchase("Purchase started", product.productIdentifier))
    case .transactionComplete(let transaction, let product, _, _):
      let detail = [product.productIdentifier, transaction.map { "txn \($0.originalTransactionIdentifier)" }]
        .compactMap { $0 }
        .joined(separator: " · ")
      record(.purchase("Purchase complete", detail))
    case .transactionFail(let error, _):
      record(.error("Purchase failed", error.message))
    case .transactionAbandon(let product, _):
      record(.purchase("Purchase abandoned", product.productIdentifier))
    case .paywallOpen(let paywallInfo):
      record(.info("Paywall opened", paywallInfo.name))
    case .paywallClose(let paywallInfo):
      record(.info("Paywall closed", paywallInfo.name))
    case .triggerFire(let placementName, let result):
      record(.info("Placement \(placementName)", result.label))
    case .restoreStart:
      record(.purchase("Restore started", nil))
    case .restoreFail(let message):
      record(.error("Restore failed", message))
    case .configFail:
      record(.error("Superwall config failed", "Check SUPERWALL_API_KEY."))
    default:
      break
    }
  }

  private func record(_ event: DemoEvent) {
    events.insert(event, at: 0)
    if events.count > Self.maxEvents {
      events.removeLast(events.count - Self.maxEvents)
    }
  }
}

/// Forwards `SuperwallDelegate` callbacks to the store. Kept separate so the store doesn't
/// expose the delegate protocol's methods.
@MainActor
private final class DelegateProxy: SuperwallDelegate {
  weak var store: DemoStore?

  init(store: DemoStore) {
    self.store = store
  }

  func subscriptionStatusDidChange(from oldValue: SubscriptionStatus, to newValue: SubscriptionStatus) {
    store?.subscriptionStatusChanged(from: oldValue, to: newValue)
  }

  func customerInfoDidChange(from oldValue: CustomerInfo, to newValue: CustomerInfo) {
    store?.customerInfoChanged(to: newValue)
  }

  func handleSuperwallEvent(withInfo eventInfo: SuperwallEventInfo) {
    store?.handle(eventInfo.event)
  }
}

extension SubscriptionStatus {
  var label: String {
    switch self {
    case .unknown: "Unknown"
    case .inactive: "Inactive"
    case .active(let entitlements): "Active (\(entitlements.map(\.id).sorted().joined(separator: ", ")))"
    }
  }
}

private extension TransactionError {
  var message: String {
    switch self {
    case .pending(let message), .failure(let message, _): message
    }
  }
}

private extension TriggerResult {
  var label: String {
    switch self {
    case .paywall: "Show paywall"
    case .holdout: "Holdout"
    case .noAudienceMatch: "No audience match"
    case .placementNotFound: "Placement not found — add it to a campaign"
    case .error(let error): "Error: \(error.localizedDescription)"
    }
  }
}
