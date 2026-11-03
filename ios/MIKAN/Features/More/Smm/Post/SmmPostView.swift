import SwiftUI

/// A post of the selected profile (Titan `post.tsx`): how it will look on the platform, its text and script, what
/// is happening with it now and the next step. A remark at the bottom — the marketer redoes the text, the picture or
/// the time and answers in the thread.
struct SmmPostView: View {
    @Environment(SmmProfileStore.self) private var store
    let postId: String

    var body: some View {
        SmmPostScreen(postId: postId, profile: store.profile)
            .id(store.profile)
    }
}

private enum SmmPostSheet: String, Identifiable {
    case text
    case reschedule

    var id: String { rawValue }
}

private struct SmmPostScreen: View {
    @Environment(APIClient.self) private var api
    @Environment(ReferenceStore.self) private var reference
    @Environment(\.dismiss) private var dismiss

    @State private var model: SmmPostModel
    @State private var sheet: SmmPostSheet?
    @State private var confirmsDelete = false
    @State private var remark = ""

    init(postId: String, profile: SmmProfile) {
        _model = State(initialValue: SmmPostModel(postId: postId, profile: profile))
    }

    private var timeZone: TimeZone { reference.workday.timeZone }

    var body: some View {
        List {
            if let payload = model.payload.value {
                content(payload)
            }
        }
        .overlay { RemoteStateOverlay(remote: model.payload) { await model.load(api) } }
        .safeAreaBar(edge: .bottom) {
            if let post = model.post {
                composer(post)
            }
        }
        .auraBackground()
        .navigationTitle(model.post?.format.title ?? "Публикация")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let post = model.post {
                ToolbarItem(placement: .topBarTrailing) { menu(post) }
            }
        }
        .refreshable { await model.load(api) }
        .task { await model.load(api) }
        .task(id: model.isWorking) { await model.pollWhileWorking(api) }
        .sheet(item: $sheet) { sheet in sheetContent(sheet) }
        .confirmationDialog("Удалить публикацию?", isPresented: $confirmsDelete, titleVisibility: .visible) {
            Button("Удалить", role: .destructive) { Task { await model.delete(api) } }
            Button("Отмена", role: .cancel) {}
        } message: {
            Text("Тема исчезнет из плана.")
        }
        .onChange(of: model.isDeleted) { _, deleted in
            if deleted { dismiss() }
        }
        .sensoryFeedback(.success, trigger: model.successCount)
        .remoteErrorAlert(model.payload)
        .errorAlert(Binding(get: { model.errorMessage }, set: { model.errorMessage = $0 }), title: model.errorTitle)
    }

    @ViewBuilder
    private func content(_ payload: SmmPostPayload) -> some View {
        let post = payload.post
        if post.isWorking || (post.error.nonEmpty != nil && post.busy == nil) {
            Section {
                if post.isWorking {
                    SmmProgressBanner(progress: model.progress, text: post.busy?.text)
                }
                if let error = post.error.nonEmpty, post.busy == nil {
                    SmmErrorBanner(text: error)
                }
            }
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
        }
        SmmPostHeader(post: post, direction: model.meta?.direction(post.direction)?.title, timeZone: timeZone)
        SmmPostMediaSection(model: model, post: post)
        SmmPostBodySection(post: post) { sheet = .text }
        if let script = post.script {
            SmmPostScriptSection(script: script, isStory: post.format == .story)
        }
        SmmPostIdeaSection(post: post)
        SmmPostResultSection(post: post)
        SmmPostNextStep(model: model, post: post, canApprove: payload.canApprove, timeZone: timeZone)
        Section("Замечания маркетологу") {
            if payload.comments.isEmpty {
                Text(post.status == .idea
                     ? "Напишите внизу, что учесть в посте, — маркетолог учтёт, когда будет писать."
                     : "Напишите внизу, что поправить: текст, картинку, время — маркетолог переделает и ответит здесь.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                SmmThread(comments: payload.comments)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            }
        }
    }

    private func composer(_ post: SmmPost) -> some View {
        ChatComposer(
            text: $remark,
            placeholder: post.status == .idea ? "Что учесть в посте?" : "Что поправить? Текст, картинку, время…",
            isSending: model.acting == .remark
        ) {
            let text = remark
            guard text.trimmed.count >= 2 else { return }
            Task {
                if await model.remark(text, api: api) { remark = "" }
            }
        }
        .disabled(model.isBusy || (model.acting != nil && model.acting != .remark))
    }

    @ViewBuilder
    private func menu(_ post: SmmPost) -> some View {
        let isPublished = post.status == .published
        Menu {
            if !isPublished, !model.isBusy {
                Button("Изменить текст", systemImage: "pencil") { sheet = .text }
            }
            if !isPublished {
                Button("Перенести", systemImage: "calendar") { sheet = .reschedule }
            }
            if !isPublished, !model.isBusy {
                Button("Написать заново", systemImage: "arrow.clockwise") { Task { await model.write(api) } }
            }
            if post.status == .skipped || post.status == .failed {
                Button("Вернуть в работу", systemImage: "arrow.uturn.backward") { Task { await model.restore(api) } }
            } else if !isPublished {
                Button("Не выкладывать", systemImage: "nosign") { Task { await model.skip(api) } }
            }
            if !isPublished {
                Divider()
                Button("Удалить", systemImage: "trash", role: .destructive) { confirmsDelete = true }
            }
            if let url = post.publishedUrl.flatMap(URL.init(string:)) {
                Link(destination: url) { Label("Открыть публикацию", systemImage: "safari") }
            }
        } label: {
            Label("Ещё", systemImage: "ellipsis")
        }
        .disabled(model.acting != nil)
    }

    @ViewBuilder
    private func sheetContent(_ sheet: SmmPostSheet) -> some View {
        if let post = model.post {
            switch sheet {
            case .text:
                SmmTextEditorSheet(
                    title: "Текст публикации",
                    text: post.body,
                    hint: Self.textHint(post),
                    allowsEmpty: false
                ) { text in
                    try await model.saveText(text, api: api)
                }
            case .reschedule:
                SmmRescheduleSheet(publishAt: post.publishAt, timeZone: timeZone) { date, time in
                    try await model.reschedule(date: date, time: time, api: api)
                }
            }
        }
    }

    private static func textHint(_ post: SmmPost) -> String {
        let remark = "Хотите, чтобы переписал маркетолог, — оставьте замечание в публикации."
        if post.platform == .telegram {
            return "Можно выделять: <b>жирный</b>, <i>курсив</i>, <a href=\"https://…\">ссылка</a>. \(remark)"
        }
        return "Простой текст, хэштеги — в конце, не больше пяти. \(remark)"
    }
}

/// A red notice of what went wrong with the post.
struct SmmErrorBanner: View {
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
            Text(text)
                .font(.subheadline)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
        }
        .padding(12)
        .background(Color.red.opacity(0.12), in: .rect(cornerRadius: 14))
        .accessibilityElement(children: .combine)
    }
}
