import SwiftUI

/// «Предоплата» on the appointment card: status, the ledger, the payment link and what staff can do.
struct AppointmentDepositSection: View {
    let appointment: Appointment
    let qrEnabled: Bool
    /// Off for another master's appointment: a master takes prepayments only of their own.
    var showsActions = true
    let onAction: (DepositFlow) -> Void

    var body: some View {
        Section {
            summary
            ForEach(appointment.depositOperations) { operation in
                DepositOperationRow(operation: operation)
            }
            if let note = DepositLinkNote.of(appointment) {
                linkRow(note)
            }
            if showsActions {
                ForEach(DepositFlow.available(for: appointment, qrEnabled: qrEnabled), id: \.self) { flow in
                    actionButton(flow)
                }
            }
        } header: {
            Text("Предоплата")
        }
    }

    private var summary: some View {
        let missing = DepositSummary.missing(appointment)
        return VStack(alignment: .leading, spacing: 6) {
            StatusBadge(
                text: appointment.depositStatus.title,
                color: appointment.depositStatus.color,
                systemImage: appointment.depositStatus.symbol
            )
            Text(DepositSummary.headline(appointment))
                .font(.headline)
            if appointment.isOpen, missing > 0, appointment.deposit > 0 {
                Text("Осталось внести \(Money.format(missing))")
                    .font(.subheadline)
                    .foregroundStyle(.orange)
            }
            if let freeUntil = DepositRules.freeUntilLine(appointment) {
                Label(freeUntil, systemImage: "calendar.badge.clock")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .monospacedDigit()
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func linkRow(_ note: DepositLinkNote) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(note.text, systemImage: linkSymbol(note))
                .font(.subheadline)
                .foregroundStyle(linkColor(note))
            if case .pending(let amount, _, _) = note, let link = appointment.depositLink {
                ShareLink(item: DepositText.shareMessage(amount: amount, startsAt: appointment.startsAt, payload: link.payload)) {
                    Label("Поделиться ссылкой", systemImage: "square.and.arrow.up")
                        .font(.subheadline)
                }
                .buttonStyle(.borderless)
            }
        }
        .padding(.vertical, 2)
        if note.offersNewLink, appointment.isOpen {
            Button("Новая ссылка / QR", systemImage: "qrcode") { onAction(.collect) }
        }
    }

    private func linkSymbol(_ note: DepositLinkNote) -> String {
        switch note {
        case .pending(_, let sentAt, _): sentAt == nil ? "link" : "paperplane.fill"
        case .expired: "clock.badge.xmark"
        case .cancelled: "xmark.circle"
        case .paidWithIssue: "exclamationmark.triangle.fill"
        }
    }

    private func linkColor(_ note: DepositLinkNote) -> Color {
        if case .paidWithIssue = note { return .orange }
        return .secondary
    }

    @ViewBuilder
    private func actionButton(_ flow: DepositFlow) -> some View {
        switch flow {
        case .collect:
            Button("Принять предоплату", systemImage: DepositStyle.symbol) { onAction(.collect) }
        case .remind:
            Button("Напомнить клиенту", systemImage: "bell") { onAction(.remind) }
        case .refund:
            Button("Вернуть клиенту", systemImage: "arrow.uturn.backward.circle") { onAction(.refund) }
        case .retain:
            Button("Удержать", systemImage: "lock") { onAction(.retain) }
        case .decide:
            EmptyView()
        }
    }
}

/// One ledger entry: what happened, when and by whom, and how it moved the held amount.
struct DepositOperationRow: View {
    let operation: DepositOperation

    private var delta: Int { DepositLedger.heldDelta(for: operation) }

    var body: some View {
        if operation.type == .apply, let saleId = operation.saleId {
            NavigationLink {
                SaleLoaderView(saleId: saleId)
            } label: {
                row
            }
        } else {
            row
        }
    }

    private var row: some View {
        HStack(spacing: 12) {
            Image(systemName: DepositLedger.symbol(for: operation))
                .foregroundStyle(delta > 0 ? Color.green : Color.secondary)
                .frame(width: 24)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(DepositLedger.title(for: operation))
                    .font(.subheadline)
                Text(DepositLedger.detail(for: operation))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
            Text(Money.formatSigned(delta))
                .font(.subheadline.weight(.medium))
                .monospacedDigit()
                .foregroundStyle(delta > 0 ? Color.green : Color.primary)
        }
        .accessibilityElement(children: .combine)
    }
}
