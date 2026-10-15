import Foundation
import Network
import Observation

/// Découverte de Lumen sur le Wi-Fi (Bonjour `_lumen._tcp`, annoncé par
/// companion.rs) : l'écran de configuration propose les ordinateurs trouvés,
/// sans adresse à taper ni QR code.
@MainActor
@Observable
final class LumenDiscovery {
    struct Found: Identifiable, Hashable {
        var id: String { name }
        let name: String
        let url: URL
    }

    private(set) var found: [Found] = []
    private var browser: NWBrowser?

    func start() {
        guard browser == nil else { return }
        let b = NWBrowser(for: .bonjour(type: "_lumen._tcp", domain: nil), using: .tcp)
        b.browseResultsChangedHandler = { [weak self] results, _ in
            Task { @MainActor in self?.resolve(results) }
        }
        b.start(queue: .main)
        browser = b
    }

    func stop() {
        browser?.cancel()
        browser = nil
    }

    private func resolve(_ results: Set<NWBrowser.Result>) {
        for r in results {
            guard case .service(let name, _, _, _) = r.endpoint, !found.contains(where: { $0.name == name }) else { continue }
            // On résout l'hôte et le port en ouvrant une connexion éphémère.
            let conn = NWConnection(to: r.endpoint, using: .tcp)
            conn.stateUpdateHandler = { [weak self] state in
                guard case .ready = state, let remote = conn.currentPath?.remoteEndpoint,
                      case .hostPort(let host, let port) = remote else {
                    if case .failed = state { conn.cancel() }
                    return
                }
                var h = "\(host)"
                if let pct = h.firstIndex(of: "%") { h = String(h[..<pct]) }   // zone IPv6
                if h.contains(":") { h = "[\(h)]" }
                conn.cancel()
                // Bonjour annonce l'écouteur HTTP (8766) ; on se connecte au
                // HTTPS du même ordinateur (8768), chiffré.
                let tls = port.rawValue == UInt16(ServerStore.httpPort) ? ServerStore.httpsPort : Int(port.rawValue)
                if let url = URL(string: "https://\(h):\(tls)/") {
                    Task { @MainActor in
                        guard let self, !self.found.contains(where: { $0.name == name }) else { return }
                        self.found.append(Found(name: name, url: url))
                    }
                }
            }
            conn.start(queue: .main)
        }
    }
}
