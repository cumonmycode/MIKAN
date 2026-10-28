import SwiftUI

/// «Чек в Telegram» on the success screen. The server sends the receipt by itself right after the sale (a client with
/// Telegram linked, `StudioSettings.pos.sendReceipt` on): the sale is re-read a few times to confirm it; otherwise
/// «Отправить чек в Telegram» sends it by hand (`POST /sales/:id/send`), and the server's answer explains a refusal.
struct SaleReceiptDeliverySection: View {
    @Environment(APIClient.self) private var api
    let sale: Sale

    /// `nil` until the studio's setting is known.
    @State private var state: SaleReceiptDeliveryState?
    @State private var errorMessage: String?

    init(sale: Sale) {
        self.sale = sale
        // Without a client, without Telegram, or already sent, the answer is known before the studio's setting.
        let seed = SaleReceiptDelivery.initialState(sale, sendsReceipts: nil)
        _state = State(initialValue: seed == .waiting ? nil : seed)
    }

    var body: some View {
        if state != .noClient {
            Section {
                content
            }
            .task(id: sale.id) { await watch() }
            .errorAlert($errorMessage, title: "Чек не отправлен")
        }
    }

    @ViewBuilder
    private var content: some View {
        switch state {
        case nil, .waiting:
            HStack(spacing: 10) {
                ProgressView()
                Text("Отправляем чек клиенту в Telegram…")
                    .foregroundStyle(.secondary)
            }
            .frame(minHeight: 44)
        case .sent(let date):
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Чек отправлен в Telegram")
                    Text(DateText.time(date)).font(.caption).foregroundStyle(.secondary).monospacedDigit()
                }
            } icon: {
                Image(systemName: "paperplane.circle.fill").foregroundStyle(.green)
            }
            .frame(minHeight: 44, alignment: .leading)
            .accessibilityElement(children: .combine)
        case .noTelegram:
            Label("У клиента не подключён Telegram — чек не отправить", systemImage: "paperplane")
                .foregroundStyle(.secondary)
                .frame(minHeight: 44, alignment: .leading)
        case .notSent, .sending:
            Button(action: send) {
                HStack {
                    Label("Отправить чек в Telegram", systemImage: "paperplane.fill")
                    Spacer()
                    if state == .sending { ProgressView() }
                }
                .frame(minHeight: 44)
                .contentShape(.rect)
            }
            .disabled(state == .sending)
            .needsConnection()
        case .noClient:
            EmptyView()
        }
    }

    /// Waits for the automatic receipt: checks the sale `maxChecks` times, `checkInterval` apart.
    private func watch() async {
        guard state == nil else { return }
        let sendsReceipts = try? await api.studioSettings().pos?.sendReceipt
        var current = SaleReceiptDelivery.initialState(sale, sendsReceipts: sendsReceipts)
        state = current
        var checks = 0
        while current == .waiting, !Task.isCancelled {
            try? await Task.sleep(for: SaleReceiptDelivery.checkInterval)
            checks += 1
            if let fresh = try? await api.sale(id: sale.id) {
                current = SaleReceiptDelivery.state(after: fresh, checksDone: checks)
            } else if checks >= SaleReceiptDelivery.maxChecks {
                current = .notSent
            }
            state = current
        }
    }

    private func send() {
        state = .sending
        Task {
            do {
                let sent = try await api.sendSaleReceipt(id: sale.id)
                state = sent.receiptSentAt.map(SaleReceiptDeliveryState.sent) ?? .sent(.now)
            } catch {
                state = .notSent
                errorMessage = error.userMessage
            }
        }
    }
}
