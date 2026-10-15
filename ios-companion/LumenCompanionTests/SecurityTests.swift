import CryptoKit
import XCTest
@testable import LumenCompanion

/// Garde-fous de sécurité du compagnon : transport chiffré par défaut,
/// cloisonnement des données par compte, enveloppe du mot de passe.
final class SecurityTests: XCTestCase {
    func testAdresseSansSchemaPartEnHTTPS() {
        XCTAssertEqual(ServerStore.normalize("192.168.1.42")?.absoluteString, "https://192.168.1.42:8768/")
        XCTAssertEqual(ServerStore.normalize("mon-mac.local")?.absoluteString, "https://mon-mac.local:8768/")
        // Le port HTTP tapé sans schéma est redirigé vers le HTTPS du même hôte.
        XCTAssertEqual(ServerStore.normalize("192.168.1.42:8766")?.absoluteString, "https://192.168.1.42:8768/")
    }

    func testHTTPSeulementSiDemandeExplicitement() {
        XCTAssertEqual(ServerStore.normalize("http://192.168.1.42")?.absoluteString, "http://192.168.1.42:8766/")
        XCTAssertNil(ServerStore.normalize("ftp://x"))
    }

    func testCompteCloisonneParServeurEtProfil() {
        let a = URL(string: "https://192.168.1.42:8768/")!
        let b = URL(string: "https://10.0.0.5:8768/")!
        let camille = "camille~dev1.1900000000.abc"
        let alexis = "alexis~dev2.1900000000.def"
        XCTAssertNotEqual(SharedStore.accountKey(server: a, token: camille), SharedStore.accountKey(server: a, token: alexis))
        XCTAssertNotEqual(SharedStore.accountKey(server: a, token: camille), SharedStore.accountKey(server: b, token: camille))
        // Nouveau jeton (reconnexion) pour le même profil : même copie locale.
        XCTAssertEqual(SharedStore.accountKey(server: a, token: camille),
                       SharedStore.accountKey(server: a, token: "camille~dev3.1900000999.fff"))
    }

    /// Même construction que `auth::open_envelope` (Rust) : ECDH P-256 →
    /// HKDF-SHA256 (sel = ticket) → AES-256-GCM (données associées = ticket).
    func testEnveloppeDuMotDePasse() throws {
        let server = P256.KeyAgreement.PrivateKey()
        let ticket = "a1b2c3"
        let env = try LumenClient.seal("mot de passe é", ticket: ticket,
                                       serverKey: server.publicKey.x963Representation.base64EncodedString())
        let client = try P256.KeyAgreement.PublicKey(x963Representation: Data(base64Encoded: env["client_key"] as! String)!)
        let key = try server.sharedSecretFromKeyAgreement(with: client)
            .hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data(ticket.utf8),
                                     sharedInfo: Data("lumen-companion-login-v1".utf8), outputByteCount: 32)
        let combined = Data(base64Encoded: env["iv"] as! String)! + Data(base64Encoded: env["ciphertext"] as! String)!
        let box = try AES.GCM.SealedBox(combined: combined)
        let plain = try AES.GCM.open(box, using: key, authenticating: Data(ticket.utf8))
        XCTAssertEqual(String(data: plain, encoding: .utf8), "mot de passe é")
        // Rejouée sur un autre ticket : refusée.
        XCTAssertThrowsError(try AES.GCM.open(box, using: key, authenticating: Data("autre".utf8)))
    }
}
