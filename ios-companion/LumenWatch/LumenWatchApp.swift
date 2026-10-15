import SwiftUI
import WatchConnectivity
import WidgetKit

/// Lumen au poignet : état, dernière réponse, dictée, décisions en attente
/// (approbations d'agents, déverrouillage), capture rapide. Tout passe par
/// l'iPhone (WatchBridge.swift côté iPhone).
@main
struct LumenWatchApp: App {
    @State private var model = WatchModel.shared
    var body: some Scene {
        WindowGroup { WatchHome().environment(model) }
    }
}

@MainActor
@Observable
final class WatchModel: NSObject, WCSessionDelegate {
    static let shared = WatchModel()

    struct Request: Identifiable, Hashable { let id: String; let title: String; let kind: String; let mode: String }

    var online = false
    var host = ""
    var source = "Lumen"
    var model = ""
    var thinking = false
    var answer = ""
    var halo = ""
    var requests: [Request] = []
    var reachable = false
    var toast: String?

    override init() {
        super.init()
        if WCSession.isSupported() {
            WCSession.default.delegate = self
            WCSession.default.activate()
        }
    }

    private func apply(_ c: [String: Any]) {
        online = c["online"] as? Bool ?? false
        host = c["host"] as? String ?? ""
        source = c["source"] as? String ?? "Lumen"
        model = c["model"] as? String ?? ""
        thinking = c["thinking"] as? Bool ?? false
        answer = c["answer"] as? String ?? ""
        halo = c["halo"] as? String ?? ""
        requests = (c["requests"] as? [[String: String]] ?? []).map {
            Request(id: $0["id"] ?? "", title: $0["title"] ?? "Lumen", kind: $0["kind"] ?? "", mode: $0["mode"] ?? "code")
        }
        // Complication : même état, lu par le widget de la montre.
        let d = UserDefaults(suiteName: "group.io.github.oneil974.lumen")
        d?.set(["source": source, "model": model, "online": online, "pending": requests.count] as [String: Any], forKey: "watchStatus")
        WidgetCenter.shared.reloadAllTimelines()
    }

    func send(_ message: [String: String], done: String? = nil) {
        guard WCSession.default.isReachable else { toast = String(localized: "iPhone injoignable"); return }
        WCSession.default.sendMessage(message, replyHandler: { reply in
            Task { @MainActor in
                if (reply["ok"] as? Bool) == true { if let done { self.toast = done } }
                else { self.toast = (reply["error"] as? String) ?? String(localized: "Échec") }
            }
        }, errorHandler: { _ in Task { @MainActor in self.toast = String(localized: "iPhone injoignable") } })
    }

    nonisolated func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {
        let ctx = session.receivedApplicationContext
        Task { @MainActor in
            self.reachable = session.isReachable
            if !ctx.isEmpty { self.apply(ctx) }
            self.send(["cmd": "refresh"])
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext ctx: [String: Any]) {
        Task { @MainActor in self.apply(ctx) }
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        Task { @MainActor in self.reachable = session.isReachable }
    }
}

struct WatchHome: View {
    @Environment(WatchModel.self) private var m
    @State private var dictation = ""
    @State private var note = ""

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        Circle().fill(m.online ? .green : .gray).frame(width: 8, height: 8)
                        VStack(alignment: .leading) {
                            Text(m.source).font(.headline)
                            Text(m.model).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                    if !m.halo.isEmpty {
                        Label(m.halo, systemImage: "bolt.fill").font(.caption2).foregroundStyle(.mint).lineLimit(2)
                    }
                }

                if !m.requests.isEmpty {
                    Section("À décider") {
                        ForEach(m.requests) { r in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(r.title).font(.footnote.weight(.semibold))
                                if r.kind == "unlock" {
                                    Button { m.send(["cmd": "unlock", "id": r.id], done: String(localized: "Déverrouillage demandé")) } label: {
                                        Label("Déverrouiller", systemImage: "lock.open.fill")
                                    }
                                    .tint(.mint)
                                } else {
                                    HStack {
                                        Button("Refuser") { m.send(["cmd": "answer", "id": r.id, "choice": "deny"]) }.tint(.red)
                                        Button("OK") { m.send(["cmd": "answer", "id": r.id, "choice": "once"]) }.tint(.mint)
                                    }
                                }
                            }
                        }
                    }
                }

                Section {
                    // Le champ texte de watchOS ouvre la dictée / Scribble.
                    TextField("Demander à Lumen", text: $dictation)
                        .onSubmit {
                            let t = dictation.trimmingCharacters(in: .whitespaces)
                            guard !t.isEmpty else { return }
                            m.send(["cmd": "ask", "text": t], done: String(localized: "Envoyé"))
                            dictation = ""
                        }
                    if m.thinking { ProgressView().frame(maxWidth: .infinity) }
                    if !m.answer.isEmpty {
                        Text(m.answer).font(.footnote)
                    }
                }

                Section("Capture") {
                    TextField("Note rapide", text: $note)
                        .onSubmit {
                            let t = note.trimmingCharacters(in: .whitespaces)
                            guard !t.isEmpty else { return }
                            m.send(["cmd": "capture", "text": t], done: String(localized: "Noté"))
                            note = ""
                        }
                }
            }
            .navigationTitle("Lumen")
            .overlay(alignment: .bottom) {
                if let t = m.toast {
                    Text(t).font(.caption2).padding(6).background(.thinMaterial, in: Capsule())
                        .task { try? await Task.sleep(for: .seconds(2)); m.toast = nil }
                }
            }
        }
    }
}
