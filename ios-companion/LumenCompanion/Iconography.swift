import SwiftUI

// Iconographie et composants partagés des écrans « riches » (étapes
// d'orchestration, appels d'outils, coffre, agents) : un seul endroit décide
// quel symbole représente quoi, pour que le fil, le coffre et les agents
// parlent la même langue visuelle.

enum LumenIcons {
    /// Outil appelé par le modèle → symbole.
    static func tool(_ name: String) -> String {
        let n = name.lowercased()
        switch true {
        case n.hasPrefix("data_agenda"): return "calendar"
        case n.hasPrefix("data_tasks"): return "checklist"
        case n.hasPrefix("data_metrics"): return "heart.text.square"
        case n.hasPrefix("data_get"): return "doc.text.magnifyingglass"
        case n.hasPrefix("data_"), n.hasPrefix("vault_"): return "cylinder.split.1x2"
        case n.hasPrefix("web_"): return "globe"
        case n.contains("weather"): return "cloud.sun"
        case n.contains("sport"): return "sportscourt"
        case n.contains("market"), n.contains("exchange"): return "chart.line.uptrend.xyaxis"
        case n.contains("air_quality"): return "aqi.medium"
        case n.contains("news"): return "newspaper"
        case n.contains("generate_image"): return "photo.badge.plus"
        case n.hasPrefix("mail_"): return "envelope"
        case n.hasPrefix("notes_"): return "note.text"
        case n.hasPrefix("sandbox_"): return "folder"
        case n.hasPrefix("memory_"), n.contains("recall"): return "brain"
        case n.contains("reminder"): return "bell"
        case n.hasPrefix("kanban"): return "rectangle.split.3x1"
        case n.hasPrefix("agenda"): return "calendar.badge.plus"
        case n.hasPrefix("agent"): return "person.2"
        case n.hasPrefix("domotique"): return "lightbulb"
        case n.contains("search_documents"), n.contains("rag"): return "books.vertical"
        case n.contains("tables"), n.contains("query_tables"): return "tablecells"
        case n.contains("ask_user"): return "questionmark.bubble"
        case n.contains("lumen_search"), n.contains("day_overview"): return "sparkle.magnifyingglass"
        case n.hasPrefix("mcp_"): return "puzzlepiece.extension"
        default: return "wrench.and.screwdriver"
        }
    }

    /// Famille d'outils (libellé affiché par l'orchestrateur) → symbole.
    static func category(_ label: String) -> String {
        let l = label.lowercased()
        switch true {
        case l.contains("coffre"), l.contains("vault"): return "cylinder.split.1x2"
        case l.contains("web"): return "globe"
        case l.contains("direct"), l.contains("live"): return "bolt.horizontal"
        case l.contains("mémoire"), l.contains("memory"): return "brain"
        case l.contains("document"), l.contains("base"): return "books.vertical"
        case l.contains("fichier"), l.contains("file"): return "folder"
        case l.contains("courrier"), l.contains("mail"): return "envelope"
        case l.contains("agent"): return "person.2"
        case l.contains("maison"), l.contains("home"): return "house"
        case l.contains("automat"), l.contains("fluxo"): return "point.3.connected.trianglepath.dotted"
        case l.contains("app"): return "square.grid.2x2"
        case l.contains("projet"), l.contains("project"): return "folder.badge.person.crop"
        case l.contains("mcp"), l.contains("connect"): return "puzzlepiece.extension"
        default: return "square.stack.3d.up"
        }
    }

    /// Étape d'une réponse orchestrée (id stable côté bureau) → symbole.
    static func step(id: String, label: String) -> String {
        let k = (id + " " + label).lowercased()
        switch true {
        case k.contains("analy"): return "text.magnifyingglass"
        case k.contains("route"), k.contains("catégor"), k.contains("categor"): return "square.grid.2x2"
        case k.contains("tool"), k.contains("outil"): return "wrench.and.screwdriver"
        case k.contains("data"), k.contains("donnée"): return "tray.full"
        case k.contains("answer"), k.contains("rédac"), k.contains("redac"), k.contains("writ"): return "pencil.line"
        case k.contains("verif"), k.contains("vérif"), k.contains("check"): return "checkmark.shield"
        case k.contains("revis"), k.contains("révis"): return "arrow.triangle.2.circlepath"
        case k.contains("compact"): return "arrow.down.right.and.arrow.up.left"
        default: return "circle.dotted"
        }
    }

    /// Source du coffre unifié (id de connecteur, libellé) → symbole.
    static func source(id: String, label: String) -> String {
        let l = label.lowercased()
        switch true {
        case id.hasPrefix("fichiers:"):
            if l.contains("image") || l.contains("photo") { return "photo.on.rectangle" }
            if l.contains("aventure") { return "book" }
            if l.contains("canevas") { return "square.on.square.dashed" }
            return "folder"
        case id == "courrier": return "envelope"
        case id == "agents": return "person.2"
        case id == "messagerie": return "bubble.left.and.bubble.right"
        case id == "bases": return "cylinder.split.1x2"
        case id == "notes": return "note.text"
        case id == "rappels": return "bell"
        case id == "coffre": return "iphone"
        case id == "corpus": return "doc.text.magnifyingglass"
        case id == "kanban": return "rectangle.split.3x1"
        case id == "agenda": return "calendar"
        case id == "contacts": return "person.crop.circle"
        case id == "moodboard": return "paintpalette"
        case id == "podcast": return "mic"
        case id == "studies": return "graduationcap"
        case id == "carte": return "map"
        case id == "media": return "play.rectangle"
        default: return "square.stack"
        }
    }
}

/// Pastille d'icône : carré arrondi teinté (accent par défaut).
struct IconBadge: View {
    @Environment(\.palette) private var p
    let symbol: String
    var tint: Color? = nil
    var size: CGFloat = 30

    var body: some View {
        let c = tint ?? p.primary
        Image(systemName: symbol)
            .font(.system(size: size * 0.47, weight: .semibold))
            .foregroundStyle(c)
            .frame(width: size, height: size)
            .background(c.opacity(0.14), in: RoundedRectangle(cornerRadius: size * 0.3, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: size * 0.3, style: .continuous).stroke(c.opacity(0.22), lineWidth: 0.8))
    }
}

/// Carte « verre » : fond carte + léger dégradé, bord fin ; `active` l'allume
/// à la couleur d'accent (sélection, élément en cours).
struct LumenCard: ViewModifier {
    @Environment(\.palette) private var p
    var active = false
    var radius: CGFloat = 16
    var padding: CGFloat = 12

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .fill(p.card)
                    .overlay(
                        LinearGradient(colors: [Color.white.opacity(0.045), .clear], startPoint: .top, endPoint: .bottom)
                            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
                    )
            }
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous)
                .stroke(active ? p.primary.opacity(0.55) : p.border, lineWidth: active ? 1 : 0.8))
            .shadow(color: active ? p.primary.opacity(0.22) : .clear, radius: 12)
    }
}

extension View {
    func lumenCard(active: Bool = false, radius: CGFloat = 16, padding: CGFloat = 12) -> some View {
        modifier(LumenCard(active: active, radius: radius, padding: padding))
    }
}

/// Pastille de texte (catégorie, statut, filtre) avec icône facultative.
struct Chip: View {
    @Environment(\.palette) private var p
    let text: String
    var symbol: String? = nil
    var tint: Color? = nil
    var filled = false

    var body: some View {
        let c = tint ?? p.mutedForeground
        HStack(spacing: 4) {
            if let symbol { Image(systemName: symbol).font(.system(size: 10, weight: .semibold)) }
            Text(text).font(.system(size: 11.5, weight: .medium)).lineLimit(1)
        }
        .foregroundStyle(filled ? p.primaryForeground : c)
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(filled ? p.primary : c.opacity(0.12), in: Capsule())
    }
}
