import UIKit

/// Confiance à la première utilisation pour le certificat auto-signé du
/// compagnon HTTPS (port 8768). Un certificat valide pour le système passe
/// directement. Sinon : empreinte connue → accepté ; empreinte différente →
/// refusé (quelqu'un se fait peut-être passer pour ton ordinateur) ; inconnue
/// → on montre l'empreinte et on demande.
@MainActor
enum CertificateTrust {
    static func evaluate(_ challenge: URLAuthenticationChallenge, store: ServerStore) async
        -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        let space = challenge.protectionSpace
        guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = space.serverTrust else {
            return (.performDefaultHandling, nil)
        }
        if SecTrustEvaluateWithError(trust, nil) {
            return (.performDefaultHandling, nil)
        }
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = chain.first else {
            return (.cancelAuthenticationChallenge, nil)
        }
        let shown = Fingerprint.display(leaf)
        let host = space.host, port = space.port

        if let known = store.pinnedFingerprint(host: host, port: port) {
            if Fingerprint.matches(known, leaf) {
                // Ancienne épingle (certificat entier) : on passe à la clé,
                // qui survit aux changements d'IP de l'ordinateur.
                if !known.hasPrefix("K:") { store.pin(Fingerprint.pin(for: leaf), host: host, port: port) }
                return (.useCredential, URLCredential(trust: trust))
            }
            // Clé différente : réinstallation de Lumen, autre ordinateur… ou
            // usurpation. On ne refuse plus sèchement : l'utilisateur compare
            // avec l'empreinte affichée dans Lumen › Réglages › Compagnon.
            let trustNew = await alert(
                title: String(localized: "Certificat modifié"),
                message: String(localized: "Le certificat de \(host) n'est plus celui accepté la dernière fois (Lumen réinstallé, données réinitialisées ou autre ordinateur ?).\n\nNe fais confiance au nouveau que si cette empreinte est identique à celle de Lumen › Réglages › Compagnon :\n\n\(shown)"),
                confirm: String(localized: "Faire confiance au nouveau"))
            guard trustNew else { return (.cancelAuthenticationChallenge, nil) }
            store.pin(Fingerprint.pin(for: leaf), host: host, port: port)
            return (.useCredential, URLCredential(trust: trust))
        }

        let accepted = await alert(
            title: String(localized: "Certificat de Lumen"),
            message: String(localized: "\(host) utilise un certificat auto-signé. Vérifie que l'empreinte correspond à celle affichée dans Lumen › Réglages › Compagnon :\n\n\(shown)"),
            confirm: String(localized: "Faire confiance"))
        guard accepted else { return (.cancelAuthenticationChallenge, nil) }
        store.pin(Fingerprint.pin(for: leaf), host: host, port: port)
        return (.useCredential, URLCredential(trust: trust))
    }

    @discardableResult
    private static func alert(title: String, message: String, confirm: String?) async -> Bool {
        await withCheckedContinuation { cont in
            guard let presenter = topController() else { cont.resume(returning: false); return }
            let a = UIAlertController(title: title, message: message, preferredStyle: .alert)
            a.addAction(UIAlertAction(title: confirm == nil ? String(localized: "OK") : String(localized: "Annuler"), style: .cancel) { _ in
                cont.resume(returning: false)
            })
            if let confirm {
                a.addAction(UIAlertAction(title: confirm, style: .default) { _ in cont.resume(returning: true) })
            }
            presenter.present(a, animated: true)
        }
    }

    static func topController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive } ??
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        var top = scene?.windows.first { $0.isKeyWindow }?.rootViewController
        while let next = top?.presentedViewController { top = next }
        return top
    }
}
