import SwiftUI
import WidgetKit

/// Complication / Smart Stack : backend, modèle, décisions en attente.
/// Lit l'état que l'app de la montre range dans l'App Group.
struct WatchStatus: TimelineEntry {
    let date: Date
    let source: String
    let model: String
    let online: Bool
    let pending: Int
}

struct WatchProvider: TimelineProvider {
    private func current() -> WatchStatus {
        let d = UserDefaults(suiteName: "group.io.github.oneil974.lumen")?.dictionary(forKey: "watchStatus") ?? [:]
        return WatchStatus(date: .now, source: d["source"] as? String ?? "Lumen", model: d["model"] as? String ?? "",
                           online: d["online"] as? Bool ?? false, pending: d["pending"] as? Int ?? 0)
    }
    func placeholder(in context: Context) -> WatchStatus { WatchStatus(date: .now, source: "llama.cpp", model: "LFM2.5", online: true, pending: 0) }
    func getSnapshot(in context: Context, completion: @escaping (WatchStatus) -> Void) { completion(current()) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<WatchStatus>) -> Void) {
        completion(Timeline(entries: [current()], policy: .after(.now.addingTimeInterval(1800))))
    }
}

@main
struct LumenWatchWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "LumenWatchStatus", provider: WatchProvider()) { s in
            WatchStatusView(s: s).containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Lumen")
        .description("État de Lumen et décisions en attente.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline, .accessoryCorner])
    }
}

struct WatchStatusView: View {
    @Environment(\.widgetFamily) private var family
    let s: WatchStatus

    var body: some View {
        switch family {
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                if s.pending > 0 {
                    VStack(spacing: 0) { Image(systemName: "exclamationmark.circle.fill"); Text("\(s.pending)").font(.caption2) }
                } else {
                    Image(systemName: s.online ? "sparkles" : "moon.zzz")
                }
            }
        case .accessoryInline:
            Text(s.pending > 0 ? "Lumen · \(s.pending) à décider" : "Lumen · \(s.source)")
        case .accessoryCorner:
            Image(systemName: s.pending > 0 ? "exclamationmark.circle.fill" : "sparkles")
                .widgetLabel(s.pending > 0 ? "\(s.pending) à décider" : s.source)
        default:
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    Circle().fill(s.online ? .green : .gray).frame(width: 6, height: 6)
                    Text(s.source).font(.headline)
                }
                Text(s.model).font(.caption2).lineLimit(1)
                if s.pending > 0 { Text("\(s.pending) décision(s) en attente").font(.caption2).foregroundStyle(.red) }
            }
        }
    }
}
