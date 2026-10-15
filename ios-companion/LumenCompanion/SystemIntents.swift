import AppIntents
import Foundation

// Intents « système » : bouton Action, automatisations NFC de Raccourcis,
// modes de concentration. Tous passent par Lumen (commande ou évènement) et
// fonctionnent sans ouvrir l'app.

/// Déclenche un évènement nommé chez Lumen → workflows Fluxo au webhook
/// « iphone/raccourci/<nom> ». À poser sur le bouton Action ou sur une
/// automatisation « Tag NFC » de Raccourcis.
struct TriggerLumenEventIntent: AppIntent {
    static var title: LocalizedStringResource = "Déclencher un évènement Lumen"
    static var description = IntentDescription("Lance les workflows Fluxo dont le déclencheur Webhook vaut « iphone/raccourci/<nom> ». Idéal pour le bouton Action ou un tag NFC.")

    @Parameter(title: "Nom", default: "bouton") var name: String

    func perform() async throws -> some IntentResult & ProvidesDialog {
        do {
            try await BackgroundAPI.post("phone/event", ["event": "raccourci", "name": name])
            return .result(dialog: "Évènement « \(name) » envoyé à Lumen.")
        } catch {
            return .result(dialog: "Lumen est injoignable.")
        }
    }
}

/// Commande pour le bureau (« ouvre Notes », « mode concentration »…).
struct RunDesktopCommandIntent: AppIntent {
    static var title: LocalizedStringResource = "Commander le bureau Lumen"
    static var description = IntentDescription("Envoie une commande vocale au bureau de Lumen (ouvrir une app, chercher…).")

    @Parameter(title: "Commande") var command: String

    func perform() async throws -> some IntentResult & ProvidesDialog {
        do {
            try await BackgroundAPI.post("command", ["type": "voice-command", "text": command])
            return .result(dialog: "C'est parti.")
        } catch {
            return .result(dialog: "Lumen est injoignable.")
        }
    }
}

/// Filtre de concentration : iOS l'applique quand un mode s'active. On l'écrit
/// dans le coffre (`focus/actuel`) et Lumen le reçoit comme évènement ; le
/// téléphone coupe sa voix si demandé.
struct LumenFocusFilter: SetFocusFilterIntent {
    static var title: LocalizedStringResource = "Lumen"
    static var description: IntentDescription? = IntentDescription("Dis à Lumen dans quel mode tu es.")

    @Parameter(title: "Nom du mode", default: "concentration") var mode: String
    @Parameter(title: "Couper la voix de Lumen", default: true) var mute: Bool

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "Mode « \(mode) »", subtitle: mute ? "Voix coupée" : "Voix active")
    }

    func perform() async throws -> some IntentResult {
        // Appelé à l'activation ET à la désactivation (paramètres par défaut).
        let active = !(mode.isEmpty)
        UserDefaults.standard.set(mute && active, forKey: "focusMute")
        VaultStore.set("focus/actuel", .string(active ? mode : "aucun"))
        await VaultStore.sync()
        _ = try? await BackgroundAPI.post("phone/event", ["event": "concentration", "name": active ? mode : "fin"])
        return .result()
    }
}
