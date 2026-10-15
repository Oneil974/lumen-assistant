import SwiftUI

/// Connexion : nom du profil Lumen + code TOTP à 6 chiffres, puis — pour un
/// profil protégé — mot de passe de la session (le code se lit dans les
/// Réglages de Lumen, il ne suffit pas à prouver qu'on connaît la session).
/// Le visage du profil apparaît dès que le nom est reconnu (`/auth/who`).
struct PairingView: View {
    @Environment(\.palette) private var p
    @EnvironmentObject private var store: ServerStore
    let client: LumenClient

    @State private var identifier = ""
    @State private var code = ""
    @State private var password = ""
    @State private var askPassword = false
    @State private var who: UserIdentity?
    @State private var error: String?
    @State private var busy = false
    @State private var showServer = false
    @FocusState private var focus: Field?
    enum Field { case id, code, password }

    var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                Spacer(minLength: 40)
                Text("Lumen")
                    .font(.system(size: 34, weight: .bold))
                    .tracking(-0.8)

                if let who {
                    VStack(spacing: 8) {
                        Avatar(identity: who, client: client, size: 72)
                        Text(who.name).font(.system(size: 17, weight: .semibold))
                    }
                    .transition(.scale.combined(with: .opacity))
                }

                VStack(alignment: .leading, spacing: 6) {
                    Text("Connexion").font(.system(size: 22, weight: .semibold))
                    Text("Saisis ton nom d'utilisateur Lumen, puis le code à 6 chiffres affiché dans Lumen › Réglages › Compagnon mobile (ou donné par ton application d'authentification).")
                        .font(.system(size: 14))
                        .foregroundStyle(p.mutedForeground)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                VStack(spacing: 10) {
                    field {
                        TextField("Ton nom", text: $identifier)
                            .textContentType(.username)
                            .textInputAutocapitalization(.words)
                            .autocorrectionDisabled()
                            .focused($focus, equals: .id)
                            .disabled(askPassword)
                            .submitLabel(.next)
                            .onSubmit { focus = .code }
                    }
                    field {
                        TextField("Code à 6 chiffres", text: $code)
                            .textContentType(.oneTimeCode)
                            .keyboardType(.numberPad)
                            .font(.system(size: 20, weight: .semibold, design: .monospaced))
                            .focused($focus, equals: .code)
                            .disabled(askPassword)
                            .onChange(of: code) { _, v in
                                code = String(v.filter(\.isNumber).prefix(6))
                                if code.count == 6 && !askPassword { submit() }
                            }
                    }
                    if askPassword {
                        Text("Code accepté. Saisis maintenant le mot de passe de ta session Lumen.")
                            .font(.system(size: 14))
                            .foregroundStyle(p.mutedForeground)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        field {
                            SecureField("Mot de passe de la session", text: $password)
                                .textContentType(.password)
                                .focused($focus, equals: .password)
                                .submitLabel(.go)
                                .onSubmit(submit)
                        }
                    }
                }

                PrimaryButton(title: busy ? "Connexion…" : "Se connecter",
                              disabled: busy || identifier.isEmpty || code.count != 6 || (askPassword && password.isEmpty),
                              action: submit)

                if let error {
                    Text(L(error)).font(.system(size: 14)).foregroundStyle(p.destructive)
                }

                Button { showServer = true } label: {
                    Label(client.server.host() ?? client.server.absoluteString, systemImage: "desktopcomputer")
                        .font(.system(size: 13))
                        .foregroundStyle(p.mutedForeground)
                }
                .padding(.top, 8)
            }
            .padding(.horizontal, 24)
            .frame(maxWidth: 460)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(p.background.ignoresSafeArea())
        .foregroundStyle(p.foreground)
        .animation(.snappy, value: who)
        .onAppear {
            identifier = client.lastIdentifier
            focus = identifier.isEmpty ? .id : .code
        }
        .task(id: identifier) {
            try? await Task.sleep(for: .milliseconds(250))
            let v = identifier.trimmingCharacters(in: .whitespaces)
            who = v.isEmpty ? nil : await client.who(v)
        }
        .sheet(isPresented: $showServer) {
            NavigationStack { SetupView(onDone: { showServer = false }) }.themed()
        }
    }

    private func field<C: View>(@ViewBuilder _ c: () -> C) -> some View {
        c()
            .font(.system(size: 16))
            .padding(.horizontal, 14)
            .frame(height: 50)
            .background(p.card, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(p.border))
    }

    private func submit() {
        guard !busy, code.count == 6 else { return }
        if askPassword && password.isEmpty { return }
        busy = true
        error = nil
        Task {
            let result = askPassword
                ? await client.login(password: password)
                : await client.pair(identifier: identifier.trimmingCharacters(in: .whitespaces), code: code)
            password = ""
            busy = false
            switch result {
            case .done:
                askPassword = false
            case .needPassword:
                askPassword = true
                focus = .password
            case .failed(let message):
                error = message
                // Ticket perdu (expiré, trop d'essais) : on repart du code.
                if !askPassword || message.hasPrefix("Connexion expirée") {
                    askPassword = false
                    client.cancelLogin()
                    code = ""
                }
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            }
        }
    }
}

/// Avatar du profil (image data:/chemin servi par Lumen) ou initiale.
struct Avatar: View {
    @Environment(\.palette) private var p
    let identity: UserIdentity
    let client: LumenClient
    var size: CGFloat = 32
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            Circle().fill(p.muted)
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Text(String(identity.name.prefix(1)).uppercased())
                    .font(.system(size: size * 0.42, weight: .semibold))
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .task(id: identity.avatar) {
            guard let a = identity.avatar, let d = await client.imageData(path: a) else { return }
            image = UIImage(data: d)
        }
    }
}
