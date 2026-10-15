import ActivityKit
import AppIntents
import Foundation

// Siri, Raccourcis et Spotlight : « Demande à Lumen… », « Note dans Lumen… »,
// « Parle à Lumen ». Les intents s'exécutent dans le processus de l'app.

/// Actions en attente, lues par SessionView au lancement / retour de l'app.
enum PendingAction {
    static let key = "pendingAction"
    static let notification = Notification.Name("LumenPendingAction")

    static func post(_ action: [String: String]) {
        UserDefaults.standard.set(action, forKey: key)
        NotificationCenter.default.post(name: notification, object: nil)
    }

    static func take() -> [String: String]? {
        defer { UserDefaults.standard.removeObject(forKey: key) }
        return UserDefaults.standard.dictionary(forKey: key) as? [String: String]
    }
}

struct AskLumenIntent: AppIntent {
    static var title: LocalizedStringResource = "Demander à Lumen"
    static var description = IntentDescription("Envoie une question à Lumen, sur ton ordinateur.")
    static var openAppWhenRun = true

    @Parameter(title: "Question", requestValueDialog: "Que veux-tu demander à Lumen ?")
    var question: String

    @MainActor
    func perform() async throws -> some IntentResult {
        PendingAction.post(["type": "ask", "text": question])
        return .result()
    }
}

enum CaptureKind: String, AppEnum {
    case card, reminder, task
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Destination"
    static var caseDisplayRepresentations: [CaptureKind: DisplayRepresentation] = [
        .card: "Tableau", .reminder: "Rappel (dans 1 h)", .task: "Agent",
    ]
}

/// Capture sans ouvrir l'app : part directement chez Lumen en HTTP.
struct QuickCaptureIntent: AppIntent {
    static var title: LocalizedStringResource = "Noter dans Lumen"
    static var description = IntentDescription("Ajoute une carte, un rappel ou une tâche d'agent dans Lumen.")

    @Parameter(title: "Texte", requestValueDialog: "Que dois-je noter ?")
    var text: String

    @Parameter(title: "Destination", default: .card)
    var kind: CaptureKind

    func perform() async throws -> some IntentResult & ProvidesDialog {
        var body: [String: Any] = ["kind": kind.rawValue, "text": text]
        if kind == .reminder { body["due_in_ms"] = 3_600_000 }
        if kind == .task {
            guard let agent = UserDefaults.standard.string(forKey: "captureAgent"), !agent.isEmpty else {
                return .result(dialog: "Choisis d'abord un agent dans la capture rapide de l'app.")
            }
            body["agent"] = agent
        }
        do {
            try await BackgroundAPI.post("capture", body)
            return .result(dialog: "C'est noté dans Lumen.")
        } catch {
            return .result(dialog: "Lumen est injoignable pour l'instant.")
        }
    }
}

struct TalkToLumenIntent: AppIntent {
    static var title: LocalizedStringResource = "Parler à Lumen"
    static var description = IntentDescription("Ouvre une conversation mains libres avec Lumen.")
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        PendingAction.post(["type": "talk"])
        return .result()
    }
}

struct LumenShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: AskLumenIntent(), phrases: [
            "Demande à \(.applicationName)", "Pose une question à \(.applicationName)", "Ask \(.applicationName)",
        ], shortTitle: "Demander", systemImageName: "bubble.left.fill")
        AppShortcut(intent: QuickCaptureIntent(), phrases: [
            "Note dans \(.applicationName)", "Ajoute à \(.applicationName)", "Capture in \(.applicationName)",
        ], shortTitle: "Noter", systemImageName: "square.and.pencil")
        AppShortcut(intent: AppendVaultListIntent(), phrases: [
            "Ajoute à ma liste \(.applicationName)", "Add to my \(.applicationName) list",
        ], shortTitle: "Ajouter à une liste", systemImageName: "text.badge.plus")
        AppShortcut(intent: GetVaultValueIntent(), phrases: [
            "Lis une valeur \(.applicationName)", "Read a \(.applicationName) value",
        ], shortTitle: "Lire le coffre", systemImageName: "shippingbox")
        AppShortcut(intent: MessageLumenIntent(), phrases: [
            "Écris à \(.applicationName)", "Envoie un message à \(.applicationName)", "Message \(.applicationName)",
        ], shortTitle: "Écrire à Lumen", systemImageName: "bubble.left.and.bubble.right")
        AppShortcut(intent: MyDayIntent(), phrases: [
            "Ma journée avec \(.applicationName)", "Qu'ai-je aujourd'hui \(.applicationName)", "My day with \(.applicationName)",
        ], shortTitle: "Ma journée", systemImageName: "sun.max")
        AppShortcut(intent: AskAgentIntent(), phrases: [
            "Demande à un agent \(.applicationName)", "Ask a \(.applicationName) agent",
        ], shortTitle: "Demander à un agent", systemImageName: "person.2")
        AppShortcut(intent: AgentsStatusIntent(), phrases: [
            "État des agents \(.applicationName)", "\(.applicationName) agents status",
        ], shortTitle: "État des agents", systemImageName: "list.bullet.rectangle")
        AppShortcut(intent: RunWorkflowIntent(), phrases: [
            "Lance un workflow \(.applicationName)", "Run a \(.applicationName) workflow",
        ], shortTitle: "Workflow Fluxo", systemImageName: "point.3.connected.trianglepath.dotted")
        AppShortcut(intent: TalkToLumenIntent(), phrases: [
            "Parle à \(.applicationName)", "Discute avec \(.applicationName)", "Talk to \(.applicationName)",
        ], shortTitle: "Parler", systemImageName: "waveform")
    }
}

// MARK: Activité en direct (démarrée et tenue à jour par l'app)

@MainActor
final class LiveActivityController {
    private var activity: Activity<LumenActivityAttributes>?
    private var endTask: Task<Void, Never>?

    /// État courant : un agent travaille et/ou des décisions attendent.
    func update(host: String, working: Bool, title: String, detail: String, pending: Int) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let state = LumenActivityAttributes.ContentState(title: title, detail: detail, pending: pending, working: working)
        endTask?.cancel()
        if !working && pending == 0 {
            // Plus rien en cours : on laisse l'état final 20 s, puis on retire.
            endTask = Task {
                try? await Task.sleep(for: .seconds(20))
                guard !Task.isCancelled else { return }
                await activity?.end(nil, dismissalPolicy: .immediate)
                activity = nil
            }
            if let activity { Task { await activity.update(.init(state: state, staleDate: nil)) } }
            return
        }
        if let activity {
            Task { await activity.update(.init(state: state, staleDate: .now.addingTimeInterval(600))) }
        } else {
            activity = try? Activity.request(attributes: LumenActivityAttributes(host: host),
                                             content: .init(state: state, staleDate: .now.addingTimeInterval(600)))
        }
    }
}
