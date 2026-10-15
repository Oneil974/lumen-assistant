import Foundation

/// Valeur JSON arbitraire (texte, nombre, booléen, liste, dictionnaire).
enum JSONValue: Codable, Hashable {
    case string(String), number(Double), bool(Bool), array([JSONValue]), object([String: JSONValue]), null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        case .null: try c.encodeNil()
        }
    }

    init(any: Any?) {
        switch any {
        case let s as String: self = .string(s)
        case let b as Bool: self = .bool(b)
        case let n as NSNumber: self = CFGetTypeID(n) == CFBooleanGetTypeID() ? .bool(n.boolValue) : .number(n.doubleValue)
        case let a as [Any]: self = .array(a.map { JSONValue(any: $0) })
        case let o as [String: Any]: self = .object(o.mapValues { JSONValue(any: $0) })
        default: self = .null
        }
    }

    var any: Any {
        switch self {
        case .string(let s): s
        case .number(let n): n
        case .bool(let b): b
        case .array(let a): a.map(\.any)
        case .object(let o): o.mapValues(\.any)
        case .null: NSNull()
        }
    }

    /// Texte lisible (widgets, Siri, listes).
    var display: String {
        switch self {
        case .string(let s): s
        case .number(let n): n.rounded() == n && abs(n) < 1e15 ? String(Int64(n)) : String(n)
        case .bool(let b): b ? String(localized: "oui") : String(localized: "non")
        case .array(let a): a.map(\.display).joined(separator: ", ")
        case .object(let o): o.sorted { $0.key < $1.key }.map { "\($0.key) : \($0.value.display)" }.joined(separator: " · ")
        case .null: "—"
        }
    }

    /// Résumé d'une ligne : une liste d'objets devient « N éléments ».
    var summary: String {
        if case .array(let a) = self, a.contains(where: { if case .object = $0 { true } else { false } }) {
            return String(localized: "\(a.count) éléments")
        }
        return display
    }

    var list: [JSONValue] { if case .array(let a) = self { a } else if case .null = self { [] } else { [self] } }
}

/// Entrée du coffre (miroir de src-tauri/src/vault.rs).
struct VaultEntry: Codable, Identifiable, Hashable {
    var id: String { key }
    var key: String
    var type: String
    var value: JSONValue
    var updated_ms: UInt64
    var device: String = ""
    var deleted: Bool = false
    /// Modifiée ici, pas encore envoyée à Lumen.
    var dirty: Bool? = nil

    var folder: String { key.contains("/") ? String(key[..<key.lastIndex(of: "/")!]) : "" }
    var name: String { key.split(separator: "/").last.map(String.init) ?? key }
}

/// Copie locale du coffre, partagée app ↔ widgets ↔ intents (App Group).
/// Écrit hors ligne ; `sync()` fusionne avec Lumen (dernière écriture gagne).
///
/// UNE copie par compte (serveur + profil, `SharedStore.accountKey`), avec son
/// propre curseur `since_ms` : une modification faite hors ligne sur le coffre
/// de A ne part jamais vers B, et changer d'ordinateur ou de profil ne montre
/// plus les données du compte quitté — sans effacer ce qu'il n'a pas encore
/// synchronisé (sa copie attend son retour).
struct VaultCollection: Codable, Identifiable {
    struct Field: Codable { let name, label, type: String; let required: Bool }
    let id, name, description, ai_access: String
    let fields: [Field]
    let updated_ms: UInt64
}

enum VaultStore {
    private static var dir: URL {
        let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: SharedStore.group)
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// Fichier d'un compte ; nil sans compte connecté (rien n'est lu ni écrit).
    private static func fileURL(_ account: String?) -> URL? {
        guard let account else { return nil }
        let url = dir.appending(path: "vault-\(account).json")
        // Migration : l'ancien fichier unique revient au premier compte ouvert
        // après la mise à jour (celui qui l'avait rempli, en pratique).
        let legacy = dir.appending(path: "vault.json")
        if !FileManager.default.fileExists(atPath: url.path), FileManager.default.fileExists(atPath: legacy.path) {
            try? FileManager.default.moveItem(at: legacy, to: url)
        }
        return url
    }

    private struct File: Codable {
        var entries: [String: VaultEntry] = [:]
        var since_ms: UInt64 = 0
        var collections: [VaultCollection]? = nil
    }

    private static let lock = NSLock()

    private static func load(_ account: String? = SharedStore.accountKey) -> File {
        fileURL(account).flatMap { try? Data(contentsOf: $0) }.flatMap { try? JSONDecoder().decode(File.self, from: $0) } ?? File()
    }

    private static func save(_ f: File, _ account: String? = SharedStore.accountKey) {
        guard let url = fileURL(account) else { return }
        if let d = try? JSONEncoder().encode(f) { try? d.write(to: url, options: .atomic) }
        // Subscribers read the vault again. Posting while NSLock is held can
        // deadlock a synchronous onReceive, and sync may run off the UI thread.
        DispatchQueue.main.async {
            if account == SharedStore.accountKey { NotificationCenter.default.post(name: changed, object: nil) }
        }
    }

    static let changed = Notification.Name("LumenVaultChanged")

    static var collections: [VaultCollection] { lock.withLock { load().collections ?? [] } }

    static var all: [VaultEntry] {
        lock.lock(); defer { lock.unlock() }
        return load().entries.values.filter { !$0.deleted }.sorted { $0.key < $1.key }
    }

    static func get(_ key: String) -> VaultEntry? {
        let k = norm(key)
        return all.first { $0.key == k }
    }

    static func norm(_ key: String) -> String {
        key.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/")).lowercased()
    }

    static func kind(of v: JSONValue) -> String {
        switch v {
        case .bool: "bool"
        case .number: "number"
        case .array: "list"
        case .object: "dict"
        case .string(let s): s.count >= 10 && s.dropFirst(4).first == "-" && s.prefix(4).allSatisfy(\.isNumber) ? "date" : "text"
        case .null: "text"
        }
    }

    private static var nowMs: UInt64 { UInt64(Date().timeIntervalSince1970 * 1000) }

    @discardableResult
    static func set(_ key: String, _ value: JSONValue, type: String? = nil) -> VaultEntry {
        lock.lock()
        var f = load()
        let k = norm(key)
        let prev = f.entries[k]?.updated_ms ?? 0
        let e = VaultEntry(key: k, type: type ?? kind(of: value), value: value, updated_ms: max(nowMs, prev + 1),
                           device: "iPhone", deleted: false, dirty: true)
        f.entries[k] = e
        save(f)
        lock.unlock()
        return e
    }

    static func append(_ key: String, _ item: JSONValue) {
        let current = get(key)?.value.list ?? []
        set(key, .array(current + [item]), type: "list")
    }

    static func delete(_ key: String) {
        lock.lock()
        var f = load()
        let k = norm(key)
        if var e = f.entries[k] {
            e.deleted = true; e.value = .null; e.updated_ms = max(nowMs, e.updated_ms + 1); e.dirty = true; e.device = "iPhone"
            f.entries[k] = e
            save(f)
        }
        lock.unlock()
    }

    /// Changements reçus de Lumen (WebSocket ou synchro) : dernière écriture gagne.
    static func merge(_ incoming: [VaultEntry], account: String? = SharedStore.accountKey) {
        guard !incoming.isEmpty else { return }
        lock.lock()
        var f = load(account)
        for var e in incoming {
            if let cur = f.entries[e.key], cur.updated_ms >= e.updated_ms { continue }
            e.dirty = nil
            f.entries[e.key] = e
        }
        save(f, account)
        lock.unlock()
    }

    /// Pousse les changements locaux, récupère ceux de Lumen.
    @discardableResult
    static func sync() async -> Bool {
        // Le compte est figé AU DÉPART : si l'utilisateur change de serveur ou
        // de profil pendant la requête, la réponse retourne dans la bonne copie.
        guard let server = SharedStore.server, let token = SharedStore.token else { return false }
        let account = SharedStore.accountKey(server: server, token: token)
        let f = lock.withLock { load(account) }
        let dirty = f.entries.values.filter { $0.dirty == true }
        let body: [String: Any] = [
            "since_ms": f.since_ms,
            "changes": dirty.map { e -> [String: Any] in
                ["key": e.key, "type": e.type, "value": e.value.any, "updated_ms": e.updated_ms, "device": e.device, "deleted": e.deleted]
            },
        ]
        var req = URLRequest(url: server.appending(path: "vault/sync"))
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        req.timeoutInterval = 12
        let session = URLSession(configuration: .ephemeral, delegate: PinnedTrust(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        guard let (data, resp) = try? await session.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200,
              let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        let remote = (j["entries"] as? [[String: Any]] ?? []).compactMap(entry(from:))
        let now = (j["now_ms"] as? NSNumber)?.uint64Value
        lock.withLock {
            var g = load(account)
            // Envoyés : plus « sales » (sauf s'ils ont bougé depuis).
            for e in dirty where g.entries[e.key]?.updated_ms == e.updated_ms { g.entries[e.key]?.dirty = nil }
            for var e in remote {
                if let cur = g.entries[e.key], cur.updated_ms >= e.updated_ms { continue }
                e.dirty = nil
                g.entries[e.key] = e
            }
            if let raw = j["collections"], let data = try? JSONSerialization.data(withJSONObject: raw),
               let collections = try? JSONDecoder().decode([VaultCollection].self, from: data) { g.collections = collections }
            g.since_ms = now ?? g.since_ms
            save(g, account)
        }
        return true
    }

    static func entry(from d: [String: Any]) -> VaultEntry? {
        guard let key = d["key"] as? String else { return nil }
        return VaultEntry(key: key, type: d["type"] as? String ?? "text", value: JSONValue(any: d["value"]),
                          updated_ms: (d["updated_ms"] as? NSNumber)?.uint64Value ?? 0,
                          device: d["device"] as? String ?? "", deleted: d["deleted"] as? Bool ?? false)
    }

    /// Texte tapé → valeur typée (même règles que vault.rs::parse_value).
    static func parse(_ s: String, type: String) -> JSONValue {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        switch type {
        case "number": return Double(t.replacingOccurrences(of: ",", with: ".")).map(JSONValue.number) ?? .string(t)
        case "bool": return .bool(["true", "vrai", "oui", "yes", "1", "on"].contains(t.lowercased()))
        case "list": return .array(t.split(separator: ",").map { .string($0.trimmingCharacters(in: .whitespaces)) }.filter { $0 != .string("") })
        case "dict":
            if let d = t.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) { return JSONValue(any: o) }
            return .string(t)
        default: return .string(t)
        }
    }
}
