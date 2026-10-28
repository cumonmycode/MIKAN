import SwiftUI

/// Horizontal category filter. `size` — `.regular` where the chips are tapped often (the POS catalog).
struct CategoryChips: View {
    let categories: [String]
    @Binding var selection: String?
    var size: ControlSize = .small

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                chip(title: "Все", value: nil)
                ForEach(categories, id: \.self) { category in
                    chip(title: category, value: category)
                }
            }
            .padding(.vertical, 2)
        }
        .scrollIndicators(.hidden)
    }

    @ViewBuilder
    private func chip(title: String, value: String?) -> some View {
        let isSelected = selection == value
        Button(title) {
            withAnimation(.snappy) { selection = value }
        }
        .buttonBorderShape(.capsule)
        .controlSize(size)
        .modifier(ChipStyle(isSelected: isSelected))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

private struct ChipStyle: ViewModifier {
    let isSelected: Bool

    func body(content: Content) -> some View {
        if isSelected {
            content.buttonStyle(.borderedProminent)
        } else {
            content.buttonStyle(.bordered)
        }
    }
}
