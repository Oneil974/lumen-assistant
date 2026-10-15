import AppIntents
import SwiftUI
import WidgetKit

// Centre de contrôle, écran verrouillé et bouton Action (iOS 18+) :
// « Parler à Lumen », « Demander », « Capturer ». Un toucher ouvre l'app sur
// la bonne action (lien lumen://…).

/// Ouvre l'app sur une action. Partagé app ↔ extension : les contrôles
/// l'exécutent dans l'app (openAppWhenRun).
struct OpenLumenIntent: AppIntent {
    static var title: LocalizedStringResource = "Ouvrir Lumen"
    static var openAppWhenRun = true
    static var isDiscoverable = false

    @Parameter(title: "Action") var action: String

    init() {}
    init(_ action: String) { self.action = action }

    @MainActor
    func perform() async throws -> some IntentResult {
        // L'app lit la route au lancement (voir SessionView / ChatView).
        SharedStore.defaults.set(action, forKey: "pendingRoute")
        NotificationCenter.default.post(name: Notification.Name("LumenRoute"), object: action)
        return .result()
    }
}

@available(iOS 18.0, *)
struct TalkControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "io.github.oneil974.lumen.talk") {
            ControlWidgetButton(action: OpenLumenIntent("talk")) {
                Label("Parler à Lumen", systemImage: "waveform")
            }
        }
        .displayName("Parler à Lumen")
        .description("Conversation mains libres.")
    }
}

@available(iOS 18.0, *)
struct AskControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "io.github.oneil974.lumen.ask") {
            ControlWidgetButton(action: OpenLumenIntent("ask")) {
                Label("Demander à Lumen", systemImage: "bubble.left.fill")
            }
        }
        .displayName("Demander à Lumen")
    }
}

@available(iOS 18.0, *)
struct CaptureControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "io.github.oneil974.lumen.capture") {
            ControlWidgetButton(action: OpenLumenIntent("capture")) {
                Label("Capture Lumen", systemImage: "square.and.pencil")
            }
        }
        .displayName("Capture rapide")
    }
}
