import AppIntents
import CoreSpotlight
import Foundation

// Coffre de données dans Raccourcis, Siri, Spotlight et les widgets — l'équivalent
// des actions de Data Jar : Lire / Écrire / Ajouter à la liste / Supprimer.
// Chaque action écrit dans la copie locale (fonctionne hors ligne) puis tente
// une synchronisation avec Lumen.

/// Une clé du coffre, choisissable dans Raccourcis et indexée dans Spotlight.
struct VaultKeyEntity: AppEntity, IndexedEntity {
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Valeur du coffre Lumen"
    static var defaultQuery = VaultKeyQuery()

    var id: String
    var value: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(id)", subtitle: "\(value)", image: .init(systemName: "shippingbox"))
    }

    init(_ e: VaultEntry) {
        id = e.key
        value = e.value.display
    }
}

struct VaultKeyQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [VaultKeyEntity] {
        identifiers.compactMap { VaultStore.get($0).map(VaultKeyEntity.init) }
    }
    func entities(matching string: String) async throws -> [VaultKeyEntity] {
        let s = string.lowercased()
        return VaultStore.all.filter { $0.key.contains(s) || $0.value.display.lowercased().contains(s) }.map(VaultKeyEntity.init)
    }
    func suggestedEntities() async throws -> [VaultKeyEntity] {
        VaultStore.all.prefix(50).map(VaultKeyEntity.init)
    }
}

enum VaultValueType: String, AppEnum {
    case text, number, bool, date, list, dict
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Type"
    static var caseDisplayRepresentations: [VaultValueType: DisplayRepresentation] = [
        .text: "Texte", .number: "Nombre", .bool: "Oui / non", .date: "Date", .list: "Liste", .dict: "Dictionnaire (JSON)",
    ]
}

struct GetVaultValueIntent: AppIntent {
    static var title: LocalizedStringResource = "Lire une valeur Lumen"
    static var description = IntentDescription("Lit une valeur du coffre de données partagé avec Lumen.")

    @Parameter(title: "Clé") var key: String

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        await VaultStore.sync()
        guard let e = VaultStore.get(key) else {
            return .result(value: "", dialog: "Aucune valeur pour « \(key) ».")
        }
        return .result(value: e.value.display, dialog: "\(e.name) : \(e.value.display)")
    }
}

struct SetVaultValueIntent: AppIntent {
    static var title: LocalizedStringResource = "Écrire une valeur Lumen"
    static var description = IntentDescription("Écrit une valeur dans le coffre de données partagé avec Lumen (synchronisé avec l'ordinateur).")

    @Parameter(title: "Clé") var key: String
    @Parameter(title: "Valeur") var value: String
    @Parameter(title: "Type", default: .text) var type: VaultValueType

    static var parameterSummary: some ParameterSummary {
        Summary("Écrire \(\.$value) dans \(\.$key)") { \.$type }
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let e = VaultStore.set(key, VaultStore.parse(value, type: type.rawValue), type: type.rawValue)
        await VaultStore.sync()
        return .result(dialog: "\(e.key) = \(e.value.display)")
    }
}

struct AppendVaultListIntent: AppIntent {
    static var title: LocalizedStringResource = "Ajouter à une liste Lumen"
    static var description = IntentDescription("Ajoute un élément à une liste du coffre (courses, idées…).")

    @Parameter(title: "Liste") var key: String
    @Parameter(title: "Élément") var item: String

    static var parameterSummary: some ParameterSummary { Summary("Ajouter \(\.$item) à \(\.$key)") }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        VaultStore.append(key, .string(item))
        await VaultStore.sync()
        return .result(dialog: "Ajouté à \(key).")
    }
}

struct DeleteVaultValueIntent: AppIntent {
    static var title: LocalizedStringResource = "Supprimer une valeur Lumen"
    @Parameter(title: "Clé") var key: String

    func perform() async throws -> some IntentResult {
        VaultStore.delete(key)
        await VaultStore.sync()
        return .result()
    }
}

/// Spotlight : chaque clé du coffre est cherchable depuis l'écran d'accueil.
enum VaultSpotlight {
    static func reindex() {
        let entities = VaultStore.all.map(VaultKeyEntity.init)
        Task {
            try? await CSSearchableIndex.default().deleteAppEntities(ofType: VaultKeyEntity.self)
            try? await CSSearchableIndex.default().indexAppEntities(entities)
        }
    }
}
