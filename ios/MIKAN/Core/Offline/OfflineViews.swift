import SwiftUI

extension View {
    /// The calm «Нет сети — данные на 14:32» banner above a main tab while offline.
    func offlineBanner() -> some View {
        modifier(OfflineBannerInset())
    }

    /// Disables a write action while offline (the API would refuse it anyway with «Нужен интернет»).
    func needsConnection() -> some View {
        modifier(NeedsConnection())
    }

    /// Runs `action` each time the app gets back online (screens reload what they show).
    func onReconnect(perform action: @escaping () async -> Void) -> some View {
        modifier(ReconnectAction(action: action))
    }
}

private struct OfflineBannerInset: ViewModifier {
    @Environment(Connectivity.self) private var connectivity

    func body(content: Content) -> some View {
        content
            .safeAreaInset(edge: .top, spacing: 0) {
                if let text = connectivity.bannerText {
                    OfflineBanner(text: text)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .animation(.smooth(duration: 0.3), value: connectivity.isOnline)
    }
}

/// A glass capsule under the status bar: no network, and how old the data on screen is.
struct OfflineBanner: View {
    let text: String

    var body: some View {
        Label(text, systemImage: "wifi.slash")
            .font(.footnote.weight(.medium))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .minimumScaleFactor(0.85)
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .glassEffect(.regular, in: .capsule)
            .padding(.horizontal, 16)
            .padding(.vertical, 4)
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .combine)
    }
}

private struct NeedsConnection: ViewModifier {
    @Environment(Connectivity.self) private var connectivity

    func body(content: Content) -> some View {
        content.disabled(!connectivity.canWrite)
    }
}

private struct ReconnectAction: ViewModifier {
    @Environment(Connectivity.self) private var connectivity
    let action: () async -> Void

    func body(content: Content) -> some View {
        content.onChange(of: connectivity.reconnects) {
            Task { await action() }
        }
    }
}

/// Above the pay button while offline: the cart stays as it is, paying waits for the network.
struct OfflinePaymentNote: View {
    @Environment(Connectivity.self) private var connectivity

    var body: some View {
        if !connectivity.canWrite {
            Label("Нужен интернет — оплатить можно, когда появится связь", systemImage: "wifi.slash")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
        }
    }
}

#if DEBUG
#Preview("Нет сети") {
    VStack(spacing: 24) {
        OfflineBanner(text: OfflineBannerText.text(dataAsOf: .now.addingTimeInterval(-25 * 60)))
        OfflineBanner(text: OfflineBannerText.text(dataAsOf: nil))
    }
    .padding(.vertical)
}
#endif
