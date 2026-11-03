import Foundation

/// The analytics of a period as a CSV table for Excel / Numbers: `;`-separated (what Russian Excel expects), CRLF
/// line ends, money in whole rubles without grouping, percents with a decimal comma. Sections follow the screen.
nonisolated enum AnalyticsCSV {
    static let separator = ";"
    static let lineEnd = "\r\n"

    static func make(_ a: ReportAnalytics, period: String, previousPeriod: String) -> String {
        let sections: [[[String]]] = [
            [["Аналитика MIKAN STUDIO", period], ["Сравнение с периодом", previousPeriod]],
            totals(a),
            revenue(a),
            series(a),
            services(a.services),
            products(a.products),
            stock(a.stock),
            deposits(a.deposits),
            loyalty(a.loyalty),
            cash(a.cash),
            people(a),
        ].filter { !$0.isEmpty }
        return sections.map { $0.map(row).joined(separator: lineEnd) }.joined(separator: lineEnd + lineEnd) + lineEnd
    }

    static func row(_ fields: [String]) -> String {
        fields.map(escape).joined(separator: separator)
    }

    /// Quotes a field holding the separator, a quote or a line break (quotes doubled).
    static func escape(_ field: String) -> String {
        guard field.contains(where: { $0 == ";" || $0 == "\"" || $0 == "\n" || $0 == "\r" }) else { return field }
        return "\"" + field.replacingOccurrences(of: "\"", with: "\"\"") + "\""
    }

    /// «57,6» — percents with a decimal comma, empty when unknown.
    static func percent(_ value: Double?) -> String {
        value.map { $0.formatted(.number.precision(.fractionLength(0...1)).grouping(.never).locale(.app)) } ?? ""
    }

    /// «MIKAN аналитика 2026-10-01 — 2026-10-18.csv» (the last day of the half-open interval).
    static func fileName(_ interval: DateInterval, calendar: Calendar = .app) -> String {
        let last = calendar.date(byAdding: .day, value: -1, to: interval.end).map { max($0, interval.start) } ?? interval.start
        let first = CalendarDay.string(from: interval.start, calendar: calendar)
        let end = CalendarDay.string(from: last, calendar: calendar)
        return first == end ? "MIKAN аналитика \(first).csv" : "MIKAN аналитика \(first) — \(end).csv"
    }

    private static func totals(_ a: ReportAnalytics) -> [[String]] {
        let t = a.totals
        let p = a.previous
        func line(_ title: String, _ current: Int, _ previous: Int) -> [String] {
            [title, String(current), String(previous), AnalyticsDelta.of(current, previous: previous).text]
        }
        return [
            ["Показатель", "Период", "Предыдущий период", "Изменение"],
            line("Выручка, ₽", t.net, p.net),
            line("Продажи, ₽", t.gross, p.gross),
            line("Возвраты, ₽", t.refunds, p.refunds),
            line("Чеков", t.salesCount, p.salesCount),
            line("Средний чек, ₽", t.averageCheck, p.averageCheck),
            line("Скидки, ₽", t.discounts, p.discounts),
            line("Услуги, ₽", t.servicesRevenue, p.servicesRevenue),
            line("Товары, ₽", t.productsRevenue, p.productsRevenue),
            line("Себестоимость товаров, ₽", t.cogs, p.cogs),
            line("Валовая прибыль с товаров, ₽", t.grossProfit, p.grossProfit),
            ["Маржа, %", percent(t.marginPercent), percent(p.marginPercent), AnalyticsDelta.points(t.marginPercent, previous: p.marginPercent).text],
            line("Расходы склада, ₽", t.stockExpenses, p.stockExpenses),
            line("Новые клиенты", t.newClients, p.newClients),
            line("Завершённые записи", t.appointmentsCompleted, p.appointmentsCompleted),
            line("Неявки", t.noShows, p.noShows),
            line("Потери от неявок, ₽", t.noShowLoss, p.noShowLoss),
            line("Получено предоплат, ₽", t.depositsReceived, p.depositsReceived),
        ]
    }

    private static func revenue(_ a: ReportAnalytics) -> [[String]] {
        let r = a.revenue
        let payments = AnalyticsChartData.paymentSlices(r.payments).map { [$0.title, String($0.amount)] }
        return [
            ["Выручка и возвраты", "₽"],
            ["Продажи (чеки периода)", String(r.gross)],
            ["Возвраты (\(r.refundsCount))", String(r.refunds)],
            ["Выручка", String(r.net)],
            ["Скидки", String(r.discounts)],
            ["Чеков", String(r.salesCount)],
            ["Средний чек", String(r.averageCheck)],
            ["Чеки без возвратов", String(r.kept)],
            [],
            ["Способы оплаты", "₽"],
        ] + payments
    }

    private static func series(_ a: ReportAnalytics) -> [[String]] {
        let days = a.byDay.map { [$0.date, String($0.gross), String($0.refunds), String($0.net), String($0.salesCount)] }
        let weekdays = AnalyticsChartData.weekdayBars(a.byWeekday).map { [ReportText.weekday($0.id, full: true), String($0.revenue), String($0.salesCount)] }
        let hours = a.byHour.map { [ReportText.hour($0.hour), String($0.revenue), String($0.salesCount)] }
        return [["По дням"], ["Дата", "Продажи, ₽", "Возвраты, ₽", "Выручка, ₽", "Чеков"]] + days
            + [[], ["По дням недели"], ["День", "Выручка, ₽", "Чеков"]] + weekdays
            + [[], ["По часам"], ["Час", "Выручка, ₽", "Чеков"]] + hours
    }

    private static func services(_ s: AnalyticsServices) -> [[String]] {
        let categories = s.byCategory.map { [ReportText.categoryTitle($0.category), String($0.quantity), String($0.revenue)] }
        let top = s.top.map { [$0.name, ReportText.categoryTitle($0.category), String($0.quantity), String($0.revenue)] }
        return [["Услуги по категориям"], ["Категория", "Количество", "Выручка, ₽"]] + categories
            + [["Всего", String(s.quantity), String(s.revenue)], [], ["Топ услуг"], ["Услуга", "Категория", "Количество", "Выручка, ₽"]] + top
    }

    private static let marginHeader = ["Количество", "Выручка, ₽", "Себестоимость, ₽", "Валовая прибыль, ₽", "Маржа, %", "Без себестоимости, шт."]

    private static func margin(_ m: AnalyticsMargin) -> [String] {
        [String(m.quantity), String(m.revenue), String(m.cogs), String(m.grossProfit), percent(m.marginPercent), String(m.itemsWithoutCost)]
    }

    private static func products(_ p: AnalyticsProducts) -> [[String]] {
        let kinds = p.byKind.map { [ReportText.kindTitle($0.kind)] + margin($0.margin) }
        let top = p.top.flatMap { product in
            [[product.name, ""] + margin(product.margin)]
                + product.variants.filter { !$0.name.isEmpty }.map { [product.name, $0.name] + margin($0.margin) }
        }
        return [["Товары по видам"], ["Вид"] + marginHeader] + kinds + [["Всего"] + margin(p.margin)]
            + [[], ["Топ товаров"], ["Товар", "Размер"] + marginHeader] + top
    }

    private static func stock(_ s: AnalyticsStock) -> [[String]] {
        let top = s.top.map { [$0.name, ReportText.stockExpenseTitle($0), String($0.quantity), String($0.value)] }
        let onHand = s.onHand.byKind.map { [ReportText.kindTitle($0.kind), String($0.units), String($0.value), String($0.unitsWithoutCost)] }
        return [
            ["Расходы склада", "Количество", "По себестоимости, ₽", "Без себестоимости, шт."],
            ["Списания", String(s.writeoffs.quantity), String(s.writeoffs.value), String(s.writeoffs.unitsWithoutCost)],
            ["Расход на процедуры", String(s.usage.quantity), String(s.usage.value), String(s.usage.unitsWithoutCost)],
            ["Покупки расходников", String(s.purchases.count), String(s.purchases.value), ""],
            ["Итого", "", String(s.expenses), ""],
            [],
            ["Товар", "Операция", "Количество", "Сумма, ₽"],
        ] + top + [[], ["На складе сейчас", "Количество", "По себестоимости, ₽", "Без себестоимости, шт."]] + onHand
            + [["Всего", String(s.onHand.units), String(s.onHand.value), String(s.onHand.unitsWithoutCost)]]
    }

    private static func deposits(_ d: ReportDeposits) -> [[String]] {
        [
            ["Предоплаты", "₽"],
            ["Получено", String(d.received)],
            ["Зачтено в чеках", String(d.applied)],
            ["Возвращено клиентам", String(d.refunded)],
            ["Удержано", String(d.retained)],
            ["На руках на конец периода", String(d.held)],
        ]
    }

    /// Left out when the studio has no bonuses or certificates.
    static func loyalty(_ l: AnalyticsLoyalty) -> [[String]] {
        guard !l.isZero else { return [] }
        let bonuses = AnalyticsLoyaltyText.bonusRows(l).map { [$0.title, String($0.amount)] }
        let certificates = AnalyticsLoyaltyText.certificateRows(l).map { [$0.title, String($0.amount)] }
        return [["Бонусы", "Бонусов"]] + bonuses + [[], ["Подарочные сертификаты", "₽"]] + certificates
    }

    private static func cash(_ c: AnalyticsCash) -> [[String]] {
        let shifts = c.shifts.map { shift in
            [
                CalendarDay.string(from: shift.closedAt ?? shift.openedAt), shift.closedBy?.name ?? "",
                shift.openingDifference.map(String.init) ?? "", String(shift.difference),
            ]
        }
        return [
            ["Касса", "₽"],
            ["Внесения", String(c.cashIn)],
            ["Изъятия", String(c.cashOut)],
            ["Закрыто смен", String(c.shiftsClosed)],
            ["Расхождение при закрытии", String(c.closingDifference)],
            ["Недостачи", String(c.shortage)],
            ["Излишки", String(c.surplus)],
            ["Расхождение при открытии", String(c.openingDifference)],
            [],
            ["Смена закрыта", "Закрыл", "Расхождение при открытии, ₽", "Расхождение при закрытии, ₽"],
        ] + shifts
    }

    private static func people(_ a: ReportAnalytics) -> [[String]] {
        let masters = a.masters.map {
            [$0.employee.name, String($0.revenue), String($0.salesCount), String($0.averageCheck), String($0.appointmentsCompleted), String($0.noShows), String($0.servicesCount)]
        }
        let c = a.clients
        let top = c.top.map { [$0.client.fullName, PhoneText.display($0.client.phone), String($0.revenue), String($0.salesCount), String($0.visits)] }
        let ap = a.appointments
        return [["Мастера"], ["Мастер", "Выручка, ₽", "Чеков", "Средний чек, ₽", "Записей", "Неявок", "Услуг"]] + masters
            + [
                [], ["Клиенты", "Количество", "Выручка, ₽"],
                ["Новые карточки", String(c.newClients), ""],
                ["Покупатели", String(c.buyers), String(c.firstTime.revenue + c.returning.revenue)],
                ["Впервые", String(c.firstTime.count), String(c.firstTime.revenue)],
                ["Повторные", String(c.returning.count), String(c.returning.revenue)],
                ["Чеки без клиента", String(c.anonymous.salesCount), String(c.anonymous.revenue)],
                [], ["Топ клиентов"], ["Клиент", "Телефон", "Выручка, ₽", "Чеков", "Визитов"],
            ] + top
            + [
                [], ["Записи", "Количество", "₽"],
                ["Всего", String(ap.total), ""],
                ["Завершены", String(ap.completed), ""],
                ["Ожидаются", String(ap.open), ""],
                ["Отменены", String(ap.cancelled), String(ap.cancelledValue)],
                ["Неявки", String(ap.noShow), String(ap.noShowLoss)],
            ]
    }
}
