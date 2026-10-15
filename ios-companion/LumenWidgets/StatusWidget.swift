import AppIntents
import SwiftUI
import WidgetKit

// Widget d'état de Lumen — l'écran « Système » de l'orbe M5 Fire, sur
// l'iPhone : backend et modèle choisis, modèle réellement chargé et sa
// mémoire, activité, décisions en attente ; boutons pour changer de backend
// et de modèle (interactifs, iOS 17+).

struct StatusEntry: TimelineEntry {
    let date: Date
    let status: LumenStatus
    let online: Bool
    let paired: Bool
}

struct StatusProvider: TimelineProvider {
    func placeholder(in context: Context) -> StatusEntry {
        var s = LumenStatus()
        s.host = "mac.local"; s.source = "llama"; s.model = "LFM2.5-VL-3B-Q4_K_M.gguf"; s.loadedModel = s.model
        s.memBytes = 2_400_000_000; s.sources = [.init(id: "llama", label: "llama.cpp"), .init(id: "ollama", label: "Ollama")]
        s.models = ["LFM2.5-VL-3B-Q4_K_M.gguf", "gemma-3-4b-it"]
        return StatusEntry(date: .now, status: s, online: true, paired: true)
    }

    func getSnapshot(in context: Context, completion: @escaping (StatusEntry) -> Void) {
        completion(SharedStore.cached.map { StatusEntry(date: .now, status: $0, online: true, paired: true) } ?? placeholder(in: context))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<StatusEntry>) -> Void) {
        Task {
            let fresh = await SharedStore.fetchStatus()
            var status = fresh ?? SharedStore.cached ?? LumenStatus()
            status.online = fresh != nil
            let entry = StatusEntry(date: .now, status: status, online: fresh != nil, paired: SharedStore.token != nil)
            completion(Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(fresh == nil ? 300 : 900))))
        }
    }
}

struct LumenStatusWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "LumenStatus", provider: StatusProvider()) { entry in
            StatusView(entry: entry)
                .containerBackground(for: .widget) { WidgetBackdrop() }
        }
        .configurationDisplayName("État de Lumen")
        .description("Backend, modèle chargé et activité — change de modèle d'un toucher.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular])
    }
}

/// Accent choisi dans l'app (App Group), ambre par défaut.
var accent: Color {
    let h = SharedStore.accentHex
    return Color(.sRGB, red: Double((h >> 16) & 0xFF) / 255, green: Double((h >> 8) & 0xFF) / 255, blue: Double(h & 0xFF) / 255)
}
let dim = Color.white.opacity(0.55)
private let faint = Color.white.opacity(0.08)

/// Fond sombre, léger reflet vertical.
struct WidgetBackdrop: View {
    var body: some View {
        ZStack {
            Color(red: 0.043, green: 0.043, blue: 0.05)
            LinearGradient(colors: [Color.white.opacity(0.04), .clear], startPoint: .top, endPoint: .center)
        }
    }
}

/// Orbe de Lumen en miniature.
private struct MiniOrb: View {
    var size: CGFloat = 20
    var online = true
    var body: some View {
        Circle()
            .fill(RadialGradient(colors: [accent.opacity(online ? 1 : 0.35), accent.opacity(online ? 0.55 : 0.2), Color.black.opacity(0.6)],
                                 center: UnitPoint(x: 0.35, y: 0.3), startRadius: 1, endRadius: size * 0.8))
            .overlay(Circle().stroke(Color.white.opacity(0.18), lineWidth: 0.6))
            .shadow(color: accent.opacity(online ? 0.55 : 0), radius: size * 0.35)
            .frame(width: size, height: size)
    }
}

struct StatusView: View {
    @Environment(\.widgetFamily) private var family
    let entry: StatusEntry
    private var s: LumenStatus { entry.status }

    var body: some View {
        if !entry.paired {
            VStack(alignment: .leading, spacing: 8) {
                brand
                Spacer()
                Text("Ouvre l'app Lumen pour appairer ton ordinateur.").font(.system(size: 13)).foregroundStyle(dim)
            }
            .widgetURL(LumenLink.ask.url)
        } else {
            switch family {
            case .accessoryRectangular:
                VStack(alignment: .leading, spacing: 1) {
                    Text(s.sourceName).font(.headline)
                    Text(s.label(for: s.model)).font(.caption).lineLimit(1)
                    Text(entry.online ? stateText : String(localized: "Hors ligne")).font(.caption2)
                }
            case .systemSmall:
                VStack(alignment: .leading, spacing: 0) {
                    HStack { MiniOrb(size: 18, online: entry.online); Spacer(); statePill }
                    Spacer(minLength: 4)
                    backendTitle(size: 22)
                    Spacer(minLength: 4)
                    stats(compact: true)
                }
                .widgetURL(LumenLink.ask.url)
            case .systemMedium:
                VStack(alignment: .leading, spacing: 8) {
                    HStack { brand; Spacer(); hostChip }
                    HStack(alignment: .bottom, spacing: 12) {
                        backendTitle(size: 24)
                        Spacer(minLength: 0)
                        LazyVGrid(columns: [GridItem(.fixed(62), spacing: 5), GridItem(.fixed(62), spacing: 5)], spacing: 5) {
                            ForEach(s.sources.prefix(4), id: \.id) { src in backendButton(src, compact: true) }
                        }
                    }
                    stats(compact: true)
                }
            default:
                // Grand format : tout doit tenir dans ~330 pt de haut. Avant,
                // 5 modèles + illustration débordaient et coupaient l'en-tête.
                VStack(alignment: .leading, spacing: 8) {
                    HStack { brand; Spacer(minLength: 8); hostChip }
                    HStack(alignment: .center) {
                        VStack(alignment: .leading, spacing: 1) {
                            caps("Backend")
                            backendTitle(size: 24)
                        }
                        Spacer(minLength: 0)
                        stackArt
                    }
                    HStack(spacing: 5) { ForEach(s.sources.prefix(4), id: \.id) { src in backendButton(src, compact: false) } }
                    HStack(spacing: 6) {
                        caps("Modèles")
                        if pageCount > 1 {
                            Text("\(page + 1)/\(pageCount)").font(.system(size: 9.5, weight: .semibold)).foregroundStyle(dim)
                        }
                        Spacer()
                        if pageCount > 1 {
                            pageButton("chevron.left", step: -1, enabled: page > 0)
                            pageButton("chevron.right", step: 1, enabled: page < pageCount - 1)
                        }
                        refresh
                    }
                    VStack(spacing: 0) {
                        ForEach(Array(largeModels.enumerated()), id: \.element) { i, m in
                            modelButton(m)
                            if i < largeModels.count - 1 { Rectangle().fill(faint).frame(height: 0.5) }
                        }
                        if s.models.isEmpty {
                            Text("Touche un backend pour lister ses modèles.").font(.system(size: 12)).foregroundStyle(dim).padding(10)
                        }
                    }
                    .background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(faint))
                    Spacer(minLength: 0)
                    stats(compact: false)
                }
            }
        }
    }

    /// Modèles du grand format, 4 par page : le choisi et le chargé en tête.
    private static let perPage = 4
    private var orderedModels: [String] {
        let first = [s.model, s.loadedModel].filter { !$0.isEmpty && s.models.contains($0) }
        var seen = Set<String>()
        return (first + s.models).filter { seen.insert($0).inserted }
    }
    private var pageCount: Int { max(1, (orderedModels.count + Self.perPage - 1) / Self.perPage) }
    /// Page bornée : la liste a pu raccourcir (autre backend) depuis le dernier toucher.
    private var page: Int { min(SharedStore.modelPage, pageCount - 1) }
    private var largeModels: [String] {
        Array(orderedModels.dropFirst(page * Self.perPage).prefix(Self.perPage))
    }

    private func pageButton(_ icon: String, step: Int, enabled: Bool) -> some View {
        // Depuis une page hors bornes, on repart de la page affichée.
        Button(intent: ModelPageIntent(step: page - SharedStore.modelPage + step)) {
            Image(systemName: icon).font(.system(size: 10, weight: .bold))
                .foregroundStyle(enabled ? .white : dim.opacity(0.4))
                .frame(width: 22, height: 22).background(Color.white.opacity(enabled ? 0.1 : 0.04), in: Circle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }

    // MARK: Morceaux

    private var brand: some View {
        HStack(spacing: 8) {
            MiniOrb(size: 22, online: entry.online)
            VStack(alignment: .leading, spacing: 0) {
                Text("Lumen").font(.system(size: 17, weight: .bold)).foregroundStyle(.white)
                Text("IA LOCALE").font(.system(size: 7.5, weight: .semibold)).tracking(1.6).foregroundStyle(dim)
            }
        }
    }

    private var hostChip: some View {
        HStack(spacing: 5) {
            Circle().fill(entry.online ? accent : .gray).frame(width: 6, height: 6)
            Text(s.host.isEmpty ? "Lumen" : s.host.replacingOccurrences(of: ".local", with: ""))
                .font(.system(size: 11, weight: .medium)).foregroundStyle(.white).lineLimit(1).truncationMode(.middle)
                .frame(maxWidth: 120, alignment: .leading)
            Image(systemName: s.location == "cloud" ? "cloud" : "desktopcomputer").font(.system(size: 10)).foregroundStyle(dim)
        }
        .padding(.horizontal, 9).padding(.vertical, 5)
        .background(Color.white.opacity(0.07), in: Capsule())
        .overlay(Capsule().stroke(faint))
    }

    private func caps(_ t: LocalizedStringKey) -> some View {
        Text(t).font(.system(size: 9.5, weight: .semibold)).tracking(1.4).textCase(.uppercase).foregroundStyle(dim)
    }

    private func backendTitle(size: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(s.sourceName).font(.system(size: size, weight: .bold)).tracking(-0.6).foregroundStyle(.white).lineLimit(1).minimumScaleFactor(0.6)
            Text(s.label(for: s.model.isEmpty ? s.loadedModel : s.model))
                .font(.system(size: 11.5, weight: .medium, design: .monospaced)).foregroundStyle(dim).lineLimit(1)
        }
    }

    /// Pile de couches lumineuse (le modèle chargé).
    private var stackArt: some View {
        ZStack {
            Circle().fill(accent.opacity(0.18)).frame(width: 56, height: 56).blur(radius: 16)
            Image(systemName: "square.stack.3d.up.fill")
                .font(.system(size: 30, weight: .light))
                .foregroundStyle(LinearGradient(colors: [.white.opacity(0.9), accent], startPoint: .top, endPoint: .bottom))
                .shadow(color: accent.opacity(0.6), radius: 8)
        }
        .frame(width: 56, height: 46)
    }

    private var statePill: some View {
        HStack(spacing: 4) {
            Circle().fill(!entry.online ? .gray : s.state == "thinking" ? accent : .green).frame(width: 6, height: 6)
            Text(entry.online ? stateText : String(localized: "Hors ligne")).font(.system(size: 10.5, weight: .medium)).foregroundStyle(.white)
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(Color.white.opacity(0.08), in: Capsule())
    }

    private func stats(compact: Bool) -> some View {
        HStack(spacing: compact ? 8 : 12) {
            if s.memBytes > 0 {
                Label(ByteCountFormatter.string(fromByteCount: s.memBytes, countStyle: .memory), systemImage: "memorychip")
            } else {
                Label(s.whereText, systemImage: s.location == "cloud" ? "cloud" : s.location == "device" ? "cpu" : "desktopcomputer")
            }
            if s.pending > 0 {
                HStack(spacing: 3) {
                    Image(systemName: "hand.raised")
                    Text("\(s.pending)")
                    Circle().fill(.red).frame(width: 6, height: 6)
                }
            }
            if !s.unlocked { Image(systemName: "lock.fill") }
            Spacer(minLength: 0)
            if !compact || family != .systemSmall { statePill }
        }
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(dim)
        .labelStyle(.titleAndIcon)
        .lineLimit(1)
    }

    private var stateText: String {
        s.state == "thinking" ? String(localized: "réfléchit…") : String(localized: "prêt")
    }

    private var refresh: some View {
        Button(intent: RefreshStatusIntent()) {
            Image(systemName: "arrow.clockwise").font(.system(size: 11, weight: .semibold)).foregroundStyle(dim)
                .frame(width: 22, height: 22).background(Color.white.opacity(0.07), in: Circle())
        }
        .buttonStyle(.plain)
    }

    private func backendButton(_ src: LumenStatus.Source, compact: Bool) -> some View {
        let on = src.id == s.source
        return Button(intent: SetBackendIntent(id: src.id)) {
            // « Lumen Server » ne tient pas dans un quart de widget : « Server ».
            Text(src.id == "lumen" ? "Server" : (LumenStatus.short[src.id] ?? src.label))
                .font(.system(size: compact ? 11 : 12.5, weight: on ? .bold : .medium))
                .lineLimit(1).minimumScaleFactor(0.7)
                .frame(maxWidth: .infinity)
                .padding(.vertical, compact ? 6 : 7)
                .foregroundStyle(on ? .black : .white)
                .background {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(on ? AnyShapeStyle(LinearGradient(colors: [accent, accent.opacity(0.8)], startPoint: .top, endPoint: .bottom)) : AnyShapeStyle(Color.white.opacity(0.07)))
                }
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(on ? accent.opacity(0.9) : faint))
                .shadow(color: on ? accent.opacity(0.45) : .clear, radius: 6)
        }
        .buttonStyle(.plain)
    }

    private func modelButton(_ m: String) -> some View {
        let on = m == s.model
        return Button(intent: SetModelIntent(model: m)) {
            HStack(spacing: 8) {
                Text(s.label(for: m)).font(.system(size: 12, weight: on ? .semibold : .regular, design: .monospaced)).lineLimit(1).truncationMode(.middle)
                Spacer()
                if on { Image(systemName: "checkmark").font(.system(size: 12, weight: .bold)).foregroundStyle(accent) }
                else if m == s.loadedModel { Image(systemName: "memorychip").font(.system(size: 11)).foregroundStyle(dim) }
                else { Image(systemName: "ellipsis").font(.system(size: 11)).foregroundStyle(dim.opacity(0.6)) }
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 12).padding(.vertical, 6.5)
            .background(on ? Color.white.opacity(0.07) : .clear)
            .overlay(alignment: .leading) {
                if on { RoundedRectangle(cornerRadius: 2).fill(accent).frame(width: 3).padding(.vertical, 4) }
            }
        }
        .buttonStyle(.plain)
    }
}

// MARK: Widget « Valeur du coffre » (choisie à la configuration)

struct VaultWidgetIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Valeur du coffre"
    static var description = IntentDescription("Affiche une valeur du coffre Lumen.")
    @Parameter(title: "Clé") var key: VaultKeyEntity?
}

struct VaultEntryTimeline: TimelineEntry {
    let date: Date
    let entry: VaultEntry?
    let key: String
}

struct VaultProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> VaultEntryTimeline {
        VaultEntryTimeline(date: .now, entry: VaultEntry(key: "courses", type: "list", value: .array([.string("lait"), .string("pain")]), updated_ms: 0), key: "courses")
    }
    func snapshot(for configuration: VaultWidgetIntent, in context: Context) async -> VaultEntryTimeline {
        let k = configuration.key?.id ?? ""
        return VaultEntryTimeline(date: .now, entry: VaultStore.get(k) ?? (k.isEmpty ? placeholder(in: context).entry : nil), key: k)
    }
    func timeline(for configuration: VaultWidgetIntent, in context: Context) async -> Timeline<VaultEntryTimeline> {
        await VaultStore.sync()
        let k = configuration.key?.id ?? ""
        return Timeline(entries: [VaultEntryTimeline(date: .now, entry: VaultStore.get(k), key: k)], policy: .after(.now.addingTimeInterval(900)))
    }
}

struct LumenVaultWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "LumenVault", intent: VaultWidgetIntent.self, provider: VaultProvider()) { t in
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 5) {
                    Image(systemName: "shippingbox.fill").font(.system(size: 11)).foregroundStyle(accent)
                    Text(t.entry?.name ?? (t.key.isEmpty ? String(localized: "Choisis une clé") : t.key))
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(dim).lineLimit(1)
                }
                if let e = t.entry {
                    if case .array(let items) = e.value {
                        ForEach(Array(items.prefix(6).enumerated()), id: \.offset) { _, it in
                            Text("• \(it.display)").font(.system(size: 13)).foregroundStyle(.white).lineLimit(1)
                        }
                        if items.count > 6 { Text("+\(items.count - 6)").font(.system(size: 11)).foregroundStyle(dim) }
                    } else {
                        Text(e.value.display).font(.system(size: e.value.display.count < 8 ? 34 : 16, weight: .bold)).foregroundStyle(.white).lineLimit(4).minimumScaleFactor(0.6)
                    }
                } else if !t.key.isEmpty {
                    Text("Valeur absente").font(.system(size: 13)).foregroundStyle(dim)
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .containerBackground(for: .widget) { WidgetBackdrop() }
            .widgetURL(URL(string: "lumen://vault"))
        }
        .configurationDisplayName("Valeur du coffre")
        .description("Une valeur ou une liste du coffre Lumen (courses, compteur, état de la maison…).")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular])
    }
}
