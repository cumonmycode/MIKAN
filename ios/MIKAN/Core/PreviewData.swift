#if DEBUG
import Foundation
import SwiftUI

/// Sample data for SwiftUI previews only.
enum PreviewData {
    static let now = Date.now
    static let today = Calendar.app.startOfDay(for: now)

    static func at(hour: Int, minute: Int = 0, dayOffset: Int = 0) -> Date {
        let day = Calendar.app.date(byAdding: .day, value: dayOffset, to: today) ?? today
        return Calendar.app.date(bySettingHour: hour, minute: minute, second: 0, of: day) ?? day
    }

    static let anna = Employee(
        id: 1, name: "Анна Смирнова", login: "anna", phone: "+79991234567",
        color: "#FF7A1A", isMaster: true, active: true, createdAt: now
    )
    static let oleg = Employee(
        id: 2, name: "Олег", login: "oleg", phone: nil,
        color: "#0090FF", isMaster: true, active: true, createdAt: now
    )
    static let employees = [anna, oleg]

    static let ivanRef = ClientRef(id: 1, name: "Иван", lastName: "Петров", phone: "+79991234567", telegramLinked: true)
    static let mariaRef = ClientRef(id: 2, name: "Мария Ким", phone: "+79161112233", telegramLinked: false)

    static let ivan = Client(
        id: 1, name: "Иван", lastName: "Петров", phone: "+79991234567", instagram: "ivan.p", telegramNick: "ivan_petrov",
        birthday: "1995-04-12",
        notes: "Аллергия на никель", source: "instagram", telegramLinked: true, telegramUsername: "ivanp",
        botEnabled: true, archived: false, createdAt: now, updatedAt: now,
        stats: ClientStats(visits: 3, totalSpent: 25_000, lastVisitAt: at(hour: 12, dayOffset: -20), upcomingAppointments: 1)
    )
    static let maria = Client(
        id: 2, name: "Мария Ким", phone: "+79161112233", instagram: nil, birthday: nil, notes: nil,
        source: "рекомендация", telegramLinked: false, telegramUsername: nil, botEnabled: true,
        archived: false, createdAt: now, updatedAt: now, stats: nil
    )
    static let clients = [ivan, maria]

    static let lobe = Service(
        id: 3, name: "Прокол мочки", category: .piercing, group: "Ухо", price: 1600, priceFrom: false, durationMin: 30,
        description: "Lobe — классический прокол мочки уха.", aftercareTemplateId: 2, active: true, sort: 0
    )
    static let tattoo = Service(
        id: 4, name: "Мини тату до 5 см", category: .tattoo, group: "Тату", price: 2000, priceMax: 5000, priceFrom: true,
        durationMin: 60, description: "Итоговая стоимость зависит от объёма и сложности.", aftercareTemplateId: 1,
        active: true, sort: 1
    )
    static let nipple = Service(
        id: 5, name: "Соски", category: .piercing, group: "Тело", price: 2500, priceFrom: false, durationMin: 45,
        description: "Nipple — прокол проходит через сосок, избегая ареолы.",
        variants: [
            ServiceVariant(name: "Один", price: 2500, durationMin: nil),
            ServiceVariant(name: "Два", price: 4000, durationMin: 60),
        ],
        depositAmount: 1000, aftercareTemplateId: 2, healingCheckDays: 7, jewelryChangeWeeks: 6, active: true, sort: 2
    )
    static let services = [lobe, tattoo, nipple]

    static let template = AftercareTemplate(
        id: 1, name: "Уход за татуировкой", category: .tattoo,
        steps: [
            AftercareStep(dayOffset: 0, text: "Снимите плёнку через 3 часа и промойте тату тёплой водой."),
            AftercareStep(dayOffset: 1, text: "Наносите заживляющий крем тонким слоем 3 раза в день."),
            AftercareStep(dayOffset: 7, text: "Как заживает? Пришлите фото, если что-то беспокоит."),
        ],
        createdAt: now, updatedAt: now
    )

    static let appointments = [
        Appointment(
            id: 1, client: ivanRef, master: anna.ref, service: tattoo.ref, title: "Предплечье, эскиз согласован",
            startsAt: at(hour: 11), endsAt: at(hour: 13), status: .confirmed, price: 8000, deposit: 2000,
            depositRequired: 2000, depositStatus: .paid, depositOperations: [depositReceived],
            notes: "Принести эскиз в цвете", saleId: nil, completedAt: nil, createdAt: now, updatedAt: now,
            cancellation: AppointmentCancellation(freeUntil: at(hour: 11).addingTimeInterval(-86_400), lateRetain: 2000, noShowRetain: 2000)
        ),
        Appointment(
            id: 2, client: mariaRef, master: oleg.ref, service: lobe.ref, title: nil,
            startsAt: at(hour: 14, minute: 30), endsAt: at(hour: 15), status: .scheduled, price: 2500, deposit: 0,
            depositRequired: 1000, depositStatus: .waiting, depositLink: depositLink,
            notes: nil, saleId: nil, completedAt: nil, createdAt: now, updatedAt: now
        ),
        Appointment(
            id: 3, client: ivanRef, master: anna.ref, service: lobe.ref,
            services: [
                AppointmentServiceLine(id: 1, serviceId: 3, name: "Прокол мочки", category: .piercing, price: 1600, durationMin: 30),
                AppointmentServiceLine(id: 2, serviceId: 5, name: "Соски — Один", category: .piercing, price: 900, durationMin: nil),
            ],
            title: nil,
            startsAt: at(hour: 17), endsAt: at(hour: 17, minute: 30), status: .completed, price: 2500, deposit: 0,
            notes: nil, saleId: 9, completedAt: now, createdAt: now, updatedAt: now
        ),
    ]

    static let labret = Product(
        id: 1, kind: .jewelry, name: "Лабрет", sku: "LB-12", category: "Лабрет", material: "Титан ASTM F136",
        threadType: .internalThread, thicknessMm: 1.2, color: "Серебристый", stone: "Фианит", supplier: "Industrial Strength",
        size: nil, description: "Плоский диск, внутренняя резьба — подходит для первичного прокола.",
        price: 1500, cost: 600, quantity: 0, minQuantity: 0, unit: "шт",
        photoUrl: nil, serviceIds: [3], active: true, lowStock: false,
        variants: [
            ProductVariant(id: 1, name: "6 мм", sku: nil, price: nil, cost: nil, quantity: 4, minQuantity: 1, lowStock: false),
            ProductVariant(id: 4, name: "8 мм", sku: "LB-12-08", price: nil, cost: nil, quantity: 1, minQuantity: 2, lowStock: true),
            ProductVariant(id: 5, name: "10 мм", sku: "LB-12-10", price: 1700, cost: 700, quantity: 0, minQuantity: 0, lowStock: true),
        ],
        createdAt: now, updatedAt: now
    )
    static let ring = Product(
        id: 2, kind: .jewelry, name: "Кольцо-кликер", sku: "CL-10", category: "Кольцо", material: "Титан ASTM F136",
        thicknessMm: 1.2, size: "1.2×10 мм", description: nil, price: 2800, cost: 1100, quantity: 2, minQuantity: 3,
        unit: "шт", photoUrl: nil, active: true, lowStock: true, createdAt: now, updatedAt: now
    )
    static let needles = Product(
        id: 3, kind: .consumable, name: "Иглы 1.2 мм", sku: nil, category: "Иглы", material: nil,
        size: nil, description: nil, price: 0, cost: 40, quantity: 48, minQuantity: 20, unit: "шт",
        photoUrl: nil, active: true, lowStock: false, createdAt: now, updatedAt: now
    )
    static let products = [labret, ring, needles]

    static let movement = StockMovement(
        id: 1, productId: 1, productName: "Лабрет", variantId: 4, variantName: "8 мм", delta: -1, quantityAfter: 1,
        type: .sale, note: nil, saleId: 5, appointmentId: nil, employee: anna.ref, createdAt: now
    )

    static let sale = Sale(
        id: 9, number: 17, client: ivanRef, employee: anna.ref, appointmentId: 3, shiftId: 3,
        items: [
            SaleItem(
                id: 1, type: .product, productId: 1, variantId: 4, variantName: "8 мм", serviceId: nil,
                name: "Лабрет — 8 мм", quantity: 1, price: 1500, total: 1500
            ),
            SaleItem(id: 2, type: .service, productId: nil, serviceId: 3, name: "Прокол мочки", quantity: 1, price: 2500, total: 2500),
        ],
        subtotal: 4000, discount: 500, total: 3500,
        payments: Payments(cash: 1500, card: 0, transfer: 0, deposit: 2000),
        status: .completed, note: nil, refundedAt: nil, refundReason: nil, createdAt: now
    )

    static let historyEntries = [
        HistoryEntry(
            id: "as1", kind: .service, date: at(hour: 17), name: "Прокол мочки", serviceId: 3, productId: nil,
            quantity: 1, price: 1600, total: 1600, client: ivanRef, employee: anna.ref, appointmentId: 3,
            saleId: 9, saleNumber: 17, refunded: false
        ),
        HistoryEntry(
            id: "si1", kind: .product, date: at(hour: 17, minute: 40), name: "Лабрет — 8 мм", serviceId: nil, productId: 1,
            variantId: 4, variantName: "8 мм", quantity: 2, price: 1500, total: 3000, client: ivanRef, employee: anna.ref, appointmentId: nil,
            saleId: 9, saleNumber: 17, refunded: true
        ),
    ]
    /// Prepayment of `appointments[0]`, received by transfer.
    static let depositReceived = DepositOperation(
        id: 1, appointmentId: 1, type: .receive, amount: 2000, method: .transfer, saleId: nil, shiftId: 3,
        qrPaymentId: nil, note: nil, employee: anna.ref, createdAt: at(hour: 14, minute: 5, dayOffset: -2)
    )
    /// Prepayment link of `appointments[1]`, sent by the bot.
    static let depositLink = QrPayment(
        id: 6, kind: .deposit, appointmentId: 2, status: .pending, amount: 1000,
        payload: "https://qr.nspk.ru/AD10001B38T99KA99CD8S37FMTH8CFQ8?type=02&bank=100000000065&sum=100000&cur=RUB&crc=43B7",
        expiresAt: at(hour: 14, minute: 30), sentAt: at(hour: 9), error: nil, sale: nil, createdAt: at(hour: 9)
    )

    static let qrPayment = QrPayment(
        id: 5, status: .pending, amount: 3500,
        payload: "https://qr.nspk.ru/AD10001B38T99KA99CD8S37FMTH8CFQ7?type=02&bank=100000000065&sum=350000&cur=RUB&crc=43B6",
        expiresAt: Date.now.addingTimeInterval(9 * 60), error: nil, sale: nil, createdAt: .now
    )

    static let shift = CashShift(
        id: 3, openedAt: at(hour: 10, minute: 2), openedBy: anna.ref, openingCash: 5000,
        closedAt: nil, closedBy: nil, closingCash: nil, note: nil, expectedCash: 8500, difference: nil,
        summary: ShiftSummary(salesCount: 3, revenue: 10_000, cash: 2500, card: 0, transfer: 5000, deposit: 2500,
                              refunds: 0, cashRefunds: 0, cashIn: 0, cashOut: 0,
                              deposits: ShiftDepositSummary(received: 3000, cash: 1000, transfer: 2000)),
        operations: []
    )

    static let report = ReportSummary(
        from: today, to: now, revenue: 120_000, salesCount: 40, averageCheck: 3000, refunds: 2500,
        payments: Payments(cash: 30_000, card: 0, transfer: 20_000, qr: 60_000, deposit: 10_000),
        deposits: ReportDeposits(received: 15_000, cash: 2000, transfer: 3000, qr: 10_000,
                                 applied: 10_000, refunded: 1000, retained: 2000, held: 7000),
        servicesRevenue: 90_000, productsRevenue: 30_000,
        byDay: [ReportDay(date: CalendarDay.string(from: today), revenue: 8000, salesCount: 3)],
        topProducts: [TopProduct(
            productId: 1, name: "Лабрет", quantity: 7, revenue: 10_500,
            variants: [
                TopProductVariant(variantId: 4, name: "8 мм", quantity: 4, revenue: 6000),
                TopProductVariant(variantId: 1, name: "6 мм", quantity: 3, revenue: 4500),
            ]
        )],
        topServices: [TopService(serviceId: 3, name: "Прокол мочки", quantity: 12, revenue: 30_000)],
        byMaster: [MasterStat(employee: anna.ref, appointmentsCompleted: 10, revenue: 50_000)],
        newClients: 14, appointmentsCompleted: 35, noShows: 2
    )

    static let analytics = ReportAnalytics(
        from: Calendar.app.date(byAdding: .day, value: -6, to: today) ?? today,
        to: Calendar.app.date(byAdding: .day, value: 1, to: today) ?? now,
        previousFrom: Calendar.app.date(byAdding: .day, value: -13, to: today) ?? today,
        previousTo: Calendar.app.date(byAdding: .day, value: -6, to: today) ?? today,
        timezone: "Europe/Moscow",
        totals: AnalyticsTotals(
            net: 118_000, gross: 120_500, refunds: 2500, salesCount: 40, averageCheck: 3013, discounts: 1800,
            servicesRevenue: 88_000, productsRevenue: 30_000, cogs: 11_000, grossProfit: 17_500, marginPercent: 61.4,
            stockExpenses: 2350, newClients: 14, appointmentsCompleted: 35, noShows: 2, noShowLoss: 8000, depositsReceived: 15_000
        ),
        previous: AnalyticsTotals(
            net: 101_000, gross: 101_000, salesCount: 36, averageCheck: 2806, servicesRevenue: 80_000, productsRevenue: 21_000,
            cogs: 8000, grossProfit: 13_000, marginPercent: 61.9, stockExpenses: 3100, newClients: 9, appointmentsCompleted: 31,
            noShows: 3, noShowLoss: 12_000, depositsReceived: 9000
        ),
        revenue: AnalyticsRevenue(
            gross: 120_500, refunds: 2500, refundsCount: 1, net: 118_000, salesCount: 40, averageCheck: 3013, discounts: 1800,
            kept: 118_000, payments: Payments(cash: 30_500, card: 0, transfer: 20_000, qr: 60_000, deposit: 10_000)
        ),
        byDay: (0..<7).map { offset in
            let day = Calendar.app.date(byAdding: .day, value: offset - 6, to: today) ?? today
            let gross = [12_000, 18_500, 9000, 21_000, 25_000, 30_000, 5000][offset]
            return AnalyticsDay(date: CalendarDay.string(from: day), gross: gross, refunds: offset == 3 ? 2500 : 0,
                                net: gross - (offset == 3 ? 2500 : 0), salesCount: gross / 3000)
        },
        byWeekday: (1...7).map { AnalyticsWeekday(weekday: $0, revenue: [12_000, 18_500, 9000, 18_500, 25_000, 30_000, 5000][$0 - 1], salesCount: 6) },
        byHour: (0..<24).map { hour in
            AnalyticsHour(hour: hour, revenue: (11...20).contains(hour) ? 8000 + (hour % 4) * 3000 : 0, salesCount: (11...20).contains(hour) ? 4 : 0)
        },
        services: AnalyticsServices(
            quantity: 30, revenue: 88_000,
            byCategory: [AnalyticsServiceCategory(category: "piercing", quantity: 24, revenue: 58_000),
                         AnalyticsServiceCategory(category: "tattoo", quantity: 6, revenue: 30_000)],
            top: [AnalyticsService(serviceId: 3, name: "Прокол мочки", category: "piercing", quantity: 12, revenue: 30_000),
                  AnalyticsService(serviceId: 2, name: "Тату мини", category: "tattoo", quantity: 6, revenue: 30_000)]
        ),
        products: AnalyticsProducts(
            margin: AnalyticsMargin(quantity: 18, revenue: 30_000, revenueWithCost: 28_500, cogs: 11_000, grossProfit: 17_500,
                                    marginPercent: 61.4, itemsWithoutCost: 1),
            byKind: [AnalyticsProductKind(kind: "jewelry", margin: AnalyticsMargin(quantity: 18, revenue: 30_000, revenueWithCost: 28_500,
                                                                                   cogs: 11_000, grossProfit: 17_500, marginPercent: 61.4, itemsWithoutCost: 1))],
            top: [AnalyticsProduct(
                productId: 1, name: "Лабрет", kind: "jewelry",
                margin: AnalyticsMargin(quantity: 7, revenue: 10_500, revenueWithCost: 10_500, cogs: 4200, grossProfit: 6300, marginPercent: 60),
                variants: [AnalyticsProductVariant(variantId: 4, name: "8 мм", margin: AnalyticsMargin(quantity: 4, revenue: 6000)),
                           AnalyticsProductVariant(variantId: 1, name: "6 мм", margin: AnalyticsMargin(quantity: 3, revenue: 4500))]
            )]
        ),
        stock: AnalyticsStock(
            writeoffs: AnalyticsStockFlow(quantity: 2, value: 1200), usage: AnalyticsStockFlow(quantity: 115, value: 1150, unitsWithoutCost: 5),
            expenses: 2350,
            top: [AnalyticsStockExpense(productId: 1, name: "Лабрет", kind: "jewelry", type: "writeoff", quantity: 2, value: 1200),
                  AnalyticsStockExpense(productId: 3, name: "Перчатки", kind: "consumable", type: "usage", quantity: 115, value: 1150)],
            onHand: AnalyticsStockOnHand(units: 340, value: 96_000, unitsWithoutCost: 12,
                                         byKind: [AnalyticsStockKind(kind: "jewelry", units: 140, value: 84_000, unitsWithoutCost: 12),
                                                  AnalyticsStockKind(kind: "consumable", units: 200, value: 12_000)])
        ),
        deposits: ReportDeposits(received: 15_000, cash: 2000, transfer: 3000, qr: 10_000, applied: 10_000, refunded: 1000, retained: 2000, held: 7000),
        cash: AnalyticsCash(
            cashIn: 2000, cashOut: 15_000, operationsCount: 3, shiftsClosed: 6, closingDifference: -150, shortage: -200, surplus: 50,
            openingDifference: 0,
            shifts: [AnalyticsShift(id: 3, openedAt: at(hour: 10, dayOffset: -2), closedAt: at(hour: 21, dayOffset: -2), closedBy: anna.ref,
                                    openingCash: 5000, closingCash: 7800, expectedCash: 8000, openingDifference: 0, difference: -200)]
        ),
        masters: [AnalyticsMaster(employee: anna.ref, revenue: 50_000, salesCount: 14, averageCheck: 3571, appointmentsCompleted: 20, noShows: 1, servicesCount: 26),
                  AnalyticsMaster(employee: oleg.ref, revenue: 38_000, salesCount: 10, averageCheck: 3800, appointmentsCompleted: 15, noShows: 1, servicesCount: 15)],
        clients: AnalyticsClients(
            newClients: 14, buyers: 30, firstTime: AnalyticsClientGroup(count: 12, revenue: 40_000),
            returning: AnalyticsClientGroup(count: 18, revenue: 70_000), anonymous: AnalyticsAnonymousSales(salesCount: 5, revenue: 8000),
            top: [AnalyticsTopClient(client: ivanRef, revenue: 25_000, salesCount: 3, visits: 3),
                  AnalyticsTopClient(client: mariaRef, revenue: 12_000, salesCount: 2, visits: 1)]
        ),
        appointments: AnalyticsAppointments(total: 45, open: 5, completed: 35, cancelled: 3, noShow: 2, noShowLoss: 8000, cancelledValue: 9000),
        loyalty: AnalyticsLoyalty(
            bonusEarned: 3540, bonusSpent: 1200, bonusExpired: 300, bonusOutstanding: 18_400,
            certificatesSold: 15_000, certificatesRedeemed: 7000, certificatesExpired: 0, certificatesCancelled: 0,
            certificatesOutstanding: 23_000
        )
    )

    static let messages = [
        BotMessage(id: 1, chatId: 123_456_789, role: .user, text: "Здравствуйте! Сколько стоит прокол хеликса?", employee: nil, createdAt: at(hour: 9, minute: 40)),
        BotMessage(id: 2, chatId: 123_456_789, role: .assistant, text: "Здравствуйте! Прокол хеликса — 3 000 ₽, украшение из титана подбирается отдельно.", employee: nil, createdAt: at(hour: 9, minute: 41)),
        BotMessage(id: 3, chatId: 123_456_789, role: .staff, text: "Можем записать на субботу в 15:00 😊", employee: anna.ref, createdAt: at(hour: 9, minute: 50)),
        BotMessage(id: 4, chatId: 123_456_789, role: .system, text: "Напоминаем о записи завтра в 15:00.", employee: nil, createdAt: at(hour: 10)),
    ]

    static let chat = BotChat(
        chatId: 123_456_789, client: ivanRef, telegramName: "Иван", username: "ivanp", aiPaused: false,
        needsAttention: true, unreadCount: 2, lastMessage: messages.last, updatedAt: now
    )

    static let staffChat = BotChat(
        chatId: 555_000_111, client: nil, telegramName: "Анна", username: "anna_mikan", aiPaused: false,
        needsAttention: false, unreadCount: 0,
        lastMessage: BotMessage(
            id: 5, chatId: 555_000_111, role: .assistant, text: "Сегодня у вас 4 записи, первая в 11:00.",
            employee: nil, createdAt: at(hour: 9)
        ),
        updatedAt: now, employee: anna.ref
    )

    static let bookingRequest = BookingRequest(
        id: 1, chatId: 123_456_789, client: nil, contactName: "Иван", phone: "+79991234567",
        serviceName: "Прокол хеликса", preferredTime: "в субботу после 15:00", comment: "Хочу кольцо",
        status: .new, createdAt: now, updatedAt: now
    )

    static let studioSettings = StudioSettings(
        name: "MIKAN STUDIO", address: "ул. Ленина, 1", phone: "+79990000000",
        workingHours: "Ежедневно 11:00–21:00", instagram: "mikan.studio", website: "",
        about: "Тату и пирсинг", timezone: "Europe/Moscow", workdayStart: "11:00", workdayEnd: "21:00",
        cancellation: CancellationRules(freeHours: 24, lateRetainPercent: 100, noShowRetainPercent: 100, autoRetain: false),
        reviewLinks: ReviewLinks(yandex: "https://yandex.ru/maps/org/mikan/", twogis: "", google: "")
    )

    /// A started visit with a labret added, a receipt for a client, and an empty one.
    static let openReceipts: [OpenReceipt] = {
        var visit = appointments[0]
        visit.receiptId = 7
        let tattooLine = OpenReceiptItem(type: .service, serviceId: 4, name: "Мини тату до 5 см", quantity: 1, price: 8_000, total: 8_000)
        let labretLine = OpenReceiptItem(
            type: .product, productId: 1, variantId: 1, variantName: "8 мм", productKind: .jewelry,
            name: "Лабрет — 8 мм", quantity: 1, price: 1_500, total: 1_500, stock: 3
        )
        return [
            OpenReceipt(
                id: 7, appointment: visit, client: ivanRef, items: [tattooLine, labretLine], subtotal: 9_500, discount: 0,
                total: 9_500, itemCount: 2, note: nil, openedBy: anna.ref, createdAt: at(hour: 11, minute: 5), updatedAt: now
            ),
            OpenReceipt(
                id: 8, client: mariaRef, items: [labretLine], subtotal: 1_500, discount: 0, total: 1_500, itemCount: 1,
                openedBy: oleg.ref, createdAt: at(hour: 12, minute: 40), updatedAt: now
            ),
            OpenReceipt(
                id: 9, subtotal: 0, discount: 0, total: 0, itemCount: 0, openedBy: oleg.ref,
                createdAt: at(hour: 13, minute: 15), updatedAt: now
            ),
        ]
    }()

    static func appState(signedIn: Bool = true) -> AppState {
        let api = APIClient(serverURL: URL(string: "http://localhost:3000")!)
        return AppState(api: api, employee: signedIn ? anna : nil, phase: signedIn ? .signedIn : .signedOut)
    }
}

extension View {
    /// Injects a preview `AppState` and its stores.
    func previewEnvironment(signedIn: Bool = true) -> some View {
        appEnvironment(PreviewData.appState(signedIn: signedIn))
    }
}
#endif
