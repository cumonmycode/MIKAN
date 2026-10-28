import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers
@testable import MIKAN

/// Masters' portfolio: the model and request bodies, reordering, the image size rule, limits and permissions.
struct PortfolioTests {
    private let anna = EmployeeRef(id: 3, name: "Анна", color: "#FF7A1A")
    private let helix = ServiceRef(id: 4, name: "Хеликс", category: .piercing)

    private func photo(_ id: Int, caption: String? = nil, service: ServiceRef? = nil) -> PortfolioPhoto {
        PortfolioPhoto(
            id: id, employee: anna, imageUrl: "/uploads/\(id).jpg", caption: caption, service: service,
            sort: id, createdAt: Date(timeIntervalSince1970: 0)
        )
    }

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONCoding.makeDecoder().decode(T.self, from: Data(json.utf8))
    }

    private func encoded(_ value: some Encodable) throws -> String {
        let encoder = JSONCoding.makeEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return String(decoding: try encoder.encode(value), as: UTF8.self)
    }

    // MARK: - Model and bodies

    @Test("A photo decodes with a service and a caption")
    func decodesWithService() throws {
        let photo = try decode(PortfolioPhoto.self, #"""
        { "id": 7, "employee": { "id": 3, "name": "Анна", "color": "#FF7A1A" }, "imageUrl": "/uploads/0b9c.jpg",
          "caption": "Хеликс, титан", "service": { "id": 4, "name": "Хеликс", "category": "piercing" },
          "sort": 0, "createdAt": "2026-10-20T10:00:00.000Z" }
        """#)
        #expect(photo.id == 7)
        #expect(photo.employee == anna)
        #expect(photo.imageUrl == "/uploads/0b9c.jpg")
        #expect(photo.caption == "Хеликс, титан")
        #expect(photo.service == helix)
        #expect(photo.sort == 0)
        #expect(photo.createdAt == ISO8601.parse("2026-10-20T10:00:00.000Z"))
    }

    @Test("A photo decodes without a service or caption (null)")
    func decodesWithoutService() throws {
        let response = try decode(ItemsResponse<PortfolioPhoto>.self, #"""
        { "items": [ { "id": 8, "employee": { "id": 3, "name": "Анна", "color": null }, "imageUrl": "/uploads/a.jpg",
          "caption": null, "service": null, "sort": 1, "createdAt": "2026-10-20T10:00:00Z" } ] }
        """#)
        let photo = try #require(response.items.first)
        #expect(photo.caption == nil)
        #expect(photo.service == nil)
        #expect(photo.employee.color == nil)
        #expect(photo.sort == 1)
    }

    @Test("PATCH always sends both keys: a blank caption and no service go as explicit null")
    func patchEncodesNulls() throws {
        #expect(try encoded(PortfolioPhotoPatch(caption: "   ", serviceId: nil)) == #"{"caption":null,"serviceId":null}"#)
        #expect(try encoded(PortfolioPhotoPatch(caption: " Хеликс, титан ", serviceId: 4)) == #"{"caption":"Хеликс, титан","serviceId":4}"#)
    }

    @Test("POST omits what is not set; the order body lists every id")
    func postAndOrderBodies() throws {
        let body = PortfolioPhotoBody(employeeId: 3, imageUrl: "/uploads/a.jpg")
        #expect(try encoded(body) == #"{"employeeId":3,"imageUrl":"/uploads/a.jpg"}"#)
        let full = PortfolioPhotoBody(employeeId: 3, imageUrl: "/uploads/a.jpg", serviceId: 4, caption: "Хеликс")
        #expect(try encoded(full) == #"{"caption":"Хеликс","employeeId":3,"imageUrl":"/uploads/a.jpg","serviceId":4}"#)
        #expect(try encoded(PortfolioOrderBody(employeeId: 3, ids: [2, 1])) == #"{"employeeId":3,"ids":[2,1]}"#)
    }

    // MARK: - Reorder

    @Test("Dropping forward: the dragged photo takes the target's place, the ones between move up")
    func dropForward() {
        #expect(PortfolioReorder.moving(1, onto: 3, in: [1, 2, 3, 4]) == [2, 3, 1, 4])
        #expect(PortfolioReorder.moving(1, onto: 4, in: [1, 2, 3, 4]) == [2, 3, 4, 1])
    }

    @Test("Dropping backward: the dragged photo takes the target's place, the ones between move down")
    func dropBackward() {
        #expect(PortfolioReorder.moving(4, onto: 2, in: [1, 2, 3, 4]) == [1, 4, 2, 3])
        #expect(PortfolioReorder.moving(3, onto: 1, in: [1, 2, 3, 4]) == [3, 1, 2, 4])
    }

    @Test("A drop onto itself or with an unknown id changes nothing")
    func dropNoChange() {
        let ids = [1, 2, 3]
        #expect(PortfolioReorder.moving(2, onto: 2, in: ids) == ids)
        #expect(PortfolioReorder.moving(9, onto: 2, in: ids) == ids)
        #expect(PortfolioReorder.moving(2, onto: 9, in: ids) == ids)
        #expect(PortfolioReorder.moving(1, onto: 2, in: []).isEmpty)
    }

    @Test("«Переместить раньше / позже» moves one place and stops at the ends")
    func accessibilityMoves() {
        let ids = [1, 2, 3]
        #expect(PortfolioReorder.moving(2, by: -1, in: ids) == [2, 1, 3])
        #expect(PortfolioReorder.moving(2, by: 1, in: ids) == [1, 3, 2])
        #expect(PortfolioReorder.moving(1, by: -1, in: ids) == ids, "the first stays first")
        #expect(PortfolioReorder.moving(3, by: 1, in: ids) == ids, "the last stays last")
        #expect(PortfolioReorder.moving(9, by: 1, in: ids) == ids)
        #expect(PortfolioReorder.moving(1, by: 1, in: [1]) == [1])
    }

    @Test("The order body is nil when nothing moved and lists every id otherwise")
    func orderDiff() {
        #expect(PortfolioReorder.orderBody(employeeId: 3, old: [1, 2, 3], new: [1, 2, 3]) == nil)
        let body = PortfolioReorder.orderBody(employeeId: 3, old: [1, 2, 3], new: [2, 1, 3])
        #expect(body == PortfolioOrderBody(employeeId: 3, ids: [2, 1, 3]))
    }

    @Test("Photos follow the new ids; ones missing from the list keep their order after them")
    func arranged() {
        let photos = [photo(1), photo(2), photo(3), photo(4)]
        #expect(PortfolioReorder.arranged(photos, by: [3, 1, 2, 4]).map(\.id) == [3, 1, 2, 4])
        #expect(PortfolioReorder.arranged(photos, by: [4, 9, 2]).map(\.id) == [4, 2, 1, 3])
        #expect(photos.map(\.id) == [1, 2, 3, 4], "the input is not mutated")
    }

    @Test("A dragged tile carries its id; unrelated dropped text is not a photo")
    func dragPayload() {
        #expect(PortfolioReorder.photoId(fromDragPayload: PortfolioReorder.dragPayload(for: 42)) == 42)
        #expect(PortfolioReorder.photoId(fromDragPayload: "42") == nil)
        #expect(PortfolioReorder.photoId(fromDragPayload: "mikan-portfolio:abc") == nil)
    }

    // MARK: - Image rule

    @Test("The long side fits into 2048 px with the aspect ratio kept, rounded, never upscaled")
    func scaledSize() {
        typealias Size = PortfolioImageRule.PixelSize
        #expect(PortfolioImageRule.scaledSize(width: 4032, height: 3024) == Size(width: 2048, height: 1536))
        #expect(PortfolioImageRule.scaledSize(width: 3024, height: 4032) == Size(width: 1536, height: 2048))
        #expect(PortfolioImageRule.scaledSize(width: 3000, height: 3000) == Size(width: 2048, height: 2048))
        #expect(PortfolioImageRule.scaledSize(width: 4000, height: 2999) == Size(width: 2048, height: 1535))
        #expect(PortfolioImageRule.scaledSize(width: 800, height: 600) == Size(width: 800, height: 600), "small: as is")
        #expect(PortfolioImageRule.scaledSize(width: 2048, height: 1000) == Size(width: 2048, height: 1000))
        #expect(PortfolioImageRule.scaledSize(width: 10_000, height: 2) == Size(width: 2048, height: 1), "at least 1 px")
        #expect(PortfolioImageRule.scaledSize(width: 3200, height: 2000, maxPixelSize: 1600) == Size(width: 1600, height: 1000))
    }

    @Test("The ladder starts at 2048 px / 0.82 and steps down; a result up to 1.5 MB is kept")
    func ladder() {
        typealias Attempt = PortfolioImageRule.Attempt
        let ladder = PortfolioImageRule.ladder
        #expect(ladder == [
            Attempt(maxPixelSize: 2048, quality: 0.82),
            Attempt(maxPixelSize: 2048, quality: 0.7),
            Attempt(maxPixelSize: 1600, quality: 0.7),
            Attempt(maxPixelSize: 1280, quality: 0.65),
        ])
        #expect(ladder.first == PortfolioImageRule.firstAttempt)
        #expect(PortfolioImageRule.nextAttempt(after: ladder[0]) == ladder[1])
        #expect(PortfolioImageRule.nextAttempt(after: ladder[2]) == ladder[3])
        #expect(PortfolioImageRule.nextAttempt(after: ladder[3]) == nil, "the last attempt is used whatever its size")
        #expect(PortfolioImageRule.nextAttempt(after: Attempt(maxPixelSize: 999, quality: 0.5)) == nil)
        #expect(PortfolioImageRule.accepts(byteCount: 1_500_000))
        #expect(!PortfolioImageRule.accepts(byteCount: 1_500_001))
    }

    @Test("A large picture is prepared as a JPEG with the long side at 2048 px")
    func preparesLargePicture() async throws {
        let jpeg = try await PortfolioImagePreparer.prepare(try pngData(width: 4000, height: 3000))
        let source = try #require(CGImageSourceCreateWithData(jpeg as CFData, nil))
        let properties = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        #expect(CGImageSourceGetType(source) as String? == UTType.jpeg.identifier)
        #expect(properties[kCGImagePropertyPixelWidth] as? Int == 2048)
        #expect(properties[kCGImagePropertyPixelHeight] as? Int == 1536)
        #expect(PortfolioImageRule.accepts(byteCount: jpeg.count))
    }

    private func pngData(width: Int, height: Int) throws -> Data {
        let space = try #require(CGColorSpace(name: CGColorSpace.sRGB))
        let context = try #require(CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        context.setFillColor(CGColor(srgbRed: 1, green: 0.48, blue: 0.1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let image = try #require(context.makeImage())
        let output = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(output as CFMutableData, UTType.png.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        #expect(CGImageDestinationFinalize(destination))
        return output as Data
    }

    // MARK: - Limits, texts, options

    @Test("At most 100 photos per master, 20 per pick; the caption counts trimmed, up to 300")
    func limits() {
        #expect(PortfolioLimits.remaining(current: 0) == 100)
        #expect(PortfolioLimits.remaining(current: 99) == 1)
        #expect(PortfolioLimits.remaining(current: 100) == 0)
        #expect(PortfolioLimits.remaining(current: 130) == 0)
        #expect(PortfolioLimits.pickLimit(current: 0) == 20)
        #expect(PortfolioLimits.pickLimit(current: 95) == 5)
        #expect(PortfolioLimits.pickLimit(current: 100) == 0)
        #expect(PortfolioLimits.captionMessage(String(repeating: "а", count: 300)) == nil)
        #expect(PortfolioLimits.captionMessage("  " + String(repeating: "а", count: 300) + "  ") == nil)
        #expect(PortfolioLimits.captionMessage(String(repeating: "а", count: 301)) == "Подпись — не длиннее 300 символов.")
        #expect(PortfolioLimits.captionLength(" Хеликс ") == 6)
    }

    @Test("Tile labels name the place, caption and service; batch failures say how many")
    func texts() {
        #expect(PortfolioText.accessibilityLabel(photo(1), index: 0, count: 12) == "Фото 1 из 12")
        let tied = photo(2, caption: "Хеликс, титан", service: helix)
        #expect(PortfolioText.accessibilityLabel(tied, index: 2, count: 12) == "Фото 3 из 12. Хеликс, титан. Услуга: Хеликс")
        #expect(PortfolioText.uploadFailure(failures: 1, total: 1, lastError: "Сеть недоступна.") == "Сеть недоступна.")
        #expect(PortfolioText.uploadFailure(failures: 2, total: 5, lastError: nil) == "Не удалось добавить 2 из 5 фото. Попробуйте ещё раз.")
    }

    @Test("The editor offers the active services plus the photo's hidden one")
    func serviceOptions() {
        let lobe = ServiceRef(id: 1, name: "Мочка", category: .piercing)
        #expect(PortfolioServices.options(active: [lobe, helix], current: helix) == [lobe, helix])
        let hidden = ServiceRef(id: 9, name: "Архив", category: .other)
        #expect(PortfolioServices.options(active: [lobe], current: hidden) == [lobe, hidden])
        #expect(PortfolioServices.options(active: [lobe], current: nil) == [lobe])
    }

    // MARK: - Permissions

    @Test("Owner and admin manage every master's portfolio; a master only their own")
    func permissions() {
        let owner = Permissions(role: .owner, employeeId: 1)
        let admin = Permissions(role: .admin, employeeId: 2)
        let master = Permissions(role: .master, employeeId: 3)
        #expect(owner.managesPortfolio(of: 3) && owner.managesPortfolio(of: 1))
        #expect(admin.managesPortfolio(of: 3))
        #expect(master.managesPortfolio(of: 3))
        #expect(!master.managesPortfolio(of: 4))
        #expect(!Permissions(role: .master, employeeId: nil).managesPortfolio(of: 3))
        #expect(owner.managesAllPortfolios && admin.managesAllPortfolios && !master.managesAllPortfolios)
    }
}
