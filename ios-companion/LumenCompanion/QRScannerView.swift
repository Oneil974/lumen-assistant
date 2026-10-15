import SwiftUI
import VisionKit

/// Scan d'un QR code contenant l'adresse du compagnon (Lumen n'en affiche
/// pas encore : n'importe quel QR d'URL convient). Premier code lu = résultat.
struct QRScannerView: UIViewControllerRepresentable {
    var onCode: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let vc = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            isHighlightingEnabled: true)
        vc.delegate = context.coordinator
        try? vc.startScanning()
        return vc
    }

    func updateUIViewController(_ vc: DataScannerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onCode: (String) -> Void
        private var done = false
        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

        func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !done else { return }
            for case .barcode(let code) in items {
                guard let value = code.payloadStringValue else { continue }
                done = true
                scanner.stopScanning()
                onCode(Self.extractURL(value))
                return
            }
        }

        /// Le QR peut contenir une URL nue ou une URL avec paramètres
        /// d'appairage : on ne garde que l'origine du compagnon.
        static func extractURL(_ value: String) -> String {
            guard let c = URLComponents(string: value), let scheme = c.scheme, let host = c.host else { return value }
            return "\(scheme)://\(host)\(c.port.map { ":\($0)" } ?? "")/"
        }
    }
}
