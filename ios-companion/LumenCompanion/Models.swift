import Foundation

/// Modèles décodés des messages WebSocket du compagnon (src/companion.js est
/// la référence du protocole). Décodage tolérant via JSON « libre » : un champ
/// absent ou nouveau côté ordinateur ne doit jamais casser l'app.
typealias JSON = [String: Any]

extension Dictionary where Key == String, Value == Any {
    func str(_ k: String) -> String { (self[k] as? String) ?? (self[k].map { "\($0)" } ?? "") }
    func bool(_ k: String) -> Bool { (self[k] as? Bool) ?? false }
    func int(_ k: String) -> Int? { (self[k] as? Int) ?? (self[k] as? Double).map(Int.init) }
    func double(_ k: String) -> Double? { (self[k] as? Double) ?? (self[k] as? Int).map(Double.init) }
    func arr(_ k: String) -> [JSON] { (self[k] as? [JSON]) ?? [] }
    func strings(_ k: String) -> [String] { (self[k] as? [String]) ?? [] }
    func obj(_ k: String) -> JSON? { self[k] as? JSON }
}

struct UserIdentity: Codable, Equatable {
    var id: String?
    var name: String
    var avatar: String?

    init?(_ j: JSON?) {
        guard let j else { return nil }
        id = j["id"] as? String
        name = j.str("name")
        avatar = (j["avatar"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    }
}

struct ProgressEvent: Identifiable {
    let id = UUID()
    let kind: String
    let message: String
    let path: String?
}

enum MessageBlock: Identifiable {
    case think(label: String?, text: String, live: Bool)
    case tool(name: String, args: String, result: String?)
    case plan(title: String, live: Bool, summary: String, steps: [PlanStep])

    var id: String {
        switch self {
        case .think(_, let t, _): "think-\(t.hashValue)"
        case .tool(let n, let a, _): "tool-\(n)-\(a.hashValue)"
        case .plan(let t, _, _, _): "plan-\(t)"
        }
    }
}

struct PlanStep: Identifiable {
    let id: String
    let label: String
    let status: String
    let detail: String
}

struct ChatMessage: Identifiable {
    let id: Int
    let isUser: Bool
    let text: String
    let progress: [ProgressEvent]
    let blocks: [MessageBlock]

    init(index: Int, _ j: JSON) {
        id = index
        isUser = j.str("sender") == "user"
        text = j.str("text")
        progress = j.arr("progress").map {
            ProgressEvent(kind: $0.str("kind"), message: $0.str("message"),
                          path: ($0["path"] as? String).flatMap { $0.isEmpty ? nil : $0 })
        }
        blocks = j.arr("blocks").map { b in
            switch b.str("kind") {
            case "plan":
                return .plan(title: b.str("title"), live: b.bool("live"), summary: b.str("summary"),
                             steps: b.arr("steps").map {
                                 PlanStep(id: $0.str("id"), label: $0.str("label"),
                                          status: $0.str("status"), detail: $0.str("detail"))
                             })
            case "think":
                return .think(label: (b["label"] as? String), text: b.str("text"), live: b.bool("live"))
            default:
                return .tool(name: b.str("name"), args: Self.stringify(b["args"]),
                             result: b["result"].map { Self.stringify($0) })
            }
        }
    }

    static func stringify(_ v: Any?) -> String {
        guard let v, !(v is NSNull) else { return "" }
        if let s = v as? String { return s }
        if JSONSerialization.isValidJSONObject(v),
           let d = try? JSONSerialization.data(withJSONObject: v, options: [.prettyPrinted, .sortedKeys]),
           let s = String(data: d, encoding: .utf8) { return s }
        return "\(v)"
    }
}

struct BackendSource: Identifiable, Hashable { let id: String; let label: String }

struct BackendState {
    var source = "ollama"
    var sources: [BackendSource] = []
    var model = ""
    var models: [String] = []
    var think = false
    var thinkAvailable = false
    var vision = false
    var sourceLabel = ""
    /// Libellés lisibles envoyés par le bureau (Apple : « sur l'appareil »…).
    var modelLabels: [String: String] = [:]
    /// Où tourne le modèle : "local" (l'ordinateur), "device" (puce Apple), "cloud".
    var location = "local"

    static let short = ["ollama": "Ollama", "llama": "llama.cpp", "api": "API", "shortcut": "Raccourci",
                        "applefm": "Apple", "lumen": "Lumen Server"]

    var sourceShort: String { Self.short[source] ?? (sourceLabel.isEmpty ? source : sourceLabel) }

    func label(for m: String) -> String {
        if let l = modelLabels[m], !l.isEmpty { return l }
        return (m.split(separator: "/").last.map(String.init) ?? m)
            .replacingOccurrences(of: ".gguf", with: "", options: .caseInsensitive)
    }

    /// `hf.co/…/gemma-3-4b-it:Q4_K_M` → `gemma-3-4b-it:Q4_K_M` (comme shortModel()).
    var modelShort: String { model.isEmpty ? "" : label(for: model) }

    /// Titre de la liste de modèles, selon la source.
    var modelSection: String {
        switch source {
        case "llama": "Modèle llama.cpp"
        case "api": "Modèle de l'API"
        case "applefm": "Modèle Apple"
        case "lumen": "Modèle Lumen Server"
        default: "Modèle Ollama"
        }
    }
}

struct ModeOption: Identifiable, Hashable { let id: String; let label: String; let desc: String }

struct ModeState {
    var available = false
    var mode = "chat"
    var workflow = ""
    var modes: [ModeOption] = []
    var workflows: [String] = []

    static let short = ["chat": "Chat", "rag": "RAG", "router": "Routeur", "tools": "Outils",
                        "docs": "Docs", "workflow": "Fluxo"]
    var tag: String { mode == "workflow" ? (workflow.isEmpty ? "Fluxo" : workflow) : (Self.short[mode] ?? "Chat") }
}

struct Conversation: Identifiable, Hashable { let id: String; let title: String }

struct AttachedDoc: Identifiable, Hashable {
    var id: String { name }
    let name: String
    let rag: Bool
}

struct CenterNotification: Identifiable {
    let id = UUID()
    let name: String
    let output: String
    let success: Bool
    let date: Date?
}

struct UserRequest: Identifiable {
    let id: String
    /// "unlock" = session verrouillée → saisie du code TOTP.
    var kind: String = ""
    /// Déverrouillage : "tap" (un geste suffit) ou "code" (TOTP exigé).
    var unlockMode: String = "code"
    let title: String
    let body: String
    let options: [(id: String, label: String, primary: Bool)]
}

struct MentionItem: Identifiable, Hashable {
    var id: String { label + kind }
    let label: String
    let desc: String
    let kind: String
    let raw: NSDictionary
}

struct AgentRef: Identifiable, Hashable { let id: String; let name: String }

struct AgentActivity {
    struct Approval: Identifiable { let id: String; let agent: String; let tool: String; let risk: String; let reason: String }
    struct Line: Identifiable { let id = UUID(); let agent: String; let status: String; let text: String; let error: String }
    var approvals: [Approval] = []
    var tasks: [Line] = []
    var runs: [Line] = []

    init() {}
    init(_ j: JSON) {
        approvals = j.arr("approvals").map {
            Approval(id: $0.str("approval_id"), agent: $0.str("agent_id"), tool: $0.str("tool"),
                     risk: $0.str("risk"), reason: $0.str("reason"))
        }
        tasks = j.arr("tasks").map { Line(agent: $0.str("agent_id"), status: $0.str("status"), text: $0.str("text"), error: $0.str("error")) }
        runs = j.arr("runs").prefix(8).map { Line(agent: $0.str("agent_id"), status: $0.str("status"), text: "", error: $0.str("error")) }
    }

    static func label(_ status: String) -> String {
        [
            "running": "en cours", "succeeded": "terminé", "blocked": "bloqué", "cancelled": "annulé",
            "retry_scheduled": "nouvelle tentative", "waiting_approval": "en attente",
            "queued": "en file", "interrupted": "interrompu",
        ][status] ?? status
    }
}

/// Halo : étape d'agent ou notification poussée par l'ordinateur.
struct HaloStep: Identifiable {
    let id = UUID()
    let agentID: String
    let agentName: String
    let thought: Bool
    let label: String
    let input: String
    let result: String
    let ok: Bool
    let date: Date
}

struct HaloNotice: Identifiable, Equatable {
    let id = UUID()
    let kind: String
    let icon: String?
    let title: String
    let body: String
    let timeout: TimeInterval
}

/// Échange hors ligne, répondu par l'IA de l'iPhone (LocalAI).
struct LocalMessage: Identifiable {
    let id = UUID()
    let isUser: Bool
    let text: String
}
