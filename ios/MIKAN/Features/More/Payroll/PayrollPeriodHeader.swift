import SwiftUI

/// The analytics period chips with payroll periods, the custom range pickers and the range title.
struct PayrollPeriodHeader: View {
    @Binding var selection: PayrollPeriodSelection

    var body: some View {
        // In the content, not a top bar: a horizontal scroll view gets no height of its own in a safe area bar.
        AnalyticsPeriodBar(period: $selection.option)
            .padding(.horizontal, -16)
        if selection.option == .custom {
            VStack(spacing: 8) {
                DatePicker("С", selection: $selection.customFrom, displayedComponents: .date)
                DatePicker("По", selection: $selection.customTo, displayedComponents: .date)
                Text("Не больше \(Plural.days(ReportPeriod.maxDays)).")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .cardStyle()
        }
        Text(selection.range().title())
            .font(.title2.weight(.bold))
            .contentTransition(.opacity)
            .accessibilityAddTraits(.isHeader)
    }
}
