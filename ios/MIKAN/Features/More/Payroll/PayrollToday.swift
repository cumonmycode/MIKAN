import Foundation

/// Today's pay at a glance: the studio day as a payroll range and what the day's statements add up to.
nonisolated struct PayrollTodaySummary: Hashable, Sendable {
    /// Employees who earned, were docked or worked today, the most earned first (then by name).
    let statements: [PayrollStatement]

    init(_ statements: [PayrollStatement]) {
        self.statements = statements
            .filter(Self.hasActivity)
            .sorted { lhs, rhs in
                if lhs.earned != rhs.earned { return lhs.earned > rhs.earned }
                return lhs.employee.name.localizedStandardCompare(rhs.employee.name) == .orderedAscending
            }
    }

    var isEmpty: Bool { statements.isEmpty }
    var earned: Int { statements.reduce(0) { $0 + $1.earned } }
    var visits: Int { statements.reduce(0) { $0 + $1.services.visits } }

    /// The employee's own day, `nil` when nothing happened for them today.
    func statement(of employeeId: Int) -> PayrollStatement? {
        statements.first { $0.employee.id == employeeId }
    }

    /// The day of `now` as a one-day range: `GET /payroll?from=&to=` takes studio dates inclusive.
    static func range(now: Date = .now, calendar: Calendar = .app) -> PayrollRange {
        PayrollPeriodOption.today.range(now: now, customFrom: now, customTo: now, calendar: calendar)
    }

    /// A pay line, a visit, a sale or a bonus/penalty today. The owner's list also has employees with rules and an
    /// empty day; those are left out.
    static func hasActivity(_ statement: PayrollStatement) -> Bool {
        statement.earned != 0 || statement.services.visits > 0 || statement.products.revenue > 0 || statement.days > 0
    }
}
