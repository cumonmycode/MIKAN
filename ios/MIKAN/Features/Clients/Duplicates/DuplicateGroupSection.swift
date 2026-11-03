import SwiftUI

/// One group of «Похожие карточки»: the cards side by side, «Объединить» and «Это разные люди».
struct DuplicateGroupSection: View {
    let group: DuplicateGroup
    let onMerge: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        let rows = DuplicateComparison.rows(group.clients)
        Section {
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: 10) {
                    ForEach(Array(group.clients.enumerated()), id: \.element.id) { index, client in
                        DuplicateCardColumn(client: client, index: index, rows: rows)
                    }
                }
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.viewAligned)
            .scrollIndicators(.hidden)
            .contentMargins(.horizontal, 16, for: .scrollContent)
            .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            .listRowBackground(Color.clear)

            GlassEffectContainer(spacing: 10) {
                HStack(spacing: 10) {
                    Button(action: onMerge) {
                        Label("Объединить", systemImage: "arrow.triangle.merge").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glassProminent)
                    Button(action: onDismiss) {
                        Label("Это разные люди", systemImage: "person.2.slash").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glass)
                }
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 8, trailing: 16))
        } header: {
            Label(group.reason.title, systemImage: group.reason.systemImage)
        }
    }
}

/// A card of the group: the same rows in every column, so the values line up across the scroll.
private struct DuplicateCardColumn: View {
    let client: Client
    let index: Int
    let rows: [DuplicateComparisonRow]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                InitialsAvatar(name: client.fullName, size: 32)
                Spacer(minLength: 0)
                if client.archived {
                    StatusBadge(text: "Архив", color: .gray)
                }
            }
            ForEach(rows) { row in
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(row.values[index] ?? "—")
                        .font(.subheadline.weight(row.conflicts && row.values[index] != nil ? .semibold : .regular))
                        .foregroundStyle(color(of: row))
                        .monospacedDigit()
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
            }
        }
        .frame(width: 210, alignment: .leading)
        .cardStyle(padding: 14)
        .accessibilityElement(children: .combine)
    }

    /// Empty — dimmed; differs from another card in who the person is — orange.
    private func color(of row: DuplicateComparisonRow) -> Color {
        guard row.values[index] != nil else { return .secondary }
        return row.conflicts ? .orange : .primary
    }
}
