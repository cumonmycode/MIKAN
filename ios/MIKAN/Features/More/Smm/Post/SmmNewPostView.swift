import SwiftUI

/// «Новая публикация» outside the plan, or an idea taken from «Идеи» (Titan `new.tsx`): platform, format, when and
/// what about. By default the marketer writes the text and draws right away. Once created, the screen turns into
/// the post itself (Titan `router.replace`), so «Back» leads where the form was opened from.
struct SmmNewPostView: View {
    let draft: SmmPostDraft
    @State private var createdId: String?

    var body: some View {
        if let createdId {
            SmmPostView(postId: createdId)
        } else {
            SmmNewPostForm(draft: draft) { createdId = $0 }
        }
    }
}

private struct SmmNewPostForm: View {
    @Environment(APIClient.self) private var api
    @Environment(SmmProfileStore.self) private var store
    @Environment(ReferenceStore.self) private var reference

    let onCreated: (String) -> Void

    @State private var platform: SmmPlatform
    @State private var format: SmmFormat
    @State private var when: Date?
    @State private var topic: String
    @State private var brief: String
    @State private var direction: String
    @State private var writesNow = true
    @State private var directions: [SmmDirection] = []
    @State private var isSaving = false
    @State private var errorMessage: String?

    private let draftDay: String?

    static let maxTopic = 160
    static let maxBrief = 800
    static let minTopic = 2

    init(draft: SmmPostDraft, onCreated: @escaping (String) -> Void) {
        self.onCreated = onCreated
        draftDay = draft.date
        _platform = State(initialValue: draft.platform == .unknown ? .telegram : draft.platform)
        _format = State(initialValue: draft.format == .unknown ? .post : draft.format)
        _topic = State(initialValue: draft.topic)
        _brief = State(initialValue: draft.brief)
        _direction = State(initialValue: draft.direction ?? "")
    }

    private var timeZone: TimeZone { reference.workday.timeZone }

    private var whenBinding: Binding<Date> {
        Binding(
            get: { when ?? SmmClock.publishDate(day: draftDay, in: timeZone) },
            set: { when = $0 }
        )
    }

    private var canSave: Bool { topic.trimmed.count >= Self.minTopic && !isSaving }

    var body: some View {
        Form {
            Section("Где и в каком виде") {
                Picker("Площадка", selection: $platform) {
                    ForEach(SmmPlatform.choices, id: \.self) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                Picker("Формат", selection: $format) {
                    ForEach(SmmFormat.choices, id: \.self) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                DatePicker("Выход", selection: whenBinding, in: Date.now..., displayedComponents: [.date, .hourAndMinute])
                    .environment(\.timeZone, timeZone)
            }
            Section {
                TextField(topicPlaceholder, text: $topic)
                    .onChange(of: topic) { _, value in
                        if value.count > Self.maxTopic { topic = String(value.prefix(Self.maxTopic)) }
                    }
                TextField("Идея и детали (необязательно)", text: $brief, axis: .vertical)
                    .lineLimit(3...8)
                    .onChange(of: brief) { _, value in
                        if value.count > Self.maxBrief { brief = String(value.prefix(Self.maxBrief)) }
                    }
                Picker("Направление", selection: $direction) {
                    Text("Не важно").tag("")
                    ForEach(directions) { Text($0.title).tag($0.key) }
                    if !direction.isEmpty, !directions.contains(where: { $0.key == direction }) {
                        Text(direction).tag(direction)
                    }
                }
                .pickerStyle(.menu)
            } header: {
                Text("О чём")
            } footer: {
                Text("Тема — коротко. В идее — что важно сказать, повод, цифры: маркетолог опирается на это и на \(factsSource).")
            }
            Section {
                Toggle("Маркетолог пишет сразу", isOn: $writesNow)
            } footer: {
                Text("Иначе маркетолог напишет сам заранее — за сутки до выхода (рилс — за трое).")
            }
        }
        .auraBackground()
        .navigationTitle("Публикация")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(isSaving)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                if isSaving {
                    ProgressView()
                } else {
                    Button("Создать", action: save)
                        .disabled(!canSave)
                }
            }
        }
        .task { await loadDirections() }
        .errorAlert($errorMessage, title: "Не создалось")
    }

    private var topicPlaceholder: String {
        store.profile == .studio ? "Тема, например «Свободные окна на выходных»" : "Тема, например «Мой новый эскиз»"
    }

    private var factsSource: String {
        store.profile == .studio ? "данные студии" : "портрет из базы знаний"
    }

    private func loadDirections() async {
        do {
            directions = try await api.smmMeta(store.profile).directions
        } catch is CancellationError {
            return
        } catch {
            // The picker keeps «Не важно»; the post is created without a direction.
            directions = []
        }
    }

    private func save() {
        let moment = whenBinding.wrappedValue
        let body = SmmNewPostBody(
            platform: platform,
            format: format,
            date: SmmText.dayKey(of: moment, in: timeZone),
            time: SmmText.timeKey(of: moment, in: timeZone),
            topic: topic.trimmed,
            brief: brief.nonEmpty,
            direction: direction.nonEmpty,
            write: writesNow
        )
        let profile = store.profile
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                let post = try await api.createSmmPost(profile, body)
                onCreated(post.id)
            } catch is CancellationError {
                return
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}
