import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

/// Mode autonome : quand l'ordinateur est injoignable, l'iPhone répond avec le
/// modèle d'Apple Intelligence embarqué (Foundation Models), sans rien envoyer
/// nulle part. Il connaît le coffre local (agenda, rappels, santé, listes…) et
/// peut y écrire : les changements repartent vers Lumen à la reconnexion.
enum LocalAI {
    static var available: Bool {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            if case .available = SystemLanguageModel.default.availability { return true }
        }
        #endif
        return false
    }

    /// Réponse locale à une question, avec l'historique récent de la session.
    static func answer(_ question: String, history: [(user: Bool, text: String)]) async throws -> String {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            let session = LanguageModelSession(tools: [DataSearchTool(), VaultReadTool(), VaultWriteTool(), VaultAppendTool()], instructions: instructions())
            let context = history.suffix(6).map { ($0.user ? "Utilisateur : " : "Assistant : ") + $0.text }.joined(separator: "\n")
            let prompt = context.isEmpty ? question : "Échanges précédents :\n\(context)\n\nNouvelle demande : \(question)"
            return try await session.respond(to: prompt).content
        }
        #endif
        throw NSError(domain: "Lumen", code: 1, userInfo: [NSLocalizedDescriptionKey: L("Apple Intelligence n'est pas disponible sur cet iPhone.")])
    }

    private static func instructions() -> String {
        let keys = VaultStore.all.prefix(80).map(\.key).joined(separator: ", ")
        let today = Date.now.formatted(date: .complete, time: .shortened)
        return """
        Tu es Lumen, l'assistant de l'utilisateur, en mode hors ligne sur son iPhone (son ordinateur est injoignable). \
        Nous sommes le \(today). Réponds brièvement, en français sauf si on te parle anglais. \
        Tu n'as ni internet ni les fichiers de l'ordinateur ; dis-le simplement si on te les demande. \
        Pour l'agenda, les tâches, les mesures de santé et les données des apps de Lumen, utilise data_search \
        (copie locale du coffre unifié\(DataHub.cachedAt.map { ", mise à jour le \($0.formatted(date: .abbreviated, time: .shortened))" } ?? "")). \
        Les outils vault lisent et écrivent des valeurs brutes. Clés existantes : \(keys.isEmpty ? "aucune" : keys).
        """
    }
}

#if canImport(FoundationModels)
@available(iOS 26.0, *)
struct DataSearchTool: Tool {
    let name = "data_search"
    let description = "Cherche dans les données de l'utilisateur (copie locale du coffre unifié de Lumen) : évènements de l'agenda, tâches et rappels, mesures de santé, compteurs. Requête vide = tout, trié par date."

    @Generable
    struct Arguments {
        @Guide(description: "Mots-clés (peut être vide)")
        var query: String
        @Guide(description: "Type facultatif : event, task, metric ou vide")
        var type: String
    }

    func call(arguments: Arguments) async throws -> String {
        let t = arguments.type.trimmingCharacters(in: .whitespaces)
        var found = DataHub.searchLocal(arguments.query, type: t.isEmpty ? nil : t)
        // Agenda : on ne garde que ce qui n'est pas passé.
        let now = Int64(Date.now.addingTimeInterval(-86_400).timeIntervalSince1970 * 1000)
        found = found.filter { $0.type != "event" || $0.start == 0 || $0.start >= now }
        guard !found.isEmpty else { return "Rien trouvé dans la copie locale du coffre." }
        return found.prefix(25).map(\.line).joined(separator: "\n")
    }
}

@available(iOS 26.0, *)
struct VaultReadTool: Tool {
    let name = "vault_get"
    let description = "Lit une valeur du coffre de données (clé exacte, ex. courses, agenda/iphone, sante/pas)."

    @Generable
    struct Arguments {
        @Guide(description: "Clé exacte du coffre")
        var key: String
    }

    func call(arguments: Arguments) async throws -> String {
        guard let e = VaultStore.get(arguments.key) else {
            return "Aucune valeur pour \(arguments.key). Clés : \(VaultStore.all.prefix(40).map(\.key).joined(separator: ", "))"
        }
        return "\(e.key) = \(e.value.display)"
    }
}

@available(iOS 26.0, *)
struct VaultWriteTool: Tool {
    let name = "vault_set"
    let description = "Écrit une valeur texte ou nombre dans le coffre de données."

    @Generable
    struct Arguments {
        @Guide(description: "Clé, dossiers séparés par /")
        var key: String
        @Guide(description: "Valeur à écrire")
        var value: String
    }

    func call(arguments: Arguments) async throws -> String {
        let v: JSONValue = Double(arguments.value.replacingOccurrences(of: ",", with: ".")).map(JSONValue.number) ?? .string(arguments.value)
        let e = VaultStore.set(arguments.key, v)
        return "Enregistré : \(e.key) = \(e.value.display) (synchronisé avec Lumen à la reconnexion)"
    }
}

@available(iOS 26.0, *)
struct VaultAppendTool: Tool {
    let name = "vault_append"
    let description = "Ajoute un élément à une liste du coffre (ex. courses)."

    @Generable
    struct Arguments {
        @Guide(description: "Clé de la liste, ex. courses")
        var key: String
        @Guide(description: "Élément à ajouter")
        var item: String
    }

    func call(arguments: Arguments) async throws -> String {
        VaultStore.append(arguments.key, .string(arguments.item))
        return "Ajouté à \(arguments.key)."
    }
}
#endif
