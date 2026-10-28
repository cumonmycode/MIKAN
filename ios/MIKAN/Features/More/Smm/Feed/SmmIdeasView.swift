import SwiftUI

/// Idea generator (Titan `ideas.tsx`): across all directions of the profile or one, with a wish («к Хэллоуину», «для
/// тех, кто боится первого прокола»). A liked idea goes to the plan with one button — only the day is left to pick.
struct SmmIdeasView: View {
    @Environment(APIClient.self) private var api
    @Environment(SmmProfileStore.self) private var store

    @State private var directions: [SmmDirection] = []
    @State private var direction: String?
    @State private var wish = ""
    @State private var ideas: [SmmIdea] = []
    @State private var progress: SmmProgress?
    @State private var errorMessage: String?
    @State private var receivedCount = 0

    static let maxWish = 300
    /// About how long the marketer thinks (the scale of an awaited request).
    static let eta: Double = 20

    private var isLoading: Bool { progress != nil }

    var body: some View {
        List {
            Section {
                Text(intro)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 0, leading: 4, bottom: 8, trailing: 4))
                directionChips
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
            }
            .listRowSeparator(.hidden)
            Section {
                TextField(wishPlaceholder, text: $wish, axis: .vertical)
                    .lineLimit(1...4)
                    .onChange(of: wish) { _, value in
                        if value.count > Self.maxWish { wish = String(value.prefix(Self.maxWish)) }
                    }
                    .accessibilityLabel("Пожелание к идеям")
            }
            Section {
                SmmStepButton(title: buttonTitle, systemImage: "lightbulb", isBusy: isLoading, prominent: true) {
                    Task { await generate() }
                }
                .disabled(isLoading)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
                if let progress {
                    SmmProgressBanner(progress: progress)
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 0, trailing: 0))
                }
            }
            .listRowSeparator(.hidden)
            ForEach(ideas) { idea in
                ideaSection(idea)
            }
        }
        .auraBackground()
        .navigationTitle("Идеи")
        .navigationBarTitleDisplayMode(.inline)
        .scrollDismissesKeyboard(.interactively)
        .task { await loadDirections() }
        .sensoryFeedback(.success, trigger: receivedCount)
        .errorAlert($errorMessage, title: "Идеи не пришли")
    }

    private var intro: String {
        switch store.profile {
        case .studio:
            "Маркетолог придумывает публикации из жизни студии: работы мастеров, эскизы, пирсинг и украшения, уход, "
                + "люди и закулисье — и под тренды рилс."
        case .author:
            "Маркетолог придумывает публикации для личных соцсетей \(store.title(of: .author)): работы и процесс, "
                + "мысли, жизнь вокруг — и под тренды рилс."
        }
    }

    private var wishPlaceholder: String {
        store.profile == .studio
            ? "Пожелание: к Хэллоуину, для новичков, про уход…"
            : "Пожелание: про вдохновение, к праздникам, закулисье…"
    }

    private var buttonTitle: String {
        if isLoading { return "Маркетолог думает…" }
        return ideas.isEmpty ? "Придумать идеи" : "Ещё идеи"
    }

    private var directionChips: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                chip(title: "Все направления", key: nil)
                ForEach(directions) { item in
                    chip(title: item.title, key: item.key)
                }
            }
            .padding(.vertical, 2)
        }
        .scrollIndicators(.hidden)
    }

    @ViewBuilder
    private func chip(title: String, key: String?) -> some View {
        let isOn = direction == key
        if isOn {
            Button(title) { direction = key }
                .buttonStyle(.glassProminent)
                .accessibilityAddTraits(.isSelected)
        } else {
            Button(title) { direction = key }
                .buttonStyle(.glass)
        }
    }

    private func ideaSection(_ idea: SmmIdea) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    SmmPlatformBadge(idea.platform, size: 20)
                    Text(meta(of: idea))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Text(idea.topic)
                    .font(.headline)
                    .textSelection(.enabled)
                Text(idea.brief)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                NavigationLink(value: SmmRoute.newPost(SmmPostDraft(idea: idea))) {
                    Label("В план", systemImage: "calendar.badge.plus")
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .controlSize(.small)
                .padding(.top, 2)
            }
            .padding(.vertical, 4)
        }
    }

    private func meta(of idea: SmmIdea) -> String {
        var parts = [idea.platform.title, idea.format.title]
        if let title = directions.first(where: { $0.key == idea.direction })?.title {
            parts.append(title)
        }
        return parts.joined(separator: " · ")
    }

    private func loadDirections() async {
        guard directions.isEmpty else { return }
        do {
            directions = try await api.smmMeta(store.profile).directions
        } catch is CancellationError {
            return
        } catch {
            // Without directions the ideas still come — across all of them.
            directions = []
        }
    }

    private func generate() async {
        let label = store.profile == .studio
            ? "Маркетолог придумывает идеи по жизни студии"
            : "Маркетолог придумывает идеи для \(store.title(of: .author))"
        progress = .estimate(label, eta: Self.eta)
        defer { progress = nil }
        do {
            let body = SmmIdeasBody(direction: direction, wish: wish.nonEmpty)
            let received = try await api.smmIdeas(store.profile, body)
            withAnimation(.smooth) { ideas = received }
            receivedCount += 1
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.userMessage
        }
    }
}
