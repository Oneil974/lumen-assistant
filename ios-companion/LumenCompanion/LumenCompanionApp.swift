import CoreSpotlight
import SwiftUI

@main
struct LumenCompanionApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var store = ServerStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .themed()
        }
    }
}

/// Sans adresse : configuration. Avec : appairage puis discussion.
struct RootView: View {
    @EnvironmentObject private var store: ServerStore
    @Environment(\.palette) private var p

    var body: some View {
        Group {
            if let url = store.current {
                SessionView(server: url).id(url)
            } else {
                NavigationStack { SetupView(onDone: {}) }
            }
        }
        .background(p.background.ignoresSafeArea())
    }
}

/// Une session = un client pour une adresse de Lumen.
struct SessionView: View {
    @EnvironmentObject private var store: ServerStore
    @Environment(\.scenePhase) private var phase
    @State private var client: LumenClient
    @State private var speech = SpeechService()
    @State private var live = LiveActivityController()
    @AppStorage("companionAutospeak") private var localAutospeak = false
    /// « messages » : écran messagerie simplifié ; « classic » : la discussion complète.
    @AppStorage("companionMode") private var companionMode = "classic"

    init(server: URL) {
        // ServerStore ne fait que lire/écrire UserDefaults : une instance
        // neuve voit les mêmes empreintes de certificats que celle de l'app.
        _client = State(initialValue: LumenClient(server: server, store: ServerStore()))
    }

    /// Route posée par un contrôle du Centre de contrôle (Controls.swift).
    private func runPendingRoute() {
        guard let r = SharedStore.defaults.string(forKey: "pendingRoute") else { return }
        SharedStore.defaults.removeObject(forKey: "pendingRoute")
        Task { try? await Task.sleep(for: .milliseconds(400)); NotificationCenter.default.post(name: .lumenRoute, object: r) }
    }

    private func runPendingAction() {
        guard let a = PendingAction.take() else { return }
        switch a["type"] {
        case "ask": if let t = a["text"], !t.isEmpty { client.sendChat(t) }
        case "talk": NotificationCenter.default.post(name: .lumenRoute, object: "talk")
        default: break
        }
    }

    private func refreshLiveActivity() {
        let pending = client.requests.count
        let step = client.haloSteps.last
        let working = client.haloLastStep.map { Date().timeIntervalSince($0) < 25 } ?? false
        let title = pending > 0
            ? (client.requests.last?.title ?? L("Lumen attend ta réponse"))
            : working ? "\(client.haloAgent) · \(step?.label ?? "…")" : L("Terminé")
        let detail = pending > 0
            ? (client.requests.last?.body ?? "")
            : (step.map { $0.thought ? $0.input : ($0.result.isEmpty ? $0.input : $0.result) } ?? "")
        live.update(host: client.server.host() ?? "Lumen", working: working, title: title, detail: detail, pending: pending)
    }

    private func unlock(_ id: String) {
        UserDefaults.standard.removeObject(forKey: "pendingUnlock")
        Task { await client.tapUnlock(requestId: id) }
    }

    var body: some View {
        Group {
            if client.needsPairing {
                PairingView(client: client)
            } else if companionMode == "messages" {
                // Mode messagerie : l'écran simple, façon Messenger.
                MessengerView(client: client, speech: speech) { withAnimation { companionMode = "classic" } }
            } else {
                ChatView(client: client, speech: speech)
            }
        }
        .onAppear {
            client.onSpeak = { [speech] text, queue in
                // Mains libres : la réponse est toujours lue (c'est tout l'intérêt).
                let d = UserDefaults.standard
                // Mode de concentration « voix coupée » (filtre Lumen) : silence.
                if d.bool(forKey: "focusMute") && !d.bool(forKey: "handsFree") { return }
                if d.bool(forKey: "companionAutospeak") || d.bool(forKey: "handsFree") { speech.speak(text, queue: queue) }
            }
            client.connect()
            WatchBridge.shared.start(client: client)
        }
        // Appairé et connecté : on active les notifications (une seule
        // demande d'autorisation, iOS s'en souvient).
        .onChange(of: client.link) { _, link in
            if link == .online { Task { await PushManager.enable() } }
        }
        .onReceive(NotificationCenter.default.publisher(for: AppDelegate.tokenNotification)) { note in
            if let token = note.object as? String { Task { await client.registerPush(token: token) } }
        }
        // Bouton « Déverrouiller avec Face ID » d'une notification (demande
        // venue du bureau ou de Lumen XR).
        .onReceive(NotificationCenter.default.publisher(for: AppDelegate.unlockNotification)) { note in
            if let id = note.object as? String { unlock(id) }
        }
        .task {
            if let id = UserDefaults.standard.string(forKey: "pendingUnlock") { unlock(id) }
            runPendingAction()
            runPendingRoute()
        }
        // Spotlight : une conversation touchée dans la recherche de l'iPhone.
        .onContinueUserActivity(CSSearchableItemActionType) { activity in
            guard let id = activity.userInfo?[CSSearchableItemActivityIdentifier] as? String,
                  id.hasPrefix("conv:") else { return }
            client.loadConversation(String(id.dropFirst(5)))
        }
        // Siri / Raccourcis (Intents.swift) et liens profonds des widgets.
        .onReceive(NotificationCenter.default.publisher(for: PendingAction.notification)) { _ in runPendingAction() }
        .onOpenURL { url in
            guard url.scheme == "lumen", let host = url.host() else { return }
            NotificationCenter.default.post(name: .lumenRoute, object: host)
        }
        // Activité en direct : agent au travail, décisions en attente.
        .onChange(of: client.haloLastStep) { _, _ in refreshLiveActivity() }
        .onChange(of: client.requests.count) { _, _ in refreshLiveActivity() }
        .onChange(of: phase) { _, new in
            // iOS coupe les sockets en arrière-plan : on se reconnecte au retour.
            if new == .active, client.link == .offline, !client.needsPairing { client.connect() }
            if new == .active, !client.needsPairing { Task { await Sensors.shared.refreshAll(); await DataHub.refreshCache() } }
            if new == .active { runPendingRoute() }
        }
    }
}

extension Notification.Name {
    /// Navigation interne : "ask", "capture", "talk", "agents".
    static let lumenRoute = Notification.Name("LumenRoute")
}
