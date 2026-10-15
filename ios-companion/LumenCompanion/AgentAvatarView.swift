import SwiftUI

// Avatars des agents — personnages « Shape Characters » de Kenney (CC0), le
// même rendu que sur l'ordinateur (src/lib/agent-avatar.js) : corps, visage et
// deux mains posées de part et d'autre, animés (respiration, clignement, mains
// qui flottent ; plus vif « au travail »). Les pièces vivent dans
// Assets.xcassets (préfixe `kenney_`). Toute la géométrie est reprise du module
// web pour que l'agent ait la même tête partout.

struct AgentAvatar: Hashable {
    var color: String
    var shape: String
    var face: String
    var hand: String
    var hand2: String
    var anim: String

    static let colors = ["blue", "purple", "pink", "red", "yellow", "green"]
    static let shapes = ["squircle", "circle", "square", "rhombus"]
    static let faces = ["a", "l", "c", "b", "f", "d", "e", "h", "g", "i", "k"]
    static let hands = ["open", "peace", "thumb", "point", "rock", "closed"]
    static let anims = ["float", "bounce", "sway", "still"]

    /// Avatar complet et valide ; champs absents ⇒ tirés de `seed` (stable,
    /// même tirage que le bureau pour les agents créés avant les avatars).
    init(_ j: [String: Any]?, seed: String) {
        let a = j ?? [:]
        let h = AgentAvatar.hash(seed)
        func pick(_ list: [String], _ key: String, _ shift: UInt32) -> String {
            if let v = a[key] as? String, list.contains(v) { return v }
            return list[Int((h >> shift) % UInt32(list.count))]
        }
        color = pick(Self.colors, "color", 0)
        shape = pick(Self.shapes, "shape", 5)
        face = pick(Self.faces, "face", 9)
        hand = pick(Self.hands, "hand", 14)
        if let v = a["hand2"] as? String, Self.hands.contains(v) { hand2 = v } else { hand2 = hand }
        if let v = a["anim"] as? String, Self.anims.contains(v) { anim = v } else { anim = "float" }
    }

    /// FNV-1a sur les unités UTF-16, comme `hash()` côté JS.
    static func hash(_ s: String) -> UInt32 {
        var h: UInt32 = 2166136261
        for u in (s.isEmpty ? "lumen" : s).utf16 { h ^= UInt32(u); h = h &* 16777619 }
        return h
    }

    static func random() -> AgentAvatar {
        let hand = hands.randomElement()!
        var a = AgentAvatar(nil, seed: UUID().uuidString)
        a.color = colors.randomElement()!; a.shape = shapes.randomElement()!; a.face = faces.randomElement()!
        a.hand = hand; a.hand2 = Bool.random() ? hand : hands.randomElement()!
        a.anim = ["float", "bounce", "sway"].randomElement()!
        return a
    }

    var json: [String: Any] { ["color": color, "shape": shape, "face": face, "hand": hand, "hand2": hand2, "anim": anim] }

    var tint: Color {
        switch color {
        case "purple": Color(red: 0.557, green: 0.357, blue: 0.878)
        case "pink": Color(red: 0.949, green: 0.498, blue: 0.749)
        case "red": Color(red: 0.878, green: 0.329, blue: 0.373)
        case "yellow": Color(red: 0.961, green: 0.694, blue: 0.176)
        case "green": Color(red: 0.361, green: 0.749, blue: 0.431)
        default: Color(red: 0.435, green: 0.561, blue: 0.941)
        }
    }
}

enum AvatarState { case idle, work, done, fail }

struct AgentAvatarView: View {
    let avatar: AgentAvatar
    var size: CGFloat = 40
    var state: AvatarState = .idle
    /// Mains : par défaut à partir de 30 pt (en dessous elles deviennent illisibles).
    var hands: Bool? = nil
    var animate = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    // Gabarits natifs (px) du pack, comme FACE_DIMS / HAND_DIMS côté web.
    private static let faceDims: [String: CGSize] = [
        "a": .init(width: 100, height: 58), "b": .init(width: 100, height: 48), "c": .init(width: 118, height: 60),
        "d": .init(width: 106, height: 66), "e": .init(width: 110, height: 80), "f": .init(width: 110, height: 66),
        "g": .init(width: 110, height: 64), "h": .init(width: 110, height: 72), "i": .init(width: 118, height: 84),
        "j": .init(width: 100, height: 78), "k": .init(width: 110, height: 80), "l": .init(width: 106, height: 74),
    ]
    private static let handDims: [String: CGSize] = [
        "open": .init(width: 68, height: 76), "closed": .init(width: 64, height: 60), "peace": .init(width: 52, height: 80),
        "point": .init(width: 68, height: 72), "rock": .init(width: 60, height: 78), "thumb": .init(width: 56, height: 72),
    ]
    /// Pose de la main GAUCHE : centre vertical (fraction de la boîte) et
    /// inclinaison ; la droite en est le miroir.
    private static let handPose: [String: (y: CGFloat, rot: Double)] = [
        "open": (0.40, -14), "closed": (0.56, 0), "peace": (0.34, 16), "point": (0.40, -12), "rock": (0.34, -8), "thumb": (0.40, 6),
    ]
    private static let body: CGFloat = 0.60          // part de la largeur occupée par le corps
    private static let scale: CGFloat = body / 160    // px natifs → fraction de boîte

    private var showHands: Bool { hands ?? (size >= 30) }
    private var faceKey: String { state == .fail ? "j" : state == .done ? "l" : avatar.face }
    private var handKeys: (String, String) {
        switch state {
        case .done: ("thumb", "thumb")
        case .fail: ("closed", "closed")
        default: (avatar.hand, avatar.hand2)
        }
    }
    private var delay: Double {
        Double(AgentAvatar.hash("\(avatar.color)\(avatar.face)") % 4000) / 1000
    }

    var body: some View {
        if animate && !reduceMotion && avatar.anim != "still" {
            TimelineView(.animation) { ctx in
                figure(t: ctx.date.timeIntervalSinceReferenceDate + delay)
            }
            .frame(width: size, height: size)
        } else {
            figure(t: nil).frame(width: size, height: size)
        }
    }

    /// Onde 0 → 1 → 0 sur la période `period` (même allure qu'un ease-in-out CSS).
    private func wave(_ t: Double?, _ period: Double, offset: Double = 0) -> CGFloat {
        guard let t else { return 0 }
        return CGFloat((1 - cos(2 * .pi * (t + offset) / period)) / 2)
    }

    private func figure(t: Double?) -> some View {
        let s = size
        let hands = showHands
        let rigW = s * (hands ? Self.body : 0.80)
        let rigX = s * (hands ? (1 - Self.body) / 2 : 0.10)
        let rigY = s * (hands ? 0.06 : 0.04)
        let working = state == .work
        let mode = working ? "work" : avatar.anim
        // Mouvement du corps (translation en fraction de sa hauteur).
        let period = mode == "work" ? 0.9 : mode == "bounce" ? 1.6 : mode == "sway" ? 3.0 : 3.4
        let v = wave(t, period)
        let lift: CGFloat = mode == "work" ? 0.12 : mode == "bounce" ? 0.12 : mode == "sway" ? 0 : 0.06
        let dy = -lift * rigW * v
        let sway = mode == "sway" ? Double(-5 + 10 * v) : 0
        let squash: CGFloat = mode == "float" || mode == "sway" ? 0.015 : 0.04
        // Clignement : les yeux se ferment brièvement toutes les 5,2 s.
        var blink: CGFloat = 1
        if let t {
            let f = (t.truncatingRemainder(dividingBy: 5.2)) / 5.2
            if f > 0.92 { blink = 1 - 0.88 * CGFloat(1 - abs(f - 0.95) / 0.05).clamped() }
        }
        let fd = Self.faceDims[faceKey] ?? Self.faceDims["a"]!
        let faceW = rigW * fd.width / 160
        let faceH = faceW * fd.height / fd.width

        return ZStack(alignment: .topLeading) {
            if hands {
                Ellipse()
                    .fill(Color(red: 0.16, green: 0.16, blue: 0.27).opacity(0.22 * (1 - 0.3 * Double(v))))
                    .frame(width: s * 0.46 * (1 - 0.18 * v), height: s * 0.09)
                    .position(x: s / 2, y: s * 0.915)
                hand(handKeys.0, left: true, t: t)
            }
            ZStack {
                piece("\(avatar.color)_body_\(avatar.shape)").frame(width: rigW, height: rigW)
                piece("face_\(faceKey)")
                    .frame(width: faceW, height: faceH)
                    .scaleEffect(x: 1, y: blink)
                    .offset(y: 0.04 * faceH)
            }
            .frame(width: rigW, height: rigW)
            .scaleEffect(x: 1 - squash * v, y: 1 + squash * v, anchor: .bottom)
            .rotationEffect(.degrees(sway), anchor: .bottom)
            .offset(x: rigX, y: rigY + dy)
            if hands { hand(handKeys.1, left: false, t: t) }
        }
        .frame(width: s, height: s, alignment: .topLeading)
        .accessibilityHidden(true)
    }

    private func hand(_ key: String, left: Bool, t: Double?) -> some View {
        let s = size
        let dims = Self.handDims[key] ?? Self.handDims["open"]!
        let pose = Self.handPose[key] ?? Self.handPose["open"]!
        let w = dims.width * Self.scale * 0.95 * s
        let h = dims.height * Self.scale * 0.95 * s
        let cx = (left ? 0.11 : 0.89) * s
        let working = state == .work
        let v = working ? wave(t, 0.45, offset: left ? 0 : 0.22) : wave(t, 3.4, offset: left ? 0.35 : 1.1)
        let dy = (working ? -0.14 : -0.10) * h * v + (state == .fail ? 0.12 * h : 0)
        let tilt = working ? 0 : -6 * Double(v)
        let name = avatar.color == "yellow" ? "hand_yellow_\(key)" : "\(avatar.color)_hand_\(key)"
        return piece(name)
            .frame(width: w, height: h)
            .rotationEffect(.degrees(pose.rot))
            .scaleEffect(x: left ? 1 : -1, y: 1)
            .rotationEffect(.degrees(tilt), anchor: UnitPoint(x: 0.5, y: 0.85))
            .position(x: cx, y: pose.y * s + dy)
    }

    private func piece(_ name: String) -> some View {
        Image("kenney_\(name)").resizable().interpolation(.high).scaledToFit()
    }
}

private extension CGFloat {
    func clamped() -> CGFloat { Swift.min(1, Swift.max(0, self)) }
}

/// Choix de l'avatar dans la fiche d'un agent : aperçu + réglages en grille.
struct AvatarPicker: View {
    @Environment(\.palette) private var p
    @Binding var avatar: AgentAvatar
    var onChange: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 14) {
                AgentAvatarView(avatar: avatar, size: 92)
                    .frame(width: 104, height: 104)
                    .background(avatar.tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                VStack(alignment: .leading, spacing: 8) {
                    Button { avatar = .random(); onChange() } label: {
                        Label("Surprends-moi", systemImage: "dice").font(.system(size: 13, weight: .semibold))
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .background(p.muted, in: Capsule())
                    }
                    .buttonStyle(PressStyle())
                    Text("Son visage dans les discussions, Halo et l'activité.").font(.system(size: 12)).foregroundStyle(p.mutedForeground)
                }
            }
            row("Couleur", AgentAvatar.colors) { c in
                Circle().fill(AgentAvatar(["color": c], seed: "").tint).frame(width: 26, height: 26)
            } selected: { $0 == avatar.color } set: { avatar.color = $0 }
            row("Forme", AgentAvatar.shapes) { sh in
                Image("kenney_\(avatar.color)_body_\(sh)").resizable().scaledToFit().frame(width: 30, height: 30)
            } selected: { $0 == avatar.shape } set: { avatar.shape = $0 }
            row("Visage", AgentAvatar.faces) { f in
                ZStack {
                    Image("kenney_\(avatar.color)_body_\(avatar.shape)").resizable().scaledToFit()
                    Image("kenney_face_\(f)").resizable().scaledToFit().frame(width: 20)
                }
                .frame(width: 32, height: 32)
            } selected: { $0 == avatar.face } set: { avatar.face = $0 }
            row("Main gauche", AgentAvatar.hands) { h in handThumb(h) } selected: { $0 == avatar.hand } set: { avatar.hand = $0 }
            row("Main droite", AgentAvatar.hands) { h in handThumb(h).scaleEffect(x: -1) } selected: { $0 == avatar.hand2 } set: { avatar.hand2 = $0 }
            row("Animation", AgentAvatar.anims) { a in
                Text(animLabel(a)).font(.system(size: 12, weight: .medium)).padding(.horizontal, 6)
            } selected: { $0 == avatar.anim } set: { avatar.anim = $0 }
        }
    }

    private func handThumb(_ h: String) -> some View {
        Image(avatar.color == "yellow" ? "kenney_hand_yellow_\(h)" : "kenney_\(avatar.color)_hand_\(h)")
            .resizable().scaledToFit().frame(width: 26, height: 26)
    }

    private func animLabel(_ a: String) -> String {
        switch a {
        case "bounce": String(localized: "Rebondit")
        case "sway": String(localized: "Se balance")
        case "still": String(localized: "Immobile")
        default: String(localized: "Flotte")
        }
    }

    private func row<Cell: View>(_ title: LocalizedStringKey, _ items: [String], @ViewBuilder cell: @escaping (String) -> Cell,
                                 selected: @escaping (String) -> Bool, set: @escaping (String) -> Void) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 11, weight: .semibold)).textCase(.uppercase).foregroundStyle(p.mutedForeground)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(items, id: \.self) { item in
                        Button { set(item); onChange() } label: {
                            cell(item)
                                .frame(minWidth: 40, minHeight: 40)
                                .background(selected(item) ? avatar.tint.opacity(0.18) : p.muted.opacity(0.6),
                                            in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    .stroke(selected(item) ? avatar.tint : .clear, lineWidth: 2))
                        }
                        .buttonStyle(PressStyle())
                    }
                }
            }
        }
    }
}
