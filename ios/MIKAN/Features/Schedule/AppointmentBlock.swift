import SwiftUI

/// Appointment in the time grid, tinted with the master's color; an unsettled online booking gets a dashed outline.
struct AppointmentBlock: View {
    private static let cornerRadius: CGFloat = 6
    private static let onlineOutline = StrokeStyle(lineWidth: 1.5, dash: [4, 3])

    let appointment: Appointment
    let compact: Bool
    let height: CGFloat

    private var color: Color { .master(appointment.master.color) }
    private var showsTitle: Bool { !compact && height >= 44 }
    private var depositMark: DepositMark? { DepositMark.of(appointment) }
    private var onlineMark: OnlineMark? { OnlineMark.of(appointment) }

    var body: some View {
        HStack(spacing: 0) {
            Rectangle()
                .fill(color)
                .frame(width: 3)
            Group {
                if compact {
                    // Week lanes can be very narrow: degrade instead of wrapping text into «1…».
                    ViewThatFits(in: .horizontal) {
                        details
                        VStack(alignment: .leading, spacing: 1) {
                            timeRow
                            initialsLabel
                        }
                        initialsLabel
                        Color.clear.frame(width: 0, height: 0)
                    }
                } else {
                    details
                }
            }
            .padding(.horizontal, compact ? 3 : 5)
            .padding(.vertical, 2)
            Spacer(minLength: 0)
        }
        .foregroundStyle(.primary)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(color.opacity(0.2))
        .clipShape(.rect(cornerRadius: Self.cornerRadius))
        .overlay {
            if let onlineMark {
                RoundedRectangle(cornerRadius: Self.cornerRadius)
                    .strokeBorder(onlineMark.color, style: Self.onlineOutline)
            }
        }
        .strikethrough(!appointment.isActive)
        .opacity(appointment.isActive ? 1 : 0.45)
        .dynamicTypeSize(...DynamicTypeSize.xLarge)
        .contentShape(.rect(cornerRadius: Self.cornerRadius))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
        .accessibilityAddTraits(.isButton)
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 1) {
            timeRow
            Text(compact ? shortName : appointment.client.fullName)
                .font(compact ? .caption2.weight(.semibold) : .caption.weight(.semibold))
                .lineLimit(compact ? 2 : 1)
            if showsTitle, let onlineMark {
                Text(onlineMark.text)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(onlineMark.color)
                    .monospacedDigit()
                    .lineLimit(1)
            }
            if showsTitle {
                Text(appointment.displayTitle)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
    }

    /// Start time with the online-booking or prepayment glyph, the «в кассе» cart and the completion check.
    private var timeRow: some View {
        HStack(spacing: 3) {
            timeLabel
            if let onlineMark {
                Image(systemName: onlineMark.symbol)
                    .font(.caption2)
                    .foregroundStyle(onlineMark.color)
            } else if let depositMark {
                Image(systemName: depositMark.symbol)
                    .font(.caption2)
                    .foregroundStyle(depositMark.color)
            }
            if appointment.isInPOS {
                Image(systemName: "cart.fill")
                    .font(.caption2)
                    .foregroundStyle(Color.accentColor)
            }
            if appointment.status == .completed {
                Image(systemName: "checkmark.circle.fill")
                    .font(.caption2)
                    .foregroundStyle(.green)
            }
        }
    }

    private var timeLabel: some View {
        Text(DateText.time(appointment.startsAt))
            .font(.caption2.weight(.semibold))
            .monospacedDigit()
    }

    private var initialsLabel: some View {
        Text(Initials.from(appointment.client.fullName))
            .font(.caption2.weight(.semibold))
    }

    /// First name, or initials when the name is long.
    private var shortName: String {
        let fullName = appointment.client.fullName
        let first = fullName.split(separator: " ").first.map(String.init) ?? fullName
        return first.count > 8 ? Initials.from(fullName) : first
    }

    private var accessibilityText: String {
        var parts = [
            DateText.timeRange(appointment.startsAt, appointment.endsAt),
            appointment.client.fullName,
            appointment.displayTitle,
            "мастер \(appointment.master.name)",
        ]
        if appointment.status != .scheduled { parts.append(appointment.status.title) }
        if let onlineMark { parts.append("онлайн-запись, \(onlineMark.text.lowercased())") }
        if let depositMark { parts.append(depositMark.accessibilityText) }
        if appointment.isInPOS { parts.append("в кассе") }
        return parts.joined(separator: ", ")
    }
}

#if DEBUG
#Preview {
    HStack(alignment: .top, spacing: 4) {
        AppointmentBlock(appointment: PreviewData.appointments[0], compact: false, height: 120)
            .frame(height: 120)
        AppointmentBlock(appointment: PreviewData.appointments[2], compact: true, height: 40)
            .frame(width: 48, height: 40)
    }
    .padding()
}
#endif
