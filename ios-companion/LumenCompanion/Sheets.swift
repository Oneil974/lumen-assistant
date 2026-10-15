import SwiftUI
import UniformTypeIdentifiers

// MARK: Tiroir des conversations

struct ConversationDrawer: View {
    @Environment(\.palette) private var p
    @EnvironmentObject private var store: ServerStore
    let client: LumenClient
    @Binding var isOpen: Bool
    let notifBadge: Int
    let onCapture: () -> Void
    let onVault: () -> Void
    var onAgents: () -> Void = {}
    let onSensors: () -> Void
    let onSettings: () -> Void
    @State private var appeared = false
    @State private var confirmDelete: Conversation?
    @State private var showServer = false

    var body: some View {
        ZStack(alignment: .leading) {
            Color.black.opacity(appeared ? 0.45 : 0)
                .ignoresSafeArea()
                .onTapGesture(perform: close)

            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    HStack(spacing: 8) {
                        Text("Lumen").font(.system(size: 20, weight: .semibold)).tracking(-0.3)
                        Circle().fill(client.link == .online ? p.success : p.mutedForeground).frame(width: 8, height: 8)
                    }
                    Spacer()
                    Button(action: close) {
                        Image(systemName: "xmark").font(.system(size: 15, weight: .medium)).frame(width: 36, height: 36)
                    }
                }
                .padding(.horizontal, 8).padding(.bottom, 8)

                row("plus", "Nouvelle discussion") { client.newConversation(); close() }
                row("square.and.pencil", "Capture rapide", action: onCapture)
                row("cylinder.split.1x2", "Coffre", action: onVault)
                row("person.2", "Agents", action: onAgents)
                row("sensor.tag.radiowaves.forward", "iPhone comme capteur", action: onSensors)
                row("gearshape", "Réglages", badge: notifBadge, action: onSettings)

                SectionLabel("Récentes")
                ScrollView {
                    LazyVStack(spacing: 2) {
                        if client.conversations.isEmpty {
                            Text("Aucune conversation enregistrée.")
                                .font(.system(size: 13)).foregroundStyle(p.mutedForeground)
                                .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                        }
                        ForEach(client.conversations) { c in
                            OptionRow(title: c.title.isEmpty ? L("Discussion") : c.title,
                                      selected: c.id == client.currentConversation) {
                                client.loadConversation(c.id)
                                close()
                            }
                            .contextMenu {
                                Button(role: .destructive) { confirmDelete = c } label: { Label("Supprimer", systemImage: "trash") }
                            }
                        }
                    }
                }

                Divider().overlay(p.border).padding(.vertical, 6)
                Button { showServer = true } label: {
                    HStack(spacing: 10) {
                        if let id = client.identity { Avatar(identity: id, client: client, size: 30) }
                        VStack(alignment: .leading, spacing: 0) {
                            Text(verbatim: client.identity?.name ?? "Lumen").font(.system(size: 14, weight: .medium))
                            Text(client.server.host() ?? "").font(.system(size: 12)).foregroundStyle(p.mutedForeground)
                        }
                        Spacer()
                        Image(systemName: "chevron.up.chevron.down").font(.system(size: 12)).foregroundStyle(p.mutedForeground)
                    }
                    .padding(8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(PressStyle())
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(width: min(320, UIScreen.main.bounds.width * 0.84))
            .frame(maxHeight: .infinity, alignment: .top)
            .background(p.sidebar.ignoresSafeArea())
            .overlay(alignment: .trailing) { Rectangle().fill(p.border).frame(width: 0.5).ignoresSafeArea() }
            .offset(x: appeared ? 0 : -340)
            .gesture(DragGesture().onEnded { if $0.translation.width < -60 { close() } })
        }
        .foregroundStyle(p.foreground)
        .onAppear { withAnimation(.snappy(duration: 0.28)) { appeared = true } }
        .confirmationDialog(String(localized: "Supprimer « \(confirmDelete?.title ?? L("Discussion")) » ?"),
                            isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } }),
                            titleVisibility: .visible) {
            Button("Supprimer", role: .destructive) {
                if let c = confirmDelete { client.deleteConversation(c.id); client.toast = "Discussion supprimée" }
            }
        }
        .sheet(isPresented: $showServer) {
            NavigationStack {
                List {
                    Section {
                        Button("Changer d'adresse de Lumen") { store.current = nil }
                        Button("Réinitialiser les certificats acceptés") { store.unpinAll(); showServer = false }
                        Button("Se déconnecter de ce profil", role: .destructive) { showServer = false; client.signOut() }
                    } footer: { Text(client.server.absoluteString) }
                }
                .navigationTitle("Compte")
                .navigationBarTitleDisplayMode(.inline)
            }
            .presentationDetents([.medium])
            .themed()
        }
    }

    private func row(_ symbol: String, _ title: String, badge: Int = 0, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: symbol).font(.system(size: 15)).foregroundStyle(p.mutedForeground).frame(width: 20)
                Text(L(title)).font(.system(size: 15))
                Spacer()
                if badge > 0 { Badge(count: badge) }
            }
            .padding(.horizontal, 10).padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle())
    }

    private func close() {
        withAnimation(.snappy(duration: 0.24)) { appeared = false }
        Task { try? await Task.sleep(for: .milliseconds(240)); isOpen = false }
    }
}

// MARK: Backend & modèle

struct BackendSheet: View {
    @Environment(\.dismiss) private var dismiss
    let client: LumenClient

    var body: some View {
        let b = client.backend
        SheetScaffold(title: "Backend") {
            SectionLabel("Source d'IA")
            ForEach(b.sources.isEmpty ? [BackendSource(id: "ollama", label: "Ollama local")] : b.sources) { s in
                OptionRow(title: s.label, selected: s.id == b.source) { client.setBackend(s.id) }
            }
            if b.thinkAvailable {
                SectionLabel("Raisonnement")
                OptionRow(title: "Mode « think »", subtitle: "Le modèle réfléchit avant de répondre (modèles compatibles).",
                          selected: b.think) { client.setThink(!b.think) }
            }
            if b.source != "shortcut" {
                SectionLabel(b.modelSection)
                if b.models.isEmpty {
                    EmptyRow(text: b.source == "api" ? "Aucun modèle renvoyé par l'API (clé manquante ?)." : "Aucun modèle disponible sur ce backend.")
                }
                ForEach(b.models, id: \.self) { m in
                    OptionRow(title: b.label(for: m), selected: m == b.model) { client.setModel(m); dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

struct ModeSheet: View {
    @Environment(\.dismiss) private var dismiss
    let client: LumenClient

    var body: some View {
        let m = client.mode
        SheetScaffold(title: "Mode") {
            ForEach(m.modes) { o in
                OptionRow(title: o.label, subtitle: o.desc, selected: m.mode == o.id) { client.setMode(o.id); dismiss() }
            }
            if !m.workflows.isEmpty {
                SectionLabel("Workflows Fluxo")
                ForEach(m.workflows, id: \.self) { w in
                    OptionRow(title: w, subtitle: "Exécute ce workflow", selected: m.mode == "workflow" && m.workflow == w) {
                        client.setMode("workflow", workflow: w); dismiss()
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

struct EmptyRow: View {
    @Environment(\.palette) private var p
    let text: String
    var body: some View {
        Text(L(text)).font(.system(size: 13)).foregroundStyle(p.mutedForeground)
            .frame(maxWidth: .infinity, alignment: .leading).padding(12)
    }
}

// MARK: Réglages

struct SettingsSheet: View {
    @Environment(\.palette) private var p
    @EnvironmentObject private var store: ServerStore
    let client: LumenClient
    let speech: SpeechService
    let notifBadge: Int
    let openNotifications: () -> Void

    @AppStorage("companionAutospeak") private var localAutospeak = false
    @AppStorage("companionTheme") private var theme = ThemeChoice.dark.rawValue
    @AppStorage("uiAccent") private var accent = ""
    @State private var faceID = false
    @State private var faceIDBusy = false
    @State private var faceIDError: String?

    private var speakMode: Binding<String> {
        Binding(
            get: {
                switch (localAutospeak, client.desktopAutospeak) {
                case (true, true): "both"
                case (true, false): "phone"
                case (false, true): "desktop"
                default: "off"
                }
            },
            set: { m in
                localAutospeak = m == "phone" || m == "both"
                let desk = m == "desktop" || m == "both"
                if desk != client.desktopAutospeak { client.setDesktopAutospeak(desk) }
                if !localAutospeak { speech.stopSpeaking() }
            })
    }

    var body: some View {
        SheetScaffold(title: "Réglages") {
            SectionLabel("Lecture à voix haute")
            Segmented(items: [("off", "Aucune"), ("phone", "iPhone"), ("desktop", "Ordinateur"), ("both", "Les deux")],
                      selection: speakMode)
            HStack(spacing: 8) {
                Menu {
                    Button("Voix par défaut") { speech.voiceID = "" }
                    ForEach(speech.voices) { v in Button(v.label) { speech.voiceID = v.id } }
                } label: {
                    HStack {
                        Text(speech.voices.first { $0.id == speech.voiceID }?.label ?? "Voix par défaut")
                            .font(.system(size: 14)).lineLimit(1)
                        Spacer()
                        Image(systemName: "chevron.up.chevron.down").font(.system(size: 11))
                    }
                    .foregroundStyle(p.foreground)
                    .padding(.horizontal, 12).frame(height: 40)
                    .background(p.background, in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(p.border))
                }
                OutlineButton(title: "Test") { speech.speak("Bonjour, je suis Lumen.") }
            }
            .padding(.top, 8)
            Text("Pour une voix plus naturelle, télécharge une voix premium dans Réglages › Accessibilité › Contenu énoncé › Voix.")
                .font(.system(size: 12)).foregroundStyle(p.mutedForeground)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 4).padding(.top, 4)

            SectionLabel("Apparence")
            Segmented(items: ThemeChoice.allCases.map { ($0.rawValue, $0.label) }, selection: $theme)
            HStack(spacing: 10) {
                swatch(id: "", color: (theme == "light" ? Palette.light : Palette.dark).primary)
                ForEach(Accent.all) { a in swatch(id: a.id, color: a.color) }
            }
            .padding(.vertical, 10)

            SectionLabel("Activité")
            Button(action: openNotifications) {
                HStack {
                    Image(systemName: "bell").foregroundStyle(p.mutedForeground).frame(width: 22)
                    Text("Notifications").font(.system(size: 15))
                    Spacer()
                    if notifBadge > 0 { Badge(count: notifBadge) }
                    Image(systemName: "chevron.right").font(.system(size: 12)).foregroundStyle(p.mutedForeground)
                }
                .padding(.horizontal, 10).padding(.vertical, 11)
                .contentShape(Rectangle())
            }
            .buttonStyle(PressStyle())

            SectionLabel("Sécurité")
            Toggle(isOn: Binding(get: { faceID }, set: { on in
                faceIDError = nil
                if on {
                    faceIDBusy = true
                    Task {
                        faceIDError = await client.enableFaceID()
                        faceID = faceIDError == nil
                        faceIDBusy = false
                    }
                } else {
                    client.disableFaceID()
                    faceID = false
                }
            })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(String(localized: "Déverrouiller avec \(BiometricKey.biometryName)")).font(.system(size: 15))
                    Text("Ouvre l'accès à tes fichiers sur l'ordinateur, depuis l'iPhone ou pour Lumen XR.")
                        .font(.system(size: 12)).foregroundStyle(p.mutedForeground)
                }
            }
            .disabled(!BiometricKey.available || faceIDBusy)
            .padding(.horizontal, 10).padding(.vertical, 8)
            if let faceIDError {
                Text(L(faceIDError)).font(.system(size: 12)).foregroundStyle(p.destructive).padding(.horizontal, 10)
            }

            if client.outboxCount > 0 {
                SectionLabel("En attente")
                ForEach(client.outbox) { item in
                    HStack {
                        Image(systemName: item.kind == "capture" ? "square.and.pencil" : "clock.arrow.circlepath")
                            .foregroundStyle(p.mutedForeground).frame(width: 22)
                        Text(item.text).font(.system(size: 14)).lineLimit(2)
                        Spacer()
                        Button { client.cancelPending(item.id) } label: {
                            Image(systemName: "xmark.circle.fill").foregroundStyle(p.mutedForeground)
                        }
                    }
                    .padding(.horizontal, 10).padding(.vertical, 6)
                }
            }

            SectionLabel("Connexion")
            HStack {
                Image(systemName: "desktopcomputer").foregroundStyle(p.mutedForeground).frame(width: 22)
                Text(client.server.host() ?? "").font(.system(size: 15))
                Spacer()
                Button("Changer") { store.current = nil }.font(.system(size: 14, weight: .medium))
            }
            .padding(.horizontal, 10).padding(.vertical, 11)
            Button("Réinitialiser les certificats acceptés") { store.unpinAll() }
                .font(.system(size: 14, weight: .medium)).padding(.horizontal, 10).padding(.vertical, 6)
        }
        .presentationDetents([.large])
        .onAppear { faceID = client.faceIDEnabled }
    }

    private func swatch(id: String, color: Color) -> some View {
        Button {
            accent = id
            UISelectionFeedbackGenerator().selectionChanged()
        } label: {
            Circle().fill(color).frame(width: 26, height: 26)
                .overlay(Circle().stroke(p.foreground, lineWidth: accent == id ? 2 : 0).padding(-4))
                .overlay(Circle().stroke(p.border))
        }
        .buttonStyle(PressStyle())
        .frame(maxWidth: .infinity)
    }
}

// MARK: Notifications

struct NotificationsSheet: View {
    @Environment(\.palette) private var p
    let client: LumenClient

    var body: some View {
        SheetScaffold(title: "Notifications") {
            if !client.notifications.isEmpty {
                HStack { Spacer(); OutlineButton(title: "Tout effacer") { client.clearNotifications() } }
                    .padding(.bottom, 6)
            }
            if client.notifications.isEmpty { EmptyRow(text: "Aucune notification.") }
            ForEach(client.notifications) { n in
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(n.name).font(.system(size: 14, weight: .semibold))
                        Spacer()
                        if let d = n.date {
                            Text(d, format: .dateTime.day().month().hour().minute())
                                .font(.system(size: 12)).foregroundStyle(p.mutedForeground)
                        }
                    }
                    Text(n.output.isEmpty ? L(n.success ? "Exécuté (aucune sortie)" : "Échec sans message") : n.output)
                        .font(.system(size: 13))
                        .foregroundStyle(n.output.isEmpty ? p.mutedForeground : p.foreground)
                        .textSelection(.enabled)
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(p.card, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(n.success ? p.border : p.destructive.opacity(0.5)))
                .padding(.bottom, 6)
            }
        }
        .presentationDetents([.medium, .large])
        .onAppear { client.listNotifications() }
    }
}

// MARK: Capture rapide

struct CaptureSheet: View {
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss
    let client: LumenClient
    let toast: (String) -> Void

    @State private var text = ""
    @State private var kind = "note"
    @State private var title = ""
    @State private var draftID = UUID().uuidString
    @State private var proposal: String?
    @State private var refining = false
    @State private var refinementID = UUID()
    @State private var expanded = false
    @State private var importing = false
    @State private var status = ""
    @State private var restoring = true
    @State private var agents: [AgentRef] = []
    @State private var agent = UserDefaults.standard.string(forKey: "captureAgent") ?? ""
    @State private var when = 3_600_000
    @State private var sending = false
    @FocusState private var focused: Bool

    var body: some View {
        SheetScaffold(title: "Capture rapide") {
            Text("Capturez une idée. Retrouvez l’essentiel.")
                .font(.system(size: 14)).foregroundStyle(p.mutedForeground)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 10)
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    Button { text = text.components(separatedBy: "\n").map { line in
                        let trimmed = line.trimmingCharacters(in: .whitespaces)
                        return trimmed.isEmpty || trimmed.hasPrefix("- ") || trimmed.hasPrefix("• ") ? line : "- " + line
                    }.joined(separator: "\n") } label: { Label("Liste", systemImage: "list.bullet") }
                    Button { importing = true } label: { Label("Importer", systemImage: "doc.badge.plus") }
                    Spacer()
                    Button { expanded.toggle() } label: { Image(systemName: expanded ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right") }
                        .accessibilityLabel(expanded ? "Réduire la note" : "Agrandir la note")
                }
                .font(.system(size: 13)).buttonStyle(.bordered).tint(p.foreground)
                TextField("Titre de la note", text: $title).font(.system(size: 16, weight: .medium))
                TextField("Une idée, une course, un rappel…", text: $text, axis: .vertical)
                    .font(.system(size: 16)).lineLimit(expanded ? 12...20 : 5...10).focused($focused)
                HStack {
                    Text("\(text.split(whereSeparator: { $0.isWhitespace }).count) mots")
                        .font(.system(size: 12)).foregroundStyle(p.mutedForeground)
                    Spacer()
                    Button(action: refine) { Label(refining ? "Correction…" : "Corriger avec l’IA", systemImage: "sparkles") }
                        .font(.system(size: 13)).buttonStyle(.bordered).tint(p.foreground)
                        .disabled(refining || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending)
                }
            }
            .padding(12).background(p.card, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(p.border))
            .disabled(sending)
            if let proposal {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Proposition de correction").font(.system(size: 14, weight: .medium))
                    Text(proposal).font(.system(size: 14)).textSelection(.enabled)
                    HStack {
                        Button("Appliquer") { text = proposal; self.proposal = nil; status = "Correction appliquée au brouillon." }
                        Button("Garder l’original") { self.proposal = nil }
                    }.buttonStyle(.bordered).tint(p.foreground)
                }
                .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                .background(p.card, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(p.border))
                .padding(.top, 8)
                .disabled(sending)
            }
            Text(status.isEmpty ? "Brouillon conservé sur cet appareil. Les notes sont enregistrées dans la messagerie." : status)
                .font(.system(size: 12)).foregroundStyle(p.mutedForeground)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 8)
                .accessibilityAddTraits(.updatesFrequently)
            Segmented(items: [("note", "Note"), ("task", "Agent"), ("reminder", "Rappel"), ("card", "Tableau")], selection: $kind)
                .padding(.vertical, 10)
                .disabled(sending)
            if kind == "task" {
                picker("Quel agent s'en charge ?") {
                    Picker("", selection: $agent) {
                        if agents.isEmpty { Text("Aucun agent").tag("") }
                        ForEach(agents) { Text($0.name).tag($0.id) }
                    }
                }
                if let selected = agents.first(where: { $0.id == agent }) {
                    HStack(spacing: 10) {
                        if let avatar = client.agentFace(agent) { AgentAvatarView(avatar: avatar, size: 36, hands: false) }
                        Text(selected.name).font(.system(size: 14, weight: .medium))
                        Spacer()
                    }
                    .padding(10).background(p.card, in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(p.border))
                }
            }
            if kind == "reminder" {
                picker("Dans combien de temps ?") {
                    Picker("", selection: $when) {
                        Text("1 heure").tag(3_600_000)
                        Text("3 heures").tag(10_800_000)
                        Text("Demain").tag(86_400_000)
                        Text("La semaine prochaine").tag(604_800_000)
                    }
                }
            }
            PrimaryButton(title: kind == "task" && agents.isEmpty ? "Aucun agent disponible" : "Enregistrer",
                          disabled: text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending || (kind == "task" && agents.isEmpty),
                          action: save)
                .padding(.top, 12)
        }
        .presentationDetents([.large])
        .fileImporter(isPresented: $importing, allowedContentTypes: [.plainText], allowsMultipleSelection: false) { result in
            do {
                guard let url = try result.get().first else { return }
                let accessed = url.startAccessingSecurityScopedResource()
                defer { if accessed { url.stopAccessingSecurityScopedResource() } }
                let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                guard size <= 256 * 1024 else { status = "Texte trop volumineux (256 Ko max)."; return }
                let imported = try String(contentsOf: url, encoding: .utf8)
                guard !imported.contains("\0") else { status = "Ce fichier n’est pas un texte."; return }
                text += (text.isEmpty ? "" : "\n\n") + imported
                if title.isEmpty { title = String(url.deletingPathExtension().lastPathComponent.prefix(120)) }
            } catch { status = error.localizedDescription }
        }
        .onChange(of: text) { _, _ in proposal = nil; persistDraft() }
        .onChange(of: title) { _, _ in persistDraft() }
        .onChange(of: kind) { _, _ in persistDraft() }
        .onChange(of: agent) { _, _ in persistDraft() }
        .onChange(of: when) { _, _ in persistDraft() }
        .task {
            if let draft = UserDefaults.standard.dictionary(forKey: draftKey) {
                text = draft["text"] as? String ?? ""
                title = draft["title"] as? String ?? ""
                kind = draft["kind"] as? String ?? "note"
                agent = draft["agent"] as? String ?? agent
                when = draft["when"] as? Int ?? when
                draftID = draft["id"] as? String ?? draftID
            }
            restoring = false
            focused = true
            await client.refreshAgentFaces(force: true)
            if let r = try? await client.api("agents/list") {
                agents = r.arr("items").map { AgentRef(id: $0.str("id"), name: $0.str("name").isEmpty ? $0.str("id") : $0.str("name")) }
            }
            if !agents.contains(where: { $0.id == agent }) { agent = agents.first?.id ?? "" }
        }
    }

    private var draftKey: String { "captureDraft:\(client.server.absoluteString):\(client.identity?.id ?? client.identity?.name ?? "local")" }

    private func persistDraft() {
        guard !restoring && !sending else { return }
        if let draft = UserDefaults.standard.dictionary(forKey: draftKey),
           draft["text"] as? String == text, draft["title"] as? String == title,
           draft["kind"] as? String == kind, draft["agent"] as? String == agent,
           draft["when"] as? Int == when { return }
        draftID = UUID().uuidString
        UserDefaults.standard.set(["id": draftID, "text": text, "title": title, "kind": kind, "agent": agent, "when": when], forKey: draftKey)
    }

    private func refine() {
        let original = text
        let request = UUID()
        refinementID = request
        refining = true
        status = "Correction en cours…"
        Task { @MainActor in
            defer { if refinementID == request { refining = false } }
            do {
                let result = try await client.api("sc/text", body: ["text": original, "action": "proofread"])
                guard refinementID == request else { return }
                guard !sending else { return }
                guard text == original else { status = "La note a changé. Relancez la correction."; return }
                let corrected = (result?.str("text") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                guard !corrected.isEmpty else { status = "Aucune correction reçue."; return }
                proposal = corrected
                status = "Relisez la proposition avant de l’appliquer."
            } catch { if refinementID == request { status = error.localizedDescription } }
        }
    }

    private func picker<C: View>(_ label: String, @ViewBuilder _ c: () -> C) -> some View {
        HStack {
            Text(label).font(.system(size: 14)).foregroundStyle(p.mutedForeground)
            Spacer()
            c().pickerStyle(.menu).tint(p.foreground)
        }
        .padding(.horizontal, 4)
    }

    private func save() {
        let content = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let heading = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty && !sending else { return }
        let destination = kind
        let savedDraftKey = draftKey
        var payload: JSON = ["kind": kind, "text": heading.isEmpty ? content : "\(heading)\n\n\(content)", "id": draftID]
        if kind == "reminder" { payload["due_in_ms"] = when }
        if kind == "task" {
            payload["agent"] = agent
            UserDefaults.standard.set(agent, forKey: "captureAgent")
        }
        sending = true
        Task {
            do {
                _ = try await client.api("capture", body: payload)
                UserDefaults.standard.removeObject(forKey: savedDraftKey)
                let name = agents.first { $0.id == agent }?.name ?? "l'agent"
                toast(destination == "reminder" ? L("Rappel programmé") : destination == "card" ? L("Carte ajoutée") : destination == "note" ? L("Note enregistrée dans la messagerie") : String(localized: "Tâche ajoutée à \(name)"))
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                dismiss()
            } catch let e as URLError {
                // Ordinateur injoignable : la capture attend la reconnexion.
                _ = e
                client.enqueue(.init(id: UUID(uuidString: payload.str("id")) ?? UUID(), kind: "capture", text: payload.str("text"),
                                     capture: payload.mapValues { "\($0)" }, date: .now))
                UserDefaults.standard.removeObject(forKey: savedDraftKey)
                dismiss()
            } catch {
                toast(error.localizedDescription.isEmpty ? "Capture impossible" : error.localizedDescription)
            }
            sending = false
        }
    }
}

// MARK: Agents

/// Activité des agents (approbations, en cours, derniers runs) : onglet
/// « Activité » de la feuille Agents.
struct AgentsActivity: View {
    @Environment(\.palette) private var p
    let client: LumenClient
    let toast: (String) -> Void
    @State private var activity: AgentActivity?
    @State private var failed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let a = activity {
                if a.approvals.isEmpty && a.tasks.isEmpty && a.runs.isEmpty {
                    EmptyRow(text: "Aucune activité pour l'instant.")
                }
                if !a.approvals.isEmpty {
                    SectionLabel("À décider")
                    ForEach(a.approvals) { ap in
                        card {
                            HStack {
                                who(ap.agent)
                                Spacer()
                                Text(ap.risk).font(.system(size: 11, weight: .semibold))
                                    .padding(.horizontal, 7).padding(.vertical, 2)
                                    .foregroundStyle(ap.risk == "high" ? p.destructive : p.mutedForeground)
                                    .background(p.muted, in: Capsule())
                            }
                            (Text("veut utiliser ") + Text(ap.tool).font(.system(size: 13, design: .monospaced)))
                                .font(.system(size: 13))
                            if !ap.reason.isEmpty {
                                Text(ap.reason).font(.system(size: 12)).foregroundStyle(p.mutedForeground)
                            }
                            HStack(spacing: 8) {
                                OutlineButton(title: "Refuser") { decide(ap, false) }
                                PrimaryButton(title: "Approuver") { decide(ap, true) }
                            }
                            .padding(.top, 4)
                        }
                    }
                }
                if !a.tasks.isEmpty {
                    SectionLabel("En cours")
                    ForEach(a.tasks) { line($0) }
                }
                if !a.runs.isEmpty {
                    SectionLabel("Derniers runs")
                    ForEach(a.runs) { line($0) }
                }
            } else if failed {
                EmptyRow(text: "Activité indisponible.")
            } else {
                ProgressView().frame(maxWidth: .infinity).padding(30)
            }
        }
        .task {
            // Une approbation peut arriver pendant qu'on regarde : 5 s, comme la PWA.
            while !Task.isCancelled {
                await refresh()
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    /// Personnage + nom de l'agent (repli : l'identifiant).
    @ViewBuilder private func who(_ ref: String) -> some View {
        HStack(spacing: 8) {
            if let face = client.agentFace(ref) { AgentAvatarView(avatar: face, size: 28, hands: false) }
            Text(client.agentFaces[ref]?.name ?? ref).font(.system(size: 14, weight: .semibold))
        }
    }

    private func refresh() async {
        await client.refreshAgentFaces()
        do {
            if let j = try await client.api("agents/activity") { activity = AgentActivity(j) }
            failed = false
        } catch { failed = activity == nil }
    }

    private func decide(_ ap: AgentActivity.Approval, _ approve: Bool) {
        Task {
            do {
                let out = try await client.api("agents/approve", body: ["approval_id": ap.id, "approve": approve])
                toast((out?["ok"] as? Bool) == true ? (approve ? "Approuvé" : "Refusé") : "Demande déjà traitée")
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            } catch { toast("Décision impossible") }
            await refresh()
        }
    }

    private func line(_ l: AgentActivity.Line) -> some View {
        card {
            HStack {
                who(l.agent)
                Spacer()
                Text(L(AgentActivity.label(l.status))).font(.system(size: 12)).foregroundStyle(p.mutedForeground)
            }
            if !l.text.isEmpty { Text(l.text).font(.system(size: 13)) }
            if !l.error.isEmpty { Text(l.error).font(.system(size: 12)).foregroundStyle(p.mutedForeground) }
        }
    }

    private func card<C: View>(@ViewBuilder _ c: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 6) { c() }
            .lumenCard(radius: 16)
            .padding(.bottom, 6)
    }
}
