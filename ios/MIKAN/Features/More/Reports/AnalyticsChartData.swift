import Foundation

/// Chart-ready data of the analytics cards (pure, so the mapping is unit-tested).
nonisolated enum AnalyticsChartData {
    /// Up to this many days the revenue chart shows days; longer ranges are summed by month.
    static let maxDailyBars = 62

    enum Granularity: Equatable, Sendable {
        case day, month
    }

    struct RevenuePoint: Identifiable, Equatable, Sendable {
        /// The day, or the first day of the month.
        let date: Date
        let net: Int
        let gross: Int
        let refunds: Int
        let salesCount: Int

        var id: Date { date }
    }

    /// Revenue bars of the period: days (`YYYY-MM-DD` parsed as local days), or months for a long range.
    static func revenuePoints(_ days: [AnalyticsDay], calendar: Calendar = .app) -> (granularity: Granularity, points: [RevenuePoint]) {
        let daily = days.compactMap { day in
            CalendarDay.date(from: day.date, calendar: calendar).map {
                RevenuePoint(date: $0, net: day.net, gross: day.gross, refunds: day.refunds, salesCount: day.salesCount)
            }
        }
        guard daily.count > maxDailyBars else { return (.day, daily) }
        var months: [RevenuePoint] = []
        for point in daily {
            let month = calendar.dateInterval(of: .month, for: point.date)?.start ?? point.date
            if let last = months.last, last.date == month {
                months[months.count - 1] = RevenuePoint(
                    date: month, net: last.net + point.net, gross: last.gross + point.gross,
                    refunds: last.refunds + point.refunds, salesCount: last.salesCount + point.salesCount
                )
            } else {
                months.append(RevenuePoint(date: month, net: point.net, gross: point.gross, refunds: point.refunds, salesCount: point.salesCount))
            }
        }
        return (.month, months)
    }

    /// A share of a whole: a payment method, services, a product kind.
    struct Slice: Identifiable, Equatable, Sendable {
        let id: String
        let title: String
        let symbol: String
        let amount: Int
        /// 0…1 of the slices' total.
        let share: Double
    }

    private static func slices(_ parts: [(id: String, title: String, symbol: String, amount: Int)]) -> [Slice] {
        let visible = parts.filter { $0.amount > 0 }
        let total = visible.reduce(0) { $0 + $1.amount }
        return visible.map { Slice(id: $0.id, title: $0.title, symbol: $0.symbol, amount: $0.amount, share: ReportText.share($0.amount, of: total)) }
    }

    /// How the sales were paid: the methods used, then the part covered by prepayments received earlier,
    /// bonuses and gift certificates.
    static func paymentSlices(_ payments: Payments) -> [Slice] {
        let split = PaymentSplit(payments)
        let methods = [PaymentMethod.cash, .transfer, .qr, .card].map { method in
            (id: method.rawValue, title: method.title, symbol: method.symbol, amount: split[method])
        }
        return slices(methods + [
            (id: "deposit", title: "Из предоплат", symbol: "rublesign.circle", amount: payments.deposit),
            (id: "bonus", title: "Бонусами", symbol: PaymentLine.bonusSymbol, amount: payments.bonus),
            (id: "certificate", title: "Сертификатами", symbol: PaymentLine.certificateSymbol, amount: payments.certificate),
        ])
    }

    /// Services against each product kind that sold.
    static func structureSlices(services: Int, kinds: [AnalyticsProductKind]) -> [Slice] {
        let products = kinds.map { kind in
            (id: "kind-\(kind.kind)", title: ReportText.kindTitle(kind.kind), symbol: "shippingbox", amount: kind.margin.revenue)
        }
        return slices([(id: "services", title: "Услуги", symbol: "sparkle", amount: services)] + products)
    }

    /// A weekday or an hour of the timing chart.
    struct Bar: Identifiable, Equatable, Sendable {
        let id: Int
        let label: String
        let revenue: Int
        let salesCount: Int
    }

    /// Monday…Sunday, always seven bars (missing days are zero).
    static func weekdayBars(_ weekdays: [AnalyticsWeekday]) -> [Bar] {
        (1...7).map { weekday in
            let entry = weekdays.first { $0.weekday == weekday }
            return Bar(id: weekday, label: ReportText.weekday(weekday), revenue: entry?.revenue ?? 0, salesCount: entry?.salesCount ?? 0)
        }
    }

    /// Hours from the first to the last one with sales (the night stays out of the chart); empty without sales.
    static func hourBars(_ hours: [AnalyticsHour]) -> [Bar] {
        let busy = hours.filter { $0.salesCount > 0 }.map(\.hour)
        guard let first = busy.min(), let last = busy.max() else { return [] }
        return (first...last).map { hour in
            let entry = hours.first { $0.hour == hour }
            return Bar(id: hour, label: String(hour), revenue: entry?.revenue ?? 0, salesCount: entry?.salesCount ?? 0)
        }
    }

    /// The bar with the most revenue (`nil` when all are zero).
    static func peak(_ bars: [Bar]) -> Bar? {
        guard let best = bars.max(by: { $0.revenue < $1.revenue }), best.revenue > 0 else { return nil }
        return best
    }
}
