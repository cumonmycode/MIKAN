import SwiftUI

/// The service card editor: main data, price and variants, masters' prices, time and prepayment, compatible jewelry,
/// the consumption norm, pictures, the text the bot reads, the aftercare memo, the bot's messages after the visit and
/// visibility.
struct ServiceEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(APIClient.self) private var api
    @Environment(ReferenceStore.self) private var reference

    let service: Service?
    /// Group names services already carry per category; offered after the warehouse categories.
    let groupSuggestions: [ServiceCategory: [String]]
    let onSaved: (Service) -> Void

    @State private var draft: ServiceEditorDraft
    /// Jewelry and consumables the service can link to.
    @State private var stock = Remote<[Product]>()
    /// The group typed in each category, so switching the category back and forth does not lose it.
    @State private var stashedGroups: [ServiceCategory: String] = [:]
    @State private var isUploadingCover = false
    @State private var isUploadingPhotos = false
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(
        service: Service?,
        nextSort: Int,
        groupSuggestions: [ServiceCategory: [String]] = [:],
        onSaved: @escaping (Service) -> Void
    ) {
        self.service = service
        self.groupSuggestions = groupSuggestions
        self.onSaved = onSaved
        _draft = State(initialValue: ServiceEditorDraft(service: service, nextSort: nextSort))
    }

    private var isUploading: Bool { isUploadingCover || isUploadingPhotos }
    private var canSave: Bool { draft.canSave && !isSaving && !isUploading }

    var body: some View {
        NavigationStack {
            Form {
                mainSection
                priceSection
                ServiceVariantsEditor(
                    variants: $draft.variants,
                    serviceName: draft.name,
                    defaultPrice: draft.price.amount,
                    defaultDuration: draft.durationMin
                )
                ServiceMasterPricesEditorSection(
                    prices: $draft.masterPrices,
                    catalog: draft.price.fields,
                    variants: draft.variants
                )
                durationSection
                depositSection
                ServiceJewelryEditorSection(jewelryIds: $draft.jewelryIds, stock: stock, retry: loadStock)
                ServiceNormsEditorSection(consumables: $draft.consumables, stock: stock, retry: loadStock)
                ServiceCoverEditorSection(
                    imageUrl: $draft.imageUrl,
                    imagePrompt: $draft.imagePrompt,
                    isUploading: $isUploadingCover,
                    errorMessage: $errorMessage,
                    placeholderSymbol: draft.category.symbol
                )
                ServicePhotosEditorSection(
                    photos: $draft.photos,
                    isUploading: $isUploadingPhotos,
                    errorMessage: $errorMessage
                )
                descriptionSection
                aftercareSection
                followUpsSection
                visibilitySection
            }
            .disabled(isSaving)
            .safeAreaInset(edge: .bottom) { saveBlockerBanner }
            .navigationTitle(service == nil ? "Новая услуга" : "Услуга")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена", role: .cancel) { dismiss() }
                        .disabled(isSaving || isUploading)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving { ProgressView() } else { Button("Сохранить", action: save).disabled(!canSave) }
                }
            }
            .interactiveDismissDisabled(isSaving || isUploading)
            .task {
                do { try await reference.ensureTemplates() } catch { errorMessage = error.userMessage }
            }
            .task { await loadStock() }
            // Only orders the group menu; names services carry are offered anyway.
            .task { try? await reference.ensureCategories() }
            .onChange(of: draft.category) { old, new in switchGroup(from: old, to: new) }
            .errorAlert($errorMessage)
        }
    }

    // MARK: - Sections

    private var mainSection: some View {
        Section {
            HStack(spacing: 14) {
                ProductThumbnail(
                    path: draft.imageUrl.nonEmpty ?? draft.photos.first,
                    size: Self.headerThumbnailSize,
                    placeholderSymbol: draft.category.symbol
                )
                TextField("Название услуги", text: $draft.name, axis: .vertical)
                    .font(.title3.weight(.semibold))
                    .lineLimit(1...3)
            }
            .padding(.vertical, 4)
            Picker("Категория", selection: $draft.category) {
                ForEach(ServiceCategory.allCases) { category in
                    Text(category.title).tag(category)
                }
            }
            .pickerStyle(.segmented)
            .listRowSeparator(.hidden, edges: .top)
            CategoryField(
                title: "Группа",
                scope: CategoryScope(section: .service, serviceCategory: draft.category),
                options: groupOptions(for: draft.category),
                selection: $draft.group
            )
        } header: {
            Text("Основное")
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                // Not red: on a new card an empty name is the starting point, not a mistake.
                if let message = draft.nameMessage {
                    Text(message)
                }
                Text("Группа — категория услуг на складе: «Ухо», «Лицо», «Доп. услуги». Список услуг и бот идут в порядке групп.")
            }
        }
    }

    private static let headerThumbnailSize: CGFloat = 56

    /// Warehouse categories of the service category in staff order, then group names services carry.
    private func groupOptions(for category: ServiceCategory) -> [String] {
        reference.categories.orderedNames(.service, serviceCategory: category, including: groupSuggestions[category] ?? [])
    }

    /// A group belongs to one service category: switching the category puts away the typed group
    /// and brings back the one typed there before (none when it was never visited).
    private func switchGroup(from old: ServiceCategory, to new: ServiceCategory) {
        stashedGroups[old] = draft.group
        guard !groupOptions(for: new).contains(draft.group.trimmed) else { return }
        draft.group = stashedGroups[new] ?? ""
    }

    private var priceSection: some View {
        Section {
            Picker("Вид цены", selection: $draft.price.mode) {
                ForEach(ServicePriceMode.allCases) { mode in
                    Text(mode.title).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            switch draft.price.mode {
            case .fixed:
                NumberField.money("Цена", value: $draft.price.amount)
            case .from:
                NumberField.money("Цена от", value: $draft.price.amount)
            case .range:
                NumberField.money("Минимум", value: $draft.price.amount)
                NumberField.optionalMoney("Максимум", value: $draft.price.maximum)
            }
        } header: {
            Text("Цена")
        } footer: {
            priceFooter
        }
    }

    @ViewBuilder
    private var priceFooter: some View {
        if let message = draft.price.validationMessage {
            Text(message).foregroundStyle(.red)
        } else {
            VStack(alignment: .leading, spacing: 4) {
                Text("В каталоге и для клиентов: «\(draft.price.previewText)».")
                switch draft.price.mode {
                case .fixed:
                    EmptyView()
                case .from:
                    Text("Итоговая цена указывается в каждой записи.")
                case .range:
                    Text("Минимум 0 — цена «до …». Итоговая цена указывается в каждой записи.")
                }
            }
        }
    }

    private var depositSection: some View {
        Section {
            Toggle("Нужна предоплата", isOn: $draft.deposit.isRequired.animation())
            if draft.deposit.isRequired {
                NumberField.money("Сумма", value: $draft.deposit.requiredAmount)
            }
        } header: {
            Text("Предоплата")
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                if let message = draft.deposit.validationMessage {
                    Text(message).foregroundStyle(.red)
                } else if let hint = draft.deposit.priceHint(for: draft.price.fields) {
                    Text(hint).foregroundStyle(.orange)
                }
                Text("Сумма предоплаты при записи на услугу. Если в записи несколько услуг, суммы складываются.")
            }
        }
    }

    private var durationSection: some View {
        Section {
            ServiceDurationStepper(title: "Длительность", minutes: $draft.durationMin)
        } footer: {
            if let message = draft.durationMessage {
                Text(message).foregroundStyle(.red)
            } else {
                Text("Время в расписании по умолчанию; у варианта может быть своё.")
            }
        }
    }

    private var descriptionSection: some View {
        Section {
            TextField("Что входит, подготовка, противопоказания", text: $draft.description, axis: .vertical)
                .lineLimit(3...10)
        } header: {
            Text("Описание")
        } footer: {
            Text("Этот текст видит бот, когда рассказывает клиентам об услуге.")
        }
    }

    private var aftercareSection: some View {
        Section {
            Toggle(draft.category.freshProcedureTitle, isOn: $draft.freshProcedure.animation(.snappy))
            if draft.freshProcedure {
                Picker("Шаблон ухода", selection: $draft.aftercareTemplateId) {
                    Text("Без памятки").tag(Int?.none)
                    ForEach(reference.templates) { template in
                        Text(template.name).tag(Int?.some(template.id))
                    }
                }
            }
        } header: {
            Text("Памятка")
        } footer: {
            Text(draft.aftercareHint)
        }
    }

    private var followUpsSection: some View {
        Section {
            Toggle("Спросить, как заживает", isOn: $draft.followUps.asksHealing.animation(.snappy))
            if draft.followUps.asksHealing {
                Stepper(value: $draft.followUps.healingDays, in: ServiceFollowUpLimits.healingDays) {
                    LabeledContent("Через", value: ServiceFollowUpText.days(draft.followUps.healingDays))
                }
            }
            if draft.followUps.showsJewelryChange(for: draft.category) {
                Toggle("Напомнить о замене украшения", isOn: $draft.followUps.remindsJewelryChange.animation(.snappy))
                if draft.followUps.remindsJewelryChange {
                    Stepper(value: $draft.followUps.jewelryWeeks, in: ServiceFollowUpLimits.jewelryWeeks) {
                        LabeledContent("Через", value: ServiceFollowUpText.weeks(draft.followUps.jewelryWeeks))
                    }
                }
            }
        } header: {
            Text("После визита")
        } footer: {
            Text(draft.followUps.hint)
        }
    }

    private var visibilitySection: some View {
        Section {
            Toggle("Активна", isOn: $draft.active)
            Stepper(value: $draft.sort, in: 0...999) {
                LabeledContent("Порядок в списке", value: "\(draft.sort)")
            }
        } footer: {
            Text("Скрытые услуги не показываются при записи, в кассе и боту.")
        }
    }

    /// Why «Сохранить» is disabled when the reason is a field the user already touched or cannot see.
    @ViewBuilder
    private var saveBlockerBanner: some View {
        if let message = draft.validationMessage, draft.nameMessage == nil {
            Label(message, systemImage: "exclamationmark.circle")
                .font(.footnote.weight(.medium))
                .foregroundStyle(.red)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassEffect(.regular, in: .rect(cornerRadius: 16))
                .padding(.horizontal, 16)
                .padding(.bottom, 4)
                .accessibilityLabel("Нельзя сохранить: \(message)")
        }
    }

    // MARK: - Data

    private func loadStock() async {
        await stock.load { try await api.serviceLinkProducts() }
    }

    private func save() {
        let body = draft.body
        let createsGroup = draft.group.nonEmpty.map { !groupOptions(for: draft.category).contains($0) } ?? false
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                let saved = if let service {
                    try await api.updateService(id: service.id, body)
                } else {
                    try await api.createService(body)
                }
                onSaved(saved)
                dismiss()
                // A new group name created a warehouse category on the server; a moved service changed the counts.
                if createsGroup || saved.group != service?.group { try? await reference.ensureCategories(force: true) }
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}

/// Duration stepper on the 15-minute grid that keeps an off-grid value (10 min, 13 h 20 min) as it is.
struct ServiceDurationStepper: View {
    let title: String
    @Binding var minutes: Int

    var body: some View {
        Stepper(
            label: { LabeledContent(title, value: DateText.duration(minutes: minutes)) },
            onIncrement: step(up: true),
            onDecrement: step(up: false)
        )
        .accessibilityValue(DateText.duration(minutes: minutes))
    }

    /// `nil` disables the button at the bounds.
    private func step(up: Bool) -> (() -> Void)? {
        guard ServiceLimits.canStepDuration(minutes, up: up) else { return nil }
        return { minutes = ServiceLimits.steppedDuration(minutes, up: up) }
    }
}

#if DEBUG
#Preview("Редактирование") {
    var nipple = PreviewData.nipple
    nipple.jewelryIds = [1, 2]
    nipple.consumables = [ServiceConsumable(productId: 3, quantity: 2)]
    return ServiceEditorView(service: nipple, nextSort: 3, groupSuggestions: [.piercing: ["Лицо", "Тело", "Ухо"]]) { _ in }
        .previewEnvironment()
}

#Preview("Новая") {
    ServiceEditorView(service: nil, nextSort: 3) { _ in }
        .previewEnvironment()
}
#endif
