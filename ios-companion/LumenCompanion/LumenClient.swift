@preconcurrency import CoreSpotlight
import CryptoKit
import Foundation
import Observation
import UIKit
import WidgetKit

/// Client natif du compagnon : même protocole que src/companion.js.
///  - WebSocket `/ws?token=` : miroir de la session du bureau (transcription,
///    backend, modes, pièces jointes, notifications, Halo) et commandes.
///  - HTTP authentifié (Bearer) : appairage, capture rapide, agents.
/// Le téléphone ne calcule rien : il affiche ce que l'ordinateur pousse.
@MainActor
@Observable
final class LumenClient {
    enum Link { case offline, connecting, online }

    let server: URL
    private let store: ServerStore

    // Session
    private(set) var token: String?
    private(set) var link: Link = .offline
    var needsPairing = false
    private(set) var identity: UserIdentity?
    private(set) var drivesDesktop = true
    private(set) var activeName = ""

    // Miroir du bureau
    private(set) var messages: [ChatMessage] = []
    private(set) var thinking = false
    private(set) var backend = BackendState()
    private(set) var mode = ModeState()
    private(set) var orchestrate = false
    private(set) var conversations: [Conversation] = []
    private(set) var currentConversation = ""
    private(set) var docs: [AttachedDoc] = []
    /// Fiches du coffre unifié jointes au prochain message : le bureau les lit
    /// (appel data_get visible) et la réponse porte sur elles.
    var pinned: [HubRecord] = []

    func pin(_ r: HubRecord) {
        guard !pinned.contains(where: { $0.id == r.id }), pinned.count < 5 else { return }
        pinned.append(r)
    }
    private(set) var imageCount = 0
    private(set) var notifications: [CenterNotification] = []
    private(set) var desktopAutospeak = false
    private(set) var requests: [UserRequest] = []
    /// Dernier refus de déverrouillage, par demande.
    var unlockError: [String: String] = [:]
    private(set) var tools: [MentionItem] = []
    private(set) var files: [MentionItem] = []

    // Halo
    private(set) var haloSteps: [HaloStep] = []
    private(set) var haloAgent = ""
    /// Dernier évènement de l'app Messages (messenger.rs), et son compteur.
    private(set) var messengerEvent: JSON?
    private(set) var messengerTick = 0
    /// Agent de la dernière étape reçue (id), pour afficher son personnage.
    private(set) var haloAgentId = ""
    /// Annuaire id → (nom, avatar), relu au plus toutes les minutes.
    private(set) var agentFaces: [String: (name: String, avatar: AgentAvatar)] = [:]
    private var agentFacesAt = Date.distantPast

    /// Relit l'annuaire des agents (nom + avatar) si nécessaire.
    func refreshAgentFaces(force: Bool = false) async {
        guard force || Date.now.timeIntervalSince(agentFacesAt) > 60 else { return }
        agentFacesAt = .now
        guard let j = try? await api("agents/list") else { return }
        var dir: [String: (name: String, avatar: AgentAvatar)] = [:]
        for a in j.arr("items") {
            let id = a.str("id")
            dir[id] = (a.str("name"), AgentAvatar(a["avatar"] as? [String: Any], seed: id))
        }
        agentFaces = dir
    }

    /// Personnage d'un agent, par id ou par nom.
    func agentFace(_ ref: String) -> AgentAvatar? {
        if let hit = agentFaces[ref] { return hit.avatar }
        return agentFaces.values.first { $0.name.caseInsensitiveCompare(ref) == .orderedSame }?.avatar
    }
    private(set) var haloLastStep: Date?
    var haloNotice: HaloNotice?

    // Événements ponctuels vers l'UI
    var toast: String?
    /// Texte à énoncer (réponse finale / annonce) — consommé par SpeechService.
    var onSpeak: ((String, Bool) -> Void)?

    private var task: URLSessionWebSocketTask?
    private var opened = false
    private var retry: Task<Void, Never>?
    private let session: URLSession
    private let delegate: TrustDelegate

    init(server: URL, store: ServerStore) {
        self.server = server
        self.store = store
        delegate = TrustDelegate(store: store)
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 20
        session = URLSession(configuration: cfg, delegate: delegate, delegateQueue: nil)
        token = Keychain.token(for: server)
        outboxCount = outbox.count
        let previous = SharedStore.accountKey
        SharedStore.saveCredentials(server: server, token: token)
        // Autre compte que la dernière fois : Spotlight ne doit plus proposer
        // les clés du coffre quitté (sa copie locale, elle, reste intacte).
        if SharedStore.accountKey != previous { VaultSpotlight.reindex() }
        if let data = UserDefaults.standard.data(forKey: "identity:\(server.absoluteString)") {
            identity = try? JSONDecoder().decode(UserIdentity.self, from: data)
        }
    }

    var lastIdentifier: String {
        get { UserDefaults.standard.string(forKey: "identifier:\(server.absoluteString)") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "identifier:\(server.absoluteString)") }
    }

    // MARK: Appairage

    func who(_ identifier: String) async -> UserIdentity? {
        var c = URLComponents(url: server.appending(path: "auth/who"), resolvingAgainstBaseURL: false)!
        c.queryItems = [URLQueryItem(name: "identifier", value: identifier)]
        guard let url = c.url, let (data, resp) = try? await session.data(from: url),
              (resp as? HTTPURLResponse)?.statusCode == 200,
              let j = try? JSONSerialization.jsonObject(with: data) as? JSON else { return nil }
        return UserIdentity(j)
    }

    enum PairResult: Equatable {
        case done
        /// Code TOTP accepté ; le profil est protégé : mot de passe de session attendu.
        case needPassword
        case failed(String)
    }

    /// Ticket de la seconde étape (5 minutes côté Lumen) et clé P-256 éphémère
    /// du serveur, pour laquelle le mot de passe est chiffré.
    private var loginTicket: (ticket: String, serverKey: String)?
    private var pendingIdentifier = ""

    /// Étape 1 : nom + code TOTP. Le code se lit dans les Réglages de Lumen :
    /// il ne prouve pas qu'on connaît la session, d'où l'étape 2.
    func pair(identifier: String, code: String) async -> PairResult {
        var req = URLRequest(url: server.appending(path: "auth/pair"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: [
            "identifier": identifier, "code": code,
            // Appareil de confiance (révocable seul dans les réglages de Lumen).
            "device_kind": "ios", "device_name": UIDevice.current.name,
        ])
        do {
            let (data, resp) = try await session.data(for: req)
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if status == 429 { return .failed("Trop d'essais. Réessaie dans quelques minutes.") }
            guard status == 200, let j = try JSONSerialization.jsonObject(with: data) as? JSON else {
                return .failed("Identifiant ou code invalide.")
            }
            if j.str("step") == "password" {
                loginTicket = (j.str("ticket"), j.str("server_key"))
                pendingIdentifier = identifier
                if let u = UserIdentity(j.obj("user")) { setIdentity(u) }
                return .needPassword
            }
            return accept(j, identifier: identifier) ? .done : .failed("Identifiant ou code invalide.")
        } catch {
            return .failed("Connexion impossible.")
        }
    }

    /// Étape 2 : mot de passe de la session, chiffré de bout en bout pour la
    /// clé éphémère du ticket (ECDH P-256 → HKDF-SHA256 → AES-256-GCM), même
    /// sur l'écouteur HTTP. Construction identique à `auth::open_envelope`.
    func login(password: String) async -> PairResult {
        guard let t = loginTicket else { return .failed("Connexion expirée : saisis un nouveau code.") }
        let envelope: JSON
        do { envelope = try Self.seal(password, ticket: t.ticket, serverKey: t.serverKey) }
        catch { return .failed("Connexion impossible.") }
        var req = URLRequest(url: server.appending(path: "auth/login"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["ticket": t.ticket, "envelope": envelope])
        do {
            let (data, resp) = try await session.data(for: req)
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            let j = (try? JSONSerialization.jsonObject(with: data)) as? JSON ?? [:]
            switch status {
            case 200:
                return accept(j, identifier: pendingIdentifier) ? .done : .failed("Connexion impossible.")
            case 401:
                let n = j.int("remaining") ?? 0
                return .failed(String(localized: "Mot de passe incorrect (\(n) essai(s) restant(s))."))
            case 429:
                return .failed("Trop d'essais. Réessaie dans quelques minutes.")
            default:
                loginTicket = nil
                return .failed("Connexion expirée : saisis un nouveau code.")
            }
        } catch {
            return .failed("Connexion impossible.")
        }
    }

    func cancelLogin() { loginTicket = nil }

    nonisolated static func seal(_ password: String, ticket: String, serverKey: String) throws -> JSON {
        guard let raw = Data(base64Encoded: serverKey) else { throw URLError(.cannotDecodeContentData) }
        let server = try P256.KeyAgreement.PublicKey(x963Representation: raw)
        let mine = P256.KeyAgreement.PrivateKey()
        let shared = try mine.sharedSecretFromKeyAgreement(with: server)
        let key = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data(ticket.utf8),
                                                 sharedInfo: Data("lumen-companion-login-v1".utf8),
                                                 outputByteCount: 32)
        let box = try AES.GCM.seal(Data(password.utf8), using: key, authenticating: Data(ticket.utf8))
        return ["client_key": mine.publicKey.x963Representation.base64EncodedString(),
                "iv": Data(box.nonce).base64EncodedString(),
                "ciphertext": (box.ciphertext + box.tag).base64EncodedString()]
    }

    private func accept(_ j: JSON, identifier: String) -> Bool {
        guard let t = j["token"] as? String, !t.isEmpty else { return false }
        loginTicket = nil
        token = t
        Keychain.setToken(t, for: server)
        SharedStore.saveCredentials(server: server, token: t)
        VaultSpotlight.reindex()
        lastIdentifier = identifier
        setIdentity(UserIdentity(j.obj("user")))
        needsPairing = false
        connect()
        return true
    }

    func signOut() {
        Keychain.setToken(nil, for: server)
        token = nil
        SharedStore.saveCredentials(server: server, token: nil)
        VaultSpotlight.reindex()
        disconnect()
        needsPairing = true
    }

    private func setIdentity(_ id: UserIdentity?) {
        identity = id
        if let id, let d = try? JSONEncoder().encode(id) {
            UserDefaults.standard.set(d, forKey: "identity:\(server.absoluteString)")
        }
    }

    // MARK: WebSocket

    func connect() {
        guard let token, !token.isEmpty else { needsPairing = true; return }
        retry?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        var c = URLComponents(url: server.appending(path: "ws"), resolvingAgainstBaseURL: false)!
        c.scheme = server.scheme == "https" ? "wss" : "ws"
        c.queryItems = [URLQueryItem(name: "token", value: token)]
        guard let url = c.url else { return }
        opened = false
        link = .connecting
        let t = session.webSocketTask(with: url)
        t.maximumMessageSize = 64 * 1024 * 1024
        task = t
        t.resume()
        receive(on: t)
        // L'ouverture est confirmée par le premier message : un jeton refusé
        // ferme la socket sans rien envoyer. On amorce avec la même demande
        // que la PWA — l'ordinateur répond par tout son état.
        t.send(.string(#"{"type":"list-conversations"}"#)) { _ in }
    }

    func disconnect() {
        retry?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        link = .offline
    }

    private func receive(on t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            Task { @MainActor in
                guard let self, t === self.task else { return }
                switch result {
                case .success(let msg):
                    if !self.opened {
                        self.opened = true; self.link = .online; self.flushOutbox()
                        Task { await VaultStore.sync(); VaultSpotlight.reindex() }
                    }
                    if case .string(let s) = msg, let d = s.data(using: .utf8),
                       let j = try? JSONSerialization.jsonObject(with: d) as? JSON {
                        self.handle(j)
                    }
                    self.receive(on: t)
                case .failure:
                    self.closed(t)
                }
            }
        }
    }

    private func closed(_ t: URLSessionWebSocketTask) {
        task = nil
        link = .offline
        for id in Array(ackWaiters.keys) { resolveAck(id, false) }
        thinking = false
        // Refus explicite du jeton (401/403) → on ré-appaire. Contrairement à
        // la PWA, un simple échec réseau (ordinateur éteint, hors Wi-Fi) ne
        // jette PAS le jeton : on réessaie.
        let status = (t.response as? HTTPURLResponse)?.statusCode ?? 0
        if !opened && (status == 401 || status == 403) {
            dropToken()
            return
        }
        let wasOpened = opened
        retry = Task { [weak self] in
            // Échec AVANT ouverture sans code HTTP : iOS ne transmet souvent pas
            // la réponse d'un handshake refusé. On demande à /status si le jeton
            // vaut encore (il ne vaut plus rien si le mot de passe de session a
            // été posé ou changé) : sinon l'app réessaierait sans fin, sur un
            // écran vide, au lieu de proposer la connexion.
            if !wasOpened, let self, await self.tokenRejected() {
                self.dropToken()
                return
            }
            try? await Task.sleep(for: .seconds(wasOpened ? 1.5 : 4))
            guard !Task.isCancelled else { return }
            self?.connect()
        }
    }

    private func dropToken() {
        Keychain.setToken(nil, for: server)
        SharedStore.saveCredentials(server: server, token: nil)
        token = nil
        link = .offline
        needsPairing = true
    }

    /// Vrai seulement si Lumen RÉPOND et refuse le jeton (401/403). Un réseau
    /// coupé ou un ordinateur éteint ne jette pas le jeton.
    private func tokenRejected() async -> Bool {
        guard let token else { return true }
        var req = URLRequest(url: server.appending(path: "status"))
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 8
        guard let (_, resp) = try? await session.data(for: req),
              let code = (resp as? HTTPURLResponse)?.statusCode else { return false }
        return code == 401 || code == 403
    }

    func send(_ obj: JSON) {
        guard let task, link == .online,
              let d = try? JSONSerialization.data(withJSONObject: obj),
              let s = String(data: d, encoding: .utf8) else {
            toast = "Pas de connexion à l'ordinateur"
            return
        }
        task.send(.string(s)) { _ in }
    }

    // MARK: File d'attente hors connexion
    //
    // Messages et captures faits pendant que l'ordinateur est injoignable :
    // gardés (par adresse de Lumen) et envoyés dès la reconnexion.

    struct Pending: Codable, Identifiable {
        var id = UUID()
        let kind: String        // "chat" | "voice-command" | "capture"
        let text: String
        var capture: [String: String]? = nil
        let date: Date
    }

    private var outboxKey: String { "outbox:\(server.absoluteString)" }

    var outbox: [Pending] {
        get { (UserDefaults.standard.data(forKey: outboxKey)).flatMap { try? JSONDecoder().decode([Pending].self, from: $0) } ?? [] }
        set {
            UserDefaults.standard.set(try? JSONEncoder().encode(newValue), forKey: outboxKey)
            outboxCount = newValue.count
        }
    }
    private(set) var outboxCount = 0

    func enqueue(_ p: Pending) {
        outbox = outbox + [p]
        toast = L("Hors ligne : envoi dès la reconnexion")
    }

    func cancelPending(_ id: UUID) { outbox = outbox.filter { $0.id != id } }

    /// Accusés attendus : id du message → reprise de l'envoi en attente.
    private var ackWaiters: [String: CheckedContinuation<Bool, Never>] = [:]
    private var flushing = false

    /// Envoie un message et attend l'accusé `{type:"ack", id}` de l'ordinateur
    /// (message accepté : démarré ou mis en file). Faux si la socket échoue ou
    /// si rien ne revient à temps : le message reste alors dans la file.
    private func sendAwaitingAck(_ obj: JSON, id: String, timeout: Double = 12) async -> Bool {
        guard let task, link == .online,
              let d = try? JSONSerialization.data(withJSONObject: obj),
              let s = String(data: d, encoding: .utf8) else { return false }
        return await withCheckedContinuation { cont in
            ackWaiters[id] = cont
            task.send(.string(s)) { [weak self] error in
                guard error != nil else { return }
                Task { @MainActor in self?.resolveAck(id, false) }
            }
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(timeout))
                self?.resolveAck(id, false)
            }
        }
    }

    private func resolveAck(_ id: String, _ ok: Bool) {
        ackWaiters.removeValue(forKey: id)?.resume(returning: ok)
    }

    /// Vide la file UN élément à la fois : chaque entrée n'est retirée qu'après
    /// acceptation explicite (accusé WebSocket ou réponse 2xx de /capture). Son
    /// `id` stable permet à l'ordinateur d'ignorer un renvoi déjà traité.
    private func flushOutbox() {
        guard !flushing, !outbox.isEmpty else { return }
        flushing = true
        Task {
            defer { flushing = false }
            var sent = 0
            while let p = outbox.first, link == .online {
                let ok: Bool
                switch p.kind {
                case "capture":
                    var body: JSON = p.capture ?? [:]
                    if let ms = (p.capture?["due_in_ms"]).flatMap(Int.init) { body["due_in_ms"] = ms }
                    body["id"] = p.id.uuidString
                    do {
                        _ = try await api("capture", body: body)
                        ok = true
                    } catch let e as NSError where e.domain == "Lumen" && (400..<500).contains(e.code)
                                && ![401, 408, 429].contains(e.code) {
                        // Refus définitif (requête invalide) : la garder bloquerait la file.
                        toast = L("Capture refusée par l'ordinateur : ") + e.localizedDescription
                        ok = true
                    } catch {
                        ok = false
                    }
                default:
                    let type = p.kind == "voice-command" ? "voice-command" : "chat"
                    ok = await sendAwaitingAck(["type": type, "text": p.text, "id": p.id.uuidString], id: p.id.uuidString)
                }
                guard ok else { break }   // réessayé à la prochaine connexion
                outbox = outbox.filter { $0.id != p.id }
                sent += 1
            }
            if sent > 0 { toast = String(localized: "\(sent) envoi(s) en attente parti(s)") }
        }
    }

    // MARK: Messages entrants

    private func handle(_ m: JSON) {
        switch m.str("type") {
        case "ack":
            resolveAck(m.str("id"), true)
        case "session":
            if let u = UserIdentity(m.obj("user")) { setIdentity(u) }
            drivesDesktop = (m["active"] as? Bool) != false
            activeName = m.str("activeName")
            if !drivesDesktop { haloSteps = []; haloNotice = nil }
        case "agent-step":
            let s = m.obj("step") ?? m
            guard !s.str("agent_id").isEmpty else { return }
            let step = HaloStep(agentID: s.str("agent_id"), agentName: m.str("agent").isEmpty ? "Agent" : m.str("agent"), thought: s.str("kind") == "thought",
                                label: s.str("skill").isEmpty ? "…" : s.str("skill"),
                                input: s.str("input"), result: s.str("result"),
                                ok: (s["success"] as? Bool) != false,
                                date: s.double("ts").map { Date(timeIntervalSince1970: $0) } ?? .now)
            haloSteps.append(step)
            if haloSteps.count > 60 { haloSteps.removeFirst(haloSteps.count - 60) }
            haloAgent = m.str("agent").isEmpty ? "Agent" : m.str("agent")
            haloAgentId = s.str("agent_id")
            if agentFaces[haloAgentId] == nil { Task { await refreshAgentFaces(force: true) } }
            haloLastStep = .now
        case "messenger":
            // Messages : la vue ouverte relit ce qui la concerne.
            messengerEvent = m
            messengerTick &+= 1
        case "halo-notify":
            let n = m.obj("notification") ?? m
            haloNotice = HaloNotice(kind: n.str("kind").isEmpty ? "info" : n.str("kind"),
                                    icon: n["icon"] as? String,
                                    title: n.str("title").isEmpty ? "Lumen" : n.str("title"),
                                    body: n.str("body").isEmpty ? n.str("message") : n.str("body"),
                                    timeout: (n.double("timeout_ms") ?? 6000) / 1000)
            UINotificationFeedbackGenerator().notificationOccurred(n.str("kind") == "error" ? .error : .success)
        case "orb":
            thinking = m.str("state") == "thinking"
            publishWidget()
        case "transcript":
            messages = m.arr("messages").enumerated().map { ChatMessage(index: $0.offset, $0.element) }
            WatchBridge.shared.push()
        case "conversations":
            conversations = m.arr("items").map { Conversation(id: $0.str("id"), title: $0.str("title")) }
            currentConversation = m.str("currentId")
            indexConversations()
        case "llm-mode", "ollama-mode":
            mode = ModeState(available: m.bool("available"),
                             mode: m.str("mode").isEmpty ? "chat" : m.str("mode"),
                             workflow: m.str("workflow"),
                             modes: m.arr("modes").map { ModeOption(id: $0.str("id"), label: $0.str("label"), desc: $0.str("desc")) },
                             workflows: m.strings("workflows"))
            if let o = m["orchestrate"] as? Bool { orchestrate = o }
        case "orchestrate":
            orchestrate = m.bool("on")
        case "backend":
            backend = BackendState(source: m.str("source").isEmpty ? "ollama" : m.str("source"),
                                   sources: m.arr("sources").map { BackendSource(id: $0.str("id"), label: $0.str("label")) },
                                   model: m.str("model"), models: m.strings("models"),
                                   think: m.bool("think"), thinkAvailable: m.bool("thinkAvailable"),
                                   vision: m.bool("vision"), sourceLabel: m.str("sourceLabel"),
                                   modelLabels: (m["modelLabels"] as? [String: String]) ?? [:],
                                   location: m.str("where").isEmpty ? "local" : m.str("where"))
            publishWidget()
        case "docs":
            docs = m.arr("items").map { AttachedDoc(name: $0.str("name"), rag: $0.str("mode") == "rag") }
            imageCount = m.int("images") ?? 0
        case "mentions":
            tools = m.arr("tools").map { MentionItem(label: $0.str("label"), desc: $0.str("desc").isEmpty ? $0.str("sub") : $0.str("desc"), kind: "tool", raw: $0 as NSDictionary) }
            files = m.arr("files").map { MentionItem(label: $0.str("label"), desc: $0.str("sub"), kind: "file", raw: $0 as NSDictionary) }
        case "notifications":
            notifications = m.arr("items").map {
                CenterNotification(name: $0.str("shortcut").isEmpty ? "Heartbeat" : $0.str("shortcut"),
                                   output: $0.str("output"), success: ($0["success"] as? Bool) != false,
                                   date: Self.parseDate($0["timestamp"]))
            }
        case "answer":
            if !m.str("text").isEmpty { onSpeak?(m.str("text"), false) }
        case "announce":
            if !m.str("text").isEmpty { onSpeak?(m.str("text"), true) }
        case "autospeak":
            desktopAutospeak = m.bool("on")
        case "user-request":
            let id = m.str("id")
            guard !id.isEmpty, !requests.contains(where: { $0.id == id }) else { return }
            requests.append(UserRequest(id: id, kind: m.str("kind"), unlockMode: m.str("unlockMode").isEmpty ? "code" : m.str("unlockMode"), title: m.str("title").isEmpty ? "Lumen" : m.str("title"),
                                        body: m.str("body"),
                                        options: m.arr("options").map { ($0.str("id"), $0.str("label"), $0.bool("primary")) }))
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
            WatchBridge.shared.push()
        case "vault":
            // Changement fait sur l'ordinateur (chat, agent, Fluxo) : copie locale à jour.
            VaultStore.merge(m.arr("entries").compactMap(VaultStore.entry(from:)))
        case "user-request-done":
            requests.removeAll { $0.id == m.str("id") }
        case "unlock-result":
            if m.bool("ok") {
                requests.removeAll { $0.id == m.str("id") }
                toast = L("Session déverrouillée")
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            } else if m.str("error") == "code-required" {
                // Le geste ne suffit pas : on bascule la demande sur le code.
                if let i = requests.firstIndex(where: { $0.id == m.str("id") }) { requests[i].unlockMode = "code" }
                unlockError = [m.str("id"): L("Code requis pour déverrouiller.")]
            } else {
                unlockError = [m.str("id"): m.str("error").isEmpty ? L("Code incorrect.") : m.str("error")]
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            }
        default:
            break
        }
    }

    private static func parseDate(_ v: Any?) -> Date? {
        if let n = v as? Double { return Date(timeIntervalSince1970: n > 1e12 ? n / 1000 : n) }
        if let n = v as? Int { return Date(timeIntervalSince1970: Double(n) > 1e12 ? Double(n) / 1000 : Double(n)) }
        if let s = v as? String {
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return f.date(from: s) ?? ISO8601DateFormatter().date(from: s)
        }
        return nil
    }

    // MARK: Spotlight

    /// Les titres des conversations deviennent cherchables depuis l'écran
    /// d'accueil (le contenu reste sur l'ordinateur).
    private func indexConversations() {
        let items = conversations.prefix(200).map { c -> CSSearchableItem in
            let attrs = CSSearchableItemAttributeSet(contentType: .text)
            attrs.title = c.title.isEmpty ? L("Discussion") : c.title
            attrs.contentDescription = L("Conversation Lumen")
            return CSSearchableItem(uniqueIdentifier: "conv:\(c.id)", domainIdentifier: "lumen.conversations", attributeSet: attrs)
        }
        CSSearchableIndex.default().deleteSearchableItems(withDomainIdentifiers: ["lumen.conversations"]) { _ in
            CSSearchableIndex.default().indexSearchableItems(Array(items))
        }
    }

    // MARK: Widget d'état

    private var widgetReload: Task<Void, Never>?

    /// Recopie l'état vu par l'app dans le cache du widget, puis le fait
    /// redessiner (au plus toutes les 2 s).
    private func publishWidget() {
        var s = SharedStore.cached ?? LumenStatus()
        s.host = server.host() ?? s.host
        s.source = backend.source
        s.sources = backend.sources.map { .init(id: $0.id, label: $0.label) }
        s.model = backend.model
        s.models = backend.models
        s.modelLabels = backend.modelLabels
        s.location = backend.location
        s.state = thinking ? "thinking" : "idle"
        s.pending = requests.count
        s.updated = .now
        SharedStore.cached = s
        WatchBridge.shared.push()
        widgetReload?.cancel()
        widgetReload = Task {
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            WidgetCenter.shared.reloadTimelines(ofKind: "LumenStatus")
        }
    }

    // MARK: Commandes (mêmes types que la PWA)

    /// Échanges hors ligne répondus par l'iPhone (Apple Intelligence).
    private(set) var localMessages: [LocalMessage] = []
    private(set) var localThinking = false

    func sendChat(_ text: String) {
        if link != .online {
            // Hors ligne : l'iPhone répond lui-même s'il le peut, sinon la
            // question attend la reconnexion.
            if LocalAI.available {
                // Fiches jointes : leur texte accompagne la question.
                let context = pinned.map(\.line).joined(separator: "\n")
                pinned = []
                answerLocally(context.isEmpty ? text : "\(text)\n\n\(L("À propos de :"))\n\(context)")
            } else {
                enqueue(Pending(kind: "chat", text: text, date: .now))
            }
            return
        }
        if pinned.isEmpty {
            send(["type": "chat", "text": text])
        } else {
            send(["type": "chat", "text": text, "records": pinned.map(\.id)])
            pinned = []
        }
    }

    private func answerLocally(_ text: String) {
        localMessages.append(LocalMessage(isUser: true, text: text))
        localThinking = true
        let history = localMessages.dropLast().map { (user: $0.isUser, text: $0.text) }
        Task {
            do {
                let reply = try await LocalAI.answer(text, history: Array(history))
                localMessages.append(LocalMessage(isUser: false, text: reply))
                onSpeak?(reply, false)
            } catch {
                localMessages.append(LocalMessage(isUser: false, text: L("Réponse locale impossible : ") + error.localizedDescription))
            }
            localThinking = false
            // Écritures faites par le modèle dans le coffre : parties dès que possible.
            Task { await VaultStore.sync() }
        }
    }

    func clearLocal() { localMessages = [] }
    func voiceCommand(_ text: String) {
        if link != .online { enqueue(Pending(kind: "voice-command", text: text, date: .now)); return }
        send(["type": "voice-command", "text": text])
    }

    // MARK: Face ID

    /// Face ID activé pour CETTE adresse de Lumen (clé présente).
    var faceIDEnabled: Bool { BiometricKey.exists(for: server) }

    /// Crée la clé Secure Enclave et dépose sa partie publique chez Lumen.
    func enableFaceID() async -> String? {
        do {
            // Un premier Face ID confirme que c'est bien le propriétaire.
            let pub = try BiometricKey.create(for: server)
            _ = try await api("devices/bio-key", body: ["key": pub])
            return nil
        } catch {
            BiometricKey.delete(for: server)
            return error.localizedDescription
        }
    }

    func disableFaceID() { BiometricKey.delete(for: server) }

    /// Déverrouille la session de l'ordinateur par Face ID (défi signé).
    @discardableResult
    func unlockWithFaceID(requestId: String) async -> Bool {
        do {
            guard let ch = try await api("unlock/challenge"), let nonce = ch["nonce"] as? String else { return false }
            let sig = try await BiometricKey.sign(nonce, for: server, reason: L("Déverrouiller tes fichiers sur l'ordinateur"))
            _ = try await api("unlock", body: ["nonce": nonce, "signature": sig, "request_id": requestId])
            requests.removeAll { $0.id == requestId }
            toast = L("Session déverrouillée")
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            return true
        } catch {
            unlockError[requestId] = error.localizedDescription
            return false
        }
    }
    func newConversation() { send(["type": "new-conversation"]) }
    func loadConversation(_ id: String) { send(["type": "load-conversation", "id": id]) }
    func deleteConversation(_ id: String) {
        conversations.removeAll { $0.id == id }
        send(["type": "delete-conversation", "id": id])
    }
    func listConversations() { send(["type": "list-conversations"]) }
    func listBackends() { send(["type": "list-backends"]) }
    func setBackend(_ id: String) { send(["type": "set-backend", "id": id]) }
    func setModel(_ m: String) { send(["type": "set-model", "model": m]) }
    func setThink(_ on: Bool) { send(["type": "set-think", "on": on]) }
    func setMode(_ id: String, workflow: String? = nil) {
        var o: JSON = ["type": "set-ollama-mode", "mode": id]
        if let workflow { o["workflow"] = workflow }
        send(o)
    }
    func setOrchestrate(_ on: Bool) { orchestrate = on; send(["type": "set-orchestrate", "on": on]) }
    func setDesktopAutospeak(_ on: Bool) { desktopAutospeak = on; send(["type": "set-autospeak", "on": on]) }
    func attachImage(dataURL: String) { send(["type": "attach-image", "dataUrl": dataURL]) }
    func attachDoc(name: String, base64: String) { send(["type": "attach-doc", "name": name, "b64": base64]) }
    func attachDocRef(_ item: MentionItem) { send(["type": "attach-doc-ref", "item": item.raw]) }
    func clearImages() { send(["type": "clear-images"]) }
    func removeDoc(_ name: String) { send(["type": "remove-doc", "name": name]) }
    func listMentions() { send(["type": "list-mentions"]) }
    func listNotifications() { send(["type": "list-notifications"]) }
    func clearNotifications() { send(["type": "clear-notifications"]) }
    /// Déverrouille la session de l'ordinateur avec le code TOTP du profil
    /// (vérifié côté Rust ; le mot de passe ne quitte jamais l'ordinateur).
    /// Déverrouillage d'un geste (appareil appairé) : Face ID d'abord s'il
    /// est activé (preuve en plus), sinon simple demande à l'ordinateur.
    func tapUnlock(requestId: String) async {
        if faceIDEnabled { await unlockWithFaceID(requestId: requestId); return }
        // Depuis une notification, la connexion n'est peut-être pas encore là.
        for _ in 0..<20 where link != .online { try? await Task.sleep(for: .milliseconds(250)) }
        unlockError[requestId] = nil
        send(["type": "remote-unlock", "id": requestId, "code": ""])
    }

    func remoteUnlock(_ req: UserRequest, code: String) {
        unlockError[req.id] = nil
        send(["type": "remote-unlock", "id": req.id, "code": code])
    }

    func answer(_ req: UserRequest, choice: String) {
        send(["type": "user-answer", "id": req.id, "choice": choice])
        requests.removeAll { $0.id == req.id }
    }

    // MARK: HTTP authentifié

    func api(_ path: String, body: JSON? = nil) async throws -> JSON? {
        var req = URLRequest(url: server.appending(path: path))
        req.setValue("Bearer \(token ?? "")", forHTTPHeaderField: "Authorization")
        if let body {
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            if (resp as? HTTPURLResponse)?.statusCode == 401 { needsPairing = true }
            throw NSError(domain: "Lumen", code: (resp as? HTTPURLResponse)?.statusCode ?? 0,
                          userInfo: [NSLocalizedDescriptionKey: String(data: data, encoding: .utf8) ?? "Erreur"])
        }
        // Certaines routes répondent « ok » en texte brut : pas une erreur.
        return data.isEmpty ? nil : (try? JSONSerialization.jsonObject(with: data)) as? JSON
    }

    /// Mode vocal : la réponse lue avec la voix Piper/Kokoro de l'ordinateur
    /// (voix de l'agent « local:<id> », ou celle de Lumen si vide). nil si
    /// l'ordinateur n'a pas cette voix → l'iPhone parle avec la sienne.
    func messengerVoice(text: String, voice: String) async -> Data? {
        var req = URLRequest(url: server.appending(path: "messenger/voice"))
        req.httpMethod = "POST"
        req.setValue("Bearer \(token ?? "")", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["text": text, "voice": voice])
        req.timeoutInterval = 60
        guard let (data, resp) = try? await session.data(for: req),
              let http = resp as? HTTPURLResponse, http.statusCode == 200, !data.isEmpty else { return nil }
        return data
    }

    /// Image jointe d'une discussion de Messages (mise en cache en mémoire).
    @MainActor private static var mxImages: [String: UIImage] = [:]
    func messengerImage(_ id: String) async -> UIImage? {
        if let hit = await MainActor.run(body: { Self.mxImages[id] }) { return hit }
        var req = URLRequest(url: server.appending(path: "messenger/file/\(id)"))
        req.setValue("Bearer \(token ?? "")", forHTTPHeaderField: "Authorization")
        guard let (data, _) = try? await session.data(for: req), let img = UIImage(data: data) else { return nil }
        await MainActor.run { Self.mxImages[id] = img }
        return img
    }

    /// Dépose le jeton APNs chez Lumen (une fois par jeton et par adresse).
    func registerPush(token: String) async {
        let key = "apnsRegistered:\(server.absoluteString)"
        guard UserDefaults.standard.string(forKey: key) != token else { return }
        do {
            _ = try await api("apns/register", body: ["token": token, "sandbox": PushManager.sandbox])
            UserDefaults.standard.set(token, forKey: key)
        } catch {
            print("Enregistrement APNs refusé : \(error.localizedDescription)")
        }
    }

    /// Image servie par Lumen (progression, avatar relatif) avec le jeton.
    func imageData(path: String) async -> Data? {
        let url: URL?
        if path.hasPrefix("data:") {
            guard let comma = path.firstIndex(of: ",") else { return nil }
            return Data(base64Encoded: String(path[path.index(after: comma)...]))
        } else if path.hasPrefix("http") {
            url = URL(string: path)
        } else {
            var c = URLComponents(url: server, resolvingAgainstBaseURL: false)!
            let parts = path.split(separator: "?", maxSplits: 1)
            c.path = String(parts[0])
            c.queryItems = (parts.count > 1 ? URLComponents(string: "?" + parts[1])?.queryItems ?? [] : [])
                + [URLQueryItem(name: "token", value: token)]
            url = c.url
        }
        guard let url, let (data, _) = try? await session.data(from: url) else { return nil }
        return data
    }
}
