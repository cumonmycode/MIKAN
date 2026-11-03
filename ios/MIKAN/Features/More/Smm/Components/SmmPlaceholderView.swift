import SwiftUI

/// Stand-in for an SMM screen that is not built yet (see `SmmRouteDestination`).
struct SmmPlaceholderView: View {
    let title: String

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: "hammer")
        } description: {
            Text("Этот экран ещё в работе.")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background { AuraBackground() }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }
}
