import SwiftUI
import WebKit

// Coffre : un explorateur façon Fichiers. Sources (apps, sandboxes, iPhone…)
// → dossiers → fiches → détail. Toute fiche peut être JOINTE à la discussion :
// le bureau la lit (appel data_get visible dans le fil) et la réponse porte
// sur elle. Les valeurs clé → valeur (Raccourcis, widgets) restent éditables.

struct VaultView: View {
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss
    let client: LumenClient
    @State private var path: [VaultRoute] = []
    @State private var search = ""
    @FocusState private var searching: Bool
    @State private var mode: DataHub.Mode = .sources
    @State private var sources: [DataHub.Source] = []
    @State private var records: [HubRecord] = []
    @State private var hubError: String?
    @State private var loading = false
    @State private var entries: [VaultEntry] = VaultStore.all
    @State private var creating = false
    @AppStorage("uiAccent") private var accent = ""
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    header
                    searchField
                    if search.isEmpty {
                        Segmented(items: [(DataHub.Mode.sources, String(localized: "Sources")), (.agenda, String(localized: "Agenda")),
                                          (.tasks, String(localized: "Tâches")), (.metrics, String(localized: "Mesures"))], selection: $mode)
                    }
                    content
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 30)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(p.popover.ignoresSafeArea())
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: VaultRoute.self) { route in
                switch route {
                case .source(let src): VaultSourceView(source: src, pin: pin)
                case .folder(let src, let recs, let dir): VaultFolderView(source: src, records: recs, dir: dir, pin: pin)
                case .record(let r): VaultRecordView(record: r, pin: pin)
                case .workspace:
                    if let server = SharedStore.server, let token = SharedStore.token {
                        VaultWorkspace(server: server, token: token, accent: accent, theme: scheme == .dark ? "dark" : "light")
                            .navigationTitle("Coffre personnel").navigationBarTitleDisplayMode(.inline)
                    } else { EmptyRow(text: "Connectez votre compagnon à Lumen.") }
                case .values: VaultValuesView(entries: $entries, creating: $creating)
                }
            }
        }
        .foregroundStyle(p.foreground)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(22)
        .presentationBackground(p.popover)
        .task { await VaultStore.sync(); entries = VaultStore.all; VaultSpotlight.reindex() }
        .task(id: "\(mode.rawValue)|\(search)") { await load() }
        .onReceive(NotificationCenter.default.publisher(for: VaultStore.changed)) { _ in entries = VaultStore.all }
        .sheet(isPresented: $creating) { VaultEditor(entry: nil) { entries = VaultStore.all; Task { await VaultStore.sync() } }.themed() }
    }

    /// Joint la fiche au prochain message et referme le coffre.
    private func pin(_ r: HubRecord) {
        client.pin(r)
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        dismiss()
    }

    private var header: some View {
        HStack(spacing: 12) {
            IconBadge(symbol: "cylinder.split.1x2", size: 40)
            VStack(alignment: .leading, spacing: 1) {
                Text("Coffre").font(.system(size: 26, weight: .bold)).tracking(-0.5)
                Text(client.pinned.isEmpty ? L("Toutes tes données, au même endroit") : String(localized: "\(client.pinned.count) élément(s) joint(s) à la discussion"))
                    .font(.system(size: 12)).foregroundStyle(client.pinned.isEmpty ? p.mutedForeground : p.primary)
            }
            Spacer()
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.system(size: 13, weight: .semibold)).foregroundStyle(p.mutedForeground)
                    .frame(width: 32, height: 32).background(p.muted, in: Circle())
            }
        }
        .padding(.top, 20)
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(searching ? p.primary : p.mutedForeground)
            TextField("Rechercher dans tout le coffre", text: $search)
                .textInputAutocapitalization(.never).autocorrectionDisabled().focused($searching)
            if !search.isEmpty {
                Button { search = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(p.mutedForeground) }
            }
        }
        .padding(12)
        .background(p.background, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(searching ? p.primary.opacity(0.6) : p.border, lineWidth: searching ? 1.2 : 0.8))
        .shadow(color: searching ? p.primary.opacity(0.18) : .clear, radius: 10)
    }

    @ViewBuilder private var content: some View {
        if loading && records.isEmpty && sources.isEmpty {
            ProgressView().frame(maxWidth: .infinity).padding(30)
        } else if let hubError, records.isEmpty, sources.isEmpty {
            EmptyRow(text: hubError)
        } else if !search.isEmpty || mode != .sources {
            if records.isEmpty && !loading {
                EmptyRow(text: String(localized: "Rien pour l'instant."))
            }
            VStack(spacing: 6) {
                ForEach(records.prefix(200)) { r in NavigationLink(value: VaultRoute.record(r)) { VaultRecordRow(record: r) }.buttonStyle(PressStyle()) }
            }
        } else {
            SectionLabel("Sources")
            VStack(spacing: 6) {
                ForEach(sources) { src in
                    NavigationLink(value: VaultRoute.source(src)) {
                        HStack(spacing: 12) {
                            IconBadge(symbol: LumenIcons.source(id: src.id, label: src.label), size: 34)
                            Text(src.label).font(.system(size: 15, weight: .medium)).lineLimit(1)
                            Spacer()
                            Text("\(src.count)").font(.system(size: 13).monospacedDigit()).foregroundStyle(p.mutedForeground)
                            Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(p.mutedForeground)
                        }
                        .lumenCard(radius: 14, padding: 10)
                    }
                    .buttonStyle(PressStyle())
                }
                NavigationLink(value: VaultRoute.workspace) {
                    HStack(spacing: 12) {
                        IconBadge(symbol: "square.stack.3d.up", size: 34)
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Coffre personnel").font(.system(size: 15, weight: .semibold))
                            Text("Collections · fiches · historique · accès IA").font(.system(size: 12)).foregroundStyle(p.mutedForeground)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").foregroundStyle(p.primary)
                    }.lumenCard(radius: 14, padding: 12)
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(p.primary.opacity(0.35)))
                }.buttonStyle(PressStyle())
                NavigationLink(value: VaultRoute.values) {
                    HStack(spacing: 12) {
                        IconBadge(symbol: "key.horizontal", size: 34)
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Valeurs du coffre").font(.system(size: 15, weight: .medium))
                            Text("Raccourcis, widgets, listes").font(.system(size: 12)).foregroundStyle(p.mutedForeground)
                        }
                        Spacer()
                        Text("\(entries.count)").font(.system(size: 13).monospacedDigit()).foregroundStyle(p.mutedForeground)
                        Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(p.mutedForeground)
                    }
                    .lumenCard(radius: 14, padding: 10)
                }
                .buttonStyle(PressStyle())
            }
        }
    }

    private func load() async {
        if !search.isEmpty { try? await Task.sleep(for: .milliseconds(300)) }
        guard !Task.isCancelled else { return }
        loading = true
        defer { loading = false }
        do {
            if !search.isEmpty {
                records = try await DataHub.query(.search, text: search, limit: 80)
            } else if mode == .sources {
                sources = try await DataHub.sources()
                records = []
            } else {
                records = try await DataHub.query(mode, period: mode == .agenda ? "next_30_days" : "")
            }
            hubError = nil
        } catch {
            let type: String? = switch mode { case .agenda: "event"; case .tasks: "task"; case .metrics: "metric"; default: nil }
            records = DataHub.searchLocal(search, type: search.isEmpty ? type : nil)
            hubError = records.isEmpty ? String(localized: "Lumen est injoignable et aucune copie locale n'est disponible.") : nil
        }
    }
}

enum VaultRoute: Hashable {
    case source(DataHub.Source)
    case folder(DataHub.Source, [HubRecord], String)
    case record(HubRecord)
    case values
    case workspace
}

/// Page intérieure du coffre : titre, retour, contenu en cartes.
private struct VaultPage<Content: View>: View {
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var back
    let title: String
    var symbol: String = "folder"
    var subtitle: String = ""
    @ViewBuilder var content: Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 10) {
                    Button { back() } label: {
                        Image(systemName: "chevron.left").font(.system(size: 14, weight: .semibold))
                            .frame(width: 34, height: 34).background(p.muted, in: Circle())
                    }
                    .buttonStyle(PressStyle())
                    IconBadge(symbol: symbol, size: 34)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(title).font(.system(size: 18, weight: .semibold)).lineLimit(1)
                        if !subtitle.isEmpty { Text(subtitle).font(.system(size: 12)).foregroundStyle(p.mutedForeground).lineLimit(1) }
                    }
                    Spacer()
                }
                .padding(.top, 18).padding(.bottom, 6)
                content
            }
            .padding(.horizontal, 14)
            .padding(.bottom, 30)
        }
        .background(p.popover.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
    }
}

/// Ligne de fiche : icône du type, titre, sous-titre, trombone si fichier.
struct VaultRecordRow: View {
    @Environment(\.palette) private var p
    let record: HubRecord

    var body: some View {
        HStack(spacing: 12) {
            IconBadge(symbol: record.icon, tint: record.type == "image" || record.type == "media" ? .purple : nil, size: 34)
            VStack(alignment: .leading, spacing: 2) {
                Text(record.title).font(.system(size: 14.5, weight: .medium)).lineLimit(1)
                Text(record.subtitle).font(.system(size: 12)).foregroundStyle(p.mutedForeground).lineLimit(2)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(p.mutedForeground)
        }
        .lumenCard(radius: 14, padding: 10)
    }
}

/// Une source : dossiers (sandboxes) ou fiches, les plus récentes d'abord.
struct VaultSourceView: View {
    @Environment(\.palette) private var p
    let source: DataHub.Source
    let pin: (HubRecord) -> Void
    @State private var records: [HubRecord] = []
    @State private var failed = false

    var body: some View {
        Group {
            if source.id.hasPrefix("fichiers:") && !records.isEmpty {
                VaultFolderView(source: source, records: records, dir: "", pin: pin)
            } else {
                VaultPage(title: source.label, symbol: LumenIcons.source(id: source.id, label: source.label),
                          subtitle: String(localized: "\(source.count) fiches")) {
                    if records.isEmpty && failed { EmptyRow(text: String(localized: "Source indisponible.")) }
                    if records.isEmpty && !failed { ProgressView().frame(maxWidth: .infinity).padding(30) }
                    VStack(spacing: 6) {
                        ForEach(records) { r in NavigationLink(value: VaultRoute.record(r)) { VaultRecordRow(record: r) }.buttonStyle(PressStyle()) }
                    }
                }
            }
        }
        .task {
            do { records = try await DataHub.records(source: source.id) } catch { failed = true }
        }
    }
}

/// Dossier d'une sandbox : sous-dossiers puis fichiers, comme l'app Fichiers.
struct VaultFolderView: View {
    @Environment(\.palette) private var p
    let source: DataHub.Source
    let records: [HubRecord]
    let dir: String
    let pin: (HubRecord) -> Void

    /// Chemin relatif d'une fiche de fichier (« fichiers:<sb>:<chemin> »).
    private func rel(_ r: HubRecord) -> String {
        let parts = r.id.split(separator: ":", maxSplits: 2)
        return parts.count == 3 ? String(parts[2]) : r.title
    }

    private var inDir: [(folders: [String], files: [HubRecord])] {
        let prefix = dir.isEmpty ? "" : dir + "/"
        var folders = Set<String>()
        var files: [HubRecord] = []
        for r in records {
            let path = rel(r)
            guard path.hasPrefix(prefix) else { continue }
            let rest = path.dropFirst(prefix.count)
            if let slash = rest.firstIndex(of: "/") { folders.insert(String(rest[..<slash])) } else { files.append(r) }
        }
        return [(folders.sorted { $0.localizedStandardCompare($1) == .orderedAscending }, files.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending })]
    }

    var body: some View {
        let content = inDir[0]
        VaultPage(title: dir.isEmpty ? source.label : String(dir.split(separator: "/").last ?? ""),
                  symbol: dir.isEmpty ? LumenIcons.source(id: source.id, label: source.label) : "folder",
                  subtitle: String(localized: "\(content.folders.count) dossier(s) · \(content.files.count) fichier(s)")) {
            if !content.folders.isEmpty {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 100), spacing: 10)], spacing: 10) {
                    ForEach(content.folders, id: \.self) { f in
                        NavigationLink(value: VaultRoute.folder(source, records, dir.isEmpty ? f : "\(dir)/\(f)")) {
                            VStack(spacing: 6) {
                                Image(systemName: "folder.fill").font(.system(size: 34)).foregroundStyle(p.primary.gradient)
                                Text(f).font(.system(size: 12, weight: .medium)).lineLimit(2).multilineTextAlignment(.center)
                            }
                            .frame(maxWidth: .infinity, minHeight: 86)
                            .lumenCard(radius: 14, padding: 8)
                        }
                        .buttonStyle(PressStyle())
                    }
                }
                .padding(.bottom, 4)
            }
            VStack(spacing: 6) {
                ForEach(content.files) { r in NavigationLink(value: VaultRoute.record(r)) { VaultRecordRow(record: r) }.buttonStyle(PressStyle()) }
            }
        }
    }
}

/// Détail d'une fiche : aperçu, texte intégral, actions.
struct VaultRecordView: View {
    @Environment(\.palette) private var p
    let record: HubRecord
    let pin: (HubRecord) -> Void
    @State private var full: HubRecord?
    @State private var preview: URL?
    @State private var opening = false

    private var r: HubRecord { full ?? record }

    var body: some View {
        VaultPage(title: r.title, symbol: r.icon, subtitle: r.app) {
            // Métadonnées en pastilles.
            HStack(spacing: 6) {
                Chip(text: L(typeLabel), symbol: r.icon, tint: p.primary)
                if let d = r.date { Chip(text: d.formatted(date: .abbreviated, time: r.tags.contains("journée") ? .omitted : .shortened), symbol: "calendar") }
                if !r.status.isEmpty { Chip(text: r.status, symbol: "circle.dashed") }
            }
            if !r.people.isEmpty || !r.place.isEmpty || !r.tags.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    if !r.people.isEmpty { Label(r.people, systemImage: "person.2").font(.system(size: 12.5)) }
                    if !r.place.isEmpty { Label(r.place, systemImage: "mappin.and.ellipse").font(.system(size: 12.5)) }
                    if !r.tags.isEmpty { Label(r.tags, systemImage: "tag").font(.system(size: 12.5)) }
                }
                .foregroundStyle(p.mutedForeground)
                .padding(.top, 2)
            }

            if r.type == "image", !r.url.isEmpty {
                LumenFileImage(url: r.url, alt: r.title).padding(.top, 6)
            }

            // Actions.
            VStack(spacing: 8) {
                PrimaryButton(title: "Utiliser dans la discussion") { pin(r) }
                HStack(spacing: 8) {
                    if !r.url.isEmpty {
                        Button {
                            opening = true
                            Task { preview = await LumenFiles.download(r.url); opening = false }
                        } label: {
                            Label(opening ? L("Ouverture…") : L("Ouvrir"), systemImage: "arrow.up.forward.app")
                                .font(.system(size: 14, weight: .medium)).frame(maxWidth: .infinity).padding(.vertical, 10)
                                .overlay(RoundedRectangle(cornerRadius: 12).stroke(p.border))
                        }
                        .buttonStyle(PressStyle())
                    }
                    ShareLink(item: "\(r.title)\n\n\(r.text)") {
                        Label("Partager", systemImage: "square.and.arrow.up")
                            .font(.system(size: 14, weight: .medium)).frame(maxWidth: .infinity).padding(.vertical, 10)
                            .overlay(RoundedRectangle(cornerRadius: 12).stroke(p.border))
                    }
                    .buttonStyle(PressStyle())
                }
            }
            .padding(.vertical, 8)

            if !r.text.isEmpty {
                SectionLabel("Contenu")
                Text(r.text.count > 20_000 ? String(r.text.prefix(20_000)) + "…" : r.text)
                    .font(.system(size: 14))
                    .textSelection(.enabled)
                    .lumenCard(radius: 14)
            } else if full == nil {
                ProgressView().frame(maxWidth: .infinity).padding(20)
            }
        }
        .task { full = (try? await DataHub.record(record.id)) ?? record }
        .sheet(item: $preview) { QuickLookSheet(url: $0).ignoresSafeArea() }
    }

    private var typeLabel: String {
        switch r.type {
        case "event": "Évènement"
        case "task": "Tâche"
        case "note": "Note"
        case "contact": "Contact"
        case "message": "Message"
        case "document": "Document"
        case "image": "Image"
        case "media": "Audio / vidéo"
        case "table": "Table"
        case "metric": "Mesure"
        case "list": "Liste"
        case "agent": "Agent"
        case "file": "Fichier"
        default: "Élément"
        }
    }
}

/// Valeurs clé → valeur (Raccourcis, widgets, capteurs), par dossier.
struct VaultValuesView: View {
    @Environment(\.palette) private var p
    @Binding var entries: [VaultEntry]
    @Binding var creating: Bool
    @State private var editing: VaultEntry?

    private var folders: [(String, [VaultEntry])] {
        Dictionary(grouping: entries, by: \.folder).sorted { $0.key < $1.key }
    }

    var body: some View {
        VaultPage(title: L("Valeurs du coffre"), symbol: "key.horizontal", subtitle: L("Raccourcis, widgets, listes")) {
            Button { creating = true } label: {
                Label("Nouvelle valeur", systemImage: "plus").font(.system(size: 14, weight: .medium))
                    .frame(maxWidth: .infinity).padding(.vertical, 10)
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(p.border, style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
            }
            .buttonStyle(PressStyle())
            if entries.isEmpty {
                EmptyRow(text: "Le coffre est vide. Ajoute une valeur ici, depuis Raccourcis (« Écrire une valeur Lumen ») ou demande à Lumen : « ajoute du lait à mes courses ».")
            }
            ForEach(folders, id: \.0) { folder, items in
                SectionLabel(folder.isEmpty ? "Racine" : VaultStore.collections.first(where: { $0.id == folder })?.name ?? folder)
                VStack(spacing: 6) {
                    ForEach(items) { e in
                        Button { editing = e } label: {
                            HStack(spacing: 12) {
                                IconBadge(symbol: e.type == "list" ? "list.bullet" : e.type == "number" ? "number" : e.type == "bool" ? "switch.2" : e.type == "date" ? "calendar" : "textformat", size: 30)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(e.name).font(.system(size: 14.5, weight: .medium))
                                    Text(e.value.summary).font(.system(size: 12.5)).foregroundStyle(p.mutedForeground).lineLimit(2)
                                }
                                Spacer()
                                if e.dirty == true { Image(systemName: "icloud.and.arrow.up").font(.system(size: 12)).foregroundStyle(p.mutedForeground) }
                            }
                            .lumenCard(radius: 14, padding: 10)
                        }
                        .buttonStyle(PressStyle())
                        .contextMenu {
                            Button(role: .destructive) {
                                VaultStore.delete(e.key); entries = VaultStore.all; Task { await VaultStore.sync() }
                            } label: { Label("Supprimer", systemImage: "trash") }
                        }
                    }
                }
            }
        }
        .sheet(item: $editing) { e in VaultEditor(entry: e) { entries = VaultStore.all; Task { await VaultStore.sync() } }.themed() }
    }
}

struct VaultEditor: View {
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss
    let entry: VaultEntry?
    let onSave: () -> Void
    @State private var key = ""
    @State private var value = ""
    @State private var type = "text"

    var body: some View {
        SheetScaffold(title: entry == nil ? "Nouvelle valeur" : "Modifier") {
            VStack(spacing: 10) {
                field("Clé (ex. maison/chauffage)", text: $key).disabled(entry != nil)
                Segmented(items: [("text", "Texte"), ("number", "Nombre"), ("bool", "Oui/non"), ("list", "Liste"), ("dict", "JSON")], selection: $type)
                TextField(type == "list" ? "Éléments séparés par des virgules" : "Valeur", text: $value, axis: .vertical)
                    .lineLimit(1...8)
                    .padding(12)
                    .background(p.background, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(p.border))
                PrimaryButton(title: "Enregistrer", disabled: key.trimmingCharacters(in: .whitespaces).isEmpty) {
                    VaultStore.set(key, VaultStore.parse(value, type: type), type: type)
                    onSave()
                    dismiss()
                }
            }
            .padding(.top, 8)
        }
        .presentationDetents([.medium, .large])
        .onAppear {
            guard let e = entry else { return }
            key = e.key
            type = ["text", "number", "bool", "list", "dict"].contains(e.type) ? e.type : "text"
            if case .array(let a) = e.value { value = a.map(\.display).joined(separator: ", ") }
            else if case .object = e.value, let d = try? JSONSerialization.data(withJSONObject: e.value.any, options: .prettyPrinted) {
                value = String(data: d, encoding: .utf8) ?? ""
            } else { value = e.value.display }
        }
    }

    private func field(_ placeholder: LocalizedStringKey, text: Binding<String>) -> some View {
        TextField(placeholder, text: text)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .padding(12)
            .background(p.background, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(p.border))
    }
}

// The connected workspace shares the desktop collection editor. An ephemeral
// web view keeps the pairing token out of its disk cache and URL/history.
private struct VaultWorkspace: UIViewRepresentable {
    let server: URL
    let token: String
    let accent: String
    let theme: String

    func makeCoordinator() -> Coordinator { Coordinator(server: server) }
    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let values: [String: String] = ["token": token, "accent": accent, "theme": theme]
        let json = String(data: try! JSONSerialization.data(withJSONObject: values), encoding: .utf8)!
        let source = "const v=\(json);sessionStorage.setItem('vaultToken',v.token);localStorage.setItem('uiAccent',v.accent);localStorage.setItem('lumenTheme',v.theme);"
        config.userContentController.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.load(URLRequest(url: server.appending(path: "vault/vault.html")))
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {
        let values = ["accent": accent, "theme": theme]
        guard let data = try? JSONSerialization.data(withJSONObject: values), let json = String(data: data, encoding: .utf8) else { return }
        view.evaluateJavaScript("(()=>{const v=\(json);localStorage.setItem('uiAccent',v.accent);document.documentElement.setAttribute('data-ui-accent',v.accent);document.documentElement.setAttribute('data-dt-theme',v.theme);})()", completionHandler: nil)
    }
    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.stopLoading(); view.navigationDelegate = nil
    }
    final class Coordinator: NSObject, WKNavigationDelegate {
        let server: URL
            init(server: URL) { self.server = server }
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url, url.scheme == server.scheme, url.host == server.host, url.port == server.port,
                  url.path.hasPrefix("/vault/") else { decisionHandler(.cancel); return }
            decisionHandler(.allow)
        }
        func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
            Task {
                let result = await PinnedTrust().urlSession(URLSession.shared, didReceive: challenge)
                completionHandler(result.0, result.1)
            }
        }

    }
}
