import SwiftUI

/// «Новая поставка»: a supplier, the sizes received with their quantity and unit cost, a note — recorded in one go
/// (`POST /stock/deliveries` with an `Idempotency-Key`, so «Повторить» after a dropped connection never doubles it).
struct DeliveryEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(APIClient.self) private var api
    let onSaved: (StockDelivery) -> Void

    @State private var draft = DeliveryDraft()
    @State private var suppliers: [StockSupplier] = []
    @State private var showsPicker = false
    @State private var confirmsDiscard = false
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var retryMessage: String?
    @State private var deliveryKey = IdempotencyKey()

    var body: some View {
        NavigationStack {
            Form {
                supplierSection
                linesSection
                Section("Комментарий") {
                    TextField("Номер накладной, условия…", text: $draft.note, axis: .vertical)
                        .lineLimit(1...4)
                }
            }
            .navigationTitle("Новая поставка")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена", role: .cancel) {
                        if draft.isEmpty { dismiss() } else { confirmsDiscard = true }
                    }
                }
            }
            .safeAreaBar(edge: .bottom) {
                DeliveryTotalsBar(draft: draft, isSaving: isSaving, onSave: save)
            }
            .interactiveDismissDisabled(!draft.isEmpty || isSaving)
            .sheet(isPresented: $showsPicker) {
                DeliveryProductPicker(draft: $draft)
            }
            .confirmationDialog("Отменить поставку?", isPresented: $confirmsDiscard, titleVisibility: .visible) {
                Button("Отменить поставку", role: .destructive) { dismiss() }
                Button("Продолжить", role: .cancel) {}
            } message: {
                Text("Добавленные позиции не сохранятся.")
            }
            .errorAlert($errorMessage)
            .retryAlert($retryMessage, title: "Поставка могла пройти", retry: save)
            .task { await loadSuppliers() }
        }
    }

    // MARK: - Sections

    private var supplierSection: some View {
        Section {
            TextField("Название поставщика", text: $draft.supplier)
                .textInputAutocapitalization(.words)
            let suggestions = DeliverySupplierSuggestions.matching(suppliers, typed: draft.supplier)
            if !suggestions.isEmpty {
                InventoryFlowLayout(spacing: 8, lineSpacing: 8) {
                    ForEach(suggestions, id: \.self) { name in
                        Button(name) { draft.supplier = name }
                            .buttonStyle(.bordered)
                            .buttonBorderShape(.capsule)
                            .controlSize(.small)
                    }
                }
                .padding(.vertical, 4)
            }
        } header: {
            Text("Поставщик")
        } footer: {
            Text("Необязательно. Позиции без поставщика в карточке получат этого.")
        }
    }

    private var linesSection: some View {
        Section {
            ForEach(draft.lines) { line in
                DeliveryLineEditorRow(
                    line: line,
                    quantity: Binding(
                        get: { draft.line(variantId: line.id)?.quantity },
                        set: { draft = draft.settingQuantity($0, forLine: line.id) }
                    ),
                    unitCost: Binding(
                        get: { draft.line(variantId: line.id)?.unitCost },
                        set: { draft = draft.settingUnitCost($0, forLine: line.id) }
                    )
                )
            }
            .onDelete { offsets in
                withAnimation(.snappy) { draft = draft.removingLines(at: offsets) }
            }
            Button("Добавить позиции", systemImage: "plus.circle.fill") { showsPicker = true }
        } header: {
            Text("Позиции")
        } footer: {
            if let message = draft.validationMessage, !draft.isEmpty {
                Text(message).foregroundStyle(.red)
            } else {
                Text("Цена закупки подставлена из карточки — исправьте, если изменилась: она станет новой себестоимостью размера. Без цены себестоимость не меняется.")
            }
        }
    }

    // MARK: - Actions

    /// Suggestions only: without them the supplier is typed by hand.
    private func loadSuppliers() async {
        guard let loaded = try? await api.suppliers() else { return }
        suppliers = loaded
    }

    private func save() {
        guard draft.canSubmit else { return }
        let body = draft.body
        let key = deliveryKey.key(for: body)
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                let delivery = try await api.createDelivery(body, idempotencyKey: key)
                onSaved(delivery)
                dismiss()
            } catch let error as APIError where error.isOutcomeUnknown {
                retryMessage = "Связь прервалась до ответа сервера. Нажмите «Повторить» — если поставка уже проведена, второй раз она не проведётся."
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}

/// One size of the delivery: how many came and what one cost, with the line's sum.
private struct DeliveryLineEditorRow: View {
    let line: DeliveryDraftLine
    @Binding var quantity: Int?
    @Binding var unitCost: Int?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(line.productName).font(.body.weight(.medium))
                if let size = line.sizeName.nonEmpty {
                    StatusBadge(text: size, color: .secondary)
                }
                Spacer(minLength: 8)
                if let amount = line.amount {
                    MoneyText(amount).foregroundStyle(.secondary)
                }
            }
            Stepper(value: stepperValue, in: 1...DeliveryDraft.maxQuantity) {
                NumberField(title: "Количество", value: $quantity, suffix: line.unit, groupsDigits: false, placeholder: "0")
            }
            NumberField.optionalMoney("Цена за \(line.unit)", value: $unitCost)
        }
        .padding(.vertical, 2)
    }

    /// The stepper counts from 1; a cleared field steps up from there.
    private var stepperValue: Binding<Int> {
        Binding(get: { max(1, quantity ?? 1) }, set: { quantity = $0 })
    }
}

/// Under the form: «3 позиции · 14 шт · 12 400 ₽» and «Провести поставку».
private struct DeliveryTotalsBar: View {
    let draft: DeliveryDraft
    let isSaving: Bool
    let onSave: () -> Void

    var body: some View {
        VStack(spacing: 8) {
            if !draft.isEmpty {
                HStack {
                    Text(DeliveryText.summary(positions: draft.positions, units: draft.units, unit: draft.commonUnit))
                    Spacer(minLength: 8)
                    MoneyText(draft.total).fontWeight(.semibold)
                }
                .font(.subheadline)
                .monospacedDigit()
                .padding(.horizontal, 4)
                .accessibilityElement(children: .combine)
            }
            Button(action: onSave) {
                Group {
                    if isSaving {
                        ProgressView()
                    } else {
                        Text("Провести поставку").font(.headline)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 4)
            }
            .buttonStyle(.glassProminent)
            .controlSize(.large)
            .disabled(!draft.canSubmit || isSaving)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }
}

#if DEBUG
#Preview {
    DeliveryEditorView { _ in }
        .previewEnvironment()
}
#endif
