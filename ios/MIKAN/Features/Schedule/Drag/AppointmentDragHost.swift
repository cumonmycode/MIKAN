import SwiftUI

extension View {
    /// Makes the appointments of a time-grid page draggable: owns the page's `AppointmentDragController`, holds the
    /// grid still while an appointment is lifted, scrolls it near the edges and asks to confirm the drop.
    /// Applied to the page's vertical `ScrollView`, whose position it moves.
    func appointmentDragging(position: Binding<ScrollPosition>) -> some View {
        modifier(AppointmentDraggingModifier(position: position))
    }
}

private struct AppointmentDraggingModifier: ViewModifier {
    @Environment(AppState.self) private var appState
    @Environment(ScheduleStore.self) private var store

    @Binding var position: ScrollPosition
    @State private var drag = AppointmentDragController()

    func body(content: Content) -> some View {
        content
            .environment(drag)
            .scrollDisabled(drag.isDragging)
            .onScrollGeometryChange(for: DragScrollMetrics.self, of: DragScrollMetrics.init(geometry:)) { _, metrics in
                drag.scrolled(metrics)
            }
            .task(id: drag.isAutoScrolling) { await autoScroll() }
            .onChange(of: appState.employee, initial: true) { _, employee in drag.employee = employee }
            .sheet(item: $drag.pendingMove, onDismiss: drag.confirmationDismissed) { move in
                AppointmentMoveSheet(move: move, onSaved: saved, onFailed: refresh)
            }
    }

    /// Scrolls about 60 times a second while the finger holds the appointment near an edge.
    private func autoScroll() async {
        let clock = ContinuousClock()
        var last = clock.now
        while drag.isAutoScrolling, !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(16))
            let now = clock.now
            let seconds = (now - last) / .seconds(1)
            last = now
            if let offset = drag.autoScrollOffset(after: seconds) {
                position.scrollTo(y: offset)
            }
        }
    }

    private func saved(_ appointment: Appointment) {
        store.upsert(appointment)
        drag.finish()
        refresh()
    }

    private func refresh() {
        Task { await store.refreshVisible() }
    }
}

nonisolated extension DragScrollMetrics {
    init(geometry: ScrollGeometry) {
        let visible = max(0, geometry.containerSize.height - geometry.contentInsets.top - geometry.contentInsets.bottom)
        self.init(
            offset: geometry.contentOffset.y + geometry.contentInsets.top,
            visibleHeight: visible,
            maxOffset: max(0, geometry.contentSize.height - visible)
        )
    }
}
