import Foundation
import Observation
import os

/// The SMM profile the screens work in (remembered on this device) and both profiles' summaries from
/// `GET /smm/profiles`: titles for the switcher, whether each is enabled, what waits for a person.
/// Owned by `SmmHomeView` and handed to every SMM screen through the environment.
@Observable
final class SmmProfileStore {
    static let storageKey = "smm.profile"

    var profile: SmmProfile {
        didSet { UserDefaults.standard.set(profile.rawValue, forKey: Self.storageKey) }
    }
    private(set) var profiles: [SmmProfileSummary] = []
    private(set) var isLoading = false
    /// Failure of the last load (the switcher keeps working with default titles).
    private(set) var failure: String?

    @ObservationIgnored private let logger = Logger(subsystem: "com.mikanstudio.crm", category: "smm")

    init() {
        let saved = UserDefaults.standard.string(forKey: Self.storageKey).flatMap(SmmProfile.init(rawValue:))
        profile = saved ?? .studio
    }

    /// Summary of the selected profile, once loaded.
    var current: SmmProfileSummary? { summary(of: profile) }

    /// A disabled profile is left alone by the marketer until it is enabled in its settings.
    var isEnabled: Bool { current?.enabled ?? true }

    func summary(of profile: SmmProfile) -> SmmProfileSummary? {
        profiles.first { $0.profile == profile }
    }

    /// «Студия» for the studio; the author's brand name («Амина») for the author.
    func title(of profile: SmmProfile) -> String {
        switch profile {
        case .studio: profile.defaultTitle
        case .author: summary(of: profile)?.brandName.nonEmpty ?? profile.defaultTitle
        }
    }

    func load(using api: APIClient) async {
        isLoading = true
        defer { isLoading = false }
        do {
            profiles = try await api.smmProfiles()
            failure = nil
        } catch is CancellationError {
            return
        } catch {
            failure = error.userMessage
            logger.notice("SMM profiles load failed: \(error.userMessage, privacy: .public)")
        }
    }

    /// Takes the brand name and the enabled flag from settings saved anywhere in SMM.
    func apply(_ settings: SmmSettings, to profile: SmmProfile) {
        profiles = profiles.map { summary in
            guard summary.profile == profile else { return summary }
            var updated = summary
            updated.brandName = settings.brandName
            updated.enabled = settings.enabled
            return updated
        }
    }
}
