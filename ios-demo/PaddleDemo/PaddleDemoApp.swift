import SuperwallKit
import SwiftUI

@main
struct PaddleDemoApp: App {
  @State private var store: DemoStore

  init() {
    let store = DemoStore(config: .current)
    store.configureSuperwall()
    _store = State(initialValue: store)
  }

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(store)
        .onOpenURL { url in
          // `superwallpaddledemo://superwall/return?reason=…` from Superwall's checkout return
          // page (set this scheme as the iOS app's URL scheme in the dashboard), and other
          // Superwall links such as paywall previews.
          Superwall.handleDeepLink(url)
        }
    }
  }
}

private struct RootView: View {
  @Environment(DemoStore.self) private var store

  var body: some View {
    Group {
      if store.userId == nil {
        SignInView()
      } else {
        HomeView()
      }
    }
    .animation(.default, value: store.userId)
  }
}
