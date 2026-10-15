import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

/// Écran principal : même anatomie que la PWA — barre (conversations /
/// modèle / agents / nouvelle discussion), Halo flottant, fil, composeur.
struct ChatView: View {
    @Environment(\.palette) private var p
    let client: LumenClient
    let speech: SpeechService

    enum Sheet: String, Identifiable { case backend, mode, settings, notifications, capture, agents, vault, sensors; var id: String { rawValue } }

    @State private var sheet: Sheet?
    @State private var drawer = false
    @State private var input = ""
    @State private var voiceCmd = false
    @AppStorage("handsFree") private var handsFree = false
    @State private var awaitingAnswer = false
    @State private var photoItem: PhotosPickerItem?
    @State private var showPhotos = false
    @State private var showFiles = false
    @State private var showCamera = false
    @State private var toast: String?
    @AppStorage("companionNotifSeen") private var notifSeen = 0
    @FocusState private var focused: Bool

    var body: some View {
        ZStack(alignment: .top) {
            VStack(spacing: 0) {
                topBar
                statusBanner
                MessagesView(client: client, speech: speech, onSuggestion: { send($0) })
                if client.drivesDesktop {
                    Composer(client: client, speech: speech, input: $input, voiceCmd: $voiceCmd, handsFree: $handsFree, focused: $focused,
                             onSend: { send(input) },
                             onPhotos: { showPhotos = true },
                             onFiles: { showFiles = true },
                             onCamera: { openCamera() },
                             onMode: { sheet = .mode },
                             onVault: { sheet = .vault },
                             toast: { toast = $0 })
                }
            }
            .background(p.background.ignoresSafeArea())

            HaloView(client: client)
                .padding(.top, 58)

            VStack(spacing: 8) {
                ForEach(client.requests) { req in
                    RequestBanner(request: req, client: client) { client.answer(req, choice: $0) }
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 56)
            .animation(.snappy, value: client.requests.map(\.id))

            if drawer {
                ConversationDrawer(client: client, isOpen: $drawer, notifBadge: unseen,
                                   onCapture: { drawer = false; sheet = .capture },
                                   onVault: { drawer = false; sheet = .vault },
                                   onAgents: { drawer = false; sheet = .agents },
                                   onSensors: { drawer = false; sheet = .sensors },
                                   onSettings: { drawer = false; sheet = .settings })
                    .transition(.identity)
                    .zIndex(5)
            }

            if let toast {
                Text(L(toast))
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(p.background)
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .background(p.foreground, in: Capsule())
                    .frame(maxHeight: .infinity, alignment: .bottom)
                    .padding(.bottom, 110)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .zIndex(10)
                    .task(id: toast) {
                        try? await Task.sleep(for: .seconds(2.5))
                        withAnimation { self.toast = nil }
                    }
            }
        }
        .foregroundStyle(p.foreground)
        .animation(.snappy(duration: 0.25), value: toast)
        // Liens profonds (widgets, Siri) : lumen://ask|capture|talk|agents.
        .onReceive(NotificationCenter.default.publisher(for: .lumenRoute)) { note in
            switch note.object as? String {
            case "ask": focused = true
            case "capture": sheet = .capture
            case "agents": sheet = .agents
            case "vault": sheet = .vault
            case "talk": handsFree = true
            default: break
            }
        }
        // ---- Mode mains libres ----
        .onAppear { if UserDefaults.standard.string(forKey: PendingAction.key) == nil { handsFree = false } }
        .onChange(of: handsFree) { _, on in
            UIApplication.shared.isIdleTimerDisabled = on   // l'écran reste allumé
            if on { toast = L("Mains libres : parle, je t'écoute"); listenHandsFree() }
            else { speech.stopDictation(); awaitingAnswer = false }
        }
        .onChange(of: client.thinking) { _, busy in
            // Réponse finie sans rien à lire (ou lecture coupée) : on réécoute.
            guard handsFree, awaitingAnswer, !busy else { return }
            Task {
                try? await Task.sleep(for: .milliseconds(1500))
                if handsFree, awaitingAnswer, !speech.speaking, !client.thinking { awaitingAnswer = false; listenHandsFree() }
            }
        }
        .onAppear {
            speech.onSpeakingDone = {
                guard handsFree, awaitingAnswer, !client.thinking else { return }
                awaitingAnswer = false
                listenHandsFree()
            }
        }
        .onChange(of: client.toast) { _, t in
            if let t { withAnimation { toast = t }; client.toast = nil }
        }
        .sheet(item: $sheet) { s in
            Group {
                switch s {
                case .backend: BackendSheet(client: client)
                case .mode: ModeSheet(client: client)
                case .settings: SettingsSheet(client: client, speech: speech, notifBadge: unseen, openNotifications: {
                    sheet = nil
                    Task { try? await Task.sleep(for: .milliseconds(350)); sheet = .notifications }
                })
                case .notifications: NotificationsSheet(client: client)
                case .capture: CaptureSheet(client: client, toast: { t in toast = t })
                case .agents: AgentsView(client: client, toast: { t in toast = t })
                case .vault: VaultView(client: client)
                case .sensors: SensorsView()
                }
            }
            .themed()
        }
        .onChange(of: sheet) { old, _ in
            if old == .notifications || old == .settings { notifSeen = client.notifications.count }
        }
        .photosPicker(isPresented: $showPhotos, selection: $photoItem, matching: .images)
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            photoItem = nil
            Task {
                if let d = try? await item.loadTransferable(type: Data.self), let img = UIImage(data: d) { attach(img) }
            }
        }
        .fileImporter(isPresented: $showFiles,
                      allowedContentTypes: [.pdf, .plainText, .commaSeparatedText, .json, .rtf, .image,
                                            UTType(filenameExtension: "docx") ?? .data,
                                            UTType(filenameExtension: "md") ?? .plainText, .log],
                      onCompletion: importFile)
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { img in if let img { attach(img) } }.ignoresSafeArea()
        }
    }

    private var unseen: Int { max(0, client.notifications.count - notifSeen) }

    // MARK: Barre supérieure

    private var topBar: some View {
        HStack(spacing: 4) {
            iconButton("sidebar.left", label: "Conversations") {
                client.listConversations()
                withAnimation(.snappy(duration: 0.28)) { drawer = true }
            }
            Spacer(minLength: 0)
            Button {
                client.listBackends()
                sheet = .backend
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(client.backend.sourceShort)
                        .font(.system(size: 17, weight: .semibold))
                        .tracking(-0.2)
                        .fixedSize()
                    Text(client.backend.modelShort)
                        .font(.system(size: 13))
                        .foregroundStyle(p.mutedForeground)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(p.mutedForeground)
                }
                .padding(.horizontal, 12).padding(.vertical, 7)
                .contentShape(Capsule())
            }
            .buttonStyle(PressStyle())
            Spacer(minLength: 0)
            iconButton("bubble.left.and.bubble.right", label: "Messages") {
                withAnimation { UserDefaults.standard.set("messages", forKey: "companionMode") }
            }
            iconButton("person.2", label: "Agents") { sheet = .agents }
                .overlay(alignment: .topTrailing) {
                    if !client.requests.isEmpty { Badge(count: client.requests.count).offset(x: -2, y: 4) }
                }
            iconButton("square.and.pencil", label: "Nouvelle discussion") {
                client.newConversation()
                toast = "Nouvelle discussion"
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(.bar)
        .overlay(alignment: .bottom) { Rectangle().fill(p.border).frame(height: 0.5) }
    }

    private func iconButton(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 18, weight: .regular))
                .frame(width: 40, height: 40)
                .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle())
        .accessibilityLabel(label)
    }

    @ViewBuilder private var statusBanner: some View {
        let text: String? = {
            if speech.listening { return "Je t'écoute…" }
            if !client.drivesDesktop {
                return client.activeName.isEmpty
                    ? "Une autre session est ouverte sur l'ordinateur."
                    : String(localized: "Session de \(client.activeName) ouverte sur l'ordinateur — capture et agents restent disponibles.")
            }
            switch client.link {
            case .online: return nil
            case .connecting: return "Connexion à l'ordinateur…"
            case .offline: return "Hors ligne — nouvelle tentative…"
            }
        }()
        if let text {
            Text(L(text))
                .font(.system(size: 12))
                .foregroundStyle(p.mutedForeground)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
                .padding(.horizontal, 16)
                .background(p.muted)
                .transition(.opacity)
        }
    }

    // MARK: Actions

    private func listenHandsFree() {
        guard handsFree, !speech.listening else { return }
        Task {
            let err = await speech.toggleDictation(onText: { input = $0 }, onFinal: { text in
                input = ""
                client.sendChat(text)
                awaitingAnswer = true
            })
            if let err { toast = err; handsFree = false }
        }
    }

    private func send(_ raw: String) {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        speech.stopDictation()
        if voiceCmd {
            client.voiceCommand(text)
            toast = "Commande envoyée au bureau"
            voiceCmd = false
        } else {
            client.sendChat(text)
        }
        input = ""
        focused = false
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    private func openCamera() {
        guard client.backend.vision else { toast = "Ce backend ne lit pas les images"; return }
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else { toast = "Appareil photo indisponible"; return }
        showCamera = true
    }

    /// Photo → JPEG réduit (2048 px max) en data URL, comme `attach-image`.
    private func attach(_ image: UIImage) {
        guard client.backend.vision else { toast = "Ce backend ne lit pas les images"; return }
        let maxSide: CGFloat = 2048
        let scale = min(1, maxSide / max(image.size.width, image.size.height))
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let resized = UIGraphicsImageRenderer(size: size).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        guard let jpeg = resized.jpegData(compressionQuality: 0.82) else { return }
        client.attachImage(dataURL: "data:image/jpeg;base64," + jpeg.base64EncodedString())
        toast = "Envoi de la photo…"
    }

    private func importFile(_ result: Result<URL, Error>) {
        guard case .success(let url) = result else { return }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { toast = "Lecture du fichier impossible"; return }
        // 12 Mo : même borne que la PWA (trame WebSocket + Base64 en mémoire).
        guard data.count <= 12 * 1024 * 1024 else { toast = "Fichier trop volumineux (12 Mo max)"; return }
        if let type = UTType(filenameExtension: url.pathExtension), type.conforms(to: .image), let img = UIImage(data: data) {
            attach(img)
        } else {
            client.attachDoc(name: url.lastPathComponent, base64: data.base64EncodedString())
            toast = String(localized: "Envoi de \(url.lastPathComponent)…")
        }
    }
}

/// Demande de Lumen (accord, confirmation…) : bandeau avec les réponses.
struct RequestBanner: View {
    @Environment(\.palette) private var p
    let request: UserRequest
    let client: LumenClient
    let onChoice: (String) -> Void
    @State private var code = ""
    @State private var sent = false
    @FocusState private var codeFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: request.title).font(.system(size: 15, weight: .semibold))
            if request.kind == "unlock" {
                unlock
            } else {
                answers
            }
        }
        .padding(14)
        .background(p.popover, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(p.border))
        .shadow(color: .black.opacity(0.18), radius: 16, y: 6)
    }

    /// Session verrouillée : code à 6 chiffres de l'app d'authentification
    /// (iOS le propose depuis Mots de passe grâce à `.oneTimeCode`).
    @ViewBuilder private var unlock: some View {
        if request.unlockMode == "tap" {
            Button {
                sent = true
                Task { await client.tapUnlock(requestId: request.id) }
            } label: {
                Label(client.faceIDEnabled ? String(localized: "Déverrouiller avec \(BiometricKey.biometryName)") : L("Déverrouiller"),
                      systemImage: client.faceIDEnabled ? "faceid" : "lock.open")
                    .font(.system(size: 15, weight: .semibold))
                    .frame(maxWidth: .infinity).frame(height: 44)
                    .foregroundStyle(p.primaryForeground)
                    .background(p.primary, in: RoundedRectangle(cornerRadius: 10))
            }
            .buttonStyle(PressStyle())
            .disabled(sent)
            if let err = client.unlockError[request.id] {
                Text(L(err)).font(.system(size: 13)).foregroundStyle(p.destructive)
            }
            Button("Annuler") { onChoice("cancel") }
                .font(.system(size: 13)).foregroundStyle(p.mutedForeground)
                .onChange(of: client.unlockError[request.id]) { _, e in if e != nil { sent = false } }
        } else {
            codeUnlock
        }
    }

    @ViewBuilder private var codeUnlock: some View {
        if client.faceIDEnabled {
            Button {
                Task { await client.unlockWithFaceID(requestId: request.id) }
            } label: {
                Label(String(localized: "Déverrouiller avec \(BiometricKey.biometryName)"), systemImage: "faceid")
                    .font(.system(size: 15, weight: .semibold))
                    .frame(maxWidth: .infinity).frame(height: 44)
                    .foregroundStyle(p.primaryForeground)
                    .background(p.primary, in: RoundedRectangle(cornerRadius: 10))
            }
            .buttonStyle(PressStyle())
            Text("ou").font(.system(size: 12)).foregroundStyle(p.mutedForeground).frame(maxWidth: .infinity)
        }
        Text("Saisis le code à 6 chiffres de ton application d'authentification.")
            .font(.system(size: 14)).foregroundStyle(p.mutedForeground)
        HStack(spacing: 8) {
            TextField("123456", text: $code)
                .textContentType(.oneTimeCode)
                .keyboardType(.numberPad)
                .font(.system(size: 20, weight: .semibold, design: .monospaced))
                .focused($codeFocused)
                .padding(.horizontal, 12)
                .frame(height: 44)
                .background(p.background, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(p.border))
                .onChange(of: code) { _, v in
                    code = String(v.filter(\.isNumber).prefix(6))
                    if code.count == 6 { submit() }
                }
            Button(action: submit) {
                Text("Déverrouiller")
                    .font(.system(size: 14, weight: .semibold))
                    .padding(.horizontal, 14).frame(height: 44)
                    .foregroundStyle(p.primaryForeground)
                    .background(p.primary, in: RoundedRectangle(cornerRadius: 10))
            }
            .buttonStyle(PressStyle())
            .disabled(code.count != 6 || sent)
            .opacity(code.count != 6 || sent ? 0.4 : 1)
        }
        if let err = client.unlockError[request.id] {
            Text(L(err)).font(.system(size: 13)).foregroundStyle(p.destructive)
        }
        Button("Annuler") { onChoice("cancel") }
            .font(.system(size: 13)).foregroundStyle(p.mutedForeground)
            .onAppear { if !client.faceIDEnabled { codeFocused = true } }
            .onChange(of: client.unlockError[request.id]) { _, e in if e != nil { sent = false; code = "" } }
    }

    private func submit() {
        guard code.count == 6, !sent else { return }
        sent = true
        client.remoteUnlock(request, code: code)
    }

    @ViewBuilder private var answers: some View {
        Group {
            if !request.body.isEmpty {
                Text(request.body).font(.system(size: 14)).foregroundStyle(p.mutedForeground)
            }
            if request.options.isEmpty {
                Text("Réponds sur l'ordinateur.").font(.system(size: 13)).foregroundStyle(p.mutedForeground)
            } else {
                HStack(spacing: 8) {
                    ForEach(request.options, id: \.id) { opt in
                        Button { onChoice(opt.id) } label: {
                            Text(opt.label)
                                .font(.system(size: 14, weight: .semibold))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 9)
                                .foregroundStyle(opt.primary ? p.primaryForeground : p.foreground)
                                .background(opt.primary ? p.primary : p.muted, in: RoundedRectangle(cornerRadius: 10))
                        }
                        .buttonStyle(PressStyle())
                    }
                }
            }
        }
    }
}

/// Appareil photo système.
struct CameraPicker: UIViewControllerRepresentable {
    var onDone: (UIImage?) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let vc = UIImagePickerController()
        vc.sourceType = .camera
        vc.delegate = context.coordinator
        return vc
    }
    func updateUIViewController(_ vc: UIImagePickerController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ p: CameraPicker) { parent = p }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            parent.onDone(info[.originalImage] as? UIImage)
            parent.dismiss()
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.onDone(nil)
            parent.dismiss()
        }
    }
}
