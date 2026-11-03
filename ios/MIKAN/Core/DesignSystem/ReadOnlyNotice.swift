import SwiftUI

/// A note on top of a form the signed-in employee's role may only look at.
struct ReadOnlyNotice: View {
    var text = "Изменять это могут владелец и администратор."

    var body: some View {
        Section {
            Label(text, systemImage: "lock")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
    }
}

#if DEBUG
#Preview {
    Form { ReadOnlyNotice() }
}
#endif
