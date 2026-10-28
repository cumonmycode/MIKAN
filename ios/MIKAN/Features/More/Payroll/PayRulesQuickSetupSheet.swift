import SwiftUI

/// «Быстрая настройка»: the master's share of the service revenue (the «60 на 40» of a studio), the share of goods and
/// consumables for several employees at once, from a chosen day. Each selected employee gets a new rules version.
struct PayRulesQuickSetupSheet: View {
    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss

    let rows: [PayRulesOverviewRow]
    let onSaved: () -> Void

    @State private var setup: PayRulesQuickSetup
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(rows: [PayRulesOverviewRow], onSaved: @escaping () -> Void) {
        self.rows = rows
        self.onSaved = onSaved
        _setup = State(initialValue: PayRulesQuickSetup(rows: rows))
    }

    var body: some View {
        NavigationStack {
            Form {
                shareSection
                goodsSection
                dateSection
                peopleSection
            }
            .navigationTitle("Быстрая настройка")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена", role: .cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Сохранить", action: save).disabled(setup.problem != nil)
                    }
                }
            }
            .interactiveDismissDisabled(isSaving)
            .errorAlert($errorMessage)
        }
    }

    private var shareSection: some View {
        Section {
            Picker("Доля мастера", selection: $setup.masterShare) {
                ForEach(presets, id: \.self) { share in
                    Text("\(share) %").tag(share)
                }
            }
            .pickerStyle(.segmented)
            Stepper(value: $setup.masterShare, in: 0...100) {
                Text(setup.shareText).monospacedDigit()
            }
        } header: {
            Text("Доля мастера с услуг")
        } footer: {
            Text("«60 на 40» обычно значит: студии 60 %, мастеру 40 % — тогда выберите 40. Если мастеру 60 % — выберите 60.")
        }
    }

    /// The presets, plus the current value when it is not one of them (so the segmented picker always shows it).
    private var presets: [Int] {
        PayRulesQuickSetup.presets.contains(setup.masterShare)
            ? PayRulesQuickSetup.presets
            : (PayRulesQuickSetup.presets + [setup.masterShare]).sorted()
    }

    private var goodsSection: some View {
        Section {
            Stepper(value: $setup.productPercent, in: 0...100, step: 5) {
                Text("С украшений и товаров: \(setup.productPercent) %").monospacedDigit()
            }
            Toggle("Сначала вычитать расходники", isOn: $setup.deductMaterials)
        } footer: {
            Text("Расходники — стоимость материалов, списанных на визит. Если включено, процент считается с выручки за услугу минус материалы.")
        }
    }

    private var dateSection: some View {
        Section {
            DatePicker("Действует с", selection: $setup.effectiveFrom, displayedComponents: .date)
        } footer: {
            Text("Зарплата пересчитается за всё время с этого дня. С 1-го числа — и текущий месяц посчитается по новой схеме.")
        }
    }

    private var peopleSection: some View {
        Section {
            ForEach(rows) { row in
                Button {
                    toggle(row.id)
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(row.employee.name).foregroundStyle(.primary)
                            Text(row.rules.map(PayrollText.rulesSummary) ?? "Правила не заданы")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: setup.selected.contains(row.id) ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(setup.selected.contains(row.id) ? Color.accentColor : Color.secondary)
                            .font(.title3)
                    }
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(setup.selected.contains(row.id) ? .isSelected : [])
            }
        } header: {
            Text("Кому применить")
        } footer: {
            Text("Оклад и оплата за рабочий день у выбранных сохранятся. Отдельные проценты для тату, пирсинга и других услуг сбросятся — их можно задать в правилах сотрудника.")
        }
    }

    private func toggle(_ id: Int) {
        if setup.selected.contains(id) {
            setup.selected.remove(id)
        } else {
            setup.selected.insert(id)
        }
    }

    private func save() {
        guard setup.problem == nil else { return }
        isSaving = true
        let chosen = rows.filter { setup.selected.contains($0.id) }
        let setup = setup
        Task {
            var failed: [String] = []
            for row in chosen {
                do {
                    _ = try await api.savePayRules(employeeId: row.employee.id, setup.body(for: row))
                } catch {
                    failed.append(row.employee.name)
                }
            }
            isSaving = false
            onSaved()
            if failed.isEmpty {
                dismiss()
            } else {
                errorMessage = "Не сохранилось для: \(failed.joined(separator: ", ")). Проверьте связь и попробуйте ещё раз."
            }
        }
    }
}
