import SwiftUI

/// Campaign editor: who gets the message. Every condition that is on must hold.
struct CampaignSegmentSections: View {
    @Binding var segment: CampaignSegmentDraft
    let masters: [Employee]
    /// Why the masters could not be loaded, shown under their list.
    var mastersFailure: String?

    var body: some View {
        Section {
            Toggle("Ещё не были у нас", isOn: $segment.neverVisited.animation())
            if segment.allowsVisitConditions {
                Toggle("По последнему визиту", isOn: $segment.usesLastVisit.animation())
                if segment.usesLastVisit {
                    lastVisitRows
                }
                Toggle("Постоянные клиенты", isOn: $segment.usesMinVisits.animation())
                if segment.usesMinVisits {
                    Stepper(value: $segment.minVisits, in: CampaignSegmentDraft.visitsRange) {
                        Text("Визитов: от \(segment.minVisits)").monospacedDigit()
                    }
                }
            }
        } header: {
            Text("Кому отправить")
        } footer: {
            if let issue = segment.issue {
                Text(issue).foregroundStyle(.red)
            } else if segment.neverVisited {
                Text("Клиенты, у которых ещё не было ни одного завершённого визита.")
            } else {
                Text("Без условий сообщение получат все клиенты с подключённым Telegram, которые не отказались от новостей.")
            }
        }
        if segment.allowsVisitConditions {
            categoriesSection
            mastersSection
        }
        Section {
            Picker("День рождения", selection: $segment.birthdayMonth) {
                Text("Любой месяц").tag(Int?.none)
                ForEach(1...CampaignSegmentText.months.count, id: \.self) { month in
                    Text(CampaignSegmentText.month(month)).tag(Int?.some(month))
                }
            }
            Toggle("Есть бонусы на счёте", isOn: $segment.hasBonuses)
            Toggle("Новые клиенты", isOn: $segment.usesCreatedWithin.animation())
            if segment.usesCreatedWithin {
                Stepper(value: $segment.createdWithinDays, in: CampaignSegmentDraft.newDaysRange) {
                    Text("Карточка создана за \(Plural.days(segment.createdWithinDays))").monospacedDigit()
                }
            }
        } header: {
            Text("Ещё условия")
        }
    }

    @ViewBuilder
    private var lastVisitRows: some View {
        Stepper(value: $segment.lastVisitMin, in: CampaignSegmentDraft.minMonthsRange) {
            Text(segment.lastVisitMin == 0 ? "Не меньше: без ограничения" : "Не меньше \(Self.monthsAgo(segment.lastVisitMin)) назад")
                .monospacedDigit()
        }
        Toggle("И не дольше чем…", isOn: $segment.lastVisitHasMax.animation())
        if segment.lastVisitHasMax {
            Stepper(value: $segment.lastVisitMax, in: CampaignSegmentDraft.maxMonthsRange) {
                Text("Не больше \(Self.monthsAgo(segment.lastVisitMax)) назад").monospacedDigit()
            }
        }
    }

    private var categoriesSection: some View {
        Section {
            ForEach(ServiceCategory.allCases) { category in
                Toggle(isOn: membership(category, in: \.categories)) {
                    Label(category.title, systemImage: category.symbol)
                }
            }
        } header: {
            Text("Были на услугах")
        } footer: {
            Text("Ничего не выбрано — любые услуги.")
        }
    }

    private var mastersSection: some View {
        Section {
            ForEach(masters) { master in
                Toggle(isOn: membership(master.id, in: \.masterIds)) {
                    HStack(spacing: 10) {
                        InitialsAvatar(name: master.name, color: .master(master.color), size: 28)
                        Text(master.name)
                    }
                }
            }
        } header: {
            Text("У мастеров")
        } footer: {
            if let mastersFailure {
                Text(mastersFailure).foregroundStyle(.red)
            } else {
                Text("Ничего не выбрано — у любого мастера.")
            }
        }
    }

    private func membership<Value: Hashable>(_ value: Value, in keyPath: WritableKeyPath<CampaignSegmentDraft, Set<Value>>) -> Binding<Bool> {
        Binding {
            segment[keyPath: keyPath].contains(value)
        } set: { isOn in
            var updated = segment[keyPath: keyPath]
            if isOn { updated.insert(value) } else { updated.remove(value) }
            segment[keyPath: keyPath] = updated
        }
    }

    /// «3 месяцев», «1 месяца» — genitive after «не меньше / не больше».
    private static func monthsAgo(_ count: Int) -> String {
        "\(count) " + Plural.word(count, one: "месяца", few: "месяцев", many: "месяцев")
    }
}

/// Campaign editor: how many clients the segment reaches now and a few of them, asked again shortly after every change.
struct CampaignAudienceSection: View {
    @Environment(APIClient.self) private var api
    let segment: CampaignSegment
    @Binding var audience: CampaignAudience?

    @State private var isLoading = false
    @State private var failure: String?

    private static let debounce = Duration.milliseconds(500)

    var body: some View {
        Section {
            LabeledContent {
                if isLoading && audience == nil {
                    ProgressView()
                } else if let audience {
                    Text(CampaignPresentation.clients(audience.count))
                        .font(.headline)
                        .monospacedDigit()
                        .contentTransition(.numericText())
                        .opacity(isLoading ? 0.5 : 1)
                } else {
                    Text("—")
                }
            } label: {
                Label("Получат", systemImage: "person.2")
            }
            // On the row, not the Section: a Section hands its modifiers to every row.
            .task(id: segment) {
                // The first count comes at once; later ones wait until the conditions stop changing.
                if audience != nil {
                    do {
                        try await Task.sleep(for: Self.debounce)
                    } catch {
                        return
                    }
                }
                await load()
            }
            if let sample = audience?.sample, !sample.isEmpty {
                Text(sampleText(sample))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        } footer: {
            if let failure {
                Text(failure).foregroundStyle(.red)
            } else {
                Text("Только клиенты с подключённым Telegram, которые не отказались от новостей.")
            }
        }
    }

    private func sampleText(_ sample: [ClientRef]) -> String {
        let names = sample.map(\.fullName).joined(separator: ", ")
        let rest = (audience?.count ?? 0) - sample.count
        return rest > 0 ? "\(names) и ещё \(rest)" : names
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let result = try await api.campaignAudience(segment)
            withAnimation { audience = result }
            failure = nil
        } catch is CancellationError {
            return
        } catch {
            failure = error.userMessage
        }
    }
}
