import SwiftUI

/// Le fil : bulles utilisateur à droite (fond secondaire, rayon 18), réponses
/// de l'assistant en pleine largeur sans bulle, blocs repliables pour le
/// raisonnement / les outils / le plan, comme au bureau.
struct MessagesView: View {
    @Environment(\.palette) private var p
    let client: LumenClient
    let speech: SpeechService
    let onSuggestion: (String) -> Void

    private let suggestions = ["Résume ma journée",
                               "Qu'est-ce qui tourne sur mon ordinateur ?",
                               "Aide-moi à rédiger un message"]

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if client.messages.isEmpty {
                        empty.padding(.top, 80)
                    }
                    ForEach(client.messages) { m in
                        MessageRow(message: m, client: client, speech: speech)
                            .id(m.id)
                    }
                    // Hors ligne : échanges répondus par l'iPhone lui-même.
                    if !client.localMessages.isEmpty {
                        HStack(spacing: 6) {
                            Image(systemName: "iphone").font(.system(size: 11))
                            Text("Hors ligne — réponses d'Apple Intelligence sur cet iPhone").font(.system(size: 11, weight: .medium))
                        }
                        .foregroundStyle(p.mutedForeground)
                        .frame(maxWidth: .infinity)
                        ForEach(client.localMessages) { m in
                            if m.isUser {
                                HStack { Spacer(minLength: 48)
                                    Text(m.text).font(.system(size: 16))
                                        .padding(.horizontal, 14).padding(.vertical, 9)
                                        .background(p.secondary, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                                }
                            } else {
                                MarkdownView(text: m.text).textSelection(.enabled)
                            }
                        }
                    }
                    if client.thinking || client.localThinking {
                        TypingDots().id("typing")
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, 16)
                .padding(.top, 16)
                .padding(.bottom, 12)
            }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            .onChange(of: client.messages.count) { _, _ in scroll(proxy) }
            .onChange(of: client.messages.last?.text) { _, _ in scroll(proxy, animated: false) }
            .onChange(of: client.thinking) { _, _ in scroll(proxy) }
            .onChange(of: client.localMessages.count) { _, _ in scroll(proxy) }
        }
    }

    private func scroll(_ proxy: ScrollViewProxy, animated: Bool = true) {
        if animated { withAnimation(.snappy) { proxy.scrollTo("bottom", anchor: .bottom) } }
        else { proxy.scrollTo("bottom", anchor: .bottom) }
    }

    private var empty: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Comment puis-je t'aider ?")
                .font(.system(size: 24, weight: .semibold))
                .tracking(-0.5)
            Text("Tes messages sont traités par ton ordinateur.")
                .font(.system(size: 14))
                .foregroundStyle(p.mutedForeground)
            VStack(spacing: 8) {
                ForEach(suggestions, id: \.self) { s in
                    Button { onSuggestion(s) } label: {
                        Text(s)
                            .font(.system(size: 14))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 14).padding(.vertical, 12)
                            .background(p.card, in: RoundedRectangle(cornerRadius: 12))
                            .overlay(RoundedRectangle(cornerRadius: 12).stroke(p.border))
                    }
                    .buttonStyle(PressStyle())
                }
            }
            .padding(.top, 20)
        }
    }
}

struct MessageRow: View {
    @Environment(\.palette) private var p
    let message: ChatMessage
    let client: LumenClient
    let speech: SpeechService

    var body: some View {
        if message.isUser {
            HStack {
                Spacer(minLength: 48)
                Text(Self.mentions(message.text, p))
                    .font(.system(size: 16))
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .background(p.secondary, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .textSelection(.enabled)
            }
        } else {
            VStack(alignment: .leading, spacing: 10) {
                if !message.progress.isEmpty { ProgressCard(events: message.progress, client: client) }
                ForEach(message.blocks) { BlockView(block: $0) }
                if !message.text.isEmpty {
                    MarkdownView(text: message.text)
                        .textSelection(.enabled)
                    HStack(spacing: 2) {
                        mini("speaker.wave.2", "Lire") { speech.speak(message.text) }
                        mini("doc.on.doc", "Copier") {
                            UIPasteboard.general.string = message.text
                            client.toast = "Copié"
                        }
                        ShareLink(item: message.text) {
                            Image(systemName: "square.and.arrow.up")
                                .font(.system(size: 13))
                                .foregroundStyle(p.mutedForeground)
                                .frame(width: 30, height: 28)
                        }
                    }
                }
            }
        }
    }

    private func mini(_ symbol: String, _ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 13))
                .foregroundStyle(p.mutedForeground)
                .frame(width: 30, height: 28)
                .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle())
        .accessibilityLabel(label)
    }

    /// « @outil » en pastille colorée, comme decorateMentions().
    static func mentions(_ s: String, _ p: Palette) -> AttributedString {
        var out = AttributedString()
        for (i, word) in s.split(separator: " ", omittingEmptySubsequences: false).enumerated() {
            if i > 0 { out += AttributedString(" ") }
            var a = AttributedString(String(word))
            if word.hasPrefix("@") && word.count > 1 {
                a.foregroundColor = p.primary
                a.font = .system(size: 16, weight: .semibold)
            }
            out += a
        }
        return out
    }
}

/// Étapes de progression (mode Action / outils) et images produites.
struct ProgressCard: View {
    @Environment(\.palette) private var p
    let events: [ProgressEvent]
    let client: LumenClient

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(events) { ev in
                if ev.kind == "image", let path = ev.path {
                    RemoteImage(path: path, client: client)
                } else {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Circle()
                            .fill(ev.kind == "error" ? p.destructive : p.mutedForeground)
                            .frame(width: 6, height: 6)
                            .offset(y: -2)
                        Text(ev.message).font(.system(size: 13)).foregroundStyle(p.mutedForeground)
                    }
                }
            }
        }
        .lumenCard(radius: 16)
    }
}

struct RemoteImage: View {
    @Environment(\.palette) private var p
    let path: String
    let client: LumenClient
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .contextMenu {
                        Button { UIImageWriteToSavedPhotosAlbum(image, nil, nil, nil) } label: {
                            Label("Enregistrer dans Photos", systemImage: "square.and.arrow.down")
                        }
                        ShareLink(item: Image(uiImage: image), preview: SharePreview("Image Lumen", image: Image(uiImage: image)))
                    }
            } else {
                RoundedRectangle(cornerRadius: 10).fill(p.muted).frame(height: 180)
                    .overlay(ProgressView())
            }
        }
        .task(id: path) {
            if let d = await client.imageData(path: path) { image = UIImage(data: d) }
        }
    }
}

/// Raisonnement, appel d'outil ou plan : repliable, fermé par défaut sauf
/// pendant le travail (comme stream-view.js). Chaque type a sa carte : frise
/// d'étapes pour le plan, résultat qualifié pour un outil.
struct BlockView: View {
    let block: MessageBlock

    var body: some View {
        switch block {
        case .plan(let title, let live, let summary, let steps):
            PlanCard(title: title, live: live, summary: summary, steps: steps)
        case .tool(let name, let args, let result):
            ToolCard(name: name, args: args, result: result)
        case .think(let label, let text, let live):
            ThinkCard(label: label, text: text, live: live)
        }
    }
}

/// En-tête commun : pastille d'icône, titre, sous-titre, chevron rond.
private struct CardHeader: View {
    @Environment(\.palette) private var p
    let symbol: String
    let title: String
    var subtitle: String = ""
    var trailing: String = ""
    var live = false
    let open: Bool

    var body: some View {
        HStack(spacing: 10) {
            IconBadge(symbol: symbol, size: 30)
                .symbolEffect(.pulse, isActive: live)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.system(size: 14, weight: .semibold)).lineLimit(1)
                if !subtitle.isEmpty {
                    Text(subtitle).font(.system(size: 12)).foregroundStyle(p.mutedForeground).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            if !trailing.isEmpty {
                Text(trailing).font(.system(size: 12).monospacedDigit()).foregroundStyle(p.mutedForeground)
            }
            Image(systemName: "chevron.down")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(p.mutedForeground)
                .rotationEffect(.degrees(open ? 180 : 0))
                .frame(width: 26, height: 26)
                .background(p.muted, in: Circle())
        }
        .contentShape(Rectangle())
    }
}

/// Réponse orchestrée : frise verticale des étapes, icône par étape, familles
/// d'outils en pastilles.
struct PlanCard: View {
    @Environment(\.palette) private var p
    let title: String
    let live: Bool
    let summary: String
    let steps: [PlanStep]
    @State private var open: Bool?

    var body: some View {
        let isOpen = open ?? live
        VStack(alignment: .leading, spacing: 10) {
            Button { withAnimation(.snappy(duration: 0.22)) { open = !isOpen } } label: {
                CardHeader(symbol: "list.bullet.clipboard",
                           title: live ? (title.isEmpty ? L("Plan") : title) : (summary.isEmpty ? (title.isEmpty ? L("Plan") : title) : summary),
                           subtitle: subtitle, live: live, open: isOpen)
            }
            .buttonStyle(.plain)
            if isOpen {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(steps.enumerated()), id: \.element.id) { i, s in
                        stepRow(s, last: i == steps.count - 1)
                    }
                }
                .padding(10)
                .background(p.background.opacity(0.55), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .transition(.opacity)
            }
        }
        .lumenCard(active: live, radius: 18)
    }

    private var subtitle: String {
        if live { return steps.first { $0.status == "running" }?.label ?? L("En cours…") }
        if steps.contains(where: { st($0.status) == .fail }) { return L("Terminée avec des erreurs") }
        return L("Orchestration terminée")
    }

    /// Statuts du bureau (stream-view.js) : running, ok, warn, skip, fail.
    private enum St { case running, ok, warn, skip, fail, pending }
    private func st(_ raw: String) -> St {
        switch raw {
        case "running": .running
        case "ok", "done": .ok
        case "warn": .warn
        case "skip", "skipped": .skip
        case "fail", "failed", "error": .fail
        default: .pending
        }
    }

    @ViewBuilder private func stepRow(_ s: PlanStep, last: Bool) -> some View {
        let state = st(s.status)
        let tint: Color = switch state {
        case .fail: p.destructive
        case .warn: Color.orange
        case .ok, .running: p.primary
        default: p.mutedForeground
        }
        HStack(alignment: .top, spacing: 10) {
            VStack(spacing: 0) {
                ZStack {
                    Circle().fill(tint.opacity(state == .ok || state == .running || state == .warn ? 0.16 : 0.06))
                    Circle().stroke(tint.opacity(0.5), style: StrokeStyle(lineWidth: 1, dash: state == .pending || state == .skip ? [2, 2] : []))
                    if state == .running {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: state == .fail ? "xmark" : LumenIcons.step(id: s.id, label: s.label))
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(tint)
                    }
                }
                .frame(width: 26, height: 26)
                if !last {
                    Rectangle().fill(p.border).frame(width: 1).frame(minHeight: 14, maxHeight: .infinity)
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(s.label).font(.system(size: 13.5, weight: .medium))
                    .foregroundStyle(state == .skip ? p.mutedForeground : p.foreground)
                if !s.detail.isEmpty {
                    if isCategoryStep(s) {
                        FlowChips(items: categories(s.detail))
                    } else {
                        Text(s.detail).font(.system(size: 12)).foregroundStyle(p.mutedForeground).lineLimit(3)
                    }
                }
            }
            .padding(.bottom, last ? 0 : 12)
            Spacer(minLength: 0)
        }
    }

    private func isCategoryStep(_ s: PlanStep) -> Bool {
        LumenIcons.step(id: s.id, label: s.label) == "square.grid.2x2" && st(s.status) == .ok
    }

    private func categories(_ detail: String) -> [String] {
        detail.split(whereSeparator: { $0 == "," || $0 == "·" }).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }
}

/// Pastilles de familles d'outils, avec leur icône, qui passent à la ligne.
private struct FlowChips: View {
    @Environment(\.palette) private var p
    let items: [String]
    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 6) { chips }
            VStack(alignment: .leading, spacing: 6) { chips }
        }
    }
    @ViewBuilder private var chips: some View {
        ForEach(items, id: \.self) { c in Chip(text: c, symbol: LumenIcons.category(c), tint: p.primary) }
    }
}

/// Appel d'outil : arguments, puis résultat qualifié (trouvé, vide, erreur).
struct ToolCard: View {
    @Environment(\.palette) private var p
    let name: String
    let args: String
    let result: String?
    @State private var open: Bool?
    @State private var rawOpen = false

    private enum Outcome { case running, found, empty, error }

    private var outcome: Outcome {
        guard let r = result?.trimmingCharacters(in: .whitespacesAndNewlines) else { return .running }
        if r.range(of: #"^(Erreur|Error)\b"#, options: .regularExpression) != nil { return .error }
        if r.isEmpty || r.range(of: #"^(Aucun(e)?\b|Rien trouvé|Rien ne correspond|Nothing found|No (note|result|match)|Le coffre est vide)"#, options: [.regularExpression, .caseInsensitive]) != nil { return .empty }
        return .found
    }

    var body: some View {
        let isOpen = open ?? false
        VStack(alignment: .leading, spacing: 10) {
            Button { withAnimation(.snappy(duration: 0.22)) { open = !isOpen } } label: {
                CardHeader(symbol: LumenIcons.tool(name), title: name, subtitle: headline,
                           live: outcome == .running, open: isOpen)
            }
            .buttonStyle(.plain)
            if isOpen {
                if !args.isEmpty { code(args, copy: true) }
                if result != nil { resultRow }
                if rawOpen, let result, !result.isEmpty { code(result, copy: true) }
            }
        }
        .lumenCard(active: outcome == .running, radius: 18)
    }

    /// Une ligne de résumé dans l'en-tête (requête ou état).
    private var headline: String {
        if outcome == .running { return L("En cours…") }
        if let d = args.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
            for k in ["query", "text", "id", "place", "key", "url", "task", "title"] {
                if let v = o[k] as? String, !v.isEmpty { return v }
            }
        }
        return ""
    }

    private var resultRow: some View {
        let (symbol, tint, title): (String, Color, String) = switch outcome {
        case .error: ("exclamationmark.triangle.fill", p.destructive, L("Échec de l'outil"))
        case .empty: ("magnifyingglass", p.primary, L("Aucun résultat trouvé"))
        case .found: ("checkmark", p.success, foundTitle)
        case .running: ("hourglass", p.mutedForeground, L("En cours…"))
        }
        return Button { withAnimation(.snappy(duration: 0.2)) { rawOpen.toggle() } } label: {
            HStack(spacing: 10) {
                Image(systemName: symbol)
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(tint)
                    .frame(width: 30, height: 30)
                    .background(tint.opacity(0.14), in: Circle())
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(.system(size: 13.5, weight: .medium))
                    Text(firstLine).font(.system(size: 12)).foregroundStyle(p.mutedForeground).lineLimit(2)
                }
                Spacer(minLength: 0)
                Image(systemName: rawOpen ? "chevron.up" : "text.alignleft")
                    .font(.system(size: 11, weight: .semibold)).foregroundStyle(p.mutedForeground)
            }
            .padding(10)
            .background(tint.opacity(0.06), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(tint.opacity(0.22)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var foundTitle: String {
        guard let r = result else { return "" }
        if let m = r.range(of: #"^\d+ (résultats|results)"#, options: .regularExpression) { return String(r[m]) }
        let bullets = r.components(separatedBy: "\n").filter { $0.hasPrefix("• ") }.count
        return bullets > 0 ? String(localized: "\(bullets) élément(s) trouvé(s)") : L("Résultat obtenu")
    }

    private var firstLine: String {
        let lines = (result ?? "").components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        return lines.first { $0.hasPrefix("• ") }.map { String($0.dropFirst(2)) } ?? lines.first ?? ""
    }

    private func code(_ s: String, copy: Bool) -> some View {
        ZStack(alignment: .topTrailing) {
            ScrollView(.horizontal, showsIndicators: false) {
                Text(s.count > 4000 ? String(s.prefix(4000)) + "…" : s)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(p.foreground.opacity(0.85))
                    .textSelection(.enabled)
                    .padding(12)
                    .padding(.trailing, 24)
            }
            if copy {
                Button {
                    UIPasteboard.general.string = s
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                } label: {
                    Image(systemName: "doc.on.doc").font(.system(size: 11)).foregroundStyle(p.mutedForeground).padding(8)
                }
                .buttonStyle(.plain)
            }
        }
        .background(p.background.opacity(0.6), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(p.border))
    }
}

/// Raisonnement du modèle, replié sauf pendant la réflexion.
struct ThinkCard: View {
    @Environment(\.palette) private var p
    let label: String?
    let text: String
    let live: Bool
    @State private var open: Bool?

    var body: some View {
        let isOpen = open ?? live
        VStack(alignment: .leading, spacing: 10) {
            Button { withAnimation(.snappy(duration: 0.22)) { open = !isOpen } } label: {
                CardHeader(symbol: "brain", title: label ?? L(live ? "Réflexion…" : "Raisonnement"), live: live, open: isOpen)
            }
            .buttonStyle(.plain)
            if isOpen {
                Text(text).font(.system(size: 13)).foregroundStyle(p.mutedForeground).textSelection(.enabled)
            }
        }
        .lumenCard(active: live, radius: 18)
    }
}

struct TypingDots: View {
    @Environment(\.palette) private var p
    @State private var phase = 0.0
    var body: some View {
        TimelineView(.animation) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            HStack(spacing: 4) {
                ForEach(0..<3) { i in
                    Circle().fill(p.mutedForeground)
                        .frame(width: 7, height: 7)
                        .opacity(0.35 + 0.65 * max(0, sin((t * 4) - Double(i) * 0.7)))
                }
            }
            .padding(.vertical, 6)
        }
    }
}
