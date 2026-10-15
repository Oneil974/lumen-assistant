// lumen-imageplayground — passerelle vers Image Playground (Apple Intelligence).
//
// Depuis macOS 27, Apple a retiré l'API programmatique `ImageCreator` : la
// génération passe OBLIGATOIREMENT par la feuille système (Private Cloud
// Compute), via `ImagePlaygroundViewController` en AppKit. Lumen ne peut donc
// pas produire une image « en silence » ; il ouvre la feuille avec le prompt
// déjà rempli, l'utilisateur valide, et l'image revient à Lumen.
//
// Ce petit exécutable héberge la feuille dans sa propre fenêtre, pour que
// n'importe quelle surface de Lumen (Studio, Canvas, blocs Fluxo, agents)
// l'utilise comme un moteur d'image ordinaire :
//
//   lumen-imageplayground --probe
//     → {"available":true,"styles":["any","illustration","animation","sketch"]}
//   lumen-imageplayground --prompt "…" [--style any] [--width 1024 --height 1024]
//                         [--source photo.png] [--strategy new|edit]
//                         [--no-personalization] --out image.png
//     → {"ok":true,"path":"image.png","width":…,"height":…}
//     → {"ok":false,"cancelled":true}   si l'utilisateur ferme la feuille
//
// Compilation : scripts/build-imageplayground.sh (swiftc, cible macOS 27).

import AppKit
import Foundation
import ImagePlayground
import UniformTypeIdentifiers

// MARK: - Arguments

struct Options {
    var probe = false
    var prompt = ""
    var style = "any"
    var width = 1024
    var height = 1024
    var source: String?
    var strategy = "auto"
    var personalization = true
    var out: String?
    var title = "Lumen"
}

func parseArguments() -> Options {
    var options = Options()
    let args = CommandLine.arguments
    var i = 1
    func value() -> String? {
        guard i + 1 < args.count else { return nil }
        i += 1
        return args[i]
    }
    while i < args.count {
        switch args[i] {
        case "--probe": options.probe = true
        case "--prompt": options.prompt = value() ?? ""
        case "--style": options.style = value() ?? "any"
        case "--width": options.width = Int(value() ?? "") ?? 1024
        case "--height": options.height = Int(value() ?? "") ?? 1024
        case "--source": options.source = value()
        case "--strategy": options.strategy = value() ?? "auto"
        case "--no-personalization": options.personalization = false
        case "--out": options.out = value()
        case "--title": options.title = value() ?? "Lumen"
        default: break
        }
        i += 1
    }
    return options
}

func emit(_ object: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object),
       let text = String(data: data, encoding: .utf8) {
        print(text)
        fflush(stdout)
    }
}

func fail(_ message: String, code: Int32 = 1) -> Never {
    emit(["ok": false, "error": message])
    exit(code)
}

// MARK: - Styles

/// Styles exposés à Lumen. `any` (macOS 27) laisse Image Playground choisir
/// librement, y compris le photoréalisme ; `emoji` produit un glyphe adaptatif
/// et non une image, il n'est donc pas proposé.
func availableStyles() -> [(id: String, style: ImagePlaygroundStyle)] {
    var list: [(String, ImagePlaygroundStyle)] = []
    if #available(macOS 27.0, *) {
        list.append(("any", .any))
    }
    list.append(("illustration", .illustration))
    list.append(("animation", .animation))
    list.append(("sketch", .sketch))
    return list
}

func style(for id: String) -> ImagePlaygroundStyle {
    availableStyles().first { $0.id == id }?.style ?? availableStyles().first!.style
}

// MARK: - Sonde

func runProbe() -> Never {
    let available = ImagePlaygroundViewController.isAvailable
    var payload: [String: Any] = [
        "available": available,
        "styles": availableStyles().map { $0.id },
        "os": ProcessInfo.processInfo.operatingSystemVersionString,
    ]
    if !available {
        // Le framework ne détaille pas la cause ; les deux usuelles sont Apple
        // Intelligence désactivée et un Mac non éligible.
        payload["reason"] = "image_playground_unavailable"
    }
    emit(payload)
    exit(0)
}

// MARK: - Fenêtre hôte et délégué

final class HostViewController: NSViewController {
    let message: String
    init(message: String) {
        self.message = message
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func loadView() {
        let container = NSView(frame: NSRect(x: 0, y: 0, width: 420, height: 160))
        let label = NSTextField(wrappingLabelWithString: message)
        label.alignment = .center
        label.font = NSFont.systemFont(ofSize: 13)
        label.textColor = .secondaryLabelColor
        label.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            label.leadingAnchor.constraint(greaterThanOrEqualTo: container.leadingAnchor, constant: 24),
            label.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor, constant: -24),
        ])
        view = container
    }
}

final class PlaygroundSession: NSObject, ImagePlaygroundViewController.Delegate, NSWindowDelegate {
    let options: Options
    var window: NSWindow!
    var host: HostViewController!
    var finished = false

    init(options: Options) {
        self.options = options
    }

    func start() {
        host = HostViewController(message: "Image Playground génère votre image. Validez-la dans la feuille pour la renvoyer à \(options.title).")
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 160),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "\(options.title) — Image Playground"
        window.contentViewController = host
        window.delegate = self
        window.isReleasedWhenClosed = false
        // Processus accessoire sans icône dans le Dock : sans ce niveau, un clic
        // dans Lumen ferait passer la feuille derrière et l'utilisateur la
        // croirait disparue.
        window.level = .floating
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        let playground = ImagePlaygroundViewController()
        playground.delegate = self
        var concepts: [ImagePlaygroundConcept] = []
        let prompt = options.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        if !prompt.isEmpty {
            // `.text` garde la formulation telle quelle ; un prompt très long
            // passe par `.extracted`, qui en tire les idées principales.
            concepts.append(prompt.count > 220 ? .extracted(from: prompt, title: nil) : .text(prompt))
        }
        if let source = options.source, let image = NSImage(contentsOfFile: source) {
            playground.sourceImage = image
        }
        playground.concepts = concepts
        let styles = availableStyles()
        playground.allowedGenerationStyles = styles.map { $0.style }
        playground.selectedGenerationStyle = style(for: options.style)
        if #available(macOS 26.4, *) {
            var opts = ImagePlaygroundOptions()
            opts.personalization = options.personalization ? .automatic : .disabled
            if #available(macOS 27.0, *) {
                opts.sizeSpecification = .closest(to: CGSize(width: options.width, height: options.height))
                switch options.strategy {
                case "new": opts.creationStrategy = .generateNew
                case "edit": opts.creationStrategy = .editExisting
                default: opts.creationStrategy = .automatic
                }
            }
            playground.options = opts
        }
        host.presentAsSheet(playground)
    }

    // MARK: Delegate

    func imagePlaygroundViewController(_ controller: ImagePlaygroundViewController, didCreateImageAt imageURL: URL) {
        finished = true
        controller.dismiss(nil)
        do {
            let (path, size) = try exportPNG(from: imageURL)
            emit(["ok": true, "path": path, "width": Int(size.width), "height": Int(size.height), "style": options.style])
            terminate(0)
        } catch {
            emit(["ok": false, "error": "Export impossible : \(error.localizedDescription)"])
            terminate(1)
        }
    }

    func imagePlaygroundViewControllerDidCancel(_ controller: ImagePlaygroundViewController) {
        finished = true
        controller.dismiss(nil)
        emit(["ok": false, "cancelled": true])
        terminate(0)
    }

    func windowWillClose(_ notification: Notification) {
        if !finished {
            finished = true
            emit(["ok": false, "cancelled": true])
            terminate(0)
        }
    }

    func terminate(_ code: Int32) {
        window?.orderOut(nil)
        DispatchQueue.main.async { exit(code) }
    }

    /// Image Playground rend un fichier temporaire (souvent HEIC ou PNG) ; on
    /// le renvoie toujours en PNG à l'emplacement demandé.
    func exportPNG(from url: URL) throws -> (String, CGSize) {
        guard let image = NSImage(contentsOf: url) else {
            throw NSError(domain: "lumen", code: 1, userInfo: [NSLocalizedDescriptionKey: "image illisible"])
        }
        guard let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else {
            throw NSError(domain: "lumen", code: 2, userInfo: [NSLocalizedDescriptionKey: "conversion PNG impossible"])
        }
        let dest = options.out ?? url.deletingPathExtension().appendingPathExtension("png").path
        try png.write(to: URL(fileURLWithPath: dest), options: .atomic)
        return (dest, CGSize(width: rep.pixelsWide, height: rep.pixelsHigh))
    }
}

// MARK: - Point d'entrée

let options = parseArguments()
if options.probe {
    runProbe()
}
if options.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && options.source == nil {
    fail("--prompt (ou --source) requis")
}
guard ImagePlaygroundViewController.isAvailable else {
    fail("Image Playground indisponible : activez Apple Intelligence dans Réglages Système.")
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let session = PlaygroundSession(options: options)
DispatchQueue.main.async { session.start() }
app.run()
