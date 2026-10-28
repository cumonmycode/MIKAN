import SwiftUI

/// Merging cards of one person: which card stays, what it gets, then a confirmation of what moves and what disappears.
/// The host closes it on `onMerged`; `onCancel` adds «Отмена» (when it is the root of a sheet).
struct ClientMergeView: View {
    @Environment(APIClient.self) private var api
    let onMerged: (ClientMergeOutcome) -> Void
    var onCancel: (() -> Void)?

    @State private var cards: [Client]
    @State private var keptId: Int
    @State private var selected: Set<Int>
    /// Staff picked the card to keep: loading stats no longer changes it.
    @State private var keptChosen = false
    @State private var confirms = false
    @State private var isMerging = false
    @State private var errorMessage: String?

    init(cards: [Client], onMerged: @escaping (ClientMergeOutcome) -> Void, onCancel: (() -> Void)? = nil) {
        let keptId = ClientMergeDefaults.kept(among: cards)?.id ?? cards.first?.id ?? 0
        _cards = State(initialValue: cards)
        _keptId = State(initialValue: keptId)
        _selected = State(initialValue: ClientMergeDefaults.selected(in: cards, keptId: keptId))
        self.onMerged = onMerged
        self.onCancel = onCancel
    }

    private var plan: ClientMergePlan? {
        guard let kept = cards.first(where: { $0.id == keptId }) else { return nil }
        return ClientMergePlan(kept: kept, sources: cards.filter { selected.contains($0.id) && $0.id != keptId })
    }

    var body: some View {
        Form {
            Section {
                ForEach(cards) { card in keptRow(card) }
            } header: {
                Text("Какую карточку оставить")
            } footer: {
                Text("Остальные карточки исчезнут, их визиты, покупки и переписка перейдут в эту.")
            }
            if cards.count > 2 {
                Section {
                    ForEach(cards.filter { $0.id != keptId }) { card in
                        Toggle(isOn: selection(of: card.id)) { ClientMergeCardLabel(client: card) }
                    }
                } header: {
                    Text("Объединить с ней")
                } footer: {
                    Text("Отметьте карточки этого же человека.")
                }
            }
            if let plan, !plan.sources.isEmpty {
                ClientMergePreviewSections(plan: plan)
            }
        }
        .navigationTitle("Объединение")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let onCancel {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена", role: .cancel, action: onCancel).disabled(isMerging)
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                if isMerging {
                    ProgressView()
                } else {
                    Button("Объединить") { confirms = true }
                        .disabled(plan?.sources.isEmpty ?? true)
                }
            }
        }
        .confirmationDialog("Объединить карточки?", isPresented: $confirms, titleVisibility: .visible) {
            Button("Объединить", role: .destructive, action: merge)
            Button("Отмена", role: .cancel) {}
        } message: {
            Text(plan?.confirmationMessage ?? "")
        }
        .errorAlert($errorMessage, title: "Карточки не объединены")
        .disabled(isMerging)
        .navigationBarBackButtonHidden(isMerging)
        .interactiveDismissDisabled(isMerging)
        .task { await loadMissingStats() }
    }

    private func keptRow(_ card: Client) -> some View {
        Button {
            keptId = card.id
            keptChosen = true
            selected = cards.count == 2 ? ClientMergeDefaults.selected(in: cards, keptId: card.id) : selected.subtracting([card.id])
        } label: {
            HStack(spacing: 12) {
                ClientMergeCardLabel(client: card)
                Spacer(minLength: 8)
                Image(systemName: card.id == keptId ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(card.id == keptId ? Color.accentColor : Color.secondary)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(card.id == keptId ? .isSelected : [])
    }

    private func selection(of id: Int) -> Binding<Bool> {
        Binding(
            get: { selected.contains(id) },
            set: { isOn in selected = isOn ? selected.union([id]) : selected.subtracting([id]) }
        )
    }

    /// Cards from a search come without stats: the preview, the confirmation and the default card to keep need them.
    private func loadMissingStats() async {
        var loaded = false
        for card in cards where card.stats == nil {
            do {
                let full = try await api.client(id: card.id)
                cards = cards.map { $0.id == full.id ? full : $0 }
                loaded = true
            } catch is CancellationError {
                return
            } catch {
                errorMessage = error.userMessage
            }
        }
        guard loaded, !keptChosen, let best = ClientMergeDefaults.kept(among: cards) else { return }
        keptId = best.id
        selected = ClientMergeDefaults.selected(in: cards, keptId: best.id)
    }

    /// One merge per card into the kept one; when a later one fails, what was merged is reported with the reason.
    private func merge() {
        guard let plan else { return }
        let keptId = plan.kept.id
        isMerging = true
        Task {
            defer { isMerging = false }
            var kept: Client?
            var removed: [Int] = []
            for source in plan.sources {
                do {
                    kept = try await api.mergeClient(id: source.id, into: keptId)
                    removed.append(source.id)
                } catch {
                    guard let kept else {
                        errorMessage = error.userMessage
                        return
                    }
                    onMerged(ClientMergeOutcome(kept: kept, removedIds: removed, failure: error.userMessage))
                    return
                }
            }
            if let kept { onMerged(ClientMergeOutcome(kept: kept, removedIds: removed, failure: nil)) }
        }
    }
}

/// A card in the merge: name, phone and its history in one line.
struct ClientMergeCardLabel: View {
    let client: Client

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(client.fullName)
                .font(.body.weight(.medium))
                .foregroundStyle(.primary)
            Text(subtitle)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .monospacedDigit()
        }
    }

    private var subtitle: String {
        let phone = client.phone.nonEmpty.map(PhoneText.display) ?? "Без телефона"
        guard let stats = client.stats else { return phone }
        let visits = Plural.count(stats.visits, one: "визит", few: "визита", many: "визитов")
        return "\(phone) · \(visits) · \(Money.format(stats.totalSpent))"
    }
}

/// «Карточка после объединения», «Не перенесутся» and «Перейдёт в карточку».
private struct ClientMergePreviewSections: View {
    let plan: ClientMergePlan

    var body: some View {
        Section("Карточка после объединения") {
            ForEach(plan.lines) { line in
                VStack(alignment: .leading, spacing: 2) {
                    Text(line.field.title)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(line.value)
                    if let caption = line.origin.caption {
                        Label(caption, systemImage: "arrow.turn.down.right")
                            .font(.caption)
                            .foregroundStyle(Color.accentColor)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
        if !plan.losses.isEmpty {
            Section {
                ForEach(plan.losses) { loss in
                    LabeledContent(loss.field.title) {
                        VStack(alignment: .trailing, spacing: 2) {
                            Text(loss.value)
                            Text("из «\(loss.from)»").font(.caption)
                        }
                    }
                }
            } header: {
                Text("Не перенесутся")
            } footer: {
                Text("В оставленной карточке уже есть свои значения. При необходимости поправьте их после объединения.")
            }
        }
        if let moved = plan.movedSummary {
            Section("Перейдёт в карточку") {
                Label(moved, systemImage: "tray.and.arrow.down")
            }
        }
    }
}
