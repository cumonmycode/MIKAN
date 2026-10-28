import SwiftUI

/// «Что возвращаем»: every line with units left, a checkbox and how many of them; «Вернуть весь чек».
struct RefundLinesSection: View {
    @Binding var selection: RefundSelection

    var body: some View {
        Section {
            ForEach(selection.lines) { line in
                RefundLineRow(
                    line: line,
                    quantity: selection.quantity(of: line.id),
                    onToggle: { withAnimation(.snappy) { selection = selection.toggling(line.id) } },
                    onQuantity: { selection = selection.settingQuantity($0, of: line.id) }
                )
            }
            if !selection.isWhole {
                Button("Вернуть весь чек", systemImage: "checklist.checked") {
                    withAnimation(.snappy) { selection = selection.selectingAll() }
                }
            }
        } header: {
            Text("Что возвращаем")
        }
    }
}

private struct RefundLineRow: View {
    let line: RefundableLine
    /// Units chosen; `nil` — the line is not returned.
    let quantity: Int?
    let onToggle: () -> Void
    let onQuantity: @MainActor (Int) -> Void

    private var isSelected: Bool { quantity != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(action: onToggle) {
                HStack(spacing: 12) {
                    Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                        .font(.title2)
                        .foregroundStyle(isSelected ? Color.accentColor : Color.secondary.opacity(0.5))
                        .contentTransition(.symbolEffect(.replace))
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(line.item.name)
                        Text(details)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(isSelected ? .isSelected : [])
            if let quantity, line.refundable > 1 {
                Stepper(value: Binding(get: { quantity }, set: onQuantity), in: 1...line.refundable) {
                    Text("Вернуть \(quantity) из \(line.refundable)")
                        .font(.subheadline)
                        .monospacedDigit()
                }
                .padding(.leading, 40)
            }
        }
    }

    /// «2 × 1 500 ₽ · вернули 1 из 2».
    private var details: String {
        var parts = ["\(line.item.quantity) × \(Money.format(line.item.price))"]
        if let returned = SaleRefundText.returnedUnits(line.returned, of: line.item.quantity) {
            parts.append(returned)
        }
        return parts.joined(separator: " · ")
    }
}

/// «Причина»: quick chips for the usual reasons and the field (required).
struct RefundReasonSection: View {
    @Binding var reason: String

    var body: some View {
        Section {
            InventoryFlowLayout(spacing: 8, lineSpacing: 8) {
                ForEach(RefundReason.quick, id: \.self) { text in
                    chip(text)
                }
            }
            .padding(.vertical, 4)
            TextField("Или опишите своими словами", text: $reason, axis: .vertical)
                .lineLimit(1...4)
        } header: {
            Text("Причина")
        } footer: {
            if let issue = RefundReason.issue(reason) {
                Text(issue).foregroundStyle(.red)
            } else {
                Text("Обязательно укажите причину — она останется в истории чека.")
            }
        }
    }

    @ViewBuilder
    private func chip(_ text: String) -> some View {
        let isSelected = reason.trimmed == text
        let button = Button(text) { reason = text }
            .buttonBorderShape(.capsule)
            .controlSize(.small)
            .accessibilityAddTraits(isSelected ? .isSelected : [])
        if isSelected {
            button.buttonStyle(.borderedProminent)
        } else {
            button.buttonStyle(.bordered)
        }
    }
}

/// What the refund returns and how, from `POST /sales/:id/refund/preview`. A preview of an earlier choice stays
/// (dimmed) while the new one loads.
struct RefundPreviewSection: View {
    let preview: RefundPreview?
    /// `preview` belongs to the current choice.
    let isCurrent: Bool
    let error: String?
    /// The sale had a discount: line amounts differ from their prices.
    let showsItems: Bool
    let hasCertificates: Bool
    let retry: () -> Void

    var body: some View {
        Section {
            if let error {
                VStack(alignment: .leading, spacing: 8) {
                    Text(error).foregroundStyle(.secondary)
                    Button("Повторить", action: retry).buttonStyle(.bordered)
                }
            } else if let preview {
                content(preview)
                    .opacity(isCurrent ? 1 : 0.5)
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        } header: {
            HStack(spacing: 6) {
                Text("Вернётся")
                if preview != nil, !isCurrent, error == nil {
                    ProgressView().controlSize(.mini)
                }
            }
        } footer: {
            footer
        }
    }

    @ViewBuilder
    private func content(_ preview: RefundPreview) -> some View {
        LabeledContent("Сумма возврата") {
            MoneyText(preview.amount).fontWeight(.semibold)
        }
        if showsItems {
            ForEach(preview.items, id: \.saleItemId) { item in
                LabeledContent {
                    MoneyText(item.amount)
                } label: {
                    Text(SaleRefundText.itemLine(item)).font(.subheadline)
                }
            }
        }
        ForEach(RefundOutcome.lines(preview)) { line in
            LabeledContent {
                Text(line.value).monospacedDigit()
            } label: {
                Label(line.instruction, systemImage: line.symbol)
            }
        }
    }

    @ViewBuilder
    private var footer: some View {
        let notes = [
            (preview?.payments.qr ?? 0) > 0 ? SaleRefundText.qrNote : nil,
            preview.flatMap { SaleRefundText.depositNote($0.payments) },
            hasCertificates ? SaleRefundText.certificateNote : nil,
        ].compactMap { $0 }
        if !notes.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(notes, id: \.self) { Text($0) }
            }
        }
    }
}

/// The refund returns cash and no shift is open.
struct RefundNeedsShiftSection: View {
    let onOpenShift: () -> Void

    var body: some View {
        Section {
            Label("Чтобы вернуть наличные, откройте смену", systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            Button("Открыть смену", systemImage: "lock.open", action: onOpenShift)
        }
    }
}
