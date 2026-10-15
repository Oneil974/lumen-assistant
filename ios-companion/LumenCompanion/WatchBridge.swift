import Foundation
import WatchConnectivity

/// Pont iPhone ↔ Apple Watch. La montre n'atteint généralement pas le réseau
/// local de l'ordinateur : elle passe par l'iPhone, qui relaie vers Lumen.
///  - l'iPhone pousse l'état (backend, modèle, décisions en attente, dernière
///    réponse) par `updateApplicationContext` — la montre l'a même app fermée ;
///  - la montre envoie ses commandes par `sendMessage` (réveille l'iPhone) :
///    ask, approve, unlock, capture, append.
@MainActor
final class WatchBridge: NSObject, WCSessionDelegate {
    static let shared = WatchBridge()
    weak var client: LumenClient?
    private var lastPush = ""

    func start(client: LumenClient) {
        self.client = client
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    /// État courant → montre (dédoublonné).
    func push() {
        guard let client, WCSession.isSupported(), WCSession.default.activationState == .activated,
              WCSession.default.isPaired, WCSession.default.isWatchAppInstalled else { return }
        let lastAnswer = client.messages.last(where: { !$0.isUser })?.text ?? client.localMessages.last(where: { !$0.isUser })?.text ?? ""
        let ctx: [String: Any] = [
            "online": client.link == .online,
            "host": client.server.host() ?? "",
            "source": client.backend.sourceShort,
            "model": client.backend.modelShort,
            "thinking": client.thinking,
            "answer": String(lastAnswer.prefix(1500)),
            "requests": client.requests.map { ["id": $0.id, "title": $0.title, "kind": $0.kind, "mode": $0.unlockMode] },
            "halo": client.haloSteps.last.map { "\(client.haloAgent) · \($0.label)" } ?? "",
        ]
        let key = (try? JSONSerialization.data(withJSONObject: ctx)).map { String(decoding: $0, as: UTF8.self) } ?? ""
        guard key != lastPush else { return }
        lastPush = key
        try? WCSession.default.updateApplicationContext(ctx)
    }

    // MARK: WCSessionDelegate

    nonisolated func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {
        Task { @MainActor in self.push() }
    }
    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}
    nonisolated func sessionDidDeactivate(_ session: WCSession) { session.activate() }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        let msg = message.compactMapValues { $0 as? String }
        Task { @MainActor in
            replyHandler(await self.handle(msg))
        }
    }

    private func handle(_ m: [String: String]) async -> [String: Any] {
        guard let client else { return ["ok": false, "error": "iPhone non connecté"] }
        switch m["cmd"] {
        case "ask":
            guard let t = m["text"], !t.isEmpty else { return ["ok": false] }
            client.sendChat(t)
            return ["ok": true]
        case "approve":
            guard let id = m["id"] else { return ["ok": false] }
            let ok = (try? await client.api("agents/approve", body: ["approval_id": id, "approve": m["approve"] == "1"])) != nil
            return ["ok": ok]
        case "answer":
            guard let id = m["id"], let choice = m["choice"], let req = client.requests.first(where: { $0.id == id }) else { return ["ok": false] }
            client.answer(req, choice: choice)
            return ["ok": true]
        case "unlock":
            guard let id = m["id"] else { return ["ok": false] }
            await client.tapUnlock(requestId: id)
            return ["ok": true]
        case "capture":
            guard let t = m["text"], !t.isEmpty else { return ["ok": false] }
            VaultStore.append("montre/notes", .string(t))
            await VaultStore.sync()
            return ["ok": true]
        case "refresh":
            lastPush = ""
            push()
            return ["ok": true]
        default:
            return ["ok": false]
        }
    }
}
