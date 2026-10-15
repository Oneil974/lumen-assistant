import ActivityKit
import SwiftUI
import WidgetKit

// Extension de widgets de l'app Lumen :
//  - widget « Lumen » (écran d'accueil / verrouillé) : raccourcis Demander,
//    Capturer, Parler (mains libres), Agents — liens profonds lumen://… ;
//  - Activité en direct : agents au travail et décisions en attente, sur
//    l'écran verrouillé et dans la Dynamic Island (comme la capsule Halo).

@main
struct LumenWidgetsBundle: WidgetBundle {
    var body: some Widget {
        LumenStatusWidget()
        LumenVaultWidget()
        TalkControl()
        AskControl()
        CaptureControl()
        LumenQuickWidget()
        LumenLiveActivity()
    }
}

// MARK: Widget de raccourcis

struct QuickEntry: TimelineEntry { let date: Date }

struct QuickProvider: TimelineProvider {
    func placeholder(in context: Context) -> QuickEntry { QuickEntry(date: .now) }
    func getSnapshot(in context: Context, completion: @escaping (QuickEntry) -> Void) { completion(QuickEntry(date: .now)) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<QuickEntry>) -> Void) {
        completion(Timeline(entries: [QuickEntry(date: .now)], policy: .never))
    }
}

struct LumenQuickWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "LumenQuick", provider: QuickProvider()) { _ in
            QuickView()
                .containerBackground(for: .widget) { WidgetBackdrop() }
        }
        .configurationDisplayName("Lumen")
        .description("Demander, capturer, parler à Lumen.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular])
    }
}

struct QuickView: View {
    @Environment(\.widgetFamily) private var family

    var body: some View {
        switch family {
        case .accessoryCircular:
            Link(destination: LumenLink.talk.url) {
                ZStack { AccessoryWidgetBackground(); Image(systemName: "waveform") }
            }
        case .accessoryRectangular:
            Link(destination: LumenLink.ask.url) {
                VStack(alignment: .leading) {
                    Label("Lumen", systemImage: "sparkles").font(.headline)
                    Text("Demander à Lumen").font(.caption)
                }
            }
        case .systemSmall:
            VStack(alignment: .leading, spacing: 10) {
                Text("Lumen").font(.system(size: 18, weight: .bold)).foregroundStyle(.white)
                Spacer()
                HStack(spacing: 10) {
                    tile(.ask, "bubble.left.fill")
                    tile(.talk, "waveform")
                }
            }
        default:
            VStack(alignment: .leading, spacing: 12) {
                Text("Lumen").font(.system(size: 18, weight: .bold)).foregroundStyle(.white)
                HStack(spacing: 10) {
                    tile(.ask, "bubble.left.fill", "Demander")
                    tile(.capture, "square.and.pencil", "Capturer")
                    tile(.talk, "waveform", "Parler")
                    tile(.agents, "person.2.fill", "Agents")
                }
            }
        }
    }

    private func tile(_ link: LumenLink, _ symbol: String, _ label: LocalizedStringKey? = nil) -> some View {
        Link(destination: link.url) {
            VStack(spacing: 6) {
                Image(systemName: symbol)
                    .font(.system(size: 18, weight: .semibold))
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .background(Color.white.opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
                if let label { Text(label).font(.system(size: 11)).foregroundStyle(.white.opacity(0.7)) }
            }
            .foregroundStyle(.white)
        }
    }
}

// MARK: Activité en direct

struct LumenLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: LumenActivityAttributes.self) { ctx in
            // Écran verrouillé
            HStack(spacing: 12) {
                lead(ctx.state)
                VStack(alignment: .leading, spacing: 2) {
                    Text(ctx.state.title).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                    Text(ctx.state.detail).font(.system(size: 13)).foregroundStyle(.secondary).lineLimit(2)
                }
                Spacer(minLength: 0)
                if ctx.state.pending > 0 {
                    Text("\(ctx.state.pending)")
                        .font(.system(size: 13, weight: .bold)).foregroundStyle(.white)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Color.red, in: Capsule())
                }
            }
            .padding(14)
            .activityBackgroundTint(Color.black.opacity(0.75))
            .widgetURL(ctx.state.pending > 0 ? LumenLink.agents.url : nil)
        } dynamicIsland: { ctx in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { lead(ctx.state) }
                DynamicIslandExpandedRegion(.center) {
                    Text(ctx.state.title).font(.system(size: 14, weight: .semibold)).lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Text(ctx.state.detail).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(2)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if ctx.state.pending > 0 {
                        Text("\(ctx.state.pending)").font(.system(size: 14, weight: .bold)).foregroundStyle(.red)
                    }
                }
            } compactLeading: {
                Image(systemName: ctx.state.pending > 0 ? "exclamationmark.circle.fill" : "bolt.fill")
                    .foregroundStyle(ctx.state.pending > 0 ? .red : .mint)
            } compactTrailing: {
                Text(ctx.state.pending > 0 ? "\(ctx.state.pending)" : "…").font(.system(size: 12, weight: .semibold))
            } minimal: {
                Image(systemName: ctx.state.pending > 0 ? "exclamationmark.circle.fill" : "bolt.fill")
                    .foregroundStyle(ctx.state.pending > 0 ? .red : .mint)
            }
            .widgetURL(LumenLink.agents.url)
        }
    }

    private func lead(_ s: LumenActivityAttributes.ContentState) -> some View {
        Image(systemName: s.pending > 0 ? "exclamationmark.circle.fill" : "bolt.fill")
            .font(.system(size: 18, weight: .semibold))
            .foregroundStyle(s.pending > 0 ? .red : .mint)
            .frame(width: 32, height: 32)
            .background(Color.white.opacity(0.1), in: Circle())
    }
}
