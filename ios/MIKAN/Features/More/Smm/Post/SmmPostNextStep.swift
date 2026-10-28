import SwiftUI

/// The next step by status — one main button and, when needed, a second (Titan `NextStep`).
struct SmmPostNextStep: View {
    @Environment(APIClient.self) private var api
    let model: SmmPostModel
    let post: SmmPost
    let canApprove: Bool
    let timeZone: TimeZone

    @State private var asksLink = false
    @State private var link = ""

    private var when: String { SmmText.when(post.publishAt, in: timeZone) }
    private var isAuto: Bool { post.autoPublishes }

    var body: some View {
        if !model.isBusy, post.status != .published, post.status != .unknown {
            Section {
                VStack(spacing: 10) {
                    steps
                }
                .frame(maxWidth: .infinity)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                .alert("Ссылка на публикацию", isPresented: $asksLink) {
                    TextField("https://…", text: $link)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Сохранить") { saveLink() }
                    Button("Отмена", role: .cancel) {}
                } message: {
                    Text("Скопируйте её в приложении соцсети: ⋯ → «Ссылка».")
                }
            }
        }
    }

    @ViewBuilder
    private var steps: some View {
        switch post.status {
        case .idea:
            note("Маркетолог подготовит пост заранее сам. Можно не ждать:")
            button("Маркетолог, напиши сейчас", systemImage: "sparkles", action: .write, prominent: true) {
                await model.write(api)
            }
        case .draft, .review:
            if canApprove {
                button("Одобрить", systemImage: "checkmark", action: .approve, prominent: true) { await model.approve(api) }
                note(isAuto ? "Выйдет в канал сам: \(when)" : "\(when) маркетолог пришлёт файлы и текст тому, кто выкладывает")
                publishButton(isAuto ? "Опубликовать сейчас" : "Передать сейчас", prominent: false)
            } else {
                note("Ждёт одобрения. Замечание можно оставить ниже.")
            }
        case .approved:
            approvedSteps
        case .skipped:
            note("Не выкладываем — публикация осталась в плане серой.")
            button("Вернуть в работу", systemImage: "arrow.uturn.backward", action: .restore, prominent: false) {
                await model.restore(api)
            }
        case .failed:
            publishButton(isAuto ? "Опубликовать ещё раз" : "Передать ещё раз", systemImage: "arrow.clockwise", prominent: true)
            if !isAuto {
                linkButton("Уже выложено — вставить ссылку", prominent: false)
            }
        case .published, .unknown:
            EmptyView()
        }
    }

    @ViewBuilder
    private var approvedSteps: some View {
        if isAuto {
            headline("✓ Одобрено — выйдет в канал сам: \(when)")
            publishButton("Опубликовать сейчас", prominent: false)
        } else if post.handoffAt == nil {
            let person = post.assigneeName.nonEmpty.map { " \($0)" } ?? ""
            headline("✓ Одобрено. \(when) маркетолог пришлёт файлы и текст\(person) в Telegram")
            if post.format == .reel, !post.media.contains(where: { $0.isVideo && $0.status == .done }) {
                note("Загрузите снятое видео в публикацию — если Instagram подключён по API, маркетолог выложит рилс сам.")
            }
            publishButton("Передать сейчас", systemImage: "tray.and.arrow.up", prominent: false, errorTitle: "Не передалось")
        } else {
            headline("Файлы и текст отправлены. Выложите и пришлите ссылку — маркетолог напомнит, если забудете.")
            linkButton("Вставить ссылку", prominent: true)
        }
    }

    // MARK: Pieces

    private func headline(_ text: String) -> some View {
        Text(text)
            .font(.subheadline.weight(.medium))
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
    }

    private func publishButton(
        _ title: String,
        systemImage: String? = nil,
        prominent: Bool,
        errorTitle: String? = nil
    ) -> some View {
        let symbol = systemImage ?? (isAuto ? "paperplane" : "tray.and.arrow.up")
        let failure = errorTitle ?? (isAuto ? "Не опубликовалось" : "Не передалось")
        return button(title, systemImage: symbol, action: .publish, prominent: prominent) {
            await model.publish(errorTitle: failure, api: api)
        }
    }

    private func linkButton(_ title: String, prominent: Bool) -> some View {
        SmmStepButton(title: title, systemImage: "link", isBusy: model.acting == .link, prominent: prominent) {
            link = ""
            asksLink = true
        }
        .disabled(model.acting != nil)
    }

    private func button(
        _ title: String,
        systemImage: String,
        action: SmmPostAction,
        prominent: Bool,
        perform: @escaping () async -> Void
    ) -> some View {
        SmmStepButton(title: title, systemImage: systemImage, isBusy: model.acting == action, prominent: prominent) {
            Task { await perform() }
        }
        .disabled(model.acting != nil)
    }

    private func saveLink() {
        let url = link
        Task { await model.markPublished(url: url, api: api) }
    }
}

/// A full-width capsule: the screen's main action in the accent glass or a secondary one in clear glass.
struct SmmStepButton: View {
    let title: String
    let systemImage: String
    var isBusy = false
    var prominent = true
    let action: () -> Void

    var body: some View {
        if prominent {
            Button(action: action) { label }
                .buttonStyle(.glassProminent)
        } else {
            Button(action: action) { label }
                .buttonStyle(.glass)
        }
    }

    private var label: some View {
        HStack(spacing: 8) {
            if isBusy {
                ProgressView()
            } else {
                Image(systemName: systemImage)
            }
            Text(title)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .font(.headline)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
    }
}
