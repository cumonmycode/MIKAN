import SwiftUI
import UIKit

/// Coordinate space of the time grid's blocks (the `ZStack` of `TimeGridContent`).
enum AppointmentDragSpace {
    static let space = NamedCoordinateSpace.named("appointmentDragGrid")
}

extension View {
    /// Lets a block of the time grid be lifted with a long press and dragged to another time (see
    /// `AppointmentDragController`). Applied to the block inside its `NavigationLink`, so a tap still opens it.
    func appointmentDragSource(_ appointment: Appointment, frame: CGRect) -> some View {
        modifier(AppointmentDragSourceModifier(appointment: appointment, frame: frame))
    }
}

private struct AppointmentDragSourceModifier: ViewModifier {
    @Environment(AppointmentDragController.self) private var drag: AppointmentDragController?

    let appointment: Appointment
    let frame: CGRect

    func body(content: Content) -> some View {
        if let drag {
            let lifted = drag.isLifted(appointment.id)
            content
                .opacity(lifted ? 0.35 : 1)
                .gesture(AppointmentLiftGesture(
                    // Kept enabled while lifted: disabling a recognizer cancels its touch.
                    isEnabled: lifted || drag.canLift(appointment),
                    onLift: { drag.lift(appointment, frame: frame, at: $0) },
                    onMove: { drag.drag(to: $0) },
                    onDrop: { drag.drop() },
                    onCancel: { drag.cancelDrag() }
                ))
                .onDisappear {
                    if drag.isLifted(appointment.id) { drag.cancelDrag() }
                }
        } else {
            content
        }
    }
}

/// Long press that lifts an appointment, then follows the finger. A UIKit recognizer: it fails as soon as the finger
/// moves before the press is long enough, so the grid scrolls and pages as usual; once it begins, the scroll views
/// and the block's tap give way to it.
private struct AppointmentLiftGesture: UIGestureRecognizerRepresentable {
    private static let pressDuration: TimeInterval = 0.4

    let isEnabled: Bool
    let onLift: (CGPoint) -> Void
    let onMove: (CGPoint) -> Void
    let onDrop: () -> Void
    let onCancel: () -> Void

    func makeUIGestureRecognizer(context: Context) -> UILongPressGestureRecognizer {
        let recognizer = UILongPressGestureRecognizer()
        recognizer.minimumPressDuration = Self.pressDuration
        return recognizer
    }

    func updateUIGestureRecognizer(_ recognizer: UILongPressGestureRecognizer, context: Context) {
        recognizer.isEnabled = isEnabled
    }

    func handleUIGestureRecognizerAction(_ recognizer: UILongPressGestureRecognizer, context: Context) {
        let location = context.converter.location(in: AppointmentDragSpace.space)
        switch recognizer.state {
        case .began: onLift(location)
        case .changed: onMove(location)
        case .ended: onDrop()
        case .cancelled, .failed: onCancel()
        default: break
        }
    }
}
