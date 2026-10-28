import SwiftUI

/// The cash shift at the top of «Касса». Open: one compact line «Смена открыта · в кассе 8 500 ₽» whose menu deposits,
/// withdraws, closes the shift and shows the history. Closed: a clear card with «Открыть смену» — selling needs it.
struct ShiftStrip: View {
    @Environment(ShiftStore.self) private var shift
    let onHistory: () -> Void

    @State private var sheet: ShiftSheet?

    var body: some View {
        Group {
            if let current = shift.current {
                openStrip(current)
            } else if shift.hasLoaded {
                closedCard
            } else if let error = shift.loadError {
                VStack(alignment: .leading, spacing: 10) {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.secondary)
                    Button("Повторить") { Task { await shift.refresh() } }
                        .buttonStyle(.glass)
                }
                .cardStyle()
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, minHeight: 56)
                    .cardStyle(padding: 0)
            }
        }
        .sheet(item: $sheet) { sheet in
            switch sheet {
            case .open: OpenShiftSheet()
            case .deposit: CashOperationSheet(type: .deposit)
            case .withdrawal: CashOperationSheet(type: .withdrawal)
            case .close(let current): CloseShiftSheet(shift: current)
            }
        }
    }

    private func openStrip(_ current: CashShift) -> some View {
        Menu {
            if let deposits = ShiftBreakdown.cardLine(current.summary) {
                Text(deposits)
            }
            Button("Внести", systemImage: "plus.circle") { sheet = .deposit }
            Button("Изъять", systemImage: "minus.circle") { sheet = .withdrawal }
            Button("Закрыть смену", systemImage: "lock.fill") { sheet = .close(current) }
            Divider()
            Button("История смен", systemImage: "tray.full", action: onHistory)
        } label: {
            HStack(spacing: 12) {
                Circle()
                    .fill(.green)
                    .frame(width: 10, height: 10)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Смена открыта · в кассе \(Money.format(current.expectedCash))")
                        .font(.subheadline.weight(.semibold))
                        .contentTransition(.numericText(value: Double(current.expectedCash)))
                    Text(ShiftStripText.details(current))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.85)
                Spacer(minLength: 8)
                Image(systemName: "ellipsis.circle")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
            .foregroundStyle(.primary)
            .padding(.horizontal, 14)
            .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
            .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: Theme.cardRadius))
            .contentShape(.rect(cornerRadius: Theme.cardRadius))
        }
        .accessibilityHint("Внести, изъять, закрыть смену или открыть историю смен")
    }

    private var closedCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Смена закрыта — откройте, чтобы продавать", systemImage: "lock.fill")
                .font(.headline)
            Button {
                sheet = .open
            } label: {
                Label("Открыть смену", systemImage: "lock.open.fill")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 4)
            }
            .buttonStyle(.glassProminent)
            .controlSize(.large)
            .needsConnection()
            Button("История смен", systemImage: "tray.full", action: onHistory)
                .font(.subheadline)
                .frame(minHeight: 44)
        }
        .cardStyle()
    }
}

/// The sheets of the shift strip.
private enum ShiftSheet: Identifiable {
    case open
    case deposit
    case withdrawal
    /// Captures the shift so the sheet can show the result after `current` becomes `nil`.
    case close(CashShift)

    var id: String {
        switch self {
        case .open: "open"
        case .deposit: "deposit"
        case .withdrawal: "withdrawal"
        case .close(let shift): "close-\(shift.id)"
        }
    }
}

/// The second line of the open shift.
nonisolated enum ShiftStripText {
    /// «с 10:02 · Фатима · 3 продажи на 12 000 ₽»; «с 10:02 · Фатима · продаж нет».
    static func details(_ shift: CashShift) -> String {
        let opened = "с \(DateText.time(shift.openedAt)) · \(shift.openedBy.name)"
        let count = shift.summary.salesCount
        guard count > 0 else { return "\(opened) · продаж нет" }
        let sales = Plural.count(count, one: "продажа", few: "продажи", many: "продаж")
        return "\(opened) · \(sales) на \(Money.format(shift.summary.revenue))"
    }
}

#if DEBUG
#Preview {
    List {
        ShiftStrip(onHistory: {})
            .hubRow()
    }
    .listStyle(.plain)
    .previewEnvironment()
}
#endif
