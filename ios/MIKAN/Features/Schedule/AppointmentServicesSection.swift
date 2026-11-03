import SwiftUI

/// «Услуги» section of the appointment editor: booked lines with editable prices, the catalog link and the
/// free-form description.
struct AppointmentServicesSection: View {
    @Environment(ReferenceStore.self) private var reference
    @Binding var draft: AppointmentDraft

    var body: some View {
        Section {
            ForEach($draft.lines) { $line in
                ServiceLineEditorRow(
                    line: $line,
                    catalogPrice: isVariablePrice(line) ? catalogPriceText(line) : nil,
                    needsPrice: needsPrice(line)
                )
            }
            .onDelete { draft.remove(at: $0) }
            NavigationLink {
                ServicePickerView(draft: $draft)
            } label: {
                Label(draft.lines.isEmpty ? "Выбрать услуги" : "Добавить услугу", systemImage: "plus.circle.fill")
            }
            TextField("Описание: эскиз, зона, украшение", text: $draft.title, axis: .vertical)
                .lineLimit(1...3)
        } header: {
            Text("Услуги")
        } footer: {
            footer
        }
    }

    @ViewBuilder
    private var footer: some View {
        if draft.lines.contains(where: needsPrice) {
            Text("Укажите итоговую цену услуг с ценой «от» или диапазоном.").foregroundStyle(.orange)
        } else if draft.lines.contains(where: isVariablePrice) {
            Text("У части услуг цена «от» — проверьте итоговую стоимость для этой записи.")
        } else if !draft.canAddLine {
            Text("В записи не больше \(AppointmentDraft.maxLines) услуг.")
        }
    }

    /// Lines loaded from a saved appointment don't carry the flag, so the catalog is consulted too, for the
    /// appointment's master (variant prices are fixed, so services with variants don't count).
    private func isVariablePrice(_ line: DraftServiceLine) -> Bool {
        if line.isVariablePrice { return true }
        guard let service = reference.service(id: line.serviceId) else { return false }
        return service.hasVariablePrice(for: draft.masterId) && service.variants.isEmpty
    }

    /// «от 3 000 до 6 000 ₽» — the catalog price of the appointment's master.
    private func catalogPriceText(_ line: DraftServiceLine) -> String? {
        reference.service(id: line.serviceId)?.priceText(for: draft.masterId)
    }

    private func needsPrice(_ line: DraftServiceLine) -> Bool {
        line.price == 0 && isVariablePrice(line)
    }
}

private struct ServiceLineEditorRow: View {
    @Binding var line: DraftServiceLine
    /// Catalog price range, shown for variable-price lines.
    let catalogPrice: String?
    let needsPrice: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            NumberField.money(line.name, value: $line.price)
            if needsPrice || !details.isEmpty {
                HStack(spacing: 6) {
                    if needsPrice {
                        Label("Укажите цену", systemImage: "exclamationmark.circle.fill")
                            .foregroundStyle(.orange)
                            .fontWeight(.medium)
                    }
                    if !details.isEmpty {
                        Text(details).foregroundStyle(.secondary)
                    }
                }
                .font(.caption)
                .monospacedDigit()
            }
        }
        .padding(.vertical, 2)
    }

    /// «45 мин · от 2 000 до 5 000 ₽», «своя услуга».
    private var details: String {
        var parts: [String] = []
        if let minutes = line.durationMin, minutes > 0 {
            parts.append(DateText.duration(minutes: minutes))
        }
        if let catalogPrice {
            parts.append(catalogPrice)
        }
        if line.serviceId == nil {
            parts.append("своя услуга")
        }
        return parts.joined(separator: " · ")
    }
}
