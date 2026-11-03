import SwiftUI

/// Who the receipt is for, as chips: the client (tap — another one, × — none) and the visit it pays for (time and
/// master; its menu unlinks it). A failed save shows below.
struct ReceiptHeaderSection: View {
    @Environment(CartStore.self) private var cart
    @Environment(OpenReceiptsStore.self) private var receipts
    let onPickClient: () -> Void

    var body: some View {
        Section {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { chips }
                VStack(alignment: .leading, spacing: 8) { chips }
            }
            .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            .listRowBackground(Color.clear)
        } footer: {
            if receipts.saveFailed {
                Label("Не сохранено — повторим при следующем изменении", systemImage: "exclamationmark.icloud")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
        }
    }

    @ViewBuilder
    private var chips: some View {
        ReceiptClientChip(client: cart.client, onPick: onPickClient) {
            withAnimation(.snappy) { cart.client = nil }
        }
        if let appointment = cart.appointment {
            ReceiptAppointmentChip(appointment: appointment) {
                withAnimation(.snappy) { cart.detachAppointment() }
            }
        }
    }
}

private struct ReceiptClientChip: View {
    let client: ClientRef?
    let onPick: () -> Void
    let onRemove: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            Button(action: onPick) {
                HStack(spacing: 8) {
                    if let client {
                        InitialsAvatar(name: client.fullName, size: 30)
                        Text(client.fullName)
                            .lineLimit(1)
                    } else {
                        Image(systemName: "person.crop.circle.badge.plus")
                            .font(.title3)
                        Text("Клиент")
                    }
                }
                .font(.subheadline.weight(.semibold))
                .padding(.leading, 8)
                .padding(.trailing, client == nil ? 16 : 2)
                .frame(minHeight: 44)
                .contentShape(.capsule)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(client.map { "Клиент: \($0.fullName)" } ?? "Добавить клиента")
            .accessibilityHint(client == nil ? "" : "Выбрать другого клиента")
            if client != nil {
                Button("Убрать клиента", systemImage: "xmark.circle.fill", action: onRemove)
                    .labelStyle(.iconOnly)
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .frame(width: 44, height: 44)
                    .contentShape(.rect)
                    .buttonStyle(.plain)
            }
        }
        .foregroundStyle(client == nil ? Color.accentColor : Color.primary)
        .background(Color(.secondarySystemGroupedBackground), in: .capsule)
    }
}

/// «14:00–15:00 · Фатима» in the master's colour; the menu names the visit and unlinks it.
private struct ReceiptAppointmentChip: View {
    let appointment: Appointment
    let onDetach: () -> Void

    private var color: Color { .master(appointment.master.color) }
    private var when: String { PaymentDueText.when(.visit(appointment)) }

    var body: some View {
        Menu {
            Section(appointment.displayTitle) {
                Button("Отвязать от записи", systemImage: "calendar.badge.minus", action: onDetach)
            }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "calendar")
                    .foregroundStyle(color)
                Text(when)
                    .monospacedDigit()
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.secondary)
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.primary)
            .padding(.horizontal, 14)
            .frame(minHeight: 44)
            .background(color.opacity(0.16), in: .capsule)
            .contentShape(.capsule)
        }
        .accessibilityLabel("По записи: \(when), \(appointment.displayTitle)")
        .accessibilityHint(appointment.deposit > 0
            ? "Отвязать: чек останется без записи, запись вернётся в «К оплате», предоплата останется за ней"
            : "Отвязать: чек останется без записи, запись вернётся в «К оплате»")
    }
}

/// What can be added to a receipt: the big buttons under its lines.
enum ReceiptAddition: CaseIterable, Identifiable {
    case jewelry
    case service
    case goods
    case certificate

    var id: Self { self }

    var title: String {
        switch self {
        case .jewelry: "Украшение"
        case .service: "Услуга"
        case .goods: "Товар"
        case .certificate: "Сертификат"
        }
    }

    var symbol: String {
        switch self {
        case .jewelry: CatalogSection.jewelry.symbol
        case .service: "hands.and.sparkles"
        case .goods: CatalogSection.goods.symbol
        case .certificate: PaymentLine.certificateSymbol
        }
    }

    /// The catalog segment it opens; `nil` for a certificate (its own sheet).
    var catalog: POSCatalog? {
        switch self {
        case .jewelry: .jewelry
        case .service: .services
        case .goods: .goods
        case .certificate: nil
        }
    }
}

/// The receipt's lines, compact: tap one to change its price or quantity, swipe to delete; the add buttons below.
struct ReceiptLinesSection: View {
    @Environment(CartStore.self) private var cart
    let onEdit: (CartLine.ID) -> Void
    let onAdd: (ReceiptAddition) -> Void

    var body: some View {
        Section {
            ForEach(cart.lines) { line in
                ReceiptLineRow(line: line, warning: cart.stockWarning(for: line) ?? ReceiptLineText.problem(line)) {
                    onEdit(line.id)
                }
            }
            .onDelete { offsets in
                withAnimation(.snappy) { cart.remove(at: offsets) }
            }
            ReceiptAddButtons(onAdd: onAdd)
                .listRowInsets(EdgeInsets(top: 10, leading: 10, bottom: 10, trailing: 10))
        } header: {
            if !cart.isEmpty {
                Text(Plural.count(cart.itemCount, one: "позиция", few: "позиции", many: "позиций"))
            }
        } footer: {
            if cart.isEmpty {
                Text("Добавьте украшение, услугу или товар — позиции появятся здесь.")
            }
        }
    }
}

private struct ReceiptLineRow: View {
    let line: CartLine
    /// Not enough stock of the size, or a certificate that cannot be sold as it is.
    let warning: String?
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: line.symbol)
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 22)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    SizedItemTitle(name: line.name, size: line.sizeName)
                        .font(.body.weight(.medium))
                    if let detail = ReceiptLineText.detail(line) {
                        Text(detail)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                    if let warning {
                        Label(warning, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.orange)
                    }
                }
                Spacer(minLength: 8)
                MoneyText(line.total)
                    .font(.body.weight(.semibold))
                    .contentTransition(.numericText(value: Double(line.total)))
                    .animation(.snappy, value: line.total)
            }
            .padding(.vertical, 4)
            .frame(minHeight: 44)
            .contentShape(.rect)
        }
        // A list row, not a link: plain text colours instead of the accent tint.
        .tint(.primary)
        .accessibilityHint("Изменить цену или количество. Смахните влево, чтобы удалить")
    }
}

/// «Украшение», «Услуга», «Товар», «Сертификат».
private struct ReceiptAddButtons: View {
    let onAdd: (ReceiptAddition) -> Void

    var body: some View {
        HStack(spacing: 8) {
            ForEach(ReceiptAddition.allCases) { addition in
                Button {
                    onAdd(addition)
                } label: {
                    VStack(spacing: 6) {
                        Image(systemName: addition.symbol)
                            .font(.title3)
                            .frame(height: 24)
                        Text(addition.title)
                            .font(.footnote.weight(.semibold))
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                    }
                    .foregroundStyle(Color.accentColor)
                    .frame(maxWidth: .infinity, minHeight: 64)
                    .background(Color.accentColor.opacity(0.12), in: .rect(cornerRadius: 16))
                    .contentShape(.rect(cornerRadius: 16))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Добавить: \(addition.title.lowercased())")
            }
        }
    }
}

/// Texts of a receipt line.
enum ReceiptLineText {
    /// «2 × 1 500 ₽» for several units, «Кому: Маше» for a gift certificate; `nil` otherwise.
    static func detail(_ line: CartLine) -> String? {
        if line.isCertificate {
            return line.recipientName.trimmed.isEmpty ? nil : "Кому: \(line.recipientName.trimmed)"
        }
        guard line.quantity > 1 else { return nil }
        return "\(line.quantity) × \(Money.format(line.unitPrice))"
    }

    /// Why a gift certificate line cannot be sold as it is; `nil` when it can (and for other lines).
    static func problem(_ line: CartLine) -> String? {
        guard line.isCertificate else { return nil }
        if !CertificateRules.isValidAmount(line.unitPrice) { return CertificateRules.amountHint }
        if line.recipientName.trimmed.count > CertificateRules.recipientNameLimit {
            return "Имя — не длиннее \(CertificateRules.recipientNameLimit) символов"
        }
        return nil
    }
}

/// Item name with its size as a small badge — «Лабрет» [8 мм] — in receipt, checkout and sale lines;
/// read out as «Лабрет, размер 8 мм».
struct SizedItemTitle: View {
    let name: String
    let size: String?

    var body: some View {
        let parts = SizeLabel.split(name: name, size: size)
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(parts.name)
                .lineLimit(2)
            if let size = parts.size {
                Text(size)
                    .font(.caption.weight(.semibold))
                    .monospacedDigit()
                    .lineLimit(1)
                    .fixedSize()
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .foregroundStyle(Color.accentColor)
                    .background(Color.accentColor.opacity(0.15), in: .capsule)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(parts.size.map { "\(parts.name), размер \($0)" } ?? parts.name)
    }
}
