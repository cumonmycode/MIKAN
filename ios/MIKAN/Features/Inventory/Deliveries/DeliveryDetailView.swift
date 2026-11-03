import SwiftUI

/// A recorded delivery: who received what from whom, each size with its quantity and unit cost; a line opens its
/// product. Deliveries are never edited: a mistake is fixed by a write-off or a stock count.
struct DeliveryDetailView: View {
    @Environment(APIClient.self) private var api
    private let deliveryId: Int
    /// The list item (without lines) shown while the full delivery loads.
    @State private var summary: StockDelivery?
    @State private var detail = Remote<StockDelivery>()

    init(delivery: StockDelivery) {
        deliveryId = delivery.id
        _summary = State(initialValue: delivery)
    }

    /// From a receipt movement (`deliveryId`).
    init(deliveryId: Int) {
        self.deliveryId = deliveryId
    }

    private var shown: StockDelivery? { detail.value ?? summary }

    var body: some View {
        List {
            if let delivery = shown {
                header(delivery)
                linesSection
                totalsSection(delivery)
            }
        }
        .auraBackground()
        .overlay {
            if shown == nil { RemoteStateOverlay(remote: detail, retry: load) }
        }
        .refreshable { await load() }
        .task {
            guard detail.value == nil else { return }
            await load()
        }
        .remoteErrorAlert(detail)
        .navigationTitle(shown.map { DeliveryText.title(number: $0.number) } ?? "Поставка")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func header(_ delivery: StockDelivery) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Text(DeliveryText.title(number: delivery.number)).font(.title2.weight(.bold))
                Text(DateText.dateTime(delivery.createdAt)).foregroundStyle(.secondary)
                if let employee = delivery.employee {
                    Text("Принял(а): \(employee.name)").font(.subheadline).foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 4)
            if let supplier = delivery.supplier.nonEmpty {
                LabeledContent("Поставщик", value: supplier)
            }
            if let note = delivery.note.nonEmpty {
                Text(note)
            }
        }
    }

    @ViewBuilder
    private var linesSection: some View {
        Section("Позиции") {
            if let lines = detail.value?.lines {
                ForEach(lines, id: \.movementId) { line in
                    NavigationLink {
                        ProductLoaderView(productId: line.productId)
                    } label: {
                        DeliveryLineRow(line: line)
                    }
                }
            } else if let failure = detail.failure {
                VStack(alignment: .leading, spacing: 8) {
                    Text(failure).foregroundStyle(.secondary)
                    Button("Повторить") { Task { await load() } }
                        .buttonStyle(.bordered)
                }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
    }

    private func totalsSection(_ delivery: StockDelivery) -> some View {
        Section {
            LabeledContent("Позиций", value: String(delivery.lineCount))
            LabeledContent("Единиц", value: String(delivery.itemCount))
            LabeledContent("Сумма") { MoneyText(delivery.total).fontWeight(.semibold) }
        } footer: {
            if delivery.lines.contains(where: { $0.unitCost == nil }) {
                Text("Позиции без цены закупки в сумму не входят, их себестоимость не изменилась.")
            }
        }
        .monospacedDigit()
    }

    private func load() async {
        await detail.load { try await api.delivery(id: deliveryId) }
    }
}

/// «Лабрет» [8 мм] · «4 × 700 ₽» — 2 800 ₽.
private struct DeliveryLineRow: View {
    let line: StockDeliveryLine

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(line.productName).font(.body.weight(.medium))
                    if let size = line.variantName.nonEmpty {
                        StatusBadge(text: size, color: .secondary)
                    }
                }
                Text(details)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            Spacer(minLength: 8)
            if let amount = line.amount {
                MoneyText(amount)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var details: String {
        guard let unitCost = line.unitCost else { return "\(line.quantity) · без цены" }
        return "\(line.quantity) × \(Money.format(unitCost))"
    }
}
