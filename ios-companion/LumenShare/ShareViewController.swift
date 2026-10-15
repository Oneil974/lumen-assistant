import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// « Envoyer à Lumen » depuis la feuille de partage de n'importe quelle app :
/// page web, texte, photo, PDF… Tout arrive dans la sandbox « iPhone » de Lumen
/// (dossier Partages/), via `POST /share`.
final class ShareViewController: UIViewController {
    private var status = ShareStatus()

    override func viewDidLoad() {
        super.viewDidLoad()
        let host = UIHostingController(rootView: ShareView(status: status, close: { [weak self] in self?.finish() }))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
        Task { await send() }
    }

    private func finish() {
        extensionContext?.completeRequest(returningItems: nil)
    }

    private func send() async {
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        var sent = 0
        var failed = 0
        for item in items {
            for provider in item.attachments ?? [] {
                if let body = await payload(from: provider, title: item.attributedContentText?.string) {
                    if await post(body) { sent += 1 } else { failed += 1 }
                }
            }
        }
        await MainActor.run {
            status.done = true
            status.text = failed == 0
                ? String(localized: "Envoyé à Lumen (\(sent)).")
                : String(localized: "Lumen est injoignable : réessaie depuis le même réseau ou le VPN.")
        }
        try? await Task.sleep(for: .seconds(failed == 0 ? 1.2 : 3))
        await MainActor.run { finish() }
    }

    private func payload(from p: NSItemProvider, title: String?) async -> [String: Any]? {
        if p.hasItemConformingToTypeIdentifier(UTType.url.identifier),
           let url = try? await p.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL, !url.isFileURL {
            return ["kind": "url", "url": url.absoluteString, "name": title ?? url.host() ?? "", "text": title ?? ""]
        }
        for type in [UTType.image, .pdf, .movie, .data] where p.hasItemConformingToTypeIdentifier(type.identifier) {
            if let url = try? await p.loadItem(forTypeIdentifier: type.identifier) as? URL, let data = try? Data(contentsOf: url) {
                return ["kind": "file", "name": url.lastPathComponent, "b64": data.base64EncodedString()]
            }
            if let img = try? await p.loadItem(forTypeIdentifier: type.identifier) as? UIImage, let data = img.jpegData(compressionQuality: 0.9) {
                return ["kind": "file", "name": "photo.jpg", "b64": data.base64EncodedString()]
            }
        }
        if p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
           let text = try? await p.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
            return ["kind": "text", "text": text, "name": ""]
        }
        return nil
    }

    private func post(_ body: [String: Any]) async -> Bool {
        guard let server = SharedStore.server, let token = SharedStore.token else { return false }
        var req = URLRequest(url: server.appending(path: "share"))
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        req.timeoutInterval = 60
        let session = URLSession(configuration: .ephemeral, delegate: PinnedTrust(), delegateQueue: nil)
        guard let (_, resp) = try? await session.data(for: req) else { return false }
        return (resp as? HTTPURLResponse)?.statusCode == 200
    }
}

@Observable final class ShareStatus {
    var done = false
    var text = String(localized: "Envoi à Lumen…")
}

struct ShareView: View {
    let status: ShareStatus
    let close: () -> Void
    var body: some View {
        VStack(spacing: 14) {
            if status.done { Image(systemName: "checkmark.circle.fill").font(.system(size: 40)).foregroundStyle(.green) }
            else { ProgressView().controlSize(.large) }
            Text(status.text).font(.system(size: 15, weight: .medium)).multilineTextAlignment(.center)
            Button("Fermer", action: close).padding(.top, 4)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.regularMaterial)
    }
}
