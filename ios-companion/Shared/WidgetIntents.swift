import AppIntents
import WidgetKit

// Boutons du widget d'état : changer de backend ou de modèle sans ouvrir
// l'app. S'exécutent dans le processus du widget (iOS 17+).

struct SetBackendIntent: AppIntent {
    static var title: LocalizedStringResource = "Changer de backend"
    static var isDiscoverable = false

    @Parameter(title: "Backend") var id: String

    init() {}
    init(id: String) { self.id = id }

    func perform() async throws -> some IntentResult {
        // Affichage immédiat, confirmé par l'état relu ensuite.
        if var s = SharedStore.cached { s.source = id; s.models = []; SharedStore.cached = s }
        SharedStore.modelPage = 0
        await SharedStore.command(["type": "set-backend", "id": id])
        try? await Task.sleep(for: .milliseconds(1500))
        _ = await SharedStore.fetchStatus()
        return .result()
    }
}

struct SetModelIntent: AppIntent {
    static var title: LocalizedStringResource = "Changer de modèle"
    static var isDiscoverable = false

    @Parameter(title: "Modèle") var model: String

    init() {}
    init(model: String) { self.model = model }

    func perform() async throws -> some IntentResult {
        if var s = SharedStore.cached { s.model = model; SharedStore.cached = s }
        await SharedStore.command(["type": "set-model", "model": model])
        try? await Task.sleep(for: .milliseconds(1200))
        _ = await SharedStore.fetchStatus()
        return .result()
    }
}

struct RefreshStatusIntent: AppIntent {
    static var title: LocalizedStringResource = "Actualiser"
    static var isDiscoverable = false

    func perform() async throws -> some IntentResult {
        await SharedStore.command(["type": "list-backends"])
        try? await Task.sleep(for: .milliseconds(600))
        _ = await SharedStore.fetchStatus()
        return .result()
    }
}

/// Page de la liste des modèles du grand widget (un widget ne défile pas :
/// ‹ › font passer aux modèles suivants). Mémorisée dans l'App Group.
struct ModelPageIntent: AppIntent {
    static var title: LocalizedStringResource = "Modèles suivants"
    static var isDiscoverable = false

    @Parameter(title: "Pas") var step: Int

    init() {}
    init(step: Int) { self.step = step }

    func perform() async throws -> some IntentResult {
        SharedStore.modelPage = max(0, SharedStore.modelPage + step)
        return .result()
    }
}
