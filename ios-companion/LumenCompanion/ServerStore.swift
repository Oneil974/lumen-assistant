import Foundation
import CryptoKit

/// Adresse du Lumen de l'ordinateur + empreintes des certificats auto-signés
/// acceptés (HTTPS 8768). Rien de secret ici : le jeton vit dans le trousseau.
@MainActor
final class ServerStore: ObservableObject {
    @Published var current: URL? {
        didSet { UserDefaults.standard.set(current?.absoluteString, forKey: Keys.current) }
    }
    @Published private(set) var recents: [URL] = []

    private enum Keys {
        static let current = "serverURL"
        static let recents = "recentServers"
        static let pins = "pinnedCertificates"
    }

    /// Port HTTP du compagnon (COMPANION_PORT dans companion.rs).
    nonisolated static let httpPort = 8766
    /// Port HTTPS (COMPANION_TLS_PORT) : celui qu'on prend par défaut.
    nonisolated static let httpsPort = 8768

    init() {
        let d = UserDefaults.standard
        if let s = d.string(forKey: Keys.current) { current = URL(string: s) }
        recents = (d.stringArray(forKey: Keys.recents) ?? []).compactMap(URL.init(string:))
    }

    /// Accepte « 192.168.1.42 », « mon-mac.local », « https://… », « http://… » :
    /// sans schéma, on part en HTTPS (8768) — jeton, mot de passe et contenus
    /// chiffrés sur le réseau. Le HTTP (8766) n'est pris que s'il est écrit
    /// explicitement (`http://…`) ; « hôte:8766 » sans schéma est redirigé
    /// vers le HTTPS du même ordinateur.
    nonisolated static func normalize(_ raw: String) -> URL? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        let explicit = s.contains("://")
        if !explicit { s = "https://" + s }
        guard var c = URLComponents(string: s), let host = c.host, !host.isEmpty,
              c.scheme == "http" || c.scheme == "https" else { return nil }
        if !explicit && c.port == httpPort { c.port = httpsPort }
        if c.port == nil { c.port = c.scheme == "https" ? httpsPort : httpPort }
        if c.path.isEmpty { c.path = "/" }
        return c.url
    }

    func use(_ url: URL) {
        current = url
        var list = recents.filter { $0 != url }
        list.insert(url, at: 0)
        recents = Array(list.prefix(5))
        UserDefaults.standard.set(recents.map(\.absoluteString), forKey: Keys.recents)
    }

    func forget(_ url: URL) {
        recents.removeAll { $0 == url }
        UserDefaults.standard.set(recents.map(\.absoluteString), forKey: Keys.recents)
        if current == url { current = nil }
    }

    // MARK: Certificats auto-signés (confiance à la première connexion)

    private func hostKey(_ host: String, _ port: Int) -> String { "\(host):\(port)" }

    func pinnedFingerprint(host: String, port: Int) -> String? {
        (UserDefaults.standard.dictionary(forKey: Keys.pins) as? [String: String])?[hostKey(host, port)]
    }

    func pin(_ fingerprint: String, host: String, port: Int) {
        var pins = (UserDefaults.standard.dictionary(forKey: Keys.pins) as? [String: String]) ?? [:]
        pins[hostKey(host, port)] = fingerprint
        UserDefaults.standard.set(pins, forKey: Keys.pins)
        SharedStore.savePin(fingerprint, hostPort: hostKey(host, port))
    }

    func unpinAll() {
        UserDefaults.standard.removeObject(forKey: Keys.pins)
        SharedStore.clearPins()
    }

    nonisolated static func fingerprint(of cert: SecCertificate) -> String {
        let der = SecCertificateCopyData(cert) as Data
        return SHA256.hash(data: der).map { String(format: "%02X", $0) }.joined(separator: ":")
    }
}
