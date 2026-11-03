import SwiftUI

/// «Цены у мастеров» of the service editor: a row per active master, where an empty field charges the catalog price.
/// In a service with variants a master's row opens their variant prices. Prices of employees who no longer work as
/// masters are kept and listed under «Не работают».
struct ServiceMasterPricesEditorSection: View {
    @Environment(ReferenceStore.self) private var reference
    @Binding var prices: ServiceMasterPricesDraft
    /// The catalog price the empty fields stand for.
    let catalog: ServicePriceFields
    let variants: [ServiceVariantDraft]

    @State private var isLoading = true
    @State private var loadError: String?
    /// Employees with own prices who are not active masters now, taken once the employees load; their rows stay
    /// editable (a price the catalog change made invalid can be fixed or cleared) and do not vanish while typing.
    @State private var retiredIds: [Int] = []

    /// Variant rows that will be saved; a master's price can be set only for those.
    private var savedVariants: [ServiceVariantDraft] { variants.filter { !$0.isBlank } }

    var body: some View {
        Section {
            if reference.masters.isEmpty {
                if isLoading, loadError == nil {
                    ProgressView().frame(maxWidth: .infinity)
                } else if loadError == nil {
                    Text("В студии пока нет мастеров.").foregroundStyle(.secondary)
                }
            }
            ForEach(reference.masters) { master in
                row(employeeId: master.id, name: master.name)
            }
        } header: {
            Text("Цены у мастеров")
        } footer: {
            footer
        }
        .task { await loadEmployees() }
        if !retiredIds.isEmpty {
            retiredSection
        }
    }

    @ViewBuilder
    private func row(employeeId: Int, name: String) -> some View {
        if savedVariants.isEmpty {
            ServiceMasterPriceFields(title: name, entry: entry(employeeId), catalog: catalog)
        } else {
            NavigationLink {
                ServiceMasterVariantPricesView(
                    masterName: name,
                    entry: entry(employeeId),
                    catalog: catalog,
                    variants: savedVariants
                )
            } label: {
                variantMasterLabel(employeeId: employeeId, name: name)
            }
        }
    }

    @ViewBuilder
    private var footer: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let loadError {
                Text(loadError).foregroundStyle(.red)
            }
            if let entry = prices.invalidEntry(catalog: catalog),
               let message = ServiceMasterPricesDraft.rangeMessage(entry, catalog: catalog) {
                Text("\(name(of: entry.employeeId)): \(message.lowercasedFirst)").foregroundStyle(.red)
            } else if let message = prices.validationMessage(catalog: catalog, variants: variants) {
                Text(message).foregroundStyle(.red)
            }
            Text("Пусто — мастер берёт обычную цену. Цену у мастера увидят в записи, кассе, у бота и на странице записи.")
        }
    }

    /// «Амина» with «как в каталоге» or their own prices: «3 000 ₽ · Два — 5 000 ₽».
    private func variantMasterLabel(employeeId: Int, name: String) -> some View {
        let own = ServiceMasterPricesDraft.resolved(prices.entry(for: employeeId), catalog: catalog, variants: variants)
        return VStack(alignment: .leading, spacing: 2) {
            Text(name)
            Text(own.map(summary) ?? "Как в каталоге")
                .font(.caption)
                .foregroundStyle(.secondary)
                .monospacedDigit()
                .lineLimit(2)
        }
    }

    private var retiredSection: some View {
        Section {
            ForEach(retiredIds, id: \.self) { employeeId in
                row(employeeId: employeeId, name: name(of: employeeId))
            }
        } header: {
            Text("Не работают")
        } footer: {
            Text("Цены сохранятся и вернутся, если сотрудник снова станет мастером.")
        }
    }

    /// The base price only when it differs from the catalog (a variant line is charged by its variant), then the
    /// master's variant prices.
    private func summary(_ price: ServiceMasterPrice) -> String {
        let base = ServiceMasterPriceText.price(price, priceFrom: catalog.priceFrom)
        let ownBase = price.price != catalog.price || price.priceMax != catalog.priceMax || price.variants.isEmpty
        return [ownBase ? base : nil, ServiceMasterPriceText.variants(price.variants)]
            .compactMap { $0 }
            .joined(separator: " · ")
    }

    private func name(of employeeId: Int) -> String {
        reference.employees.first { $0.id == employeeId }?.name ?? "Сотрудник №\(employeeId)"
    }

    private func entry(_ employeeId: Int) -> Binding<ServiceMasterPriceDraft> {
        Binding(get: { prices.entry(for: employeeId) }, set: { prices.set($0) })
    }

    private func loadEmployees() async {
        isLoading = true
        defer { isLoading = false }
        do {
            try await reference.ensureEmployees()
            loadError = nil
            let masterIds = Set(reference.masters.map(\.id))
            retiredIds = prices.entries.map(\.employeeId).filter { !masterIds.contains($0) }
        } catch {
            loadError = error.userMessage
        }
    }
}

/// A master's price field with the catalog price as the placeholder, and «до» for a range («—» when their saved
/// price has no maximum).
private struct ServiceMasterPriceFields: View {
    let title: String
    @Binding var entry: ServiceMasterPriceDraft
    let catalog: ServicePriceFields

    /// A range service, or a master who already has their own maximum.
    private var showsMaximum: Bool { catalog.priceMax != nil || entry.priceMax.amount != nil }

    /// Typing sets the master's maximum; emptying the field makes it follow the catalog.
    private var maximum: Binding<Int?> {
        Binding(
            get: { entry.priceMax.amount },
            set: { entry.priceMax = $0.map(ServiceMasterPriceMax.amount) ?? .catalog }
        )
    }

    private var maximumPlaceholder: String {
        entry.priceMax == .noMaximum ? ServiceMasterPriceText.placeholder(nil) : ServiceMasterPriceText.placeholder(catalog.priceMax)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            NumberField.optionalMoney(
                title,
                value: $entry.price,
                placeholder: ServiceMasterPriceText.placeholder(catalog.price)
            )
            if showsMaximum {
                NumberField.optionalMoney(
                    "до",
                    value: maximum,
                    placeholder: maximumPlaceholder
                )
            }
            if let message = ServiceMasterPricesDraft.rangeMessage(entry, catalog: catalog) {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
    }
}

/// A master's own variant prices (and the service price the catalog shows for them) in a service with variants.
private struct ServiceMasterVariantPricesView: View {
    let masterName: String
    @Binding var entry: ServiceMasterPriceDraft
    let catalog: ServicePriceFields
    let variants: [ServiceVariantDraft]

    var body: some View {
        Form {
            Section {
                ForEach(variants) { variant in
                    NumberField.optionalMoney(
                        variant.name.trimmed,
                        value: variantPrice(variant.id),
                        placeholder: ServiceMasterPriceText.placeholder(variant.price)
                    )
                }
            } header: {
                Text("Варианты")
            } footer: {
                Text("Пусто — цена варианта из каталога. В запись идёт цена выбранного варианта.")
            }
            Section {
                ServiceMasterPriceFields(title: "Цена услуги", entry: $entry, catalog: catalog)
            } footer: {
                Text("Видна в списке услуг и у бота. Пусто — как в каталоге.")
            }
        }
        .navigationTitle(masterName)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func variantPrice(_ id: UUID) -> Binding<Int?> {
        Binding(get: { entry.variantPrices[id] }, set: { entry.variantPrices[id] = $0 })
    }
}

private extension String {
    /// «Максимум…» → «максимум…», to follow «Амина: ».
    var lowercasedFirst: String { prefix(1).lowercased() + dropFirst() }
}
