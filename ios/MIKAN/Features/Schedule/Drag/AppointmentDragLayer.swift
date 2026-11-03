import SwiftUI

extension View {
    /// The grid side of dragging: names the coordinate space the blocks report the finger in, tells the controller
    /// the grid's geometry and draws the lifted appointment at the place it would land.
    func appointmentDragLayer(_ grid: DragGrid, compact: Bool) -> some View {
        modifier(AppointmentDragLayerModifier(grid: grid, compact: compact))
    }
}

private struct AppointmentDragLayerModifier: ViewModifier {
    @Environment(AppointmentDragController.self) private var drag: AppointmentDragController?

    let grid: DragGrid
    let compact: Bool

    func body(content: Content) -> some View {
        content
            .coordinateSpace(AppointmentDragSpace.space)
            .overlay(alignment: .topLeading) {
                if let session = drag?.session {
                    DragGhost(session: session, compact: compact)
                }
            }
            .onChange(of: grid, initial: true) { _, grid in drag?.grid = grid }
            .sensoryFeedback(.impact(weight: .medium), trigger: drag?.liftCount ?? 0)
            .sensoryFeedback(.selection, trigger: drag?.stepCount ?? 0)
            .sensoryFeedback(.success, trigger: drag?.savedCount ?? 0)
    }
}

/// The lifted appointment: raised while dragged, snapped to its new slot, with the new time above it.
private struct DragGhost: View {
    private static let cornerRadius: CGFloat = 6
    private static let badgeRise: CGFloat = 20

    let session: AppointmentDragController.Session
    let compact: Bool

    @State private var lifted = false

    private var raised: Bool { lifted && session.phase == .dragging }

    var body: some View {
        let frame = session.plan.frame(of: session.target)
        AppointmentBlock(appointment: session.preview, compact: compact, height: frame.height)
            .background(Color(.systemBackground), in: .rect(cornerRadius: Self.cornerRadius))
            .overlay {
                RoundedRectangle(cornerRadius: Self.cornerRadius)
                    .strokeBorder(Color.accentColor, lineWidth: session.phase == .returning ? 0 : 1.5)
            }
            .frame(width: frame.width, height: frame.height)
            .overlay(alignment: .topLeading) {
                // Above the block, or below it at the very top of the grid where it would be cut off.
                if session.phase != .returning {
                    timeBadge.offset(y: frame.minY >= Self.badgeRise ? -Self.badgeRise : frame.height + 2)
                }
            }
            .scaleEffect(raised ? 1.04 : 1)
            .shadow(color: .black.opacity(raised ? 0.22 : 0.1), radius: raised ? 10 : 3, y: raised ? 6 : 1)
            .offset(x: frame.minX, y: frame.minY)
            .animation(.snappy(duration: 0.18), value: session.target)
            .animation(.spring(duration: 0.25, bounce: 0.3), value: raised)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
            .onAppear { lifted = true }
    }

    private var timeBadge: some View {
        Text(DateText.timeRange(session.target.startsAt, session.target.endsAt))
            .font(.caption2.weight(.semibold))
            .monospacedDigit()
            .foregroundStyle(.white)
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color.accentColor, in: .capsule)
    }
}
