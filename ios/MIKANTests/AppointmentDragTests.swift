import CoreGraphics
import Foundation
import Testing
@testable import MIKAN

@MainActor
private enum DragSample {
    static let calendar = Calendar.app

    static func date(day: Int, hour: Int, minute: Int = 0) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: 10, day: day, hour: hour, minute: minute))!
    }

    static func appointment(
        start: Date = date(day: 20, hour: 14),
        minutes: Int = 60,
        status: AppointmentStatus = .scheduled,
        masterId: Int = 2,
        clientName: String = "Анна",
        telegram: Bool = true
    ) -> Appointment {
        Appointment(
            id: 7, client: ClientRef(id: 1, name: clientName, lastName: "Смирнова", phone: nil, telegramLinked: telegram),
            master: EmployeeRef(id: masterId, name: "Фатима", color: nil), service: nil, title: "Хеликс",
            startsAt: start, endsAt: start.addingTimeInterval(TimeInterval(minutes * 60)), status: status,
            price: 3000, deposit: 0, createdAt: start, updatedAt: start
        )
    }

    static func employee(id: Int = 2, role: EmployeeRole) -> Employee {
        Employee(id: id, name: "Фатима", login: "e\(id)", phone: nil, color: nil, isMaster: true, role: role, active: true, createdAt: .distantPast)
    }

    /// Three days (20–22 October), 100 pt columns, 1 pt per minute, 10:00–21:00 visible.
    static let days = DragGrid(
        columns: [20, 21, 22].map { DragColumn(day: date(day: $0, hour: 0)) },
        columnWidth: 100,
        hourHeight: 60,
        range: 600..<1260
    )

    /// Lifted 10 pt below the top of a 14:00 block in the first column.
    static let grab = CGPoint(x: 50, y: 250)
    static let blockFrame = CGRect(x: 1.5, y: 241.5, width: 47, height: 57)

    static func plan(
        _ appointment: Appointment = appointment(),
        grid: DragGrid = days,
        grab: CGPoint = grab,
        canChangeMaster: Bool = true
    ) -> AppointmentDragPlan? {
        AppointmentDragPlan(
            appointment: appointment, grid: grid, sourceFrame: blockFrame, grabLocation: grab,
            canChangeMaster: canChangeMaster, calendar: calendar
        )
    }
}

@MainActor
struct AppointmentDragRulesTests {
    @Test("Owner and admin lift any open appointment, a master only their own")
    func roles() {
        let appointment = DragSample.appointment(masterId: 2)
        #expect(AppointmentDragRules.canDrag(appointment, by: DragSample.employee(id: 9, role: .owner)))
        #expect(AppointmentDragRules.canDrag(appointment, by: DragSample.employee(id: 9, role: .admin)))
        #expect(AppointmentDragRules.canDrag(appointment, by: DragSample.employee(id: 2, role: .master)))
        #expect(!AppointmentDragRules.canDrag(appointment, by: DragSample.employee(id: 9, role: .master)))
        #expect(!AppointmentDragRules.canDrag(appointment, by: nil))
    }

    @Test("Completed, cancelled and no-show appointments stay put; a confirmed one moves")
    func statuses() {
        let admin = DragSample.employee(role: .admin)
        #expect(AppointmentDragRules.canDrag(DragSample.appointment(status: .confirmed), by: admin))
        for status in [AppointmentStatus.completed, .cancelled, .noShow] {
            #expect(!AppointmentDragRules.canDrag(DragSample.appointment(status: status), by: admin))
        }
    }

    @Test("An appointment running past midnight is not lifted; one ending at midnight is")
    func midnight() {
        let admin = DragSample.employee(role: .admin)
        let late = DragSample.date(day: 20, hour: 22)
        #expect(AppointmentDragRules.canDrag(DragSample.appointment(start: late, minutes: 120), by: admin))
        #expect(!AppointmentDragRules.canDrag(DragSample.appointment(start: late, minutes: 180), by: admin))
    }

    @Test("Only the owner and admins hand an appointment to another master")
    func changingMaster() {
        #expect(AppointmentDragRules.canChangeMaster(by: DragSample.employee(role: .owner)))
        #expect(AppointmentDragRules.canChangeMaster(by: DragSample.employee(role: .admin)))
        #expect(!AppointmentDragRules.canChangeMaster(by: DragSample.employee(role: .master)))
        #expect(!AppointmentDragRules.canChangeMaster(by: nil))
    }
}

@MainActor
struct AppointmentDragPlanTests {
    @Test("Dragging snaps the start to 15 minutes and keeps the duration")
    func snapsAndKeepsDuration() throws {
        let plan = try #require(DragSample.plan())
        let target = plan.target(at: CGPoint(x: 50, y: 250 + 67)) // 14:00 + 67 min → 15:07 → 15:00
        #expect(target.startsAt == DragSample.date(day: 20, hour: 15))
        #expect(target.endsAt == DragSample.date(day: 20, hour: 16))
        #expect(target.startMinute == 900)
        #expect(target.masterId == 2)
        let later = plan.target(at: CGPoint(x: 50, y: 250 + 83)) // 15:23 → 15:30
        #expect(later.startsAt == DragSample.date(day: 20, hour: 15, minute: 30))
    }

    @Test("A small wobble keeps the appointment where it is, even off the 15-minute grid")
    func wobbleKeepsTime() throws {
        let plan = try #require(DragSample.plan(DragSample.appointment(start: DragSample.date(day: 20, hour: 14, minute: 10))))
        #expect(plan.target(at: CGPoint(x: 60, y: 256)) == plan.original)
        #expect(plan.target(at: CGPoint(x: 60, y: 244)) == plan.original)
        // A real move snaps: 14:10 + 20 min → 14:30.
        #expect(plan.target(at: CGPoint(x: 50, y: 270)).startsAt == DragSample.date(day: 20, hour: 14, minute: 30))
    }

    @Test("Sideways in a multi-day grid moves to the day under the finger, keeping the time")
    func otherDay() throws {
        let plan = try #require(DragSample.plan())
        let target = plan.target(at: CGPoint(x: 250, y: 253))
        #expect(target.column == 2)
        #expect(target.startsAt == DragSample.date(day: 22, hour: 14))
        #expect(target.endsAt == DragSample.date(day: 22, hour: 15))
        #expect(plan.target(at: CGPoint(x: 900, y: 250)).column == 2)
        #expect(plan.target(at: CGPoint(x: -40, y: 250)) == plan.original)
    }

    @Test("The drop stays inside the visible hours with the whole appointment")
    func clampsToVisibleHours() throws {
        let plan = try #require(DragSample.plan(DragSample.appointment(minutes: 50)))
        #expect(plan.target(at: CGPoint(x: 50, y: -800)).startsAt == DragSample.date(day: 20, hour: 10))
        // 21:00 − 50 min = 20:10 → the last slot that fits is 20:00.
        #expect(plan.target(at: CGPoint(x: 50, y: 4000)).startsAt == DragSample.date(day: 20, hour: 20))
    }

    @Test("Master columns: an admin hands the appointment over, a master stays in their own column")
    func masterColumns() throws {
        let day = DragSample.date(day: 20, hour: 0)
        let grid = DragGrid(
            columns: [DragColumn(day: day, masterId: 2), DragColumn(day: day, masterId: 5)],
            columnWidth: 100, hourHeight: 60, range: 600..<1260
        )
        let admin = try #require(DragSample.plan(grid: grid, canChangeMaster: true))
        let handed = admin.target(at: CGPoint(x: 150, y: 310))
        #expect(handed.column == 1)
        #expect(handed.masterId == 5)
        #expect(handed.startsAt == DragSample.date(day: 20, hour: 15))

        let master = try #require(DragSample.plan(grid: grid, canChangeMaster: false))
        let kept = master.target(at: CGPoint(x: 150, y: 310))
        #expect(kept.column == 0)
        #expect(kept.masterId == 2)
        #expect(kept.startsAt == DragSample.date(day: 20, hour: 15))
    }

    @Test("No plan when the finger is not over the appointment's day or the grid is empty")
    func invalidPlans() {
        #expect(DragSample.plan(grab: CGPoint(x: 150, y: 250)) == nil)
        let empty = DragGrid(columns: [], columnWidth: 100, hourHeight: 60, range: 600..<1260)
        #expect(DragSample.plan(grid: empty) == nil)
    }

    @Test("The ghost spans its column at the new time and returns to the block's own frame")
    func frames() throws {
        let plan = try #require(DragSample.plan())
        #expect(plan.frame(of: plan.original) == DragSample.blockFrame)
        let target = plan.target(at: CGPoint(x: 150, y: 310)) // 21 October 15:00
        #expect(plan.frame(of: target) == CGRect(x: 101.5, y: 301.5, width: 97, height: 57))
    }
}

@MainActor
struct AppointmentMoveTests {
    private let now = DragSample.date(day: 15, hour: 12)

    private func move(_ appointment: Appointment = DragSample.appointment(), to start: Date, masterId: Int = 2) -> AppointmentMove {
        let end = start.addingTimeInterval(appointment.endsAt.timeIntervalSince(appointment.startsAt))
        let minute = TimeGridLayout.minuteOfDay(start, calendar: DragSample.calendar)
        return AppointmentMove(appointment: appointment, target: DragTarget(column: 1, startMinute: minute, startsAt: start, endsAt: end, masterId: masterId))
    }

    @Test("The PATCH carries the new time and the flag; the master and force only when needed")
    func body() throws {
        let moved = move(to: DragSample.date(day: 21, hour: 15))
        let body = moved.body(notifyClient: true, force: false, now: now)
        #expect(body == AppointmentMoveBody(startsAt: DragSample.date(day: 21, hour: 15), endsAt: DragSample.date(day: 21, hour: 16), masterId: nil, notifyClient: true, force: nil))
        let json = try #require(JSONSerialization.jsonObject(with: JSONCoding.makeEncoder().encode(body)) as? [String: Any])
        #expect(Set(json.keys) == ["startsAt", "endsAt", "notifyClient"])

        let handed = move(to: DragSample.date(day: 21, hour: 15), masterId: 5).body(notifyClient: false, force: true, now: now)
        #expect(handed.masterId == 5)
        #expect(handed.force == true)
        #expect(handed.notifyClient == false)
    }

    @Test("Telegram is offered only for a new future time of a client with Telegram")
    func telegramNotice() {
        #expect(move(to: DragSample.date(day: 21, hour: 15)).offersTelegramNotice(now: now))
        let noTelegram = move(DragSample.appointment(telegram: false), to: DragSample.date(day: 21, hour: 15))
        #expect(!noTelegram.offersTelegramNotice(now: now))
        #expect(!noTelegram.body(notifyClient: true, force: false, now: now).notifyClient)
        #expect(!move(to: DragSample.date(day: 14, hour: 15)).offersTelegramNotice(now: now))
        let masterOnly = move(to: DragSample.date(day: 20, hour: 14), masterId: 5)
        #expect(masterOnly.isChange)
        #expect(!masterOnly.changesTime)
        #expect(!masterOnly.offersTelegramNotice(now: now))
    }

    @Test("«Перенести запись Анны на 21 октября, 15:00?»")
    func question() {
        #expect(AppointmentMoveText.question(move(to: DragSample.date(day: 21, hour: 15)), now: now) == "Перенести запись Анны на 21 октября, 15:00?")
        let igor = move(DragSample.appointment(clientName: "Игорь"), to: DragSample.date(day: 21, hour: 9, minute: 30))
        #expect(AppointmentMoveText.question(igor, now: now) == "Перенести запись на 21 октября, 09:30?")
        let masterOnly = move(to: DragSample.date(day: 20, hour: 14), masterId: 5)
        #expect(AppointmentMoveText.question(masterOnly, now: now) == "Передать запись Анны другому мастеру?")
    }

    @Test("The queued notice reads as «Перенос записи»")
    func scheduledKind() throws {
        let kinds = try JSONCoding.makeDecoder().decode([ScheduledKind].self, from: Data(#"["reschedule_notice"]"#.utf8))
        #expect(kinds == [.rescheduleNotice])
        #expect(kinds.first?.title == "Перенос записи")
    }

    @Test("First names in the genitive; unsure ones are left out")
    func genitive() {
        let cases: [(String, String?)] = [
            ("Анна", "Анны"), ("Ольга", "Ольги"), ("Саша", "Саши"), ("Никита", "Никиты"), ("Мария", "Марии"),
            ("Илья", "Ильи"), ("Иван", "Ивана"), ("Андрей", "Андрея"), ("Павел", "Павла"), ("Пётр", "Петра"),
            ("АННА", "АННЫ"), (" Анна ", "Анны"),
            ("Игорь", nil), ("Любовь", nil), ("Нелли", nil), ("Anna", nil), ("Анна-Мария", nil), ("", nil),
        ]
        for (name, expected) in cases {
            #expect(AppointmentMoveText.genitive(name) == expected, "\(name)")
        }
    }
}

@MainActor
struct DragAutoScrollTests {
    @Test("Scrolls up near the top, down near the bottom, faster closer to the edge")
    func velocity() {
        #expect(DragAutoScroll.velocity(fingerY: 300, visibleHeight: 600) == 0)
        #expect(DragAutoScroll.velocity(fingerY: 0, visibleHeight: 600) == -DragAutoScroll.maxSpeed)
        #expect(DragAutoScroll.velocity(fingerY: 600, visibleHeight: 600) == DragAutoScroll.maxSpeed)
        let near = DragAutoScroll.velocity(fingerY: 40, visibleHeight: 600)
        let nearer = DragAutoScroll.velocity(fingerY: 10, visibleHeight: 600)
        #expect(near < 0 && nearer < near)
        #expect(DragAutoScroll.velocity(fingerY: -50, visibleHeight: 600) == -DragAutoScroll.maxSpeed)
        #expect(DragAutoScroll.velocity(fingerY: 20, visibleHeight: 100) == 0, "too short to scroll")
    }

    @Test("The offset stays inside the content")
    func offset() {
        #expect(DragAutoScroll.offset(from: 100, velocity: 700, seconds: 0.1, maxOffset: 500) == 170)
        #expect(DragAutoScroll.offset(from: 20, velocity: -700, seconds: 0.1, maxOffset: 500) == 0)
        #expect(DragAutoScroll.offset(from: 480, velocity: 700, seconds: 0.1, maxOffset: 500) == 500)
    }
}
