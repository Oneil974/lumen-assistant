import Foundation

/// Une fiche du coffre unifié de Lumen (src-tauri/src/datahub.rs) : tâche,
/// évènement, note, contact, message, fichier, mesure… venue de n'importe
/// quelle app (Kanban, Notes, Agenda, iPhone, Courrier, Bases…).
struct HubRecord: Codable, Identifiable, Hashable {
    let id: String
    let app: String
    let type: String
    let title: String
    var text: String = ""
    var start: Int64 = 0
    var end: Int64 = 0
    var status: String = ""
    var tags: String = ""
    var people: String = ""
    var place: String = ""
    /// Adresse du fichier d'origine (lumenmedia://…), vide sinon.
    var url: String = ""

    var date: Date? { start > 0 ? Date(timeIntervalSince1970: Double(start) / 1000) : nil }

    var icon: String {
        switch type {
        case "event": "calendar"
        case "task": status.hasPrefix("fait") ? "checkmark.circle.fill" : "circle"
        case "note": "note.text"
        case "contact": "person.crop.circle"
        case "message": "envelope"
        case "file": "doc"
        case "document": "doc.text"
        case "image": "photo"
        case "media": "play.rectangle"
        case "table": "tablecells"
        case "metric": "chart.line.uptrend.xyaxis"
        case "list": "list.bullet"
        case "agent": "sparkles"
        default: "square.stack"
        }
    }

    /// Ligne secondaire : app, date, statut, extrait.
    var subtitle: String {
        var parts = [app]
        if let d = date {
            let allDay = tags.contains("journée")
            parts.append(allDay ? d.formatted(date: .abbreviated, time: .omitted) : d.formatted(date: .abbreviated, time: .shortened))
        }
        for x in [status, place, people] where !x.isEmpty { parts.append(x) }
        if !text.isEmpty, type != "event" { parts.append(String(text.prefix(140))) }
        return parts.joined(separator: " · ")
    }

    /// Texte pour le modèle local.
    var line: String {
        var s = "• \(title)"
        if let d = date { s += " — \(d.formatted(date: .abbreviated, time: .shortened))" }
        s += " (\(type), \(app)\(status.isEmpty ? "" : ", \(status)"))"
        if !text.isEmpty { s += " : \(text.prefix(200))" }
        return s
    }
}

/// Accès au coffre unifié depuis l'iPhone : requêtes en ligne (`/data/query`)
/// et copie locale des fiches utiles (agenda à 30 jours, tâches ouvertes,
/// mesures, notes récentes) pour l'IA hors ligne.
enum DataHub {
    enum Mode: String, CaseIterable, Identifiable {
        case sources, search, agenda, tasks, metrics
        var id: String { rawValue }
    }

    /// Une source du coffre (app, sandbox, iPhone…) et son nombre de fiches.
    struct Source: Decodable, Identifiable, Hashable {
        let id: String
        let label_fr: String
        let label_en: String
        let count: Int
        var label: String { Locale.current.language.languageCode?.identifier == "en" ? label_en : label_fr }
    }

    static func sources() async throws -> [Source] {
        let data = try await BackgroundAPI.post("data/query", ["mode": "overview"])
        struct Out: Decodable { let sources: [Source] }
        return try JSONDecoder().decode(Out.self, from: data).sources.filter { $0.count > 0 }
    }

    /// Fiche complète (texte intégral) par son id.
    static func record(_ id: String) async throws -> HubRecord? {
        let data = try await BackgroundAPI.post("data/query", ["mode": "get", "text": id])
        struct Out: Decodable { let records: [HubRecord] }
        return try JSONDecoder().decode(Out.self, from: data).records.first
    }

    /// Fiches d'une source, les plus récentes d'abord.
    static func records(source: String, limit: Int = 300) async throws -> [HubRecord] {
        let data = try await BackgroundAPI.post("data/query", ["mode": "source", "source": source, "limit": limit])
        struct Out: Decodable { let records: [HubRecord] }
        return try JSONDecoder().decode(Out.self, from: data).records
    }

    static func query(_ mode: Mode, text: String = "", period: String = "", limit: Int = 60) async throws -> [HubRecord] {
        var body: [String: Any] = ["mode": mode.rawValue, "text": text, "limit": limit]
        if !period.isEmpty { body["period"] = period }
        let data = try await BackgroundAPI.post("data/query", body)
        struct Out: Decodable { let records: [HubRecord] }
        return try JSONDecoder().decode(Out.self, from: data).records
    }

    // MARK: Copie locale (App Group, lue par l'IA hors ligne)
    //
    // Rangée PAR COMPTE (serveur + profil) et PAR SOURCE (agenda, tâches,
    // mesures), chacune avec sa date : si l'agenda répond mais pas les tâches,
    // les anciennes tâches restent et gardent leur ancienne date de fraîcheur.

    private static let key = "dataHubCache"
    private static let parts: [(name: String, mode: Mode, period: String, limit: Int)] = [
        ("agenda", .agenda, "next_30_days", 150),
        ("tasks", .tasks, "", 100),
        ("metrics", .metrics, "", 40),
    ]
    private static var defaults: UserDefaults { SharedStore.defaults }

    private static func slot(_ account: String, _ part: String) -> String { "\(key).\(account).\(part)" }

    static var cached: [HubRecord] {
        guard let account = SharedStore.accountKey else { return [] }
        var seen = Set<String>()
        return parts.flatMap { p -> [HubRecord] in
            guard let d = defaults.data(forKey: slot(account, p.name)) else { return [] }
            return (try? JSONDecoder().decode([HubRecord].self, from: d)) ?? []
        }.filter { seen.insert($0.id).inserted }
    }

    /// Fraîcheur de la source la PLUS ANCIENNE : on ne prétend pas que tout
    /// est à jour quand une partie seulement l'est.
    static var cachedAt: Date? {
        guard let account = SharedStore.accountKey else { return nil }
        let dates = parts.map { defaults.object(forKey: slot(account, $0.name) + ".at") as? Date }
        // Une source jamais reçue : fraîcheur inconnue.
        guard !dates.contains(where: { $0 == nil }) else { return nil }
        return dates.compactMap { $0 }.min()
    }

    /// Rafraîchit la copie locale (silencieux si Lumen est injoignable).
    static func refreshCache() async {
        guard let account = SharedStore.accountKey else { return }
        // Ancien cache global, sans compte : il pourrait venir d'un autre profil.
        defaults.removeObject(forKey: key)
        defaults.removeObject(forKey: key + ".at")
        await withTaskGroup(of: Void.self) { group in
            for p in parts {
                group.addTask {
                    guard let records = try? await query(p.mode, period: p.period, limit: p.limit),
                          let d = try? JSONEncoder().encode(records) else { return }
                    // Le compte a pu changer pendant la requête : on n'écrit pas
                    // la réponse d'un compte dans la copie d'un autre.
                    guard SharedStore.accountKey == account else { return }
                    defaults.set(d, forKey: slot(account, p.name))
                    defaults.set(Date.now, forKey: slot(account, p.name) + ".at")
                }
            }
        }
    }

    /// Recherche dans la copie locale (mots-clés, accents ignorés).
    static func searchLocal(_ text: String, type: String? = nil) -> [HubRecord] {
        let fold = { (s: String) in s.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current) }
        let words = fold(text).split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init).filter { $0.count >= 3 }
        return cached.filter { r in
            (type == nil || r.type == type) &&
            (words.isEmpty || words.contains { w in fold("\(r.title) \(r.text) \(r.tags) \(r.people) \(r.place)").contains(w) })
        }
        .sorted { ($0.start == 0 ? Int64.max : $0.start) < ($1.start == 0 ? Int64.max : $1.start) }
    }
}
