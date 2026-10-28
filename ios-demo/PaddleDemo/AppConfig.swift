import Foundation

/// Values from `Config/*.xcconfig`, surfaced through Info.plist.
struct AppConfig: Sendable {
  /// Public Superwall SDK key (`pk_…`).
  let superwallAPIKey: String
  /// Placement registered by "Show paywall".
  let placement: String
  /// Talk to a local Superwall stack instead of production (`SUPERWALL_NETWORK = local`).
  let usesLocalNetwork: Bool

  static let current = AppConfig(bundle: .main)

  init(bundle: Bundle) {
    func value(_ key: String) -> String {
      (bundle.object(forInfoDictionaryKey: key) as? String)?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }
    superwallAPIKey = value("SuperwallAPIKey")
    let placement = value("SuperwallPlacement")
    self.placement = placement.isEmpty ? "paddle_demo" : placement
    usesLocalNetwork = value("SuperwallNetwork") == "local"
  }

  /// `true` while the build still uses the defaults from `Base.xcconfig`.
  var isPlaceholder: Bool {
    superwallAPIKey.isEmpty || superwallAPIKey == "pk_replace_me"
  }
}
