import Foundation

/// One line in the home screen's event log.
struct DemoEvent: Identifiable, Sendable {
  enum Kind: Sendable {
    case info
    case purchase
    case status
    case error
  }

  let id = UUID()
  let date = Date()
  let kind: Kind
  let title: String
  let detail: String?

  static func info(_ title: String, _ detail: String?) -> DemoEvent {
    DemoEvent(kind: .info, title: title, detail: detail)
  }

  static func purchase(_ title: String, _ detail: String?) -> DemoEvent {
    DemoEvent(kind: .purchase, title: title, detail: detail)
  }

  static func status(_ title: String, _ detail: String?) -> DemoEvent {
    DemoEvent(kind: .status, title: title, detail: detail)
  }

  static func error(_ title: String, _ detail: String?) -> DemoEvent {
    DemoEvent(kind: .error, title: title, detail: detail)
  }
}
