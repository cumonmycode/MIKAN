import CoreGraphics
import Observation

/// Where the time grid is scrolled, in `ScrollPosition` units (content y at the top of the visible area).
nonisolated struct DragScrollMetrics: Equatable, Sendable {
    var offset: CGFloat
    var visibleHeight: CGFloat
    var maxOffset: CGFloat

    static let zero = DragScrollMetrics(offset: 0, visibleHeight: 0, maxOffset: 0)
}

/// One calendar page's drag: the lifted appointment, where it would land and the drop waiting for confirmation.
/// Positions are in the grid's coordinate space (`AppointmentDragSpace`).
@Observable
final class AppointmentDragController {
    enum Phase: Equatable {
        case dragging
        /// Dropped; the confirmation sheet is open.
        case confirming
        /// Gliding back after a cancel or an error.
        case returning
    }

    struct Session {
        let plan: AppointmentDragPlan
        var target: DragTarget
        var phase: Phase

        var appointment: Appointment { plan.appointment }

        /// The appointment as it would look after the move: the ghost shows its new time.
        var preview: Appointment {
            var moved = plan.appointment
            moved.startsAt = target.startsAt
            moved.endsAt = target.endsAt
            return moved
        }
    }

    private static let returnDuration: Duration = .milliseconds(260)

    private(set) var session: Session?
    /// The drop the confirmation sheet asks about.
    var pendingMove: AppointmentMove?
    /// Who drags: decides what may be lifted.
    var employee: Employee?
    /// Haptic triggers.
    private(set) var liftCount = 0
    private(set) var stepCount = 0
    private(set) var savedCount = 0
    /// True while the finger holds the appointment near the top or bottom edge.
    private(set) var isAutoScrolling = false

    /// Set by the grid; read only when lifting.
    @ObservationIgnored var grid: DragGrid?
    @ObservationIgnored private(set) var scroll = DragScrollMetrics.zero
    /// The finger relative to the top of the visible area: it stays put on screen while the grid scrolls under it.
    @ObservationIgnored private var finger: CGPoint?

    var isDragging: Bool { session?.phase == .dragging }

    func canLift(_ appointment: Appointment) -> Bool {
        session == nil && AppointmentDragRules.canDrag(appointment, by: employee)
    }

    func isLifted(_ appointmentId: Int) -> Bool {
        session?.appointment.id == appointmentId
    }

    func lift(_ appointment: Appointment, frame: CGRect, at location: CGPoint) {
        guard canLift(appointment), let grid, let plan = AppointmentDragPlan(
            appointment: appointment,
            grid: grid,
            sourceFrame: frame,
            grabLocation: location,
            canChangeMaster: AppointmentDragRules.canChangeMaster(by: employee)
        ) else { return }
        session = Session(plan: plan, target: plan.original, phase: .dragging)
        track(location)
        liftCount += 1
    }

    func drag(to location: CGPoint) {
        guard isDragging else { return }
        track(location)
        retarget(location)
    }

    /// The finger is lifted: an unchanged place puts the appointment back, a new one asks for confirmation.
    func drop() {
        guard let session, session.phase == .dragging else { return }
        stopTracking()
        let move = AppointmentMove(appointment: session.appointment, target: session.target)
        guard move.isChange else { return putBack() }
        self.session?.phase = .confirming
        pendingMove = move
    }

    /// The system took the touch away (a call, the app going to the background).
    func cancelDrag() {
        guard isDragging else { return }
        stopTracking()
        putBack()
    }

    /// Saved: the calendar already shows the appointment at its new place.
    func finish() {
        session = nil
        pendingMove = nil
        savedCount += 1
    }

    /// The confirmation closed without saving (cancel, error): back to where it was.
    func confirmationDismissed() {
        guard session?.phase == .confirming else { return }
        putBack()
    }

    func scrolled(_ metrics: DragScrollMetrics) {
        scroll = metrics
        guard isDragging, let finger else { return }
        retarget(CGPoint(x: finger.x, y: metrics.offset + finger.y))
        updateAutoScroll()
    }

    /// The next scroll offset while auto-scrolling, or `nil` when it stays.
    func autoScrollOffset(after seconds: Double) -> CGFloat? {
        guard isDragging, let finger else { return nil }
        let velocity = DragAutoScroll.velocity(fingerY: finger.y, visibleHeight: scroll.visibleHeight)
        let next = DragAutoScroll.offset(from: scroll.offset, velocity: velocity, seconds: seconds, maxOffset: scroll.maxOffset)
        return next == scroll.offset ? nil : next
    }

    // MARK: - Private

    private func track(_ location: CGPoint) {
        finger = CGPoint(x: location.x, y: location.y - scroll.offset)
        updateAutoScroll()
    }

    private func stopTracking() {
        finger = nil
        updateAutoScroll()
    }

    private func updateAutoScroll() {
        let scrolling = isDragging && finger.map {
            DragAutoScroll.velocity(fingerY: $0.y, visibleHeight: scroll.visibleHeight) != 0
        } == true
        if scrolling != isAutoScrolling { isAutoScrolling = scrolling }
    }

    private func retarget(_ location: CGPoint) {
        guard let session else { return }
        let target = session.plan.target(at: location)
        guard target != session.target else { return }
        self.session?.target = target
        stepCount += 1
    }

    private func putBack() {
        guard let session else { return }
        pendingMove = nil
        self.session?.target = session.plan.original
        self.session?.phase = .returning
        Task { [weak self] in
            try? await Task.sleep(for: Self.returnDuration)
            guard let self, self.session?.phase == .returning else { return }
            self.session = nil
        }
    }
}
