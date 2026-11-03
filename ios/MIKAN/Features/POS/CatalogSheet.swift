import SwiftUI

/// The catalog over a receipt: «Украшения», «Услуги», «Товары» (the segment last used is kept), search on top, category
/// chips and cards. Sizes and variants are chips right on a card: one tap adds one unit with a haptic and a count badge.
/// The sheet stays open for several adds; «Готово» closes it and says what was added.
struct CatalogSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(CartStore.self) private var cart
    @Environment(ReferenceStore.self) private var reference

    @Binding var segment: POSCatalog
    /// Jewelry and goods (loaded by the receipt; refreshed here so the stock is current).
    let catalog: Remote<[Product]>
    /// Whose prices services are added at (`ReceiptPricing.masterId`).
    let masterId: Int?
    let reload: () async -> Void

    @State private var search = ""
    /// The category chip chosen in each product segment.
    @State private var productCategories: [ProductKind: String] = [:]
    @State private var serviceCategory: ServiceCategory?
    /// Load state of the services; the services themselves live in `ReferenceStore`.
    @State private var services = Remote<Void>()
    @State private var addedUnits = 0
    @State private var addedAmount = 0
    @State private var hint: CatalogHint?
    @State private var customServiceName: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    content
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
            }
            .scrollDismissesKeyboard(.immediately)
            .background(Color(.systemGroupedBackground))
            .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: segment.searchPrompt)
            .refreshable {
                await reload()
                if segment == .services { await loadServices(force: true) }
            }
            .navigationTitle("Каталог")
            .navigationBarTitleDisplayMode(.inline)
            // The segments stay in reach however far the list is scrolled.
            .safeAreaBar(edge: .top) {
                Picker("Каталог", selection: $segment.animation(.snappy)) {
                    ForEach(POSCatalog.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                .controlSize(.large)
                .padding(.horizontal, 16)
                .padding(.vertical, 6)
            }
            .safeAreaBar(edge: .bottom) { doneBar }
            .catalogHint($hint)
            .sensoryFeedback(.impact(weight: .light), trigger: addedUnits)
            .remoteErrorAlert(catalog)
            .remoteErrorAlert(services)
            .task { await reload() }
            .task(id: segment) {
                if segment == .services { await loadServices() }
            }
            .sheet(item: customServiceSheet) { draft in
                CustomServiceAddSheet(name: draft.name) { name, price in
                    cart.addCustomService(name: name, price: price)
                    added(price)
                }
            }
        }
        .presentationDetents([.large])
    }

    @ViewBuilder
    private var content: some View {
        switch segment {
        case .jewelry:
            CatalogProductsContent(
                kind: .jewelry, catalog: catalog, search: search, category: categoryBinding(.jewelry), reload: reload, onAdd: add
            )
        case .goods:
            CatalogProductsContent(
                kind: .goods, catalog: catalog, search: search, category: categoryBinding(.goods), reload: reload, onAdd: add
            )
        case .services:
            CatalogServicesContent(
                state: services, search: search, category: $serviceCategory, masterId: masterId,
                load: { await loadServices(force: true) },
                onAdd: add,
                onCustom: { customServiceName = $0 }
            )
        }
    }

    /// «Готово», with what was added while the sheet was open.
    private var doneBar: some View {
        VStack(spacing: 6) {
            if addedUnits > 0 {
                Text("Добавлено в чек: \(Plural.count(addedUnits, one: "позиция", few: "позиции", many: "позиций")) · \(Money.format(addedAmount))")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                    .contentTransition(.numericText(value: Double(addedUnits)))
            }
            Button {
                dismiss()
            } label: {
                Text("Готово")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 4)
            }
            .buttonStyle(.glassProminent)
            .controlSize(.large)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .animation(.snappy, value: addedUnits)
    }

    private func categoryBinding(_ kind: ProductKind) -> Binding<String?> {
        Binding(get: { productCategories[kind] }, set: { productCategories[kind] = $0 })
    }

    private var customServiceSheet: Binding<CustomServiceDraft?> {
        Binding(
            get: { customServiceName.map(CustomServiceDraft.init) },
            set: { customServiceName = $0?.name }
        )
    }

    // MARK: Adding

    private func add(_ product: Product, variant: ProductVariant) {
        let isAdded = withAnimation(.snappy) { cart.add(product: product, variant: variant) }
        guard isAdded else { return }
        added(product.price(of: variant))
        if product.hasSeveralSizes { hint = CatalogHint(text: SizePicking.addedHint(product: product, variant: variant)) }
    }

    private func add(_ service: Service, variant: ServiceVariant?) {
        withAnimation(.snappy) { cart.add(service: service, variant: variant, masterId: masterId) }
        added(service.price(for: masterId, variant: variant))
        if let text = POSServiceCatalog.priceHint(for: service, variant: variant, masterId: masterId) {
            hint = CatalogHint(text: text)
        }
    }

    private func added(_ price: Int) {
        addedUnits += 1
        addedAmount += price
    }

    private func loadServices(force: Bool = false) async {
        await services.load { try await reference.ensureServices(force: force) }
    }
}

/// The name a custom service starts with (search text that found nothing, or empty).
private struct CustomServiceDraft: Identifiable {
    let name: String
    var id: String { name }
}

/// Short message over the «Готово» bar after adding something (the size added, a variable price).
struct CatalogHint: Identifiable, Equatable {
    let id = UUID()
    let text: String
}

private struct CatalogHintOverlay: ViewModifier {
    @Binding var hint: CatalogHint?

    private static let visibleFor: Duration = .seconds(2)

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .bottom) {
                if let hint {
                    Label(hint.text, systemImage: "checkmark.circle.fill")
                        .font(.subheadline)
                        .multilineTextAlignment(.leading)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)
                        .glassEffect(.regular, in: .rect(cornerRadius: 20))
                        .padding(.horizontal, 16)
                        .padding(.bottom, 8)
                        .onTapGesture { self.hint = nil }
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                        .id(hint.id)
                        .accessibilityAddTraits(.isStaticText)
                }
            }
            .animation(.spring(response: 0.35, dampingFraction: 0.85), value: hint)
            .task(id: hint?.id) {
                guard let hint else { return }
                AccessibilityNotification.Announcement(hint.text).post()
                do {
                    try await Task.sleep(for: Self.visibleFor)
                } catch {
                    return // replaced by a newer hint or the view went away
                }
                if self.hint?.id == hint.id { self.hint = nil }
            }
    }
}

extension View {
    /// Shows `hint` at the bottom for a moment (tap hides it sooner).
    func catalogHint(_ hint: Binding<CatalogHint?>) -> some View {
        modifier(CatalogHintOverlay(hint: hint))
    }
}

#if DEBUG
#Preview {
    @Previewable @State var segment = POSCatalog.jewelry
    let state = PreviewData.appState()
    state.reference.replaceServices(PreviewData.services)
    state.cart.add(product: PreviewData.labret, variant: PreviewData.labret.variants[1])
    return Color.clear
        .sheet(isPresented: .constant(true)) {
            CatalogSheet(
                segment: $segment,
                catalog: Remote(PreviewData.products.filter(\.kind.isSold) + [PreviewData.aftercareSpray]),
                masterId: nil,
                reload: {}
            )
        }
        .appEnvironment(state)
}
#endif
