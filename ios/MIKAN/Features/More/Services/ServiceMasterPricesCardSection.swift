import SwiftUI

/// «Цены у мастеров» of the service card: «Амина — 4 000 ₽», then the master's own variant prices.
struct ServiceMasterPricesCardSection: View {
    @Environment(ReferenceStore.self) private var reference
    let service: Service

    var body: some View {
        Section {
            ForEach(service.masterPrices, id: \.employeeId) { price in
                VStack(alignment: .leading, spacing: 4) {
                    if showsBase(price) {
                        LabeledContent(title(price.employeeId), value: service.priceText(for: price.employeeId))
                    } else {
                        Text(title(price.employeeId))
                    }
                    ForEach(price.variants, id: \.name) { variant in
                        LabeledContent(variant.name, value: Money.format(variant.price))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .padding(.leading, 12)
                    }
                }
                .monospacedDigit()
                .accessibilityElement(children: .combine)
            }
        } header: {
            Text("Цены у мастеров")
        } footer: {
            Text("У остальных мастеров — цена из каталога.")
        }
        // Only names the masters; on failure the rows read «Сотрудник №2».
        .task { try? await reference.ensureEmployees() }
    }

    /// A service with variants is charged by its variants: the master's base price is shown only when it is their own.
    private func showsBase(_ price: ServiceMasterPrice) -> Bool {
        service.variants.isEmpty || price.variants.isEmpty || price.price != service.price
            || price.priceMax != service.priceMax
    }

    /// «Амина», «Ольга · не работает».
    private func title(_ employeeId: Int) -> String {
        guard let employee = reference.employees.first(where: { $0.id == employeeId }) else {
            return "Сотрудник №\(employeeId)"
        }
        return employee.active && employee.isMaster ? employee.name : "\(employee.name) · не работает"
    }
}
