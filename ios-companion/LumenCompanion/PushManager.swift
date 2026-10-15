import UIKit
import UserNotifications

/// Notifications APNs : l'app demande l'autorisation une fois appairée,
/// récupère son jeton d'appareil et le dépose chez Lumen (`/apns/register`),
/// rattaché au profil (src-tauri/src/apns.rs).
///
/// Les notifications portent une CATÉGORIE (champ `aps.category`) qui ajoute
/// des boutons : on répond sans ouvrir l'app.
///  - APPROVAL : Approuver / Refuser une action d'agent (en arrière-plan) ;
///  - UNLOCK   : Déverrouiller avec Face ID (ouvre l'app : Face ID a besoin
///               de l'écran) — c'est ainsi qu'on déverrouille depuis Lumen XR ;
///  - REQUEST  : Autoriser / Refuser une demande de Lumen (accès aux fichiers).
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    static let tokenNotification = Notification.Name("LumenAPNsToken")
    /// Demande de déverrouillage Face ID venue d'une notification.
    static let unlockNotification = Notification.Name("LumenUnlockRequest")

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories(PushManager.categories)
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        UserDefaults.standard.set(hex, forKey: "apnsToken")
        NotificationCenter.default.post(name: Self.tokenNotification, object: hex)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("APNs indisponible : \(error.localizedDescription)")
    }

    /// App ouverte : la bannière s'affiche quand même (le Halo la double).
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async
        -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }

    /// Bouton d'une notification (ou toucher de la notification elle-même).
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let action = response.actionIdentifier
        switch action {
        case "APPROVE", "DENY":
            guard let id = info["approval_id"] as? String else { return }
            _ = try? await BackgroundAPI.post("agents/approve", ["approval_id": id, "approve": action == "APPROVE"])
        case "ALLOW", "REFUSE":
            guard let id = info["request_id"] as? String else { return }
            _ = try? await BackgroundAPI.post("request/answer", ["id": id, "choice": action == "ALLOW" ? "once" : "deny"])
        case "UNLOCK", UNNotificationDefaultActionIdentifier:
            // Déverrouillage : l'app est au premier plan, SessionView lance Face ID.
            if (info["kind"] as? String) == "unlock", let id = info["request_id"] as? String {
                await MainActor.run {
                    UserDefaults.standard.set(id, forKey: "pendingUnlock")
                    NotificationCenter.default.post(name: Self.unlockNotification, object: id)
                }
            }
        default:
            break
        }
    }
}

enum PushManager {
    /// Build Xcode (développement) → serveur sandbox d'Apple ; TestFlight /
    /// App Store → production. Lumen choisit l'hôte d'après ce drapeau.
    static var sandbox: Bool {
        #if DEBUG
        true
        #else
        false
        #endif
    }

    static var categories: Set<UNNotificationCategory> {
        let approve = UNNotificationAction(identifier: "APPROVE", title: L("Approuver"), options: [.authenticationRequired])
        let deny = UNNotificationAction(identifier: "DENY", title: L("Refuser"), options: [.destructive])
        let unlock = UNNotificationAction(identifier: "UNLOCK", title: L("Déverrouiller"),
                                          options: [.foreground, .authenticationRequired])
        let allow = UNNotificationAction(identifier: "ALLOW", title: L("Autoriser"), options: [.authenticationRequired])
        let refuse = UNNotificationAction(identifier: "REFUSE", title: L("Refuser"), options: [.destructive])
        return [
            UNNotificationCategory(identifier: "APPROVAL", actions: [approve, deny], intentIdentifiers: []),
            UNNotificationCategory(identifier: "UNLOCK", actions: [unlock], intentIdentifiers: []),
            UNNotificationCategory(identifier: "REQUEST", actions: [allow, refuse], intentIdentifiers: []),
        ]
    }

    @MainActor
    static func enable() async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .notDetermined:
            guard (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) == true else { return }
        case .denied:
            return
        default:
            break
        }
        UIApplication.shared.registerForRemoteNotifications()
    }
}

/// Appels HTTP hors de toute vue (boutons de notification, App Intents) :
/// adresse et jeton relus depuis UserDefaults / le trousseau.
enum BackgroundAPI {
    static var server: URL? {
        UserDefaults.standard.string(forKey: "serverURL").flatMap(URL.init(string:))
    }

    @discardableResult
    static func post(_ path: String, _ body: [String: Any], timeout: TimeInterval = 15) async throws -> Data {
        guard let server, let token = Keychain.token(for: server) else {
            throw URLError(.userAuthenticationRequired)
        }
        var req = URLRequest(url: server.appending(path: path))
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        req.timeoutInterval = timeout
        let session = URLSession(configuration: .ephemeral, delegate: BackgroundTrust(), delegateQueue: nil)
        let (data, resp) = try await session.data(for: req)
        guard (resp as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) == true else {
            throw BackgroundAPIError.status((resp as? HTTPURLResponse)?.statusCode ?? 0, String(data: data, encoding: .utf8) ?? "")
        }
        return data
    }

    /// GET authentifié (listes pour les Raccourcis).
    static func get(_ path: String, timeout: TimeInterval = 15) async throws -> Data {
        guard let server, let token = Keychain.token(for: server) else {
            throw URLError(.userAuthenticationRequired)
        }
        var req = URLRequest(url: server.appending(path: path))
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = timeout
        let session = URLSession(configuration: .ephemeral, delegate: BackgroundTrust(), delegateQueue: nil)
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw BackgroundAPIError.status((resp as? HTTPURLResponse)?.statusCode ?? 0, String(data: data, encoding: .utf8) ?? "")
        }
        return data
    }

    /// POST qui renvoie du JSON (réponse des routes /sc/*).
    static func json(_ path: String, _ body: [String: Any], timeout: TimeInterval = 60) async throws -> [String: Any] {
        let data = try await post(path, body, timeout: timeout)
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }
    static func getJSON(_ path: String) async throws -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: try await get(path))) as? [String: Any] ?? [:]
    }
}

enum BackgroundAPIError: LocalizedError {
    case status(Int, String)
    var errorDescription: String? {
        switch self {
        case .status(403, _): String(localized: "Une autre session est ouverte sur l'ordinateur.")
        case .status(_, let m): m.isEmpty ? String(localized: "Lumen est injoignable.") : m
        }
    }
}

/// Certificat auto-signé de Lumen, sans interface : seule une empreinte DÉJÀ
/// acceptée dans l'app passe (pas de question possible en arrière-plan).
final class BackgroundTrust: NSObject, URLSessionDelegate {
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge) async
        -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        let space = challenge.protectionSpace
        guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust, let trust = space.serverTrust else {
            return (.performDefaultHandling, nil)
        }
        if SecTrustEvaluateWithError(trust, nil) { return (.performDefaultHandling, nil) }
        guard let leaf = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first else {
            return (.cancelAuthenticationChallenge, nil)
        }
        let pins = UserDefaults.standard.dictionary(forKey: "pinnedCertificates") as? [String: String] ?? [:]
        return Fingerprint.matches(pins["\(space.host):\(space.port)"], leaf)
            ? (.useCredential, URLCredential(trust: trust))
            : (.cancelAuthenticationChallenge, nil)
    }
}
