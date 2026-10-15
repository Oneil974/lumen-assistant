import PhotosUI
import SwiftUI

// Messages : parler à Lumen et à ses agents comme dans une messagerie (façon
// Messenger). Même moteur et mêmes fils que le compagnon web et le bureau
// (src-tauri/src/messenger.rs) : la liste des discussions, un contact par fil
// (Lumen ou un agent avec son avatar), des bulles, les appels d'outils en
// pastilles, la coupure de contexte et les photos.

struct MxContact: Identifiable, Hashable {
    let id: String
    let name: String
    let description: String
    let avatar: AgentAvatar?
    /// Voix propre de l'agent (« local:<id> » Piper/Kokoro de l'ordinateur,
    /// « system:<nom> »), vide pour Lumen : le mode vocal la respecte.
    let voice: String

    init(_ j: JSON) {
        id = j.str("id"); name = j.str("name"); description = j.str("description"); voice = j.str("voice")
        avatar = id.isEmpty ? nil : AgentAvatar(j["avatar"] as? [String: Any], seed: id)
    }
}

struct MxThreadRow: Identifiable, Hashable {
    let id: String, title: String, contact: String, preview: String, previewRole: String
    let updated: Double, unread: Int, pinned: Bool, busy: Bool
    init(_ j: JSON) {
        id = j.str("id"); title = j.str("title"); contact = j.str("contact"); preview = j.str("preview")
        previewRole = j.str("preview_role"); updated = j.double("updated") ?? 0
        unread = (j["unread"] as? Int) ?? 0; pinned = j.bool("pinned"); busy = j.bool("busy")
    }
}

struct MxMessage: Identifiable, Hashable {
    let id: String, role: String, text: String, from: String
    let toolName: String, toolArgs: String, toolResult: String, toolOk: Bool, toolRunning: Bool
    let fileId: String, fileName: String, fileMime: String
    init(_ j: JSON) {
        id = j.str("id"); role = j.str("role"); text = j.str("text"); from = j.str("from")
        let t = j.obj("tool") ?? [:]
        toolName = t.str("name"); toolResult = t.str("result"); toolOk = t.bool("ok"); toolRunning = t.bool("running")
        toolArgs = (t["args"] as? JSON).flatMap { try? JSONSerialization.data(withJSONObject: $0) }.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        let f = j.obj("file") ?? [:]
        fileId = f.str("id"); fileName = f.str("name"); fileMime = f.str("mime")
    }
}

@MainActor
@Observable
final class MessengerModel {
    var contacts: [MxContact] = []
    var threads: [MxThreadRow] = []
    var readOnly = false
    var loaded = false

    func contact(_ id: String) -> MxContact {
        contacts.first { $0.id == id } ?? MxContact(["id": id, "name": id.isEmpty ? "Lumen" : L("Agent")])
    }

    func refresh(_ client: LumenClient) async {
        async let c = try? client.api("messenger/contacts")
        async let t = try? client.api("messenger/threads")
        let (cj, tj) = await (c, t)
        if let cj { contacts = cj.arr("items").map(MxContact.init) }
        if let tj {
            threads = tj.arr("items").map(MxThreadRow.init)
            readOnly = (tj["active"] as? Bool) == false
        }
        loaded = true
    }
}

/// Visage d'un contact : l'orbe de Lumen ou le personnage de l'agent.
struct MxFace: View {
    let contact: MxContact
    var size: CGFloat = 44
    var working = false

    var body: some View {
        if let av = contact.avatar {
            AgentAvatarView(avatar: av, size: size * 0.92, state: working ? .work : .idle, hands: size >= 44)
                .frame(width: size, height: size)
                .background(av.tint.opacity(0.14), in: Circle())
        } else {
            ZStack {
                Circle().fill(AngularGradient(colors: [Color(hex: 0x7C6CF0), Color(hex: 0x46C2FF), Color(hex: 0x56E0A8), Color(hex: 0xFF8AC2), Color(hex: 0x7C6CF0)], center: .center))
                HStack(spacing: size * 0.12) {
                    Capsule().fill(.white).frame(width: size * 0.1, height: size * 0.26)
                    Capsule().fill(.white).frame(width: size * 0.1, height: size * 0.26)
                }
            }
            .frame(width: size, height: size)
        }
    }
}

struct MessengerView: View {
    @Environment(\.palette) private var p
    let client: LumenClient
    let speech: SpeechService
    /// Retour au mode classique (nil : pas de bouton).
    var onExit: (() -> Void)?
    @State private var model = MessengerModel()
    @State private var path: [String] = []
    @State private var search = ""

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    header
                    searchField
                    people
                    if model.loaded && filtered.isEmpty {
                        VStack(spacing: 4) {
                            Text("Aucune discussion pour l'instant.").font(.system(size: 15, weight: .semibold))
                            Text("Choisis Lumen ou un agent ci-dessus pour commencer.").font(.system(size: 13)).foregroundStyle(p.mutedForeground)
                        }
                        .frame(maxWidth: .infinity).padding(.vertical, 40)
                    }
                    LazyVStack(spacing: 0) {
                        ForEach(filtered) { t in
                            NavigationLink(value: t.id) { row(t) }.buttonStyle(PressStyle())
                                .contextMenu {
                                    Button(t.pinned ? "Désépingler" : "Épingler", systemImage: "pin") {
                                        Task { _ = try? await client.api("messenger/update", body: ["thread": t.id, "pinned": !t.pinned]); await model.refresh(client) }
                                    }
                                    Button("Supprimer", systemImage: "trash", role: .destructive) {
                                        Task { _ = try? await client.api("messenger/delete", body: ["thread": t.id]); await model.refresh(client) }
                                    }
                                }
                        }
                    }
                    .padding(.horizontal, 6)
                }
                .padding(.bottom, 30)
            }
            .refreshable { await model.refresh(client) }
            .background(p.background.ignoresSafeArea())
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: String.self) { id in
                MessengerThreadView(client: client, speech: speech, model: model, threadId: id)
            }
        }
        .foregroundStyle(p.foreground)
        .task { await model.refresh(client) }
        .onChange(of: client.messengerTick) { _, _ in
            // La liste suit tout ; le fil ouvert gère lui-même ses messages.
            Task { await model.refresh(client) }
        }
        .onOpenURL { url in
            // lumen://messages/<fil> (notification)
            if url.host() == "messages", let id = url.pathComponents.dropFirst().first { path = [id] }
        }
    }

    private var filtered: [MxThreadRow] {
        let q = search.lowercased()
        guard !q.isEmpty else { return model.threads }
        return model.threads.filter { "\($0.title) \(model.contact($0.contact).name) \($0.preview)".lowercased().contains(q) }
    }

    private var header: some View {
        HStack(spacing: 10) {
            if let onExit {
                Button(action: onExit) {
                    Image(systemName: "xmark").font(.system(size: 14, weight: .semibold))
                        .frame(width: 36, height: 36).background(p.muted, in: Circle())
                }
                .accessibilityLabel("Mode classique")
            }
            Text("Messages").font(.system(size: 30, weight: .heavy)).tracking(-0.6)
            Spacer()
            Menu {
                ForEach(model.contacts) { c in
                    Button(c.name) { start(c) }
                }
            } label: {
                Image(systemName: "square.and.pencil").font(.system(size: 16, weight: .semibold))
                    .frame(width: 36, height: 36).background(p.muted, in: Circle())
            }
            .accessibilityLabel("Nouvelle discussion")
        }
        .padding(.horizontal, 14).padding(.top, 14).padding(.bottom, 8)
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(p.mutedForeground)
            TextField("Rechercher", text: $search)
        }
        .padding(.horizontal, 12).frame(height: 38)
        .background(p.muted, in: Capsule())
        .padding(.horizontal, 14)
    }

    private var people: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 14) {
                ForEach(model.contacts) { c in
                    Button { start(c) } label: {
                        VStack(spacing: 6) {
                            MxFace(contact: c, size: 58)
                            Text(c.name).font(.system(size: 12)).lineLimit(1).frame(maxWidth: 66)
                        }
                    }
                    .buttonStyle(PressStyle())
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 12)
        }
    }

    private func row(_ t: MxThreadRow) -> some View {
        let c = model.contact(t.contact)
        return HStack(spacing: 12) {
            MxFace(contact: c, size: 52, working: t.busy)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text(t.title.isEmpty ? c.name : t.title).font(.system(size: 15, weight: t.unread > 0 ? .bold : .semibold)).lineLimit(1)
                    if t.pinned { Image(systemName: "pin.fill").font(.system(size: 10)).foregroundStyle(p.mutedForeground) }
                    Spacer(minLength: 4)
                    Text(Self.when(t.updated)).font(.system(size: 12)).foregroundStyle(p.mutedForeground)
                }
                if t.busy {
                    Text("\(c.name) écrit…").font(.system(size: 13.5)).foregroundStyle(p.primary)
                } else {
                    Text((t.previewRole == "user" ? L("Vous : ") : "") + t.preview)
                        .font(.system(size: 13.5, weight: t.unread > 0 ? .semibold : .regular))
                        .foregroundStyle(t.unread > 0 ? p.foreground : p.mutedForeground).lineLimit(1)
                }
            }
            if t.unread > 0 {
                Text("\(t.unread)").font(.system(size: 12, weight: .bold)).foregroundStyle(p.primaryForeground)
                    .padding(.horizontal, 7).frame(minWidth: 20, minHeight: 20).background(p.primary, in: Capsule())
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 8)
        .contentShape(Rectangle())
    }

    static func when(_ ms: Double) -> String {
        guard ms > 0 else { return "" }
        let d = Date(timeIntervalSince1970: ms / 1000)
        if Date.now.timeIntervalSince(d) < 60 { return L("à l'instant") }
        if Calendar.current.isDateInToday(d) { return d.formatted(date: .omitted, time: .shortened) }
        if Calendar.current.isDateInYesterday(d) { return L("hier") }
        return d.formatted(.dateTime.day().month(.abbreviated))
    }

    private func start(_ c: MxContact) {
        Task {
            if let j = try? await client.api("messenger/new", body: ["contact": c.id]), let t = j.obj("data") {
                await model.refresh(client)
                path = [t.str("id")]
            }
        }
    }
}

// MARK: - Fil de discussion

struct MessengerThreadView: View {
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var back
    let client: LumenClient
    let speech: SpeechService
    let model: MessengerModel
    let threadId: String
    @State private var title = ""
    @State private var contactId = ""
    @State private var pinned = false
    @State private var messages: [MxMessage] = []
    @State private var busy = false
    @State private var draft = ""
    @State private var photos: [PhotosPickerItem] = []
    @State private var images: [UIImage] = []
    @State private var renaming = false
    @State private var confirmDelete = false
    @State private var error: String?
    @FocusState private var focused: Bool
    // Mode vocal (façon ChatGPT) : écoute → envoi → réponse lue → réécoute.
    // Bouton orchestré : FORCE l'orchestration (sinon le routeur décide).
    @State private var orchestrate = false
    // Menu « @ » : outils de Lumen / de l'agent, chargés à la demande.
    @State private var tools: [(name: String, desc: String)] = []
    @State private var toolsLoaded = false
    @State private var voiceOn = false
    @State private var voicePhase: VoicePhase = .listening
    @State private var voiceCaption = ""
    @State private var voiceMuted = false
    @State private var voiceAwaiting = false
    @State private var voiceStart = 0
    @State private var voiceRetries = 0
    @State private var savedSpeakingDone: (() -> Void)?

    private var contact: MxContact { model.contact(contactId) }
    private var starters: [String] {
        contactId.isEmpty
            ? [L("Quel temps fait-il ?"), L("Qu'ai-je au programme aujourd'hui ?"), L("Résume mes derniers mails"), L("Rappelle-moi d'appeler Léa demain à 10 h")]
            : [L("Que sais-tu faire ?"), L("Au travail !"), L("Fais le point")]
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 3) {
                        ForEach(Array(messages.enumerated()), id: \.element.id) { i, m in
                            line(m, next: i + 1 < messages.count ? messages[i + 1] : nil).id(m.id)
                        }
                        if busy { typing.id("typing") }
                    }
                    .padding(.horizontal, 10).padding(.vertical, 10)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: messages.count) { _, _ in scrollDown(proxy) }
                .onChange(of: busy) { _, _ in scrollDown(proxy) }
                .onAppear { scrollDown(proxy, animated: false) }
            }
            if !model.readOnly && !messages.contains(where: { $0.role == "user" }) { startersBar }
            composer
        }
        .background(p.background.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .task { await load() }
        .onChange(of: client.messengerTick) { _, _ in apply(client.messengerEvent) }
        .fullScreenCover(isPresented: $voiceOn, onDismiss: endVoice) { voiceScreen }
        // La reconnaissance s'est arrêtée sans phrase (silence, erreur) : on
        // se remet à écouter tant que le mode vocal est ouvert.
        .onChange(of: speech.listening) { _, on in
            guard !on, voiceOn, voicePhase == .listening, !voiceMuted, !voiceAwaiting else { return }
            Task { try? await Task.sleep(for: .milliseconds(400)); if voiceOn && voicePhase == .listening && !speech.listening { voiceListen() } }
        }
        .onChange(of: photos) { _, items in
            Task {
                for item in items.prefix(4) {
                    if let data = try? await item.loadTransferable(type: Data.self), let img = UIImage(data: data) { images.append(img) }
                }
                photos = []
            }
        }
        .alert("Nom de la discussion", isPresented: $renaming) {
            TextField("Nom", text: $title)
            Button("OK") { Task { _ = try? await client.api("messenger/update", body: ["thread": threadId, "title": title]) } }
            Button("Annuler", role: .cancel) {}
        }
        .confirmationDialog("Supprimer cette discussion ?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Supprimer", role: .destructive) {
                Task { _ = try? await client.api("messenger/delete", body: ["thread": threadId]); back() }
            }
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Button { back() } label: {
                Image(systemName: "chevron.left").font(.system(size: 15, weight: .semibold))
                    .frame(width: 36, height: 36).background(p.muted, in: Circle())
            }
            .buttonStyle(PressStyle())
            MxFace(contact: contact, size: 38, working: busy)
            VStack(alignment: .leading, spacing: 0) {
                Text(title.isEmpty ? contact.name : title).font(.system(size: 16, weight: .semibold)).lineLimit(1)
                Text(busy ? "\(contact.name) écrit…" : (contactId.isEmpty ? L("Assistant") : contact.name))
                    .font(.system(size: 12)).foregroundStyle(busy ? p.primary : p.mutedForeground).lineLimit(1)
            }
            Spacer()
            Button { toggleOrchestrate() } label: {
                Image(systemName: "list.bullet.clipboard").font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(orchestrate ? p.primaryForeground : p.foreground)
                    .frame(width: 36, height: 36).background(orchestrate ? p.primary : p.muted, in: Circle())
            }
            .accessibilityLabel(orchestrate ? L("Réponse orchestrée forcée") : L("Forcer la réponse orchestrée"))
            Button { cut() } label: {
                Image(systemName: "scissors").font(.system(size: 15, weight: .semibold))
                    .frame(width: 36, height: 36).background(p.muted, in: Circle())
            }
            .accessibilityLabel("Couper le contexte")
            Menu {
                Button("Couper le contexte", systemImage: "scissors") { cut() }
                Button("Renommer", systemImage: "pencil") { renaming = true }
                Button(pinned ? "Désépingler" : "Épingler", systemImage: "pin") {
                    pinned.toggle()
                    Task { _ = try? await client.api("messenger/update", body: ["thread": threadId, "pinned": pinned]) }
                }
                Button("Supprimer la discussion", systemImage: "trash", role: .destructive) { confirmDelete = true }
            } label: {
                Image(systemName: "ellipsis").font(.system(size: 15, weight: .semibold))
                    .frame(width: 36, height: 36).background(p.muted, in: Circle())
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(.bar)
        .overlay(alignment: .bottom) { Rectangle().fill(p.border).frame(height: 0.5) }
    }

    // MARK: Messages

    @ViewBuilder private func line(_ m: MxMessage, next: MxMessage?) -> some View {
        let lastOfGroup = next == nil || next?.role == "user" || next?.role == "cut" || next?.from != m.from
        switch m.role {
        case "cut":
            HStack(spacing: 8) {
                Rectangle().fill(p.border).frame(height: 1)
                Label("Contexte coupé — la suite repart de zéro", systemImage: "scissors")
                    .font(.system(size: 11.5)).foregroundStyle(p.mutedForeground).fixedSize()
                Rectangle().fill(p.border).frame(height: 1)
            }
            .padding(.vertical, 12)
        case "user":
            HStack {
                Spacer(minLength: 50)
                Text(inline(m.text))
                    .padding(.horizontal, 13).padding(.vertical, 8)
                    .foregroundStyle(p.primaryForeground)
                    .background(p.primary, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            }
            .padding(.top, 6)
        case "tool":
            HStack(alignment: .bottom, spacing: 7) {
                Color.clear.frame(width: 28, height: 1)
                ToolPill(message: m)
                Spacer(minLength: 40)
            }
        case "file":
            HStack(alignment: .bottom, spacing: 7) {
                if m.from == "me" { Spacer(minLength: 50) } else { faceSlot(lastOfGroup) }
                MxAttachment(client: client, message: m)
                if m.from != "me" { Spacer(minLength: 50) }
            }
        case "error":
            HStack(alignment: .bottom, spacing: 7) {
                faceSlot(false)
                Label(m.text, systemImage: "exclamationmark.triangle")
                    .font(.system(size: 14)).foregroundStyle(p.destructive)
                    .padding(.horizontal, 13).padding(.vertical, 8)
                    .background(p.destructive.opacity(0.1), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                Spacer(minLength: 40)
            }
        default:
            HStack(alignment: .bottom, spacing: 7) {
                faceSlot(lastOfGroup)
                Text(inline(m.text))
                    .textSelection(.enabled)
                    .padding(.horizontal, 13).padding(.vertical, 8)
                    .background(p.muted, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                Spacer(minLength: 40)
            }
        }
    }

    @ViewBuilder private func faceSlot(_ show: Bool) -> some View {
        if show { MxFace(contact: contact, size: 28) } else { Color.clear.frame(width: 28, height: 1) }
    }

    private var typing: some View {
        HStack(alignment: .bottom, spacing: 7) {
            MxFace(contact: contact, size: 28, working: true)
            MxTypingDots(color: p.mutedForeground)
                .padding(.horizontal, 14).padding(.vertical, 12)
                .background(p.muted, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            Spacer()
        }
    }

    /// Markdown en ligne (gras, italique, liens) ; les listes gardent leurs puces.
    private func inline(_ s: String) -> AttributedString {
        let prepared = s.replacingOccurrences(of: "\n- ", with: "\n• ").replacingOccurrences(of: "\n* ", with: "\n• ")
        return (try? AttributedString(markdown: prepared, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }

    private var startersBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(starters, id: \.self) { s in
                    Button { send(s) } label: {
                        Text(s).font(.system(size: 13.5)).padding(.horizontal, 12).padding(.vertical, 7)
                            .overlay(Capsule().stroke(p.border))
                    }
                    .buttonStyle(PressStyle())
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 6)
        }
    }

    private var composer: some View {
        VStack(spacing: 6) {
            if !atMatches.isEmpty { atMenu }
            if let error { Text(error).font(.system(size: 12)).foregroundStyle(p.destructive) }
            if !images.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(Array(images.enumerated()), id: \.offset) { i, img in
                            Image(uiImage: img).resizable().scaledToFill().frame(width: 56, height: 56)
                                .clipShape(RoundedRectangle(cornerRadius: 12))
                                .overlay(alignment: .topTrailing) {
                                    Button { images.remove(at: i) } label: {
                                        Image(systemName: "xmark.circle.fill").foregroundStyle(.white, .black.opacity(0.6))
                                    }
                                    .offset(x: 5, y: -5)
                                }
                        }
                    }
                    .padding(.horizontal, 12).padding(.top, 6)
                }
            }
            HStack(alignment: .bottom, spacing: 8) {
                PhotosPicker(selection: $photos, maxSelectionCount: 4, matching: .images) {
                    Image(systemName: "photo").font(.system(size: 18))
                        .frame(width: 38, height: 38).background(p.muted, in: Circle())
                }
                .disabled(model.readOnly)
                TextField(model.readOnly ? L("Une autre session est ouverte sur l'ordinateur") : L("Message"), text: $draft, axis: .vertical)
                    .lineLimit(1...6)
                    .focused($focused)
                    .onChange(of: draft) { _, d in if d.contains("@") && !toolsLoaded { loadTools() } }
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .background(p.muted, in: RoundedRectangle(cornerRadius: 21, style: .continuous))
                    .disabled(model.readOnly)
                if !model.readOnly && draft.isEmpty && images.isEmpty && !busy {
                    Button { startVoice() } label: {
                        Image(systemName: "waveform").font(.system(size: 17, weight: .semibold))
                            .frame(width: 38, height: 38).background(p.muted, in: Circle())
                    }
                    .accessibilityLabel(L("Mode vocal"))
                }
                Button { busy ? stop() : send(draft) } label: {
                    Image(systemName: busy ? "stop.fill" : "arrow.up")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(busy ? p.background : p.primaryForeground)
                        .frame(width: 38, height: 38)
                        .background(busy ? p.foreground : p.primary, in: Circle())
                }
                .disabled(model.readOnly || (!busy && draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && images.isEmpty))
                .accessibilityLabel(busy ? "Arrêter" : "Envoyer")
            }
            .padding(.horizontal, 10).padding(.bottom, 8)
        }
        .padding(.top, 6)
        .background(.bar)
        .overlay(alignment: .top) { Rectangle().fill(p.border).frame(height: 0.5) }
    }

    // MARK: Actions

    private func scrollDown(_ proxy: ScrollViewProxy, animated: Bool = true) {
        let target: String? = busy ? "typing" : messages.last?.id
        guard let target else { return }
        if animated { withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(target, anchor: .bottom) } }
        else { proxy.scrollTo(target, anchor: .bottom) }
    }

    private func load() async {
        // Le contact est connu dès la liste : sans ça, le fil s'affichait (et
        // parlait) comme Lumen tant que le détail n'était pas arrivé — ou pour
        // de bon si la requête échouait.
        if contactId.isEmpty, let row = model.threads.first(where: { $0.id == threadId }) {
            contactId = row.contact; if title.isEmpty { title = row.title }
        }
        var fetched: JSON?
        for attempt in 0..<3 {
            if let j = try? await client.api("messenger/thread/\(threadId)"), let t = j.obj("data") { fetched = t; break }
            try? await Task.sleep(for: .milliseconds(400 * (attempt + 1)))
        }
        guard let t = fetched else { error = L("Impossible de charger la discussion."); return }
        title = t.str("title"); if !t.str("contact").isEmpty || contactId.isEmpty { contactId = t.str("contact") }; pinned = t.bool("pinned"); orchestrate = t.bool("orchestrate")
        messages = t.arr("messages").map(MxMessage.init)
        busy = t.bool("busy")
        _ = try? await client.api("messenger/update", body: ["thread": threadId, "read": true])
    }

    private func apply(_ ev: JSON?) {
        guard let ev, ev.str("thread") == threadId else { return }
        switch ev.str("event") {
        case "typing":
            busy = ev.bool("on")
            if !busy && voiceAwaiting { voiceReply() }
        case "message":
            guard let mj = ev.obj("message") else { return }
            let m = MxMessage(mj)
            if let i = messages.firstIndex(where: { $0.id == m.id }) { messages[i] = m } else { messages.append(m) }
            if m.role == "assistant" {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                Task { _ = try? await client.api("messenger/update", body: ["thread": threadId, "read": true]) }
            }
        default: break
        }
    }

    private func send(_ text: String) {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty || !images.isEmpty else { return }
        let payload = images.compactMap { img -> String? in
            let scaled = img.scaledDown(maxSide: 1600)
            guard let data = scaled.jpegData(compressionQuality: 0.85) else { return nil }
            return "data:image/jpeg;base64," + data.base64EncodedString()
        }
        draft = ""; images = []; error = nil
        busy = true
        Task {
            do { _ = try await client.api("messenger/send", body: ["thread": threadId, "text": body, "images": payload]) }
            catch { busy = false; self.error = error.localizedDescription }
        }
    }

    private func stop() { Task { _ = try? await client.api("messenger/stop", body: ["thread": threadId]) } }

    // MARK: Orchestration forcée & outils « @ »

    private func toggleOrchestrate() {
        orchestrate.toggle()
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        Task { _ = try? await client.api("messenger/update", body: ["thread": threadId, "orchestrate": orchestrate]) }
    }

    private func loadTools() {
        toolsLoaded = true
        Task {
            guard let j = try? await client.api("messenger/tools/\(threadId)") else { toolsLoaded = false; return }
            tools = j.arr("items").map { (name: $0.str("name"), desc: $0.str("description")) }
        }
    }

    /// Mot « @… » en cours de frappe à la fin du brouillon.
    private var atQuery: String? {
        guard let r = draft.range(of: #"(^|\s)@([\w.-]*)$"#, options: .regularExpression) else { return nil }
        let token = draft[r].trimmingCharacters(in: .whitespaces)
        return String(token.dropFirst()).lowercased()
    }

    private var atMatches: [(name: String, desc: String)] {
        guard let q = atQuery else { return [] }
        let hits = tools.filter { q.isEmpty || $0.name.lowercased().contains(q) || $0.desc.lowercased().contains(q) }
        return Array(hits.sorted { ($0.name.lowercased().hasPrefix(q) ? 0 : 1, $0.name) < ($1.name.lowercased().hasPrefix(q) ? 0 : 1, $1.name) }.prefix(20))
    }

    private func pickTool(_ name: String) {
        guard let r = draft.range(of: #"@[\w.-]*$"#, options: .regularExpression) else { return }
        draft.replaceSubrange(r, with: "@\(name) ")
        UISelectionFeedbackGenerator().selectionChanged()
    }

    private var atMenu: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(atMatches, id: \.name) { t in
                    Button { pickTool(t.name) } label: {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("@\(t.name)").font(.system(size: 14, weight: .semibold)).foregroundStyle(p.foreground)
                            if !t.desc.isEmpty {
                                Text(t.desc).font(.system(size: 12)).foregroundStyle(p.mutedForeground).lineLimit(1)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .frame(maxHeight: 210)
        .background(p.background, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(p.border, lineWidth: 0.5))
        .padding(.horizontal, 10)
    }

    // MARK: Mode vocal

    enum VoicePhase { case listening, thinking, speaking, error }

    private func startVoice() {
        focused = false
        voiceMuted = false; voiceRetries = 0; voiceCaption = ""
        savedSpeakingDone = speech.onSpeakingDone
        speech.onSpeakingDone = {
            // Fin de lecture (ou interruption) : à l'utilisateur de parler.
            if voiceOn && voicePhase == .speaking { voiceListen() }
        }
        voiceOn = true
        voiceListen()
    }

    private func voiceListen() {
        guard voiceOn else { return }
        voicePhase = .listening
        voiceCaption = ""
        guard !voiceMuted else { return }
        if speech.listening { speech.stopDictation() }
        Task {
            let err = await speech.toggleDictation(onText: { voiceCaption = $0 }, onFinal: { voiceHeard($0) })
            if let err {
                voicePhase = .error; voiceCaption = L(err)
                voiceRetries += 1
                if voiceRetries < 3 { try? await Task.sleep(for: .seconds(2)); if voiceOn && voicePhase == .error { voiceListen() } }
            }
        }
    }

    private func voiceHeard(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard voiceOn, !t.isEmpty else { voiceListen(); return }
        voiceRetries = 0
        voicePhase = .thinking
        voiceCaption = t
        voiceStart = messages.count
        voiceAwaiting = true
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        if busy { stop() }
        send(t)
        // Envoi refusé (erreur réseau) : pas de « écrit… » à attendre.
        Task { try? await Task.sleep(for: .seconds(1)); if voiceAwaiting && !busy && error != nil { voiceReply() } }
    }

    private func voiceReply() {
        voiceAwaiting = false
        guard voiceOn else { return }
        let reply = messages.dropFirst(min(voiceStart, messages.count))
            .filter { $0.role == "assistant" || $0.role == "error" }
            .map(\.text).joined(separator: "\n\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !reply.isEmpty else { voiceListen(); return }
        voicePhase = .speaking
        voiceCaption = reply.count > 280 ? String(reply.prefix(280)) + "…" : reply
        let voice = contact.voice
        Task {
            // Voix de l'agent : Piper/Kokoro → WAV produit par l'ordinateur ;
            // voix système → même nom sur l'iPhone ; sinon voix réglée.
            if !voice.hasPrefix("system:"), let wav = await client.messengerVoice(text: reply, voice: voice),
               voiceOn, voicePhase == .speaking, await speech.play(wav: wav) { return }
            guard voiceOn, voicePhase == .speaking else { return }
            if voice.hasPrefix("system:") { speech.speak(reply, voiceName: String(voice.dropFirst(7))) }
            else { speech.speak(reply) }
        }
    }

    private func voiceTap() {
        switch voicePhase {
        case .speaking: speech.stopSpeaking()                 // → onSpeakingDone → écoute
        case .listening:
            // Fin de phrase anticipée.
            let heard = speech.partial
            speech.stopDictation()
            if !heard.isEmpty { voiceHeard(heard) }
        case .thinking: stop()
        case .error: voiceRetries = 0; voiceListen()
        }
    }

    private func toggleVoiceMute() {
        voiceMuted.toggle()
        if voiceMuted { speech.stopDictation(); voicePhase = .listening }
        else if voicePhase == .listening { voiceListen() }
    }

    private func endVoice() {
        guard voiceOn || voiceAwaiting || speech.listening || speech.speaking else { return }
        voiceOn = false
        voiceAwaiting = false
        speech.stopDictation()
        speech.stopSpeaking()
        speech.onSpeakingDone = savedSpeakingDone
        savedSpeakingDone = nil
    }

    private var voiceLabel: String {
        switch voicePhase {
        case .listening: return voiceMuted ? L("Micro coupé") : L("Je vous écoute…")
        case .thinking: return L("Réflexion…")
        case .speaking: return L("Touchez pour interrompre")
        case .error: return L("Micro indisponible")
        }
    }

    private var voiceScreen: some View {
        VStack(spacing: 18) {
            Text(title.isEmpty ? contact.name : title)
                .font(.system(size: 15, weight: .semibold)).foregroundStyle(p.mutedForeground)
                .padding(.top, 18)
            Spacer()
            Button { voiceTap() } label: {
                ZStack {
                    VoicePulse(phase: voicePhase, color: p.primary)
                    MxFace(contact: contact, size: 128, working: voicePhase == .thinking)
                }
                .frame(width: 230, height: 230)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(voiceLabel)
            Text(voiceLabel).font(.system(size: 18, weight: .semibold))
                .foregroundStyle(voicePhase == .error ? p.destructive : p.foreground)
            Text(voiceCaption)
                .font(.system(size: 15)).foregroundStyle(p.mutedForeground)
                .multilineTextAlignment(.center).lineLimit(6)
                .frame(minHeight: 66, alignment: .top)
                .padding(.horizontal, 28)
                .animation(.easeOut(duration: 0.15), value: voiceCaption)
            Spacer()
            HStack(spacing: 40) {
                Button { toggleVoiceMute() } label: {
                    Image(systemName: voiceMuted ? "mic.slash.fill" : "mic.fill").font(.system(size: 22, weight: .semibold))
                        .foregroundStyle(voiceMuted ? p.background : p.foreground)
                        .frame(width: 64, height: 64).background(voiceMuted ? p.foreground : p.muted, in: Circle())
                }
                .accessibilityLabel(voiceMuted ? L("Réactiver le micro") : L("Couper le micro"))
                Button { voiceOn = false } label: {
                    Image(systemName: "xmark").font(.system(size: 22, weight: .bold)).foregroundStyle(.white)
                        .frame(width: 64, height: 64).background(Color.red, in: Circle())
                }
                .accessibilityLabel(L("Terminer"))
            }
            .padding(.bottom, 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(p.background.ignoresSafeArea())
        .sensoryFeedback(.selection, trigger: voicePhase)
    }

    private func cut() {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        Task { _ = try? await client.api("messenger/cut", body: ["thread": threadId]) }
    }
}

/// Appel d'outil : une pastille « Regarde la météo ✓ », dépliable sur le résultat.
private struct ToolPill: View {
    @Environment(\.palette) private var p
    let message: MxMessage
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button { withAnimation(.snappy) { open.toggle() } } label: {
                HStack(spacing: 7) {
                    Image(systemName: Self.symbol(message.toolName)).font(.system(size: 12))
                    Text(Self.label(message.toolName, message.toolArgs)).font(.system(size: 13)).lineLimit(1)
                    if message.toolRunning { ProgressView().controlSize(.mini) }
                    else { Image(systemName: message.toolOk ? "checkmark" : "xmark").font(.system(size: 11, weight: .bold)).foregroundStyle(message.toolOk ? p.success : p.destructive) }
                }
                .foregroundStyle(p.mutedForeground)
            }
            .buttonStyle(.plain)
            if open && !message.toolResult.isEmpty {
                Text(message.toolResult).font(.system(size: 12)).foregroundStyle(p.mutedForeground).textSelection(.enabled)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(p.border))
    }

    static func symbol(_ n: String) -> String {
        switch true {
        case n == "orchestrate_plan": "list.bullet.clipboard"
        case n == "orchestrate_check": "checkmark.seal"
        case n.contains("weather"): "cloud.sun"
        case n.contains("search"), n.contains("web"): "magnifyingglass"
        case n.contains("news"): "newspaper"
        case n.contains("reminder"): "bell"
        case n.contains("mail"): "envelope"
        case n.contains("image"): "photo"
        case n.contains("agent"): "person.2"
        case n.contains("domotique"): "house"
        case n.contains("file"), n.contains("sandbox"), n.contains("doc"): "doc.text"
        case n.contains("memory"), n.contains("recall"): "brain"
        case n.contains("agenda"), n.contains("calendar"): "calendar"
        default: "bolt"
        }
    }

    static func label(_ n: String, _ args: String) -> String {
        let base: String = switch true {
        case n == "orchestrate_plan": L("Plan de la réponse")
        case n == "orchestrate_check": L("Vérification de la réponse")
        case n.contains("weather"): L("Regarde la météo")
        case n.contains("web_search"), n.hasSuffix("search"): L("Cherche sur le web")
        case n.contains("read_page"): L("Lit une page")
        case n.contains("news"): L("Lit les actualités")
        case n.contains("reminder"): L("Crée un rappel")
        case n.contains("mail"): L("Consulte les mails")
        case n.contains("image"): L("Crée une image")
        case n.contains("agent"): L("Délègue à un agent")
        case n.contains("domotique"): L("Pilote la maison")
        case n.contains("memory"), n.contains("recall"): L("Consulte la mémoire")
        case n.contains("agenda"): L("Consulte l'agenda")
        case n.contains("tasks"): L("Consulte les tâches")
        default: n.replacingOccurrences(of: "_", with: " ")
        }
        // Premier argument textuel en précision : « Cherche sur le web · météo … »
        if let d = args.data(using: .utf8), let j = try? JSONSerialization.jsonObject(with: d) as? JSON,
           let v = j.values.compactMap({ $0 as? String }).first(where: { !$0.isEmpty }) {
            return "\(base) · \(v)"
        }
        return base
    }
}

/// Pièce jointe : image affichée, document ouvert dans Quick Look.
private struct MxAttachment: View {
    @Environment(\.palette) private var p
    let client: LumenClient
    let message: MxMessage
    @State private var image: UIImage?

    var body: some View {
        Group {
            if message.fileMime.hasPrefix("image/") {
                if let image {
                    Image(uiImage: image).resizable().scaledToFit()
                        .frame(maxWidth: 240, maxHeight: 300)
                        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                } else {
                    RoundedRectangle(cornerRadius: 18).fill(p.muted).frame(width: 180, height: 140).overlay(ProgressView())
                }
            } else {
                Label(message.fileName, systemImage: "doc.text").font(.system(size: 14))
                    .padding(.horizontal, 12).padding(.vertical, 10)
                    .background(p.muted, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            }
        }
        .task(id: message.fileId) {
            guard message.fileMime.hasPrefix("image/"), image == nil else { return }
            image = await client.messengerImage(message.fileId)
        }
    }
}

private struct MxTypingDots: View {
    let color: Color
    var body: some View {
        TimelineView(.animation) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            HStack(spacing: 4) {
                ForEach(0..<3) { i in
                    let v = (sin((t * 2 * .pi / 1.2) - Double(i) * 0.8) + 1) / 2
                    Circle().fill(color).frame(width: 7, height: 7).opacity(0.35 + 0.65 * v).offset(y: -3 * v)
                }
            }
        }
    }
}

extension UIImage {
    func scaledDown(maxSide: CGFloat) -> UIImage {
        let k = min(1, maxSide / max(size.width, size.height))
        guard k < 1 else { return self }
        let target = CGSize(width: size.width * k, height: size.height * k)
        return UIGraphicsImageRenderer(size: target).image { _ in draw(in: CGRect(origin: .zero, size: target)) }
    }
}

/// Halo animé du mode vocal : respire en réflexion, bat en lecture, suit
/// l'écoute plus calmement.
private struct VoicePulse: View {
    let phase: MessengerThreadView.VoicePhase
    let color: Color
    @State private var on = false
    var body: some View {
        let (lo, hi, d): (CGFloat, CGFloat, Double) = switch phase {
        case .speaking: (1.0, 1.16, 0.45)
        case .thinking: (0.9, 1.05, 0.9)
        case .listening: (0.96, 1.06, 1.4)
        case .error: (1.0, 1.0, 1)
        }
        Circle().fill(color.opacity(phase == .error ? 0.08 : 0.2))
            .frame(width: 200, height: 200)
            .scaleEffect(on ? hi : lo)
            .animation(.easeInOut(duration: d).repeatForever(autoreverses: true), value: on)
            .onAppear { on = true }
            .id(phase)   // relance l'animation au changement de phase
    }
}
