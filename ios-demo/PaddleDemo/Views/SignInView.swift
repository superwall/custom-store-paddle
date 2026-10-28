import SwiftUI

struct SignInView: View {
  @Environment(DemoStore.self) private var store
  @State private var userId = "demo-user-\(String(format: "%04d", Int.random(in: 0...9999)))"
  @State private var isSigningIn = false
  @FocusState private var isFieldFocused: Bool

  var body: some View {
    NavigationStack {
      VStack(spacing: 32) {
        Spacer()

        VStack(spacing: 12) {
          Image(systemName: "creditcard.and.123")
            .font(.system(size: 48, weight: .semibold))
            .foregroundStyle(.tint)
          Text("Paddle Demo")
            .font(.largeTitle.bold())
          Text("Sell a Superwall custom store product through Paddle checkout.")
            .font(.callout)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
        }

        VStack(alignment: .leading, spacing: 8) {
          Text("App user ID")
            .font(.footnote.weight(.medium))
            .foregroundStyle(.secondary)
          TextField("App user ID", text: $userId)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .font(.body.monospaced())
            .focused($isFieldFocused)
            .submitLabel(.go)
            .onSubmit(signIn)
            .padding(14)
            .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 12))
          Text("Superwall identifies this user, and the forwarder attributes Paddle purchases to them.")
            .font(.footnote)
            .foregroundStyle(.secondary)
        }

        Button(action: signIn) {
          Group {
            if isSigningIn {
              ProgressView()
            } else {
              Text("Sign in")
            }
          }
          .frame(maxWidth: .infinity)
          .padding(.vertical, 6)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(userId.trimmingCharacters(in: .whitespaces).isEmpty || isSigningIn)

        Spacer()

        ConfigSummary(config: store.config)
      }
      .padding(24)
    }
  }

  private func signIn() {
    isFieldFocused = false
    isSigningIn = true
    Task {
      await store.signIn(as: userId)
      isSigningIn = false
    }
  }
}

private struct ConfigSummary: View {
  let config: AppConfig

  var body: some View {
    VStack(spacing: 4) {
      if config.isPlaceholder {
        Label("Placeholder config — see README", systemImage: "exclamationmark.triangle.fill")
          .foregroundStyle(.orange)
      }
      Text("Placement: \(config.placement)")
        .foregroundStyle(.secondary)
    }
    .font(.caption)
  }
}
