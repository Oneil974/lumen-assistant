import SwiftUI

/// Composeur : carte arrondie (rayon 24) — champ en haut, options actives en
/// pastilles, puis ＋ (pièces jointes + options) | micro, envoyer / mains libres.
struct Composer: View {
    @Environment(\.palette) private var p
    let client: LumenClient
    let speech: SpeechService
    @Binding var input: String
    @Binding var voiceCmd: Bool
    @Binding var handsFree: Bool
    var focused: FocusState<Bool>.Binding
    let onSend: () -> Void
    let onPhotos: () -> Void
    let onFiles: () -> Void
    let onCamera: () -> Void
    let onMode: () -> Void
    var onVault: () -> Void = {}
    let toast: (String) -> Void

    @State private var dictationBase = ""

    var body: some View {
        VStack(spacing: 8) {
            mentionStrip
            attachments
            VStack(alignment: .leading, spacing: 4) {
                TextField(L(voiceCmd ? "Commande pour le bureau…" : "Message à Lumen"), text: $input, axis: .vertical)
                    .font(.system(size: 16))
                    .lineLimit(1...7)
                    .focused(focused)
                    .padding(.horizontal, 6)
                    .padding(.top, 6)
                    .submitLabel(.send)
                    .onSubmit(onSend)

                activeModes
                HStack(spacing: 8) {
                    plusMenu
                    Spacer(minLength: 0)
                    Button(action: dictate) {
                        ghost(speech.listening && !handsFree ? "mic.fill" : "mic")
                            .foregroundStyle(speech.listening && !handsFree ? p.destructive : p.foreground)
                            .symbolEffect(.pulse, isActive: speech.listening && !handsFree)
                    }
                    .accessibilityLabel("Dictée")
                    // Champ vide : conversation mains libres ; sinon : envoyer.
                    if trimmed.isEmpty {
                        Button { handsFree.toggle() } label: {
                            Image(systemName: handsFree ? "stop.fill" : "waveform")
                                .font(.system(size: 15, weight: .bold))
                                .symbolEffect(.variableColor.iterative, isActive: handsFree && speech.listening)
                                .foregroundStyle(p.primaryForeground)
                                .frame(width: 36, height: 36)
                                .background(handsFree ? p.destructive : p.primary, in: Circle())
                        }
                        .accessibilityLabel(handsFree ? "Arrêter la conversation" : "Conversation mains libres")
                    } else {
                        Button(action: onSend) {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 16, weight: .bold))
                                .foregroundStyle(p.primaryForeground)
                                .frame(width: 36, height: 36)
                                .background(p.primary, in: Circle())
                        }
                        .accessibilityLabel("Envoyer")
                    }
                }
                .padding(.horizontal, 2)
            }
            .padding(8)
            .background(p.card, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(focused.wrappedValue ? p.mutedForeground.opacity(0.5) : p.border))
        }
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
        .background(p.background)
        .buttonStyle(PressStyle())
        .animation(.snappy(duration: 0.2), value: client.docs)
        .animation(.snappy(duration: 0.2), value: client.pinned)
        .animation(.snappy(duration: 0.2), value: mentionQuery.map { "\($0.kind)\($0.text)" })
    }

    private var trimmed: String { input.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func ghost(_ symbol: String) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 17))
            .frame(width: 34, height: 34)
            .contentShape(Circle())
    }

    /// ＋ : pièces jointes ET options de la discussion, dans un seul menu —
    /// la rangée reste lisible sur un iPhone étroit.
    private var plusMenu: some View {
        Menu {
            Section {
                Button(action: onPhotos) { Label("Photothèque", systemImage: "photo.on.rectangle") }
                Button(action: onCamera) { Label("Prendre une photo", systemImage: "camera") }
                Button(action: onFiles) { Label("Fichier", systemImage: "doc") }
                Button(action: onVault) { Label("Élément du coffre", systemImage: "cylinder.split.1x2") }
            }
            Section {
                Toggle(isOn: Binding(get: { voiceCmd }, set: { voiceCmd = $0; if $0 { focused.wrappedValue = true } })) {
                    Label("Commander le bureau", systemImage: "desktopcomputer")
                }
                if client.mode.available && client.mode.mode == "chat" {
                    Toggle(isOn: Binding(get: { client.orchestrate }, set: { client.setOrchestrate($0) })) {
                        Label("Réponse orchestrée", systemImage: "point.3.connected.trianglepath.dotted")
                    }
                }
                if client.mode.available {
                    Button(action: onMode) {
                        Label(String(localized: "Mode : \(L(client.mode.tag))"), systemImage: "text.alignleft")
                    }
                }
            }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(p.foreground)
                .frame(width: 36, height: 36)
                .background(p.muted, in: Circle())
        }
        .accessibilityLabel("Joindre et options")
    }

    /// Options actives, en pastilles discrètes (touchées = désactivées).
    @ViewBuilder private var activeModes: some View {
        let orchestrated = client.orchestrate && client.mode.available && client.mode.mode == "chat"
        let mode = client.mode.available && client.mode.mode != "chat"
        if voiceCmd || orchestrated || mode {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    if voiceCmd { pill("Bureau", "desktopcomputer") { voiceCmd = false } }
                    if orchestrated { pill("Orchestré", "point.3.connected.trianglepath.dotted") { client.setOrchestrate(false) } }
                    if mode { pill(client.mode.tag, "text.alignleft", closable: false, action: onMode) }
                }
                .padding(.horizontal, 4)
            }
        }
    }

    private func pill(_ title: String, _ symbol: String, closable: Bool = true, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: symbol).font(.system(size: 11, weight: .semibold))
                Text(L(title)).font(.system(size: 12, weight: .medium)).lineLimit(1)
                if closable { Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).opacity(0.7) }
            }
            .padding(.horizontal, 10).frame(height: 26)
            .foregroundStyle(p.primary)
            .background(p.primary.opacity(0.14), in: Capsule())
        }
    }

    // MARK: Pièces jointes

    @ViewBuilder private var attachments: some View {
        // Fiches du coffre jointes : cartes accentuées (elles orientent la réponse).
        if !client.pinned.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(client.pinned) { r in
                        HStack(spacing: 8) {
                            IconBadge(symbol: r.icon, size: 24)
                            VStack(alignment: .leading, spacing: 0) {
                                Text(r.title).font(.system(size: 12.5, weight: .medium)).lineLimit(1).frame(maxWidth: 170, alignment: .leading)
                                Text(r.app).font(.system(size: 10.5)).foregroundStyle(p.mutedForeground)
                            }
                            Button { client.pinned.removeAll { $0.id == r.id } } label: {
                                Image(systemName: "xmark").font(.system(size: 9, weight: .bold))
                                    .foregroundStyle(p.mutedForeground)
                                    .frame(width: 18, height: 18)
                                    .background(p.muted, in: Circle())
                            }
                        }
                        .padding(.leading, 6).padding(.trailing, 6).padding(.vertical, 5)
                        .background(p.primary.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(p.primary.opacity(0.35)))
                    }
                }
                .padding(.horizontal, 2)
            }
        }
        if !client.docs.isEmpty || client.imageCount > 0 {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    if client.imageCount > 0 {
                        attachChip(client.imageCount > 1 ? String(localized: "\(client.imageCount) images") : String(localized: "1 image"), tag: nil, symbol: "photo") {
                            client.clearImages()
                        }
                    }
                    ForEach(client.docs) { d in
                        attachChip(d.name, tag: d.rag ? "indexé" : "contexte", symbol: "doc.text") { client.removeDoc(d.name) }
                    }
                }
                .padding(.horizontal, 2)
            }
        }
    }

    private func attachChip(_ name: String, tag: String?, symbol: String, remove: @escaping () -> Void) -> some View {
        HStack(spacing: 6) {
            Image(systemName: symbol).font(.system(size: 11)).foregroundStyle(p.mutedForeground)
            Text(name).font(.system(size: 12)).lineLimit(1).frame(maxWidth: 160)
            if let tag { Text(L(tag)).font(.system(size: 12)).foregroundStyle(p.mutedForeground) }
            Button(action: remove) {
                Image(systemName: "xmark").font(.system(size: 9, weight: .bold))
                    .foregroundStyle(p.mutedForeground)
                    .frame(width: 18, height: 18)
                    .background(p.muted, in: Circle())
            }
        }
        .padding(.leading, 10).padding(.trailing, 4).padding(.vertical, 4)
        .background(p.card, in: Capsule())
        .overlay(Capsule().stroke(p.border))
    }

    // MARK: Mentions « @outil » / « #document »

    private var mentionQuery: (kind: Character, text: String)? {
        guard let last = input.split(separator: " ", omittingEmptySubsequences: false).last,
              let first = last.first, first == "@" || first == "#" else { return nil }
        return (first, String(last.dropFirst()).lowercased())
    }

    @ViewBuilder private var mentionStrip: some View {
        if let q = mentionQuery {
            let pool = q.kind == "@" ? client.tools : client.files
            let items = pool.filter { q.text.isEmpty || $0.label.lowercased().contains(q.text) }.prefix(12)
            VStack(alignment: .leading, spacing: 0) {
                Text(L(q.kind == "@" ? "Outils — touche pour insérer" : "Documents — touche pour joindre"))
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(p.mutedForeground)
                    .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 4)
                if items.isEmpty {
                    Text(L(pool.isEmpty ? "Chargement…" : "Aucun résultat"))
                        .font(.system(size: 13)).foregroundStyle(p.mutedForeground)
                        .padding(12)
                }
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(Array(items)) { item in
                            Button { pick(item, kind: q.kind) } label: {
                                VStack(alignment: .leading, spacing: 1) {
                                    Text((q.kind == "@" ? "@" : "") + item.label).font(.system(size: 14, weight: .medium))
                                    if !item.desc.isEmpty {
                                        Text(item.desc).font(.system(size: 12)).foregroundStyle(p.mutedForeground).lineLimit(1)
                                    }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 12).padding(.vertical, 8)
                                .contentShape(Rectangle())
                            }
                        }
                    }
                }
                .frame(maxHeight: 220)
            }
            .background(p.popover, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(p.border))
            .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .onAppear { client.listMentions() }
        }
    }

    private func pick(_ item: MentionItem, kind: Character) {
        var words = input.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
        if kind == "@" {
            words[words.count - 1] = "@" + item.label
            input = words.joined(separator: " ") + " "
        } else {
            // Le document vit sur l'ordinateur : c'est lui qui le joint.
            words.removeLast()
            input = words.joined(separator: " ")
            client.attachDocRef(item)
            toast(String(localized: "\(item.label) — joint à la discussion"))
        }
    }

    // MARK: Dictée

    private func dictate() {
        if !speech.listening { dictationBase = trimmed.isEmpty ? "" : trimmed + " " }
        Task {
            if let err = await speech.toggleDictation(onText: { input = dictationBase + $0 }) { toast(err) }
        }
    }
}

struct Badge: View {
    @Environment(\.palette) private var p
    let count: Int
    var body: some View {
        Text(count > 99 ? "99+" : "\(count)")
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(.white)
            .padding(.horizontal, 5)
            .frame(minWidth: 16, minHeight: 16)
            .background(p.destructive, in: Capsule())
    }
}
