import SwiftUI

/// A device signed in: its name, when it was used and signed in; «Завершить» for any but this iPhone.
struct SessionRow: View {
    let session: AuthSession
    let end: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "iphone")
                .font(.title2)
                .foregroundStyle(session.current ? Color.accentColor : .secondary)
                .frame(width: 32)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(session.deviceTitle)
                Text(session.activityText())
                    .font(.subheadline)
                    .foregroundStyle(session.current ? Color.accentColor : .secondary)
                Text(session.signInText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
            Spacer(minLength: 8)
            if !session.current {
                Button("Завершить", role: .destructive, action: end)
                    .buttonStyle(.borderless)
                    .font(.subheadline)
            }
        }
    }
}
