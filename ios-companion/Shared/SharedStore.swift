import Foundation
import Security

/// Données partagées app ↔ widget (App Group) : adresse de Lumen, jeton,
/// empreintes des certificats acceptés, dernier état connu.
enum SharedStore {
    static let group = "group.io.github.oneil974.lumen"
    static var defaults: UserDefaults { UserDefaults(suiteName: group) ?? .standard }

    /// Accent choisi dans l'app (hex), ambre par défaut — lu par les widgets.
    static var accentHex: UInt32 {
        let v = defaults.integer(forKey: "uiAccentHex")
        return v > 0 ? UInt32(v) : 0xFE9A00
    }

    /// Adresse (non secrète) dans l'App Group ; le JETON, lui, dans le
    /// trousseau partagé par le groupe d'apps — jamais dans les UserDefaults,
    /// lisibles en clair dans le conteneur partagé.
    static func saveCredentials(server: URL, token: String?) {
        defaults.set(server.absoluteString, forKey: "server")
        defaults.removeObject(forKey: "token")   // ancienne copie en clair
        SharedKeychain.set(token)
    }

    static func savePin(_ fingerprint: String, hostPort: String) {
        var pins = defaults.dictionary(forKey: "pins") as? [String: String] ?? [:]
        pins[hostPort] = fingerprint
        defaults.set(pins, forKey: "pins")
    }

    /// « Oublier les certificats » : la copie des widgets et de l'extension de
    /// partage doit disparaître aussi, sinon ils continueraient de l'approuver.
    static func clearPins() { defaults.removeObject(forKey: "pins") }

    /// Page affichée de la liste des modèles (grand widget).
    static var modelPage: Int {
        get { defaults.integer(forKey: "widgetModelPage") }
        set { defaults.set(newValue, forKey: "widgetModelPage") }
    }
    static var server: URL? { defaults.string(forKey: "server").flatMap(URL.init(string:)) }
    static var token: String? {
        if let t = SharedKeychain.get() { return t }
        // Migration : un jeton laissé en clair par une version précédente.
        guard let legacy = defaults.string(forKey: "token") else { return nil }
        SharedKeychain.set(legacy)
        defaults.removeObject(forKey: "token")
        return legacy
    }

    /// Identité du compte courant (serveur + profil) : cloisonne les copies
    /// locales du coffre et du cache de données.
    static var accountKey: String? {
        guard let server, let token else { return nil }
        return accountKey(server: server, token: token)
    }

    /// Le profil est le sujet du jeton (`<profil>~<appareil>.<exp>.<sig>`).
    static func accountKey(server: URL, token: String) -> String {
        let subject = token.split(separator: ".").dropLast(2).joined(separator: ".")
        let profile = subject.split(separator: "~").first.map(String.init) ?? subject
        let host = "\(server.host() ?? "")_\(server.port ?? 0)"
        let raw = "\(host)_\(profile)"
        return String(raw.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" ? $0 : "_" })
    }

    // MARK: État

    static var cached: LumenStatus? {
        get { defaults.data(forKey: "status").flatMap { try? JSONDecoder().decode(LumenStatus.self, from: $0) } }
        set { defaults.set(try? JSONEncoder().encode(newValue), forKey: "status") }
    }

    /// `GET /status` ; met le cache à jour. nil si Lumen est injoignable.
    static func fetchStatus() async -> LumenStatus? {
        guard let server, let token else { return nil }
        var req = URLRequest(url: server.appending(path: "status"))
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 8
        guard let (data, resp) = try? await session.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200,
              let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let status = LumenStatus(json: j, previous: cached)
        cached = status
        return status
    }

    /// `POST /command` : réglage de discussion (backend, modèle…).
    @discardableResult
    static func command(_ body: [String: Any]) async -> Bool {
        guard let server, let token else { return false }
        var req = URLRequest(url: server.appending(path: "command"))
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        req.timeoutInterval = 8
        guard let (_, resp) = try? await session.data(for: req) else { return false }
        return (resp as? HTTPURLResponse)?.statusCode == 200
    }

    private static let session = URLSession(configuration: .ephemeral, delegate: PinnedTrust(), delegateQueue: nil)
}

/// Jeton du compte courant dans le trousseau, groupe d'accès = App Group :
/// l'app, les widgets et l'extension de partage le lisent sans copie en clair.
enum SharedKeychain {
    private static let service = "com.lumen.companion.shared-token"

    private static var base: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: "current",
         kSecAttrAccessGroup as String: SharedStore.group]
    }

    static func get() -> String? {
        var q = base
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }

    static func set(_ token: String?) {
        SecItemDelete(base as CFDictionary)
        guard let token, !token.isEmpty else { return }
        var q = base
        q[kSecValueData as String] = Data(token.utf8)
        // Les widgets tournent écran verrouillé : après le premier déverrouillage.
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(q as CFDictionary, nil)
    }
}

/// Certificat auto-signé : seule une empreinte déjà acceptée dans l'app passe.
final class PinnedTrust: NSObject, URLSessionDelegate {
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge) async
        -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        let space = challenge.protectionSpace
        guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust, let trust = space.serverTrust else {
            return (.performDefaultHandling, nil)
        }
        if SecTrustEvaluateWithError(trust, nil) { return (.performDefaultHandling, nil) }
        guard let leaf = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first else {
            return (.cancelAuthenticationChallenge, nil)
        }
        let pins = SharedStore.defaults.dictionary(forKey: "pins") as? [String: String] ?? [:]
        return Fingerprint.matches(pins["\(space.host):\(space.port)"], leaf)
            ? (.useCredential, URLCredential(trust: trust))
            : (.cancelAuthenticationChallenge, nil)
    }
}

import CryptoKit
enum Fingerprint {
    private static func hex(_ d: some Sequence<UInt8>) -> String { d.map { String(format: "%02X", $0) }.joined(separator: ":") }

    /// Empreinte du certificat entier (ancien épinglage) : change à chaque
    /// régénération, donc à chaque changement d'IP de l'ordinateur.
    static func sha256(_ cert: SecCertificate) -> String {
        hex(SHA256.hash(data: SecCertificateCopyData(cert) as Data))
    }

    /// Empreinte de la CLÉ publique (SHA-256 du point P-256 brut) — la même
    /// que celle affichée dans Lumen › Réglages › Compagnon. Stable : Lumen
    /// garde sa clé quand il régénère le certificat pour une nouvelle IP.
    static func key(_ cert: SecCertificate) -> String? {
        guard let k = SecCertificateCopyKey(cert),
              let raw = SecKeyCopyExternalRepresentation(k, nil) as Data? else { return nil }
        return hex(SHA256.hash(data: raw))
    }

    /// Épingle stockée : « K:<empreinte de clé> », ou ancienne empreinte de
    /// certificat (sans préfixe), toujours acceptée tant qu'elle correspond.
    static func pin(for cert: SecCertificate) -> String { key(cert).map { "K:" + $0 } ?? sha256(cert) }

    static func matches(_ pin: String?, _ cert: SecCertificate) -> Bool {
        guard let pin else { return false }
        if pin.hasPrefix("K:") { return key(cert).map { "K:" + $0 } == pin }
        return pin == sha256(cert)
    }

    /// Texte montré à l'utilisateur (sans le préfixe technique).
    static func display(_ cert: SecCertificate) -> String { key(cert) ?? sha256(cert) }
}

/// État de Lumen vu par le widget (façon écran « Système » de l'orbe M5).
struct LumenStatus: Codable, Hashable {
    struct Source: Codable, Hashable { let id: String; let label: String }

    var online = true
    var host = ""
    var source = ""
    var sources: [Source] = []
    var model = ""
    var models: [String] = []
    var modelLabels: [String: String] = [:]
    var location = "local"
    var state = "idle"
    var loadedModel = ""
    var memBytes: Int64 = 0
    var compute = ""
    var pending = 0
    var unlocked = true
    var updated = Date()

    static let short = ["ollama": "Ollama", "llama": "llama.cpp", "api": "API", "shortcut": "Raccourci", "applefm": "Apple", "lumen": "Lumen Server"]
    var sourceName: String { Self.short[source] ?? sources.first { $0.id == source }?.label ?? "Lumen" }

    static func shortModel(_ m: String) -> String {
        (m.split(separator: "/").last.map(String.init) ?? m).replacingOccurrences(of: ".gguf", with: "", options: .caseInsensitive)
    }

    func label(for m: String) -> String { modelLabels[m].flatMap { $0.isEmpty ? nil : $0 } ?? Self.shortModel(m) }

    /// « sur ce Mac », « puce Apple », « cloud ».
    var whereText: String {
        switch location {
        case "device": String(localized: "puce Apple")
        case "cloud": String(localized: "cloud")
        default: String(localized: "local")
        }
    }

    init() {}

    init(json j: [String: Any], previous: LumenStatus?) {
        let b = j["backend"] as? [String: Any] ?? [:]
        host = (j["host"] as? String) ?? previous?.host ?? ""
        source = (b["source"] as? String) ?? previous?.source ?? ""
        sources = (b["sources"] as? [[String: Any]])?.map { Source(id: "\($0["id"] ?? "")", label: "\($0["label"] ?? "")") } ?? previous?.sources ?? []
        model = (b["model"] as? String) ?? previous?.model ?? ""
        models = (b["models"] as? [String]) ?? previous?.models ?? []
        modelLabels = (b["modelLabels"] as? [String: String]) ?? previous?.modelLabels ?? [:]
        location = (b["where"] as? String) ?? previous?.location ?? "local"
        state = (j["state"] as? String) ?? "idle"
        if let l = j["llama"] as? [String: Any] {
            loadedModel = (l["running"] as? Bool) == true ? ((l["model"] as? String) ?? "") : ""
            memBytes = (l["mem_bytes"] as? NSNumber)?.int64Value ?? 0
            compute = (l["compute"] as? String) ?? ""
        }
        pending = (j["pending_approvals"] as? Int) ?? 0
        unlocked = (j["unlocked"] as? Bool) ?? true
        updated = .now
    }
}
