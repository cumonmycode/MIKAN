import SwiftUI

// Pieces of the SMM knowledge base: long texts that fold, the state of a document being studied, a calendar row
// and the tattoo & piercing reference.

/// Text folded to a few lines with «Читать полностью» / «Свернуть».
struct SmmKnowledgeExpandableText: View {
    let text: String
    var lines = 6

    @State private var isExpanded = false

    /// Roughly how many characters fit a line of the list.
    private static let charactersPerLine = 70

    private var isLong: Bool {
        text.split(whereSeparator: \.isNewline).count > lines || text.count > lines * Self.charactersPerLine
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(text)
                .font(.subheadline)
                .lineLimit(isExpanded ? nil : lines)
                .textSelection(.enabled)
            if isLong {
                Button(isExpanded ? "Свернуть" : "Читать полностью") {
                    withAnimation(.snappy) { isExpanded.toggle() }
                }
                .font(.subheadline)
                .buttonStyle(.borderless)
            }
        }
    }
}

/// Small capital caption over a text: whose words these are.
struct SmmKnowledgeCaption: View {
    let text: String

    var body: some View {
        Text(text.uppercased())
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
    }
}

/// The marketer is studying the document (the live bar), or the last attempt failed.
struct SmmKnowledgeDocState: View {
    let progress: SmmProgress?
    let error: String?

    var body: some View {
        if let progress {
            SmmProgressBanner(progress: progress)
        } else if let error = error.nonEmpty {
            Label(error, systemImage: "exclamationmark.triangle.fill")
                .font(.footnote)
                .foregroundStyle(.red)
        }
    }
}

/// A holiday or an own date: the day badge in the tone's color, the title and what it means for the posts.
struct SmmKnowledgeDateRow: View {
    let date: SmmDate

    private static let monthsShort = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"]
    /// Weight 3 — a themed post is required.
    private static let requiredWeight = 3

    var body: some View {
        HStack(spacing: 12) {
            badge
            VStack(alignment: .leading, spacing: 2) {
                Text(date.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(2)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
    }

    private var badge: some View {
        let parts = date.date.split(separator: "-").compactMap { Int($0) }
        let day = parts.count >= 3 ? parts[2] : 0
        let month = parts.count >= 2 ? parts[1] : 0
        let tint = date.tone.tint
        return VStack(spacing: 0) {
            Text("\(day)")
                .font(.headline)
                .monospacedDigit()
            Text((1...12).contains(month) ? Self.monthsShort[month - 1] : "")
                .font(.caption2)
        }
        .foregroundStyle(tint)
        .frame(width: 48, height: 48)
        .background(tint.opacity(0.14), in: .rect(cornerRadius: 12))
        .accessibilityLabel(SmmText.dayTitle(date.date))
    }

    private var subtitle: String {
        var head = date.own == true ? "Своя дата · \(date.tone.title)" : date.tone.title
        if date.weight >= Self.requiredWeight { head += " · обязательно пост" }
        guard let note = date.note.nonEmpty else { return head }
        return "\(head) — \(note)"
    }
}

/// Tattoo & piercing reference the marketer leans on (read-only), section by section.
struct SmmCraftSectionRow: View {
    let section: SmmCraftSection

    @State private var isExpanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            Text(section.text)
                .font(.subheadline)
                .textSelection(.enabled)
                .padding(.vertical, 4)
        } label: {
            Text(section.title)
                .font(.headline)
        }
    }
}

/// An own date waiting for the delete confirmation.
struct SmmOwnDateRef: Identifiable, Hashable {
    let id: String
    let title: String
}
