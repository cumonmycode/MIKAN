import SwiftUI

// Pieces of «Настройки» of an SMM profile: the long texts opened in the editor and the approvers picker.

/// A long text of the settings, edited in `SmmTextEditorSheet` (Titan `edit-text.tsx`, `field`).
nonisolated enum SmmSettingsTextField: String, Identifiable, CaseIterable, Sendable {
    case voice
    case audience
    case goals
    case directions

    var id: String { rawValue }

    var title: String {
        switch self {
        case .voice: "Голос и тон"
        case .audience: "Аудитория"
        case .goals: "Цели"
        case .directions: "Направления"
        }
    }

    var symbol: String {
        switch self {
        case .voice: "quote.bubble.fill"
        case .audience: "person.3.fill"
        case .goals: "target"
        case .directions: "list.bullet.rectangle.fill"
        }
    }

    var tint: Color {
        switch self {
        case .voice: .purple
        case .audience: .blue
        case .goals: .orange
        case .directions: .teal
        }
    }

    /// Limits of `server/src/smm/settings.ts`.
    var maxLength: Int {
        switch self {
        case .voice, .audience, .goals: 1500
        case .directions: 2000
        }
    }

    func value(in settings: SmmSettings) -> String {
        switch self {
        case .voice: settings.voice
        case .audience: settings.audience
        case .goals: settings.goals
        case .directions: settings.directions
        }
    }

    func patch(_ text: String) -> SmmSettingsPatch {
        switch self {
        case .voice: SmmSettingsPatch(voice: text)
        case .audience: SmmSettingsPatch(audience: text)
        case .goals: SmmSettingsPatch(goals: text)
        case .directions: SmmSettingsPatch(directions: text)
        }
    }

    /// What to write, for the studio or for the author (`brand` — the profile's brand name).
    func hint(for profile: SmmProfile, brand: String) -> String {
        switch (self, profile) {
        case (.voice, .studio):
            "Как маркетолог пишет от имени студии: тон, обращение на «вы» или «ты», юмор, чего избегать."
        case (.voice, _):
            "Как маркетолог пишет от имени \(brand): от первого лица, тон, обращение к подписчикам, юмор, чего избегать."
        case (.audience, .studio):
            "Для кого пишем: возраст, интересы, кто приходит за первой татуировкой или проколом, кто выбирает украшения."
        case (.audience, _):
            "Для кого пишет \(brand): кто её подписчики и что им интересно."
        case (.goals, .studio):
            "Чего добиваемся соцсетями: записи на тату и пирсинг, продажи украшений, доверие к студии, узнаваемость."
        case (.goals, _):
            "Чего \(brand) хочет от своих соцсетей: личный бренд, сообщество, интерес к её работам."
        case (.directions, _):
            "О чём пишет профиль — по направлению на строку. Каждое направление маркетолог ставит в план месяца."
        }
    }

    /// The row's subtitle: the text itself, for directions — how many there are.
    func summary(of settings: SmmSettings) -> String {
        let text = value(in: settings).trimmed
        guard !text.isEmpty else { return "Не заполнено" }
        guard self == .directions else { return text }
        let lines = text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        return lines.joined(separator: " · ")
    }
}

/// Row of a long settings text: a colored symbol, the title and the text's first lines.
struct SmmSettingsTextRow: View {
    let field: SmmSettingsTextField
    let summary: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: field.symbol)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(width: 28, height: 28)
                    .background(field.tint, in: .rect(cornerRadius: 7))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(field.title)
                        .foregroundStyle(.primary)
                    Text(summary)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Открывает редактор")
    }
}

/// Who approves posts of the profile: several employees, each with or without a private chat with the bot.
struct SmmApproversView: View {
    let profile: SmmProfile
    let brand: String
    let people: [SmmPerson]
    @Binding var selection: [Int]

    /// `server/src/smm/settings.ts`: at most 20 approvers.
    static let maxApprovers = 20

    var body: some View {
        List {
            Section {
                ForEach(people) { person in
                    row(person)
                }
            } footer: {
                Text(footer)
            }
            if !selection.isEmpty {
                Section {
                    Button("Снять выбор", role: .destructive) { selection = [] }
                }
            }
        }
        .overlay {
            if people.isEmpty {
                ContentUnavailableView(
                    "Нет сотрудников",
                    systemImage: "person.2.slash",
                    description: Text("Добавьте сотрудников в разделе «Сотрудники».")
                )
            }
        }
        .auraBackground()
        .navigationTitle("Кто одобряет")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func row(_ person: SmmPerson) -> some View {
        let isSelected = selection.contains(person.id)
        return Button {
            toggle(person)
        } label: {
            HStack(spacing: 12) {
                InitialsAvatar(name: person.name, size: 34)
                VStack(alignment: .leading, spacing: 2) {
                    Text(person.name)
                        .foregroundStyle(.primary)
                    if person.telegram {
                        Text("Telegram привязан")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        Text("Telegram не привязан — превью не придут")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if person.telegram {
                    TelegramBadge()
                }
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(isSelected ? Color.accentColor : Color.secondary)
                    .accessibilityHidden(true)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(!isSelected && selection.count >= Self.maxApprovers)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private var footer: String {
        switch profile {
        case .studio:
            "Им маркетолог присылает превью в Telegram с кнопками «Одобрить», «Поправить», «Не выкладывать». "
                + "Никого не выбрали — превью получают все сотрудники, связанные с ботом."
        case .author:
            "Выберите себя — \(brand). Это личный профиль: пока никто не выбран, превью на одобрение никому не приходят, "
                + "сотрудникам студии они не рассылаются."
        }
    }

    private func toggle(_ person: SmmPerson) {
        if selection.contains(person.id) {
            selection = selection.filter { $0 != person.id }
        } else if selection.count < Self.maxApprovers {
            selection = selection + [person.id]
        }
    }
}
