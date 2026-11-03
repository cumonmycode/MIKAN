import SwiftUI

// What needs a person and the two-week feed of the SMM home (Titan `Attention` and `Feed`).

/// What waits for a person: what the marketer is busy with, then failed, awaiting a link and awaiting approval.
struct SmmAttentionSection: View {
    let posts: [SmmPost]
    let timeZone: TimeZone

    private var busy: SmmPost? { posts.first { $0.busy != nil && $0.busy != .video } }

    private var items: [SmmPost] {
        let failed = posts.filter { $0.status == .failed }
        let link = posts.filter(\.awaitsLink)
        let review = posts.filter { $0.status == .review && $0.busy == nil }
        return failed + link + review
    }

    var body: some View {
        if busy != nil || !items.isEmpty {
            Section("Нужно ваше внимание") {
                if let busy {
                    NavigationLink(value: SmmRoute.post(id: busy.id)) {
                        SmmProgressBanner(progress: label(busy.progress, topic: busy.topic), text: busyText(busy))
                    }
                }
                ForEach(items) { post in
                    NavigationLink(value: SmmRoute.post(id: post.id)) {
                        SmmPostRow(post: post, timeZone: timeZone, showsDay: true)
                    }
                }
            }
        }
    }

    private func label(_ progress: SmmProgress?, topic: String) -> SmmProgress? {
        guard let progress else { return nil }
        return SmmProgress(
            label: "«\(topic)»: \(progress.label.lowercased())",
            pct: progress.pct, next: progress.next, eta: progress.eta, at: progress.at
        )
    }

    private func busyText(_ post: SmmPost) -> String? {
        guard let busy = post.busy else { return nil }
        return "«\(post.topic)»: \(busy.text.lowercased())"
    }
}

/// The next two weeks by day (yesterday's published posts stay, to see the result; failed ones are above).
struct SmmFeedSections: View {
    let posts: [SmmPost]
    let timeZone: TimeZone
    let month: String

    private struct Day: Identifiable {
        let key: String
        let posts: [SmmPost]
        var id: String { key }
    }

    private var days: [Day] {
        let today = SmmText.dayKey(of: .now, in: timeZone)
        var order: [String] = []
        var groups: [String: [SmmPost]] = [:]
        for post in posts where post.status != .failed {
            guard let publishAt = post.publishAt else { continue }
            let day = SmmText.dayKey(of: publishAt, in: timeZone)
            guard day >= today else { continue }
            if groups[day] == nil { order.append(day) }
            groups[day, default: []].append(post)
        }
        return order.sorted().map { Day(key: $0, posts: groups[$0] ?? []) }
    }

    var body: some View {
        let feed = days
        if feed.isEmpty {
            Section {
                Text("На ближайшие две недели публикаций нет. Составьте план месяца — маркетолог распишет темы по дням и сам будет готовить посты.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                NavigationLink(value: SmmRoute.plan(month: month)) {
                    Label("Открыть план", systemImage: "wand.and.stars")
                }
            } header: {
                header
            }
        } else {
            ForEach(Array(feed.enumerated()), id: \.element.id) { index, day in
                Section {
                    ForEach(day.posts) { post in
                        NavigationLink(value: SmmRoute.post(id: post.id)) {
                            SmmPostRow(post: post, timeZone: timeZone)
                        }
                    }
                } header: {
                    if index == 0 {
                        VStack(alignment: .leading, spacing: 10) {
                            header
                            Text(SmmClock.dayTitle(day.key, in: timeZone))
                        }
                    } else {
                        Text(SmmClock.dayTitle(day.key, in: timeZone))
                    }
                }
            }
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("Ближайшие публикации")
                .font(.title3.weight(.bold))
                .foregroundStyle(.primary)
            Spacer()
            NavigationLink(value: SmmRoute.newPost()) {
                Text("Добавить")
                    .font(.subheadline)
            }
        }
        .textCase(nil)
        .accessibilityAddTraits(.isHeader)
    }
}
