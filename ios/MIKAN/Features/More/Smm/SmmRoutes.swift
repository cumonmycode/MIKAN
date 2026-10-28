import SwiftUI

/// Screens of «СММ-маркетолог», pushed with `NavigationLink(value:)` — the home itself too, from «Ещё», whose stack
/// declares the destination and owns the `SmmProfileStore`. A home pushed as a view (`NavigationLink { … }`) was
/// re-created whenever «Ещё» redrew (badges refresh), and the screens pushed on top of it closed at once. Every screen
/// works in `SmmProfileStore.profile` (from the environment). Ids are server UUID strings; `month` is `YYYY-MM`.
nonisolated enum SmmRoute: Hashable, Sendable {
    case home
    case post(id: String)
    /// «Новая публикация», prefilled from an idea or a day of the plan.
    case newPost(SmmPostDraft = SmmPostDraft())
    case plan(month: String)
    case ideas
    case analytics
    case report(id: String)
    case memory
    case settings
    case accounts
    case instagram
    /// Photo archive; with `postId` a picked photo is added to that post.
    case library(postId: String? = nil)
    case album(id: String, title: String, postId: String? = nil)
    /// Carousel slides / story frames order of a post.
    case mediaOrder(postId: String)
    case knowledge
    case zone(id: String)
}

/// Prefill of «Новая публикация».
nonisolated struct SmmPostDraft: Hashable, Sendable {
    var topic = ""
    var brief = ""
    var platform: SmmPlatform = .telegram
    var format: SmmFormat = .post
    var direction: String?
    /// `YYYY-MM-DD` in the studio time zone.
    var date: String?

    init(
        topic: String = "",
        brief: String = "",
        platform: SmmPlatform = .telegram,
        format: SmmFormat = .post,
        direction: String? = nil,
        date: String? = nil
    ) {
        self.topic = topic
        self.brief = brief
        self.platform = platform
        self.format = format
        self.direction = direction
        self.date = date
    }

    init(idea: SmmIdea) {
        self.init(topic: idea.topic, brief: idea.brief, platform: idea.platform, format: idea.format, direction: idea.direction)
    }
}

/// Route → screen. Screen authors replace their placeholder line with the real view (one line per route).
struct SmmRouteDestination: View {
    let route: SmmRoute

    var body: some View {
        switch route {
        case .home: SmmHomeView()
        case .post(let id): SmmPostView(postId: id)
        case .newPost(let draft): SmmNewPostView(draft: draft)
        case .plan(let month): SmmPlanView(month: month)
        case .ideas: SmmIdeasView()
        case .analytics: SmmAnalyticsView()
        case .report(let id): SmmReportView(id: id)
        case .memory: SmmMemoryView()
        case .settings: SmmSettingsView()
        case .accounts: SmmAccountsView()
        case .instagram: SmmInstagramView()
        case .library(let postId): SmmLibraryView(postId: postId)
        case .album(let id, let title, let postId): SmmAlbumView(albumId: id, title: title, postId: postId)
        case .mediaOrder(let postId): SmmMediaOrderView(postId: postId)
        case .knowledge: SmmKnowledgeView()
        case .zone(let id): SmmZoneView(zoneId: id)
        }
    }
}
