import QuickLook
import SwiftUI

/// Fichiers du coffre unifié cités par l'IA : `lumenmedia://localhost/<sb>/<chemin>`
/// → `/media/<sb>/<chemin>?token=` du serveur compagnon (certificat épinglé).
/// Images affichées dans la bulle ; autres fichiers (PDF, documents, binaires)
/// ouverts en aperçu Quick Look, avec partage / enregistrement dans Fichiers.
enum LumenFiles {
    static let scheme = "lumenmedia"

    static func isLumenFile(_ s: String) -> Bool { s.hasPrefix("lumenmedia://localhost/") }

    /// Adresse HTTP(S) du serveur compagnon pour ce fichier.
    static func serverURL(for lumenURL: String) -> URL? {
        guard let server = SharedStore.server, let token = SharedStore.token,
              let rest = lumenURL.components(separatedBy: "lumenmedia://localhost/").last, !rest.isEmpty,
              var c = URLComponents(url: server, resolvingAgainstBaseURL: false) else { return nil }
        let base = c.percentEncodedPath.hasSuffix("/") ? String(c.percentEncodedPath.dropLast()) : c.percentEncodedPath
        c.percentEncodedPath = "\(base)/media/\(rest)"
        c.queryItems = [URLQueryItem(name: "token", value: token)]
        return c.url
    }

    static func fileName(of lumenURL: String) -> String {
        let last = lumenURL.split(separator: "/").last.map(String.init) ?? "fichier"
        return last.removingPercentEncoding ?? last
    }

    private static let cache = NSCache<NSString, NSData>()

    static func data(_ lumenURL: String) async -> Data? {
        if let d = cache.object(forKey: lumenURL as NSString) { return d as Data }
        guard let url = serverURL(for: lumenURL) else { return nil }
        let session = URLSession(configuration: .ephemeral, delegate: PinnedTrust(), delegateQueue: nil)
        guard let (data, resp) = try? await session.data(from: url),
              (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        if data.count < 8 * 1024 * 1024 { cache.setObject(data as NSData, forKey: lumenURL as NSString) }
        return data
    }

    /// Télécharge dans un fichier temporaire portant le vrai nom (pour Quick Look).
    static func download(_ lumenURL: String) async -> URL? {
        guard let data = await data(lumenURL) else { return nil }
        let dir = FileManager.default.temporaryDirectory.appending(path: "lumen-files", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appending(path: fileName(of: lumenURL))
        do { try data.write(to: file, options: .atomic) } catch { return nil }
        return file
    }
}

/// Image du coffre dans une bulle (touchée : aperçu plein écran).
struct LumenFileImage: View {
    @Environment(\.palette) private var p
    let url: String
    let alt: String
    @State private var image: UIImage?
    @State private var failed = false
    @State private var preview: URL?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxHeight: 320)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .onTapGesture { Task { preview = await LumenFiles.download(url) } }
            } else if failed {
                Label(alt.isEmpty ? LumenFiles.fileName(of: url) : alt, systemImage: "photo.badge.exclamationmark")
                    .font(.system(size: 14)).foregroundStyle(p.mutedForeground)
            } else {
                RoundedRectangle(cornerRadius: 12).fill(p.muted).frame(height: 160).overlay(ProgressView())
            }
        }
        .accessibilityLabel(alt)
        .task(id: url) {
            if let d = await LumenFiles.data(url), let img = UIImage(data: d) { image = img } else { failed = true }
        }
        .sheet(item: $preview) { QuickLookSheet(url: $0).ignoresSafeArea() }
    }
}

extension URL: @retroactive Identifiable {
    public var id: String { absoluteString }
}

/// Aperçu Quick Look (PDF, images, Office, texte…) avec partage intégré.
struct QuickLookSheet: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> UINavigationController {
        let ql = QLPreviewController()
        ql.dataSource = context.coordinator
        return UINavigationController(rootViewController: ql)
    }

    func updateUIViewController(_ vc: UINavigationController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        let url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    }
}
