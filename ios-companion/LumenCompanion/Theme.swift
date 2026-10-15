import SwiftUI
import WidgetKit

/// Palette du compagnon : les jetons shadcn « neutral » de src/lib/tokens.css
/// (convertis d'OKLCH en sRGB), en clair et en sombre, + les accents proposés
/// par la PWA. Aucune couleur n'est écrite ailleurs dans l'app.
struct Palette {
    let background, foreground, card, popover, secondary, muted, mutedForeground,
        border, primary, primaryForeground, destructive, sidebar, success: Color

    static let dark = Palette(
        background: Color(hex: 0x0A0A0A), foreground: Color(hex: 0xFAFAFA),
        card: Color(hex: 0x171717), popover: Color(hex: 0x171717),
        secondary: Color(hex: 0x262626), muted: Color(hex: 0x262626),
        mutedForeground: Color(hex: 0xA1A1A1), border: Color.white.opacity(0.10),
        primary: Color(hex: 0xE5E5E5), primaryForeground: Color(hex: 0x171717),
        destructive: Color(hex: 0xFF6467), sidebar: Color(hex: 0x171717),
        success: Color(hex: 0x3FCB78))

    static let light = Palette(
        background: .white, foreground: Color(hex: 0x0A0A0A),
        card: .white, popover: .white,
        secondary: Color(hex: 0xF5F5F5), muted: Color(hex: 0xF5F5F5),
        mutedForeground: Color(hex: 0x737373), border: Color(hex: 0xE5E5E5),
        primary: Color(hex: 0x171717), primaryForeground: Color(hex: 0xFAFAFA),
        destructive: Color(hex: 0xE7000B), sidebar: Color(hex: 0xFAFAFA),
        success: Color(hex: 0x16A34A))

    func with(accent: Accent?) -> Palette {
        guard let accent else { return self }
        return Palette(background: background, foreground: foreground, card: card, popover: popover,
                       secondary: secondary, muted: muted, mutedForeground: mutedForeground,
                       border: border, primary: accent.color, primaryForeground: accent.ink,
                       destructive: destructive, sidebar: sidebar, success: success)
    }
}

/// Mêmes accents et mêmes identifiants que la PWA (clé `uiAccent`).
struct Accent: Identifiable, Hashable {
    let id: String
    let label: String
    let color: Color
    let ink: Color

    static let all: [Accent] = [
        Accent(id: "orbe-rose", label: "Rose", color: Color(hex: 0xEFA3C4), ink: Color(hex: 0x241A1E)),
        Accent(id: "orbe-violet", label: "Violet", color: Color(hex: 0xC0AEF3), ink: Color(hex: 0x1E1B24)),
        Accent(id: "orbe-bleu", label: "Bleu", color: Color(hex: 0x8EC0F0), ink: Color(hex: 0x1A1D24)),
        Accent(id: "orbe-menthe", label: "Menthe", color: Color(hex: 0x86E3C3), ink: Color(hex: 0x1A2420)),
        Accent(id: "orbe-peche", label: "Pêche", color: Color(hex: 0xF4B192), ink: Color(hex: 0x241D1A)),
        Accent(id: "blue", label: "Azur", color: Color(hex: 0x155DFC), ink: .white),
        Accent(id: "green", label: "Vert", color: Color(hex: 0x009966), ink: .white),
        Accent(id: "amber", label: "Ambre", color: Color(hex: 0xFE9A00), ink: Color(hex: 0x1C1917)),
        Accent(id: "rose", label: "Framboise", color: Color(hex: 0xEC003F), ink: .white),
    ]

    static func find(_ id: String) -> Accent? { all.first { $0.id == id } }

    /// Mêmes teintes en hexadécimal, partagées avec les widgets (App Group).
    static let hex: [String: UInt32] = [
        "orbe-rose": 0xEFA3C4, "orbe-violet": 0xC0AEF3, "orbe-bleu": 0x8EC0F0, "orbe-menthe": 0x86E3C3,
        "orbe-peche": 0xF4B192, "blue": 0x155DFC, "green": 0x009966, "amber": 0xFE9A00, "rose": 0xEC003F,
    ]
}

enum ThemeChoice: String, CaseIterable, Identifiable {
    case system, light, dark
    var id: String { rawValue }
    var label: String {
        switch self {
        case .system: "Auto"
        case .light: "Clair"
        case .dark: "Sombre"
        }
    }
    var scheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

private struct PaletteKey: EnvironmentKey {
    static let defaultValue = Palette.dark
}

extension EnvironmentValues {
    var palette: Palette {
        get { self[PaletteKey.self] }
        set { self[PaletteKey.self] = newValue }
    }
}

/// Applique thème + accent à toute la hiérarchie.
struct Themed: ViewModifier {
    @AppStorage("companionTheme") private var theme = ThemeChoice.dark.rawValue
    @AppStorage("uiAccent") private var accent = ""
    @Environment(\.colorScheme) private var system

    func body(content: Content) -> some View {
        let choice = ThemeChoice(rawValue: theme) ?? .dark
        let scheme = choice.scheme ?? system
        let palette = (scheme == .dark ? Palette.dark : Palette.light).with(accent: Accent.find(accent))
        content
            .environment(\.palette, palette)
            .preferredColorScheme(choice.scheme)
            .tint(palette.primary)
            // Les widgets reprennent l'accent choisi dans l'app.
            .task(id: accent) {
                let hex = Accent.hex[accent].map { Int($0) } ?? 0
                if SharedStore.defaults.integer(forKey: "uiAccentHex") != hex {
                    SharedStore.defaults.set(hex, forKey: "uiAccentHex")
                    WidgetCenter.shared.reloadAllTimelines()
                }
            }
    }
}

extension View {
    func themed() -> some View { modifier(Themed()) }
}

extension Color {
    init(hex: UInt32) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255)
    }
}

/// Traduit une chaîne connue à l'exécution (titres passés en paramètre,
/// messages éphémères). Une chaîne absente du catalogue — nom de modèle,
/// texte venu de l'ordinateur — ressort telle quelle.
func L(_ s: String) -> String { String(localized: String.LocalizationValue(s)) }

// MARK: Composants de base (motifs shadcn de la PWA)

/// Titre de section en petites capitales grises (`.section-label`).
struct SectionLabel: View {
    @Environment(\.palette) private var p
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(L(text).uppercased())
            .font(.system(size: 11, weight: .semibold))
            .tracking(0.6)
            .foregroundStyle(p.mutedForeground)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 8)
            .padding(.top, 14)
            .padding(.bottom, 4)
    }
}

/// Ligne d'option avec coche (`.row` / `.row.current`).
struct OptionRow: View {
    @Environment(\.palette) private var p
    let title: String
    var subtitle: String? = nil
    var selected = false
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(L(title)).font(.system(size: 15)).lineLimit(1)
                    if let subtitle, !subtitle.isEmpty {
                        Text(L(subtitle)).font(.system(size: 12)).foregroundStyle(p.mutedForeground).lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "checkmark")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(p.primary)
                    .opacity(selected ? 1 : 0)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(selected ? p.muted : .clear, in: RoundedRectangle(cornerRadius: 10))
            .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle())
    }
}

/// Contrôle segmenté façon shadcn (`.segmented`).
struct Segmented<T: Hashable>: View {
    @Environment(\.palette) private var p
    let items: [(T, String)]
    @Binding var selection: T

    var body: some View {
        HStack(spacing: 2) {
            ForEach(items, id: \.0) { value, label in
                Button {
                    withAnimation(.snappy(duration: 0.2)) { selection = value }
                    UISelectionFeedbackGenerator().selectionChanged()
                } label: {
                    Text(L(label))
                        .font(.system(size: 13, weight: selection == value ? .medium : .regular))
                        .foregroundStyle(selection == value ? p.foreground : p.mutedForeground)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 7)
                        .background {
                            if selection == value {
                                RoundedRectangle(cornerRadius: 7).fill(p.background)
                                    .shadow(color: .black.opacity(0.08), radius: 1, y: 1)
                            }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(3)
        .background(p.muted, in: RoundedRectangle(cornerRadius: 10))
    }
}

/// Retour visuel discret à l'appui (`:active { background: var(--subtle) }`).
struct PressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.6 : 1)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

struct PrimaryButton: View {
    @Environment(\.palette) private var p
    let title: String
    var disabled = false
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(L(title))
                .font(.system(size: 15, weight: .semibold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .foregroundStyle(p.primaryForeground)
                .background(p.primary, in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(PressStyle())
        .disabled(disabled)
        .opacity(disabled ? 0.4 : 1)
    }
}

struct OutlineButton: View {
    @Environment(\.palette) private var p
    let title: String
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(L(title))
                .font(.system(size: 14, weight: .medium))
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .foregroundStyle(p.foreground)
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(p.border))
        }
        .buttonStyle(PressStyle())
    }
}

/// Feuille du bas : en-tête « titre + fermer », fond popover (`.sheet`).
struct SheetScaffold<Content: View>: View {
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(L(title)).font(.system(size: 16, weight: .semibold))
                Spacer()
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(p.mutedForeground)
                        .frame(width: 30, height: 30)
                        .background(p.muted, in: Circle())
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 18)
            .padding(.bottom, 6)
            ScrollView {
                VStack(spacing: 2) { content }
                    .padding(.horizontal, 12)
                    .padding(.bottom, 24)
            }
        }
        .background(p.popover)
        .foregroundStyle(p.foreground)
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(20)
        .presentationBackground(p.popover)
    }
}
