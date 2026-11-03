import SwiftUI

struct SaleDetailView: View {
    @Environment(APIClient.self) private var api
    @State private var sale: Sale
    @State private var showsRefund = false
    @State private var errorMessage: String?
    var onChange: ((Sale) -> Void)?

    init(sale: Sale, onChange: ((Sale) -> Void)? = nil) {
        _sale = State(initialValue: sale)
        self.onChange = onChange
    }

    /// Some line still has units to return.
    private var canRefund: Bool {
        sale.items.contains { sale.refundableQuantity(of: $0) > 0 }
    }

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text("Продажа №\(sale.number)").font(.title2.weight(.bold))
                        Spacer()
                        if sale.isRefunded {
                            StatusBadge(text: "Возврат", color: .red, systemImage: "arrow.uturn.backward")
                        } else if sale.isPartlyRefunded {
                            StatusBadge(text: "Частичный возврат", color: .orange, systemImage: "arrow.uturn.backward")
                        }
                    }
                    Text(DateText.dateTime(sale.createdAt)).foregroundStyle(.secondary)
                    Text("Продал(а): \(sale.employee.name)").font(.subheadline).foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
            }
            if let client = sale.client {
                Section("Клиент") {
                    NavigationLink {
                        ClientDetailView(clientId: client.id)
                    } label: {
                        Label(client.fullName, systemImage: "person.crop.circle")
                    }
                }
            }
            SaleLinesSection(sale: sale)
            SalePaymentsSection(payments: sale.payments)
            SaleBonusEarnedSection(sale: sale)
            IssuedCertificatesSection(sale: sale)
            if let note = sale.note.nonEmpty {
                Section("Комментарий") { Text(note) }
            }
            SaleRefundsSection(sale: sale)
            SaleReceiptSection(sale: sale, onSent: apply)
            AuditHistorySection(scope: .sale(id: sale.id))
        }
        .navigationTitle("Чек №\(sale.number)")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await reload() }
        .toolbar {
            if canRefund {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Вернуть", systemImage: "arrow.uturn.backward") { showsRefund = true }
                        .labelStyle(.titleAndIcon)
                }
            }
        }
        .sheet(isPresented: $showsRefund) {
            RefundSheet(sale: sale, onRefunded: apply)
        }
        .errorAlert($errorMessage)
    }

    private func apply(_ updated: Sale) {
        sale = updated
        onChange?(updated)
    }

    /// Pull to refresh: refunds or a receipt sent from another device.
    private func reload() async {
        do {
            apply(try await api.sale(id: sale.id))
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.userMessage
        }
    }
}

/// Loads a sale by id (e.g. from an appointment's `saleId`).
struct SaleLoaderView: View {
    @Environment(APIClient.self) private var api
    let saleId: Int
    @State private var sale = Remote<Sale>()

    var body: some View {
        Group {
            if let value = sale.value {
                SaleDetailView(sale: value)
            } else {
                RemoteStateOverlay(remote: sale, retry: load)
            }
        }
        .task { await load() }
    }

    private func load() async {
        await sale.load { try await api.sale(id: saleId) }
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        SaleDetailView(sale: PreviewData.sale)
    }
    .previewEnvironment()
}
#endif
