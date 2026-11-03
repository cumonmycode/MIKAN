import Foundation

/// What a log screen lists: the whole studio (with filters), or one card's own history.
nonisolated enum AuditScope: Hashable, Sendable {
    case studio
    /// The appointment and its prepayment.
    case appointment(id: Int)
    case client(id: Int)
    case sale(id: Int)
    /// The product and its stock movements.
    case product(id: Int)
    case certificate(id: Int)

    var title: String {
        self == .studio ? "Журнал действий" : "История изменений"
    }

    /// Only the studio log filters by employee and section; a card's history is already narrowed down.
    var hasFilters: Bool { self == .studio }

    var emptyDescription: String {
        switch self {
        case .studio: "Здесь будет видно, кто и что менял: записи, оплаты, клиентов, склад и настройки."
        case .appointment: "Здесь появятся изменения этой записи и её предоплаты."
        case .client: "Здесь появятся изменения карточки клиента."
        case .sale: "Здесь появятся действия с этой продажей."
        case .product: "Здесь появятся изменения товара и его остатков."
        case .certificate: "Здесь появятся изменения сертификата: получатель, заметка, срок, отмена и отправка."
        }
    }

    /// A page of entries: the card's own sections, or the studio log narrowed by the filter.
    func query(_ filter: AuditFilter, offset: Int, limit: Int = AuditQuery.defaultLimit) -> AuditQuery {
        switch self {
        case .studio:
            AuditQuery(employeeId: filter.employeeId, sections: filter.section.map { [$0] } ?? [], limit: limit, offset: offset)
        case .appointment(let id):
            AuditQuery(sections: [.appointment, .deposit], entityId: id, limit: limit, offset: offset)
        case .client(let id):
            AuditQuery(sections: [.client], entityId: id, limit: limit, offset: offset)
        case .sale(let id):
            AuditQuery(sections: [.sale], entityId: id, limit: limit, offset: offset)
        case .product(let id):
            AuditQuery(sections: [.product, .stock], entityId: id, limit: limit, offset: offset)
        case .certificate(let id):
            AuditQuery(sections: [.certificate], entityId: id, limit: limit, offset: offset)
        }
    }
}

/// The studio log's filters: one employee and one section, `nil` meaning all.
nonisolated struct AuditFilter: Hashable, Sendable {
    var employeeId: Int?
    var section: AuditSection?

    var isActive: Bool { employeeId != nil || section != nil }
}
