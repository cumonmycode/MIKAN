import XCTest
@testable import MIKAN

private typealias F = InventoryFixtures

/// A category's items screen: who is in it, who can be added (and in what order), and the registry lookup by name.
final class CategoryMembershipTests: XCTestCase {
    private let products = [
        F.product(id: 1, name: "Штанга", category: "Штанга"),
        F.product(id: 2, name: "Банан", category: " банан "),
        F.product(id: 3, name: "Банан с камнем", sku: "BN-7", category: "Банан"),
        F.product(id: 4, name: "Кольцо", category: nil),
        F.product(id: 5, name: "Ёлочка", category: "Кликер"),
    ]
    private let registry = [
        F.category(1, "Кликер", position: 0),
        F.category(2, "Банан", position: 1),
        F.category(3, "Штанга", position: 2),
    ]

    func testMembersMatchTheNameInAnyCaseAndSortByName() {
        let members = CategoryMembership.members(of: "Банан", in: products)
        XCTAssertEqual(members.map(\.id), [2, 3], "« банан » is the same category")
        XCTAssertTrue(CategoryMembership.members(of: "Септум", in: products).isEmpty)
    }

    func testCandidatesPutUncategorizedFirstThenTheRegistryOrder() {
        let groups = CategoryMembership.candidates(for: "Банан", section: .jewelry, in: products, registry: registry)
        XCTAssertEqual(groups.map(\.category), [nil, "Кликер", "Штанга"])
        XCTAssertEqual(groups.flatMap(\.items).map(\.id), [4, 5, 1], "the category's own items are left out")
    }

    func testCandidatesSearchNameArticleAndCurrentCategory() {
        let byName = CategoryMembership.candidates(for: "Штанга", section: .jewelry, in: products, registry: registry, query: "елочка")
        XCTAssertEqual(byName.flatMap(\.items).map(\.id), [5], "«ё» reads as «е»")
        let byArticle = CategoryMembership.candidates(for: "Штанга", section: .jewelry, in: products, registry: registry, query: "bn-7")
        XCTAssertEqual(byArticle.flatMap(\.items).map(\.id), [3])
        let byCategory = CategoryMembership.candidates(for: "Штанга", section: .jewelry, in: products, registry: registry, query: "банан камн")
        XCTAssertEqual(byCategory.flatMap(\.items).map(\.id), [3], "every word must match")
    }

    func testTexts() {
        XCTAssertEqual(CategoryMembership.progressText(done: 0, total: 3), "Перемещаю 1 из 3…")
        XCTAssertEqual(CategoryMembership.progressText(done: 3, total: 3), "Перемещаю 3 из 3…")
        XCTAssertEqual(CategoryMembership.failureText(moved: 2, total: 5, reason: "Нет связи."), "Перемещено 2 из 5. Нет связи.")
        XCTAssertEqual(CategoryMembership.failureText(moved: 0, total: 1, reason: "Нет связи."), "Нет связи.")
    }

    func testRegistryLookupByNameStaysInItsScope() {
        let ear = F.category(10, "Ухо", section: .service, serviceCategory: .piercing, position: 0)
        let all = registry + [ear]
        XCTAssertEqual(all.named("  кликер ", in: CategoryScope(section: .jewelry))?.id, 1)
        XCTAssertNil(all.named("Ухо", in: CategoryScope(section: .jewelry)))
        XCTAssertNil(all.named("Ухо", in: CategoryScope(section: .service, serviceCategory: .tattoo)))
        XCTAssertEqual(all.named("ухо", in: CategoryScope(section: .service, serviceCategory: .piercing))?.id, 10)
        XCTAssertNil(all.named(" ", in: CategoryScope(section: .jewelry)))
    }
}
