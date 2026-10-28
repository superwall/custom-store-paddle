import SuperwallKit
import SwiftUI

struct HomeView: View {
  @Environment(DemoStore.self) private var store

  var body: some View {
    NavigationStack {
      List {
        Section {
          AccessCard(userId: store.userId ?? "", status: store.subscriptionStatus)
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
        }

        Section("Entitlements") {
          let entitlements = (store.customerInfo?.entitlements ?? [])
            .sorted { ($0.isActive ? 0 : 1, $0.id) < ($1.isActive ? 0 : 1, $1.id) }
          if entitlements.isEmpty {
            Text("None yet. Buy something from the paywall.")
              .foregroundStyle(.secondary)
          } else {
            ForEach(entitlements, id: \.id) { entitlement in
              EntitlementRow(entitlement: entitlement)
            }
          }
        }

        Section {
          Button {
            store.showPaywall()
          } label: {
            Label("Show paywall", systemImage: "rectangle.portrait.on.rectangle.portrait")
          }
          Button {
            Task { await store.refresh() }
          } label: {
            HStack {
              Label("Refresh", systemImage: "arrow.clockwise")
              if store.isRefreshing {
                Spacer()
                ProgressView()
              }
            }
          }
          .disabled(store.isRefreshing)
          Button {
            Task { await store.restore() }
          } label: {
            HStack {
              Label("Restore", systemImage: "clock.arrow.circlepath")
              if store.isRestoring {
                Spacer()
                ProgressView()
              }
            }
          }
          .disabled(store.isRestoring)
        } header: {
          Text("Actions")
        } footer: {
          Text("Placement: \(store.config.placement)")
        }

        Section("Event log") {
          if store.events.isEmpty {
            Text("SDK events show up here.")
              .foregroundStyle(.secondary)
          } else {
            ForEach(store.events) { event in
              EventRow(event: event)
            }
          }
        }
      }
      .navigationTitle("Paddle Demo")
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Sign out", role: .destructive) {
            store.signOut()
          }
        }
      }
      .refreshable {
        await store.refresh()
      }
    }
  }
}

private struct AccessCard: View {
  let userId: String
  let status: SubscriptionStatus

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack {
        Text("Access")
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(.secondary)
        Spacer()
        StatusBadge(status: status)
      }
      Text(headline)
        .font(.title2.bold())
      Label {
        Text(userId)
          .font(.callout.monospaced())
          .textSelection(.enabled)
      } icon: {
        Image(systemName: "person.crop.circle")
      }
      .foregroundStyle(.secondary)
    }
    .padding(18)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.background.secondary, in: RoundedRectangle(cornerRadius: 16))
  }

  private var headline: String {
    switch status {
    case .unknown: "Checking access…"
    case .inactive: "No active subscription"
    case .active: "Premium unlocked"
    }
  }
}

private struct StatusBadge: View {
  let status: SubscriptionStatus

  var body: some View {
    Text(title)
      .font(.caption.weight(.semibold))
      .padding(.horizontal, 10)
      .padding(.vertical, 4)
      .foregroundStyle(color)
      .background(color.opacity(0.15), in: Capsule())
  }

  private var title: String {
    switch status {
    case .unknown: "Unknown"
    case .inactive: "Inactive"
    case .active: "Active"
    }
  }

  private var color: Color {
    switch status {
    case .unknown: .gray
    case .inactive: .orange
    case .active: .green
    }
  }
}

private struct EntitlementRow: View {
  let entitlement: Entitlement

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack {
        Image(systemName: entitlement.isActive ? "checkmark.seal.fill" : "xmark.seal")
          .foregroundStyle(entitlement.isActive ? .green : .secondary)
        Text(entitlement.id)
          .font(.body.weight(.medium))
        Spacer()
        Text(entitlement.isActive ? "Active" : "Inactive")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      if let product = entitlement.latestProductId ?? entitlement.productIds.sorted().first {
        Text("Product: \(product)")
          .font(.caption.monospaced())
          .foregroundStyle(.secondary)
      }
      if let expiresAt = entitlement.expiresAt {
        Text("\(entitlement.isActive ? "Renews or expires" : "Ended") \(expiresAt.formatted(date: .abbreviated, time: .shortened))")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
    .padding(.vertical, 2)
  }
}

private struct EventRow: View {
  let event: DemoEvent

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Image(systemName: icon)
        .foregroundStyle(color)
        .frame(width: 18)
      VStack(alignment: .leading, spacing: 2) {
        Text(event.title)
          .font(.subheadline.weight(.medium))
        if let detail = event.detail {
          Text(detail)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
      Spacer(minLength: 8)
      Text(event.date, format: .dateTime.hour().minute().second())
        .font(.caption2.monospacedDigit())
        .foregroundStyle(.tertiary)
    }
  }

  private var icon: String {
    switch event.kind {
    case .info: "info.circle"
    case .purchase: "cart"
    case .status: "person.badge.shield.checkmark"
    case .error: "exclamationmark.triangle"
    }
  }

  private var color: Color {
    switch event.kind {
    case .info: .secondary
    case .purchase: .accentColor
    case .status: .green
    case .error: .red
    }
  }
}
