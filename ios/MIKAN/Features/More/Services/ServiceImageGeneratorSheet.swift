import SwiftUI

/// Generates the schematic cover of a service with AI (1–2 minutes).
struct ServiceImageGeneratorSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(APIClient.self) private var api

    let service: Service
    let onGenerated: (Service) -> Void

    @State private var prompt: String
    @State private var startedAt: Date?
    @State private var isChecking = false
    /// The cover before this generation; another one on the server means it finished.
    @State private var baselineImageUrl: String?
    /// The picture may still be drawing on the server; the alert offers «Проверить».
    @State private var pendingMessage: String?
    @State private var errorMessage: String?

    private static let previewSize: CGFloat = 72
    private static let lostConnectionMessage =
        "Связь с сервером прервалась, но картинка может ещё рисоваться. Проверьте через минуту."

    init(service: Service, onGenerated: @escaping (Service) -> Void) {
        self.service = service
        self.onGenerated = onGenerated
        _prompt = State(initialValue: service.imagePrompt ?? "")
        _baselineImageUrl = State(initialValue: service.imageUrl)
    }

    private var isGenerating: Bool { startedAt != nil }
    private var isBusy: Bool { isGenerating || isChecking }
    private var promptMessage: String? { ServiceLimits.imagePromptMessage(prompt) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 14) {
                        ProductThumbnail(path: service.imageUrl, size: Self.previewSize, placeholderSymbol: service.category.symbol)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(service.name).font(.headline)
                            Text(service.imageUrl.nonEmpty == nil ? "Картинки пока нет" : "Новая картинка заменит текущую")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
                Section {
                    TextField("Например: схема прокола хеликса, вид сбоку", text: $prompt, axis: .vertical)
                        .lineLimit(3...8)
                        .disabled(isBusy)
                } header: {
                    Text("Что нарисовать (необязательно)")
                } footer: {
                    if let promptMessage {
                        Text(promptMessage).foregroundStyle(.red)
                    } else {
                        Text("Если оставить пустым, картинку нарисуют по названию и описанию услуги. Текст сохранится в услуге.")
                    }
                }
                statusSection
            }
            .navigationTitle("Картинка услуги")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена", role: .cancel) { dismiss() }
                        .disabled(isBusy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isBusy {
                        ProgressView()
                    } else {
                        Button("Сгенерировать", action: generate)
                            .disabled(promptMessage != nil)
                    }
                }
            }
            .interactiveDismissDisabled(isBusy)
            .errorAlert($errorMessage, title: "Не удалось сгенерировать")
            .alert(
                "Картинка ещё рисуется",
                isPresented: Binding(get: { pendingMessage != nil }, set: { if !$0 { pendingMessage = nil } })
            ) {
                Button("Проверить") { startCheck() }
                Button("Закрыть", role: .cancel) {}
            } message: {
                Text(pendingMessage ?? "")
            }
        }
    }

    @ViewBuilder
    private var statusSection: some View {
        Section {
            if let startedAt {
                HStack(spacing: 14) {
                    ProgressView()
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Рисуем картинку…").font(.headline)
                        Text("Обычно это 1–2 минуты. Не закрывайте экран.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                    TimelineView(.periodic(from: startedAt, by: 1)) { context in
                        Text(Self.elapsed(from: startedAt, to: context.date))
                            .font(.subheadline)
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
            } else if isChecking {
                HStack(spacing: 14) {
                    ProgressView()
                    Text("Проверяем, готова ли картинка…").font(.subheadline)
                }
            } else {
                Label {
                    Text("Генерация занимает 1–2 минуты и стоит несколько рублей. Предыдущая картинка заменится новой.")
                } icon: {
                    Image(systemName: "wand.and.sparkles").foregroundStyle(Color.accentColor)
                }
                .font(.subheadline)
            }
        }
    }

    private static func elapsed(from start: Date, to now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(start)))
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    // MARK: - Actions

    private func generate() {
        baselineImageUrl = service.imageUrl
        startedAt = .now
        Task {
            defer { startedAt = nil }
            do {
                let updated = try await clearSavedPromptIfNeeded()
                finish(try await api.generateServiceImage(id: updated.id, prompt: prompt.nonEmpty))
            } catch is CancellationError {
                return
            } catch let error where ServiceImageGeneration.mayStillFinish(error) {
                // The server keeps drawing after the connection broke; the picture may already be there.
                await check(otherwise: Self.lostConnectionMessage)
            } catch let error where ServiceImageGeneration.isAlreadyGenerating(error) {
                pendingMessage = error.userMessage
            } catch {
                errorMessage = error.userMessage
            }
        }
    }

    private func startCheck() {
        Task { await check(otherwise: "Картинка ещё не готова. Проверьте через минуту.") }
    }

    /// Re-fetches the catalog: a new cover means the generation finished despite the error.
    private func check(otherwise message: String) async {
        isChecking = true
        defer { isChecking = false }
        do {
            let fresh = try await api.services(includeInactive: true).first { $0.id == service.id }
            if let fresh, ServiceImageGeneration.hasNewPicture(fresh, baseline: baselineImageUrl) {
                finish(fresh)
            } else {
                pendingMessage = message
            }
        } catch is CancellationError {
            return
        } catch {
            pendingMessage = message
        }
    }

    private func finish(_ generated: Service) {
        onGenerated(generated)
        dismiss()
    }

    /// Sending no prompt makes the server reuse the saved one, so an emptied field clears it first —
    /// then the picture really is drawn from the name and description.
    private func clearSavedPromptIfNeeded() async throws -> Service {
        guard prompt.nonEmpty == nil, service.imagePrompt.nonEmpty != nil else { return service }
        var body = ServiceBody(service)
        body.imagePrompt = nil
        let updated = try await api.updateService(id: service.id, body)
        onGenerated(updated)
        return updated
    }
}

// MARK: - Cover generation

/// How to read the outcome of an AI cover generation request.
nonisolated enum ServiceImageGeneration {
    /// The service has a picture other than the one it had when the generation started.
    static func hasNewPicture(_ service: Service?, baseline: String?) -> Bool {
        guard let current = service?.imageUrl.nonEmpty else { return false }
        return current != baseline.nonEmpty
    }

    /// `409` because a generation for this service is still running (a missing AI key is a `409` too, with another message).
    static func isAlreadyGenerating(_ error: any Error) -> Bool {
        guard let error = error as? APIError, error.status == 409 else { return false }
        return error.message.localizedCaseInsensitiveContains("генерируется")
    }

    /// The request broke on the way (timeout, dropped connection, app in background): the server may still finish.
    static func mayStillFinish(_ error: any Error) -> Bool {
        guard let error = error as? APIError, case .transport = error else { return false }
        return true
    }
}

#if DEBUG
#Preview {
    ServiceImageGeneratorSheet(service: PreviewData.nipple) { _ in }
        .previewEnvironment()
}
#endif
