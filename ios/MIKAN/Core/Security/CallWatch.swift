import CallKit
import Observation

/// Whether the iPhone is on a call: `CXCallObserver` reports the calls of the whole system, whichever app has them.
@Observable
final class CallWatch: NSObject {
    private(set) var isOnCall = false
    @ObservationIgnored private let observer = CXCallObserver()

    override init() {
        super.init()
        refresh()
        observer.setDelegate(self, queue: nil)
    }

    /// Calls that changed while the app was suspended send no news, so the scene asks again when it wakes.
    func refresh() {
        isOnCall = observer.calls.contains { !$0.hasEnded }
    }
}

extension CallWatch: nonisolated CXCallObserverDelegate {
    nonisolated func callObserver(_ callObserver: CXCallObserver, callChanged call: CXCall) {
        Task { @MainActor in self.refresh() }
    }
}
