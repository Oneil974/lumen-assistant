import SwiftUI

/// Capsule Halo : pastille flottante sous la barre quand un agent travaille
/// (dernière étape), carte quand une notification arrive, déroulé complet
/// au toucher — même grammaire que companion-halo.js.
struct HaloView: View {
    @Environment(\.palette) private var p
    let client: LumenClient
    @State private var open = false
    @State private var shownNotice: HaloNotice?
    @State private var now = Date()

    /// Une étape reste affichée 25 s après la dernière activité.
    private var activeStep: HaloStep? {
        guard let last = client.haloLastStep, now.timeIntervalSince(last) < 25 else { return nil }
        return client.haloSteps.last
    }

    var body: some View {
        VStack(spacing: 6) {
            if shownNotice != nil || activeStep != nil || open {
                Button {
                    withAnimation(.spring(response: 0.34, dampingFraction: 0.82)) { open.toggle() }
                    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                } label: { shell }
                .buttonStyle(PressStyle())
                .transition(.scale(scale: 0.92, anchor: .top).combined(with: .opacity))

                if open { timeline.transition(.move(edge: .top).combined(with: .opacity)) }
            }
        }
        .padding(.horizontal, 12)
        .animation(.spring(response: 0.34, dampingFraction: 0.82), value: shownNotice?.id)
        .animation(.spring(response: 0.34, dampingFraction: 0.82), value: activeStep?.id)
        .onChange(of: client.haloNotice) { _, n in
            guard let n else { return }
            shownNotice = n
            client.haloNotice = nil
            Task {
                try? await Task.sleep(for: .seconds(max(2, n.timeout)))
                if shownNotice?.id == n.id && !open { shownNotice = nil }
            }
        }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                now = .now
            }
        }
    }

    private var shell: some View {
        HStack(spacing: 10) {
            ZStack {
                Circle().fill(p.muted)
                // L'agent au travail montre son personnage, comme sur l'ordinateur.
                if shownNotice == nil, activeStep != nil, let face = client.agentFace(client.haloAgentId) ?? client.agentFace(client.haloAgent) {
                    AgentAvatarView(avatar: face, size: 26, state: .work, hands: false)
                } else {
                    Image(systemName: leadSymbol)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(leadColor)
                        .symbolEffect(.pulse, isActive: shownNotice == nil && activeStep != nil)
                }
            }
            .frame(width: 26, height: 26)

            VStack(alignment: .leading, spacing: 1) {
                Text(titleText).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                if !subText.isEmpty {
                    Text(subText)
                        .font(.system(size: 11.5))
                        .foregroundStyle(p.mutedForeground)
                        .lineLimit(open ? 6 : 1)
                        .multilineTextAlignment(.leading)
                }
            }
            if client.haloSteps.count > 1 && !open {
                Text("\(client.haloSteps.count)")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(p.mutedForeground)
                    .padding(.horizontal, 7).padding(.vertical, 1)
                    .background(p.muted, in: Capsule())
            }
        }
        .padding(.leading, 10).padding(.trailing, 14).padding(.vertical, 8)
        .background(p.popover, in: RoundedRectangle(cornerRadius: open ? 20 : 999, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: open ? 20 : 999, style: .continuous).stroke(p.border))
        .shadow(color: .black.opacity(0.18), radius: 12, y: 6)
        .foregroundStyle(p.foreground)
    }

    private var titleText: String {
        if let n = shownNotice { return n.title }
        if let s = activeStep { return client.haloAgent + " · " + s.label }
        return L("Activité des agents")
    }

    private var subText: String {
        if let n = shownNotice { return n.body }
        if let s = activeStep { return s.thought ? s.input : (s.result.isEmpty ? s.input : s.result) }
        return ""
    }

    private var leadSymbol: String {
        if let n = shownNotice {
            switch n.icon ?? n.kind {
            case "success", "check": return "checkmark"
            case "error", "warn": return "exclamationmark.triangle"
            case "trophy": return "trophy"
            case "cloud": return "cloud.sun"
            case "agents": return "person.2"
            case "progress", "thinking", "bolt": return "bolt.fill"
            default: return "bell"
            }
        }
        return "bolt.fill"
    }

    private var leadColor: Color {
        switch shownNotice?.kind {
        case "success": return p.success
        case "error", "warn": return p.destructive
        default: return shownNotice == nil ? p.primary : p.mutedForeground
        }
    }

    private var timeline: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                if client.haloSteps.isEmpty {
                    Text("Aucune étape pour l'instant.")
                        .font(.system(size: 12)).foregroundStyle(p.mutedForeground)
                        .frame(maxWidth: .infinity).padding(10)
                }
                ForEach(client.haloSteps.reversed()) { s in
                    HStack(alignment: .top, spacing: 8) {
                        if let avatar = client.agentFace(s.agentID) {
                            AgentAvatarView(avatar: avatar, size: 24, state: s.ok ? .done : .fail, hands: false)
                        }
                        Text(s.date, format: .dateTime.hour().minute().second())
                            .font(.system(size: 10.5).monospacedDigit())
                            .foregroundStyle(p.mutedForeground)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(s.agentName).font(.system(size: 11, weight: .medium)).foregroundStyle(p.mutedForeground)
                            Text(s.label).font(.system(size: 12.5, weight: s.thought ? .regular : .semibold))
                                .foregroundStyle(s.thought ? p.mutedForeground : p.foreground)
                            let detail = s.thought ? s.input : (s.result.isEmpty ? s.input : s.result)
                            if !detail.isEmpty {
                                Text(detail).font(.system(size: 11)).italic(s.thought)
                                    .foregroundStyle(p.mutedForeground).lineLimit(3)
                            }
                        }
                        Spacer(minLength: 0)
                        if !s.thought {
                            Image(systemName: s.ok ? "checkmark" : "xmark")
                                .font(.system(size: 11, weight: .bold))
                                .foregroundStyle(s.ok ? p.success : p.destructive)
                        }
                    }
                    .padding(.horizontal, 10).padding(.vertical, 7)
                }
            }
        }
        .frame(maxHeight: 320)
        .background(p.popover, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(p.border))
        .shadow(color: .black.opacity(0.22), radius: 16, y: 8)
    }
}
