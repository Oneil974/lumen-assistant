import AppIntents
import Foundation
import Speech
import UniformTypeIdentifiers

// Raccourcis Apple : les modules de Lumen en actions réutilisables (Siri,
// Raccourcis, automatisations, bouton Action). Chaque action appelle une route
// /sc/* du compagnon (src-tauri/src/companion.rs) et rend un résultat
// exploitable par l'action suivante — du texte le plus souvent, une image pour
// « Générer une image ». Aucune n'ouvre l'app, sauf « Ouvrir Messages ».

// MARK: - Entités

/// Un agent de l'atelier (Siri le connaît par son nom).
struct AgentEntity: AppEntity, Identifiable {
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Agent"
    static var defaultQuery = AgentQuery()
    let id: String
    let name: String
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

struct AgentQuery: EntityQuery, EntityStringQuery {
    func all() async throws -> [AgentEntity] {
        let j = try await BackgroundAPI.getJSON("agents/list")
        return ((j["items"] as? [[String: Any]]) ?? []).map { AgentEntity(id: $0["id"] as? String ?? "", name: $0["name"] as? String ?? "") }
    }
    func entities(for identifiers: [String]) async throws -> [AgentEntity] { try await all().filter { identifiers.contains($0.id) } }
    func suggestedEntities() async throws -> [AgentEntity] { try await all() }
    func entities(matching string: String) async throws -> [AgentEntity] {
        try await all().filter { $0.name.localizedCaseInsensitiveContains(string) }
    }
}

/// Interlocuteur de Messages : Lumen ou un agent.
struct ContactEntity: AppEntity, Identifiable {
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Contact Lumen"
    static var defaultQuery = ContactQuery()
    /// « lumen » pour Lumen (un identifiant d'entité ne peut pas être vide).
    let id: String
    let name: String
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
    var contactId: String { id == "lumen" ? "" : id }
}

struct ContactQuery: EntityQuery, EntityStringQuery {
    func all() async throws -> [ContactEntity] {
        let j = try await BackgroundAPI.getJSON("messenger/contacts")
        return ((j["items"] as? [[String: Any]]) ?? []).map {
            let id = $0["id"] as? String ?? ""
            return ContactEntity(id: id.isEmpty ? "lumen" : id, name: $0["name"] as? String ?? "Lumen")
        }
    }
    func entities(for identifiers: [String]) async throws -> [ContactEntity] { try await all().filter { identifiers.contains($0.id) } }
    func suggestedEntities() async throws -> [ContactEntity] { try await all() }
    func entities(matching string: String) async throws -> [ContactEntity] {
        try await all().filter { $0.name.localizedCaseInsensitiveContains(string) }
    }
    func defaultResult() async -> ContactEntity? { ContactEntity(id: "lumen", name: "Lumen") }
}

/// Un bloc de document vivant.
struct LivingEntity: AppEntity, Identifiable {
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Document vivant"
    static var defaultQuery = LivingQuery()
    let id: String
    let title: String
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(title)") }
}

struct LivingQuery: EntityQuery {
    func all() async throws -> [LivingEntity] {
        let j = try await BackgroundAPI.getJSON("sc/living")
        return ((j["items"] as? [[String: Any]]) ?? []).map { LivingEntity(id: $0["id"] as? String ?? "", title: $0["title"] as? String ?? "") }
    }
    func entities(for identifiers: [String]) async throws -> [LivingEntity] { try await all().filter { identifiers.contains($0.id) } }
    func suggestedEntities() async throws -> [LivingEntity] { try await all() }
}

/// Un workflow Fluxo.
struct WorkflowEntity: AppEntity, Identifiable {
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Workflow Fluxo"
    static var defaultQuery = WorkflowQuery()
    let id: String
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(id)") }
}

struct WorkflowQuery: EntityQuery, EntityStringQuery {
    func all() async throws -> [WorkflowEntity] {
        let j = try await BackgroundAPI.getJSON("sc/workflows")
        return ((j["items"] as? [String]) ?? []).map { WorkflowEntity(id: $0) }
    }
    func entities(for identifiers: [String]) async throws -> [WorkflowEntity] { identifiers.map { WorkflowEntity(id: $0) } }
    func suggestedEntities() async throws -> [WorkflowEntity] { try await all() }
    func entities(matching string: String) async throws -> [WorkflowEntity] {
        try await all().filter { $0.id.localizedCaseInsensitiveContains(string) }
    }
}

enum TextAction: String, AppEnum {
    case summarize, translate, proofread, friendly, professional, bullets, rewrite
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Transformation"
    static var caseDisplayRepresentations: [TextAction: DisplayRepresentation] = [
        .summarize: "Résumer", .translate: "Traduire", .proofread: "Corriger", .friendly: "Ton chaleureux",
        .professional: "Ton professionnel", .bullets: "Points clés", .rewrite: "Réécrire",
    ]
}

/// Texte d'une réponse /sc/* (ou l'erreur, dite simplement).
private func text(_ j: [String: Any]) -> String { (j["text"] as? String) ?? "" }
private func failure(_ error: Error) -> String { error.localizedDescription }

// MARK: - Messages

struct MessageLumenIntent: AppIntent {
    static var title: LocalizedStringResource = "Écrire à Lumen"
    static var description = IntentDescription("Envoie un message à Lumen (ou à un agent) dans Messages et renvoie sa réponse.")

    @Parameter(title: "À") var contact: ContactEntity?
    @Parameter(title: "Message", requestValueDialog: "Que veux-tu écrire ?") var message: String

    static var parameterSummary: some ParameterSummary { Summary("Écrire \(\.$message) à \(\.$contact)") }

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        do {
            let j = try await BackgroundAPI.json("sc/message", ["contact": contact?.contactId ?? "", "text": message], timeout: 250)
            return .result(value: text(j), dialog: "\(text(j))")
        } catch { return .result(value: "", dialog: "\(failure(error))") }
    }
}

struct OpenMessagesIntent: AppIntent {
    static var title: LocalizedStringResource = "Ouvrir Messages"
    static var description = IntentDescription("Ouvre Lumen en mode messagerie.")
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        UserDefaults.standard.set("messages", forKey: "companionMode")
        return .result()
    }
}

// MARK: - Agents

struct AskAgentIntent: AppIntent {
    static var title: LocalizedStringResource = "Demander à un agent"
    static var description = IntentDescription("Confie une demande à un agent de Lumen et renvoie son compte rendu.")

    @Parameter(title: "Agent") var agent: AgentEntity
    @Parameter(title: "Demande", requestValueDialog: "Que dois-je lui demander ?") var request: String

    static var parameterSummary: some ParameterSummary { Summary("Demander à \(\.$agent) : \(\.$request)") }

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        do {
            let j = try await BackgroundAPI.json("sc/agent/ask", ["agent": agent.id, "text": request], timeout: 300)
            return .result(value: text(j), dialog: "\(text(j))")
        } catch { return .result(value: "", dialog: "\(failure(error))") }
    }
}

struct GiveTaskIntent: AppIntent {
    static var title: LocalizedStringResource = "Confier une tâche à un agent"
    static var description = IntentDescription("Ajoute une tâche à la liste d'un agent et le met au travail, sans attendre la fin.")

    @Parameter(title: "Agent") var agent: AgentEntity
    @Parameter(title: "Tâche") var task: String

    func perform() async throws -> some IntentResult & ProvidesDialog {
        do {
            try await BackgroundAPI.post("agents/task", ["id": agent.id, "text": task])
            return .result(dialog: "\(agent.name) s'en occupe.")
        } catch { return .result(dialog: "\(failure(error))") }
    }
}

struct RunAgentIntent: AppIntent {
    static var title: LocalizedStringResource = "Lancer un agent"
    static var description = IntentDescription("Lance un tour de travail d'un agent maintenant.")

    @Parameter(title: "Agent") var agent: AgentEntity

    func perform() async throws -> some IntentResult & ProvidesDialog {
        do {
            try await BackgroundAPI.post("agents/run", ["id": agent.id])
            return .result(dialog: "\(agent.name) est au travail.")
        } catch { return .result(dialog: "\(failure(error))") }
    }
}

struct AgentsStatusIntent: AppIntent {
    static var title: LocalizedStringResource = "État des agents"
    static var description = IntentDescription("Qui travaille, et ce qui attend ta décision.")

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        do {
            let j = try await BackgroundAPI.getJSON("sc/status")
            return .result(value: text(j), dialog: "\(text(j))")
        } catch { return .result(value: "", dialog: "\(failure(error))") }
    }
}

struct DecideApprovalIntent: AppIntent {
    static var title: LocalizedStringResource = "Répondre aux demandes des agents"
    static var description = IntentDescription("Approuve ou refuse la dernière action en attente (ou toutes).")

    @Parameter(title: "Approuver", default: true) var approve: Bool
    @Parameter(title: "Toutes les demandes", default: false) var all: Bool

    func perform() async throws -> some IntentResult & ProvidesDialog {
        do {
            let j = try await BackgroundAPI.json("sc/approve", ["approve": approve, "all": all])
            return .result(dialog: "\(text(j))")
        } catch { return .result(dialog: "\(failure(error))") }
    }
}

// MARK: - Données et journée

struct MyDayIntent: AppIntent {
    static var title: LocalizedStringResource = "Ma journée"
    static var description = IntentDescription("Agenda, tâches et météo du jour, résumés par Lumen. Idéal au réveil.")

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        do {
            let data = try await BackgroundAPI.get("sc/day", timeout: 90)
            let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
            return .result(value: text(j), dialog: "\(text(j))")
        } catch { return .result(value: "", dialog: "\(failure(error))") }
    }
}

struct SearchMyDataIntent: AppIntent {
    static var title: LocalizedStringResource = "Chercher dans mes données"
    static var description = IntentDescription("Cherche dans tout ce que Lumen connaît : notes, mails, tâches, agenda…")

    @Parameter(title: "Recherche") var query: String

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        do {
            let j = try await BackgroundAPI.json("data/query", ["mode": "search", "text": query, "limit": 8])
            let lines = ((j["records"] as? [[String: Any]]) ?? []).map { r in
                let title = r["title"] as? String ?? ""
                let app = r["app"] as? String ?? ""
                let body = (r["text"] as? String ?? "").prefix(140)
                return "• \(title) (\(app))" + (body.isEmpty ? "" : " — \(body)")
            }
            let out = lines.isEmpty ? String(localized: "Rien trouvé.") : lines.joined(separator: "\n")
            return .result(value: out, dialog: "\(out)")
        } catch { return .result(value: "", dialog: "\(failure(error))") }
    }
}

// MARK: - Documents et texte

struct CreateNoteIntent: AppIntent {
    static var title: LocalizedStringResource = "Créer une note Lumen"
    static var description = IntentDescription("Crée une note dans l'app Notes de Lumen (le texte partagé depuis une autre app, par exemple).")

    @Parameter(title: "Titre") var title: String?
    @Parameter(title: "Contenu") var content: String

    func perform() async throws -> some IntentResult & ProvidesDialog {
        do {
            _ = try await BackgroundAPI.json("sc/note", ["title": title ?? "", "text": content])
            return .result(dialog: "Note créée dans Lumen.")
        } catch { return .result(dialog: "\(failure(error))") }
    }
}

struct RefreshLivingIntent: AppIntent {
    static var title: LocalizedStringResource = "Mettre à jour un document vivant"
    static var description = IntentDescription("Demande à l'agent d'un document vivant de le mettre à jour tout de suite.")

    @Parameter(title: "Document vivant") var block: LivingEntity

    func perform() async throws -> some IntentResult & ProvidesDialog {
        do {
            _ = try await BackgroundAPI.json("sc/living/run", ["id": block.id], timeout: 300)
            return .result(dialog: "« \(block.title) » est à jour.")
        } catch { return .result(dialog: "\(failure(error))") }
    }
}

struct TransformTextIntent: AppIntent {
    static var title: LocalizedStringResource = "Transformer un texte avec Lumen"
    static var description = IntentDescription("Résume, traduit, corrige ou reformule un texte avec le modèle de Lumen.")

    @Parameter(title: "Action", default: .summarize) var action: TextAction
    @Parameter(title: "Texte") var input: String
    @Parameter(title: "Langue (traduction)", default: "anglais") var language: String

    static var parameterSummary: some ParameterSummary {
        When(\.$action, .equalTo, .translate) {
            Summary("\(\.$action) \(\.$input) en \(\.$language)")
        } otherwise: {
            Summary("\(\.$action) \(\.$input)")
        }
    }

    func perform() async throws -> some IntentResult & ReturnsValue<String> {
        let j = try await BackgroundAPI.json("sc/text", ["action": action.rawValue, "text": input, "lang": language], timeout: 120)
        return .result(value: text(j))
    }
}

// MARK: - Création et voix

struct GenerateImageIntent: AppIntent {
    static var title: LocalizedStringResource = "Générer une image avec Lumen"
    static var description = IntentDescription("Crée une image avec le moteur d'image de Lumen (sur ton ordinateur).")

    @Parameter(title: "Description") var prompt: String

    func perform() async throws -> some IntentResult & ReturnsValue<IntentFile> {
        let data = try await BackgroundAPI.post("sc/image", ["text": prompt], timeout: 300)
        return .result(value: IntentFile(data: data, filename: "lumen.png", type: .png))
    }
}

struct SpeakOnMacIntent: AppIntent {
    static var title: LocalizedStringResource = "Lire à voix haute sur l'ordinateur"
    static var description = IntentDescription("L'ordinateur lit un texte avec une voix de Lumen.")

    @Parameter(title: "Texte") var input: String
    @Parameter(title: "Voix (facultatif)") var voice: String?

    func perform() async throws -> some IntentResult {
        try await BackgroundAPI.post("sc/speak", ["text": input, "voice": voice ?? ""], timeout: 30)
        return .result()
    }
}

/// Transcription SUR L'IPHONE (reconnaissance vocale d'Apple, sur l'appareil
/// quand c'est possible) : l'audio ne part pas chez Lumen.
struct TranscribeAudioIntent: AppIntent {
    static var title: LocalizedStringResource = "Transcrire un mémo vocal"
    static var description = IntentDescription("Transforme un fichier audio en texte, sur l'iPhone.")

    @Parameter(title: "Audio", supportedContentTypes: [.audio]) var audio: IntentFile

    func perform() async throws -> some IntentResult & ReturnsValue<String> {
        let status = await withCheckedContinuation { c in SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) } }
        guard status == .authorized, let recognizer = SFSpeechRecognizer(locale: Locale.current), recognizer.isAvailable else {
            throw BackgroundAPIError.status(0, String(localized: "La reconnaissance vocale n'est pas autorisée."))
        }
        let url = FileManager.default.temporaryDirectory.appending(path: "lumen-memo-\(UUID().uuidString).\(audio.filename.split(separator: ".").last ?? "m4a")")
        try audio.data.write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let request = SFSpeechURLRecognitionRequest(url: url)
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        let text: String = try await withCheckedThrowingContinuation { c in
            var done = false
            recognizer.recognitionTask(with: request) { result, error in
                guard !done else { return }
                if let error { done = true; c.resume(throwing: error); return }
                if let result, result.isFinal { done = true; c.resume(returning: result.bestTranscription.formattedString) }
            }
        }
        return .result(value: text)
    }
}

// MARK: - Maison, workflows, bureau

struct HomeDevicesIntent: AppIntent {
    static var title: LocalizedStringResource = "État de la maison"
    static var description = IntentDescription("Les appareils domotiques de Lumen et leur état.")

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        do {
            let j = try await BackgroundAPI.getJSON("sc/home")
            return .result(value: text(j), dialog: "\(text(j))")
        } catch { return .result(value: "", dialog: "\(failure(error))") }
    }
}

struct HomeCommandIntent: AppIntent {
    static var title: LocalizedStringResource = "Piloter un appareil de la maison"
    static var description = IntentDescription("Envoie une commande (on, off, toggle…) à un appareil domotique de Lumen.")

    @Parameter(title: "Appareil") var device: String
    @Parameter(title: "Action", default: "toggle") var action: String
    @Parameter(title: "Composant (facultatif)") var component: String?

    func perform() async throws -> some IntentResult & ProvidesDialog {
        do {
            var body: [String: Any] = ["device": device, "action": action]
            if let component, !component.isEmpty { body["component"] = component }
            let j = try await BackgroundAPI.json("sc/home/cmd", body)
            return .result(dialog: "\(text(j).isEmpty ? "C'est fait." : text(j))")
        } catch { return .result(dialog: "\(failure(error))") }
    }
}

struct RunWorkflowIntent: AppIntent {
    static var title: LocalizedStringResource = "Lancer un workflow Fluxo"
    static var description = IntentDescription("Exécute un workflow Fluxo de Lumen et renvoie sa sortie.")

    @Parameter(title: "Workflow") var workflow: WorkflowEntity
    @Parameter(title: "Entrée (facultatif)") var input: String?

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        do {
            let j = try await BackgroundAPI.json("sc/workflow", ["name": workflow.id, "input": input ?? ""], timeout: 300)
            return .result(value: text(j), dialog: "\(text(j).isEmpty ? "Terminé." : text(j))")
        } catch { return .result(value: "", dialog: "\(failure(error))") }
    }
}

struct OpenMacAppIntent: AppIntent {
    static var title: LocalizedStringResource = "Ouvrir une app sur l'ordinateur"
    static var description = IntentDescription("Ouvre une app de Lumen OS (Notes, Agenda, Messages…) sur l'ordinateur.")

    @Parameter(title: "App") var app: String

    func perform() async throws -> some IntentResult & ProvidesDialog {
        do {
            _ = try await BackgroundAPI.json("sc/open", ["name": app])
            return .result(dialog: "\(app) s'ouvre sur l'ordinateur.")
        } catch { return .result(dialog: "\(failure(error))") }
    }
}
