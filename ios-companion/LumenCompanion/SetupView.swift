import SwiftUI
import VisionKit

/// Choix de l'adresse de Lumen : saisie, QR code contenant
/// l'adresse ou serveur récent. On teste la connexion avant
/// d'enregistrer, pour ne pas atterrir sur une page blanche.
struct SetupView: View {
    @EnvironmentObject private var store: ServerStore
    @Environment(\.palette) private var p
    var onDone: () -> Void

    @State private var input = ""
    @State private var testing = false
    @State private var error: String?
    @State private var scanning = false
    @State private var discovery = LumenDiscovery()

    var body: some View {
        Form {
            Section {
                TextField("192.168.1.42", text: $input)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .onSubmit(connect)
                Button(action: connect) {
                    HStack {
                        Text("Se connecter")
                        if testing { Spacer(); ProgressView() }
                    }
                }
                .disabled(testing || input.isEmpty)
                if DataScannerViewController.isSupported {
                    Button { scanning = true } label: {
                        Label("Scanner le QR code", systemImage: "qrcode.viewfinder")
                    }
                }
            } header: {
                Text("Adresse de Lumen")
            } footer: {
                Text("Scanne le QR code affiché dans Lumen › Réglages › Compagnon mobile, ou tape l'adresse : la connexion est chiffrée (HTTPS, port 8768). Écris « http://… » pour forcer l'ancien accès non chiffré (8766). Hors de chez toi, utilise l'adresse de ton VPN (Tailscale…).")
            }

            if let error {
                Section { Text(L(error)).foregroundStyle(.red) }
            }

            // Ordinateurs Lumen annoncés sur ce Wi-Fi (Bonjour).
            Section {
                if discovery.found.isEmpty {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Recherche de Lumen sur ce réseau…").font(.system(size: 14)).foregroundStyle(.secondary)
                    }
                }
                ForEach(discovery.found) { f in
                    Button {
                        input = f.url.absoluteString
                        connect()
                    } label: {
                        Label(f.name, systemImage: "desktopcomputer")
                    }
                }
            } header: {
                Text("Sur ce réseau")
            }

            if !store.recents.isEmpty {
                Section("Récents") {
                    ForEach(store.recents, id: \.self) { url in
                        Button(url.absoluteString) { input = url.absoluteString; connect() }
                            .swipeActions { Button("Oublier", role: .destructive) { store.forget(url) } }
                    }
                }
            }

            if store.current != nil {
                Section {
                    Button("Oublier les certificats acceptés") { store.unpinAll() }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(p.background.ignoresSafeArea())
        .navigationTitle("Lumen")
        .toolbar {
            if store.current != nil {
                ToolbarItem(placement: .cancellationAction) { Button("Fermer", action: onDone) }
            }
        }
        .onAppear {
            if input.isEmpty { input = store.current?.absoluteString ?? "" }
            discovery.start()
        }
        .onDisappear { discovery.stop() }
        .sheet(isPresented: $scanning) {
            QRScannerView { code in
                scanning = false
                // QR de Lumen : « https://ip:8768/#fp=<empreinte de clé> ». On
                // épingle cette clé d'office : pas d'alerte « certificat inconnu ».
                if var c = URLComponents(string: code), let frag = c.fragment, frag.hasPrefix("fp="),
                   let host = c.host {
                    let hex = String(frag.dropFirst(3)).uppercased().filter(\.isHexDigit)
                    if hex.count == 64 {
                        let pairs = stride(from: 0, to: 64, by: 2).map { i -> String in
                            let a = hex.index(hex.startIndex, offsetBy: i)
                            return String(hex[a..<hex.index(a, offsetBy: 2)])
                        }
                        store.pin("K:" + pairs.joined(separator: ":"), host: host, port: c.port ?? ServerStore.httpsPort)
                    }
                    c.fragment = nil
                    input = c.string ?? code
                } else {
                    input = code
                }
                connect()
            }
            .ignoresSafeArea()
        }
    }

    private func connect() {
        guard let url = ServerStore.normalize(input) else {
            error = "Adresse invalide."
            return
        }
        error = nil
        testing = true
        Task {
            let result = await ConnectionProbe(store: store).check(url)
            testing = false
            switch result {
            case .ok:
                store.use(url)
                onDone()
            case .failure(let message):
                error = message
            }
        }
    }
}

/// Vérifie que l'adresse répond bien comme un compagnon Lumen
/// (le manifeste PWA est servi sans authentification).
struct ConnectionProbe {
    enum Result { case ok, failure(String) }
    let store: ServerStore

    @MainActor
    func check(_ url: URL) async -> Result {
        let probe = url.appending(path: "manifest.webmanifest")
        let delegate = TrustDelegate(store: store)
        let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
        var req = URLRequest(url: probe)
        req.timeoutInterval = 6
        do {
            let (_, resp) = try await session.data(for: req)
            guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
                return .failure("Lumen répond, mais pas comme un compagnon mobile. Vérifie le port.")
            }
            return .ok
        } catch let e as URLError where e.code == .cancelled {
            return .failure("Certificat refusé.")
        } catch {
            return .failure(String(localized: "Lumen injoignable : \(error.localizedDescription)\nL'ordinateur est-il allumé, sur le même réseau, avec le compagnon activé ?"))
        }
    }
}

/// Certificat auto-signé de Lumen (HTTPS 8768) : accepté si son empreinte
/// est déjà connue, sinon on demande à l'utilisateur de la vérifier une fois.
final class TrustDelegate: NSObject, URLSessionDelegate {
    let store: ServerStore
    init(store: ServerStore) { self.store = store }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge) async
        -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        await CertificateTrust.evaluate(challenge, store: store)
    }
}
