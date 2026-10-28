import SwiftUI

/// «К оплате»: open receipts and today's visits not started yet in one list of large cards, earliest first. A master
/// gets «Мои / Все». A tap opens the receipt (a visit's is created first); an open receipt swipes to delete.
struct PaymentDueSection: View {
    /// What is shown (the scope applied).
    let items: [PaymentDue]
    /// Before the first load of both lists: `nil`; a failure while nothing is shown: its message.
    let state: PaymentDueLoadState
    /// «Мои / Все» for a master; `nil` hides it.
    let scope: Binding<PaymentDueScope>?
    /// Everything is hidden by «Мои».
    let hidesAll: Bool
    /// The receipt this device's cart holds (marked «Открыт у вас»).
    let cartReceiptId: Int?
    let opening: POSOpening?
    let retry: () async -> Void
    let onOpen: (PaymentDue) -> Void
    let onDelete: (OpenReceipt) -> Void

    var body: some View {
        Section {
            header
            content
        }
        .listSectionSeparator(.hidden)
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            Text("К оплате")
                .font(.title3.weight(.semibold))
                .accessibilityAddTraits(.isHeader)
            if !items.isEmpty {
                Text("\(items.count)")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            Spacer(minLength: 8)
            if let scope {
                Picker("Чьи", selection: scope.animation(.snappy)) {
                    ForEach(PaymentDueScope.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                .fixedSize()
            }
        }
        .hubRow(top: 16, bottom: 2)
    }

    @ViewBuilder
    private var content: some View {
        switch state {
        case .loading:
            ProgressView()
                .frame(maxWidth: .infinity, minHeight: 120)
                .hubRow()
        case .failed(let message):
            ErrorStateView(message: message, retry: retry)
                .cardStyle()
                .hubRow()
        case .loaded(let problem):
            if let problem {
                PaymentDueProblemRow(message: problem, retry: retry)
                    .hubRow()
            }
            if items.isEmpty, problem == nil {
                PaymentDueEmptyCard(hidesAll: hidesAll) { scope?.wrappedValue = .all }
                    .hubRow()
            } else {
                ForEach(items) { item in
                    card(item)
                }
            }
        }
    }

    @ViewBuilder
    private func card(_ item: PaymentDue) -> some View {
        let row = PaymentDueCard(
            item: item,
            isInCart: item.receipt?.id != nil && item.receipt?.id == cartReceiptId,
            isOpening: isOpening(item)
        ) {
            onOpen(item)
        }
        .hubRow()
        if let receipt = item.receipt {
            row
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    // Not `.destructive`: that role removes the row before the confirmation is answered.
                    Button { onDelete(receipt) } label: {
                        Label("Удалить", systemImage: "trash")
                    }
                    .tint(.red)
                }
                .contextMenu {
                    Button("Удалить чек", systemImage: "trash", role: .destructive) { onDelete(receipt) }
                }
        } else {
            row
        }
    }

    private func isOpening(_ item: PaymentDue) -> Bool {
        switch item {
        case .receipt(let receipt): opening == .receipt(receipt.id)
        case .visit(let appointment): opening == .visit(appointmentId: appointment.id)
        }
    }
}

/// Where the two lists of «К оплате» (open receipts, unpaid visits) are.
nonisolated enum PaymentDueLoadState: Equatable, Sendable {
    /// One of them has not answered yet.
    case loading
    /// Neither loaded.
    case failed(String)
    /// At least one loaded; `problem` — why the other did not.
    case loaded(problem: String?)

    /// Each list: whether it has a value and why its last load failed while it had none.
    init(receipts: (hasValue: Bool, failure: String?), visits: (hasValue: Bool, failure: String?)) {
        let lists = [receipts, visits]
        if lists.contains(where: { !$0.hasValue && $0.failure == nil }) {
            self = .loading
        } else if !lists.contains(where: \.hasValue) {
            self = .failed(receipts.failure ?? visits.failure ?? "")
        } else {
            self = .loaded(problem: receipts.failure ?? visits.failure)
        }
    }
}

/// One of the lists did not load: what is there is shown, with this row to try again.
private struct PaymentDueProblemRow: View {
    let message: String
    let retry: () async -> Void

    @State private var isRetrying = false

    var body: some View {
        HStack(spacing: 12) {
            Label(message, systemImage: "exclamationmark.icloud")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Spacer(minLength: 8)
            Button {
                Task {
                    isRetrying = true
                    await retry()
                    isRetrying = false
                }
            } label: {
                if isRetrying { ProgressView() } else { Text("Повторить") }
            }
            .buttonStyle(.bordered)
            .frame(minHeight: 44)
            .disabled(isRetrying)
        }
        .cardStyle(padding: 14)
    }
}

/// A card: the client and amount, what is paid for, time and master, and badges (visit status, prepayment held or
/// waited for, «Открыт у вас»).
private struct PaymentDueCard: View {
    let item: PaymentDue
    let isInCart: Bool
    let isOpening: Bool
    let action: () -> Void

    private var masterColor: Color {
        item.appointment.map { .master($0.master.color) } ?? Color.secondary
    }

    private var deposit: QueueDepositBadge? {
        guard let appointment = item.appointment else { return nil }
        return PaymentQueue.depositBadge(for: appointment)
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Capsule()
                    .fill(masterColor)
                    .frame(width: 5)
                    .padding(.vertical, 2)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 5) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(item.clientName)
                            .font(.headline)
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        MoneyText(item.amount)
                            .font(.headline)
                    }
                    Text(PaymentDueText.contents(item))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                    Text(PaymentDueText.when(item))
                        .font(.subheadline.weight(.medium))
                        .monospacedDigit()
                        .lineLimit(1)
                    InventoryFlowLayout(spacing: 6, lineSpacing: 6) {
                        badges
                    }
                }
                RowAccessory(isWorking: isOpening)
            }
            .foregroundStyle(.primary)
            .padding(14)
            .frame(maxWidth: .infinity, minHeight: 88, alignment: .leading)
            .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: Theme.cardRadius))
            .overlay {
                if isInCart {
                    RoundedRectangle(cornerRadius: Theme.cardRadius)
                        .strokeBorder(Color.accentColor.opacity(0.5), lineWidth: 1.5)
                }
            }
            .contentShape(.rect(cornerRadius: Theme.cardRadius))
            .contentShape(.contextMenuPreview, .rect(cornerRadius: Theme.cardRadius))
        }
        .buttonStyle(.plain)
        .disabled(isOpening)
        .accessibilityHint(item.receipt == nil
            ? "Открыть чек визита с услугами, клиентом и предоплатой"
            : "Открыть чек. Смахните влево, чтобы удалить")
    }

    @ViewBuilder
    private var badges: some View {
        switch item {
        case .visit(let appointment):
            AppointmentStatusBadge(status: appointment.status)
        case .receipt(let receipt):
            StatusBadge(
                text: receipt.appointment == nil ? "Чек открыт" : "Визит идёт",
                color: .accentColor,
                systemImage: "cart"
            )
        }
        if let deposit {
            QueueDepositBadgeView(badge: deposit)
        }
        if isInCart {
            StatusBadge(text: "Открыт у вас", color: .accentColor, systemImage: "iphone")
        }
    }
}

private struct PaymentDueEmptyCard: View {
    /// «Мои» hides everything there is.
    let hidesAll: Bool
    let onShowAll: () -> Void

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "checkmark.circle")
                .font(.title2)
                .foregroundStyle(.secondary)
            Text(hidesAll ? "У вас нет визитов к оплате" : "Сейчас нечего оплачивать")
                .font(.subheadline.weight(.semibold))
            Text(hidesAll
                ? "Чеки и визиты других мастеров — во «Все»."
                : "Здесь появятся открытые чеки и сегодняшние неоплаченные визиты. Продажа без записи — кнопкой «Новая продажа».")
                .font(.caption)
                .foregroundStyle(.secondary)
            if hidesAll {
                Button("Показать все", action: onShowAll)
                    .buttonStyle(.bordered)
                    .frame(minHeight: 44)
            }
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .cardStyle(padding: 20)
    }
}
