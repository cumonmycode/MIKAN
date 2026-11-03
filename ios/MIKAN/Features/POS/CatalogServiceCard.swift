import SwiftUI

/// A service in the catalog at the price of the receipt's master. Without variants the card adds it on tap; with
/// variants each one is a chip that adds it.
struct CatalogServiceCard: View {
    @Environment(CartStore.self) private var cart
    let service: Service
    let masterId: Int?
    let onAdd: (ServiceVariant?) -> Void

    var body: some View {
        if service.variants.isEmpty {
            Button {
                onAdd(nil)
            } label: {
                header(showsPlus: true)
                    .catalogCard()
                    .contentShape(.rect(cornerRadius: 20))
            }
            .buttonStyle(.plain)
            .accessibilityHint("Добавить в чек")
        } else {
            VStack(alignment: .leading, spacing: 12) {
                header(showsPlus: false)
                    .accessibilityElement(children: .combine)
                InventoryFlowLayout(spacing: 8, lineSpacing: 8) {
                    ForEach(Array(service.variants.enumerated()), id: \.offset) { _, variant in
                        variantChip(variant)
                    }
                }
            }
            .catalogCard()
        }
    }

    private func header(showsPlus: Bool) -> some View {
        HStack(spacing: 12) {
            ServiceThumbnail(service: service, size: 64)
            VStack(alignment: .leading, spacing: 3) {
                Text(service.name)
                    .font(.headline)
                    .lineLimit(2)
                Text(service.priceText(for: masterId))
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                    .lineLimit(1)
                if !service.variants.isEmpty {
                    Text(Plural.count(service.variants.count, one: "вариант", few: "варианта", many: "вариантов"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            CatalogCountBadge(count: cart.quantity(ofService: service.id), showsPlus: showsPlus)
        }
        .foregroundStyle(.primary)
    }

    private func variantChip(_ variant: ServiceVariant) -> some View {
        let price = service.price(for: masterId, variant: variant)
        return CatalogChip(
            title: variant.name,
            subtitle: Money.format(price),
            count: cart.quantity(ofService: service.id, named: service.lineName(variant: variant)),
            accessibilityLabel: "\(variant.name), \(Money.format(price))"
        ) {
            onAdd(variant)
        }
    }
}

/// «Своя услуга» at the top of the services: something not in the catalog, by name and price.
struct CustomServiceCard: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: "square.and.pencil")
                    .font(.title2)
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 64, height: 44)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Своя услуга").font(.headline)
                    Text("Название и цена — если услуги нет в каталоге")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                Image(systemName: "plus.circle.fill")
                    .font(.title2)
                    .foregroundStyle(Color.accentColor)
            }
            .foregroundStyle(.primary)
            .catalogCard()
            .contentShape(.rect(cornerRadius: 20))
        }
        .buttonStyle(.plain)
    }
}

/// The name and price of a custom service; «Добавить» puts it into the receipt.
struct CustomServiceAddSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onAdd: (_ name: String, _ price: Int) -> Void

    @State private var name: String
    @State private var price = 0
    @FocusState private var focusesName: Bool

    init(name: String = "", onAdd: @escaping (_ name: String, _ price: Int) -> Void) {
        _name = State(initialValue: name)
        self.onAdd = onAdd
    }

    var body: some View {
        NavigationStack {
            Form {
                TextField("Название услуги", text: $name)
                    .focused($focusesName)
                    .submitLabel(.next)
                NumberField.money("Цена", value: $price)
            }
            .navigationTitle("Своя услуга")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена", role: .cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Добавить") {
                        onAdd(name, price)
                        dismiss()
                    }
                    .disabled(name.trimmed.isEmpty)
                }
            }
            .onAppear { if name.isEmpty { focusesName = true } }
        }
        .presentationDetents([.medium])
    }
}
