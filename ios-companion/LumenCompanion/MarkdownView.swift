import SwiftUI

/// Rendu Markdown des réponses : blocs (titres, listes, code, citations,
/// tableaux, séparateurs) découpés ici, mise en forme en ligne (gras,
/// italique, `code`, liens) confiée à AttributedString.
struct MarkdownView: View {
    @Environment(\.palette) private var p
    let text: String
    @State private var preview: URL?
    @State private var opening = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(MarkdownBlock.parse(text).enumerated()), id: \.offset) { _, block in
                view(for: block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // Lien vers un fichier du coffre (PDF, document…) : aperçu Quick Look.
        .environment(\.openURL, OpenURLAction { url in
            guard url.scheme == LumenFiles.scheme else { return .systemAction }
            opening = true
            Task {
                preview = await LumenFiles.download(url.absoluteString)
                opening = false
            }
            return .handled
        })
        .overlay(alignment: .topTrailing) { if opening { ProgressView().padding(4) } }
        .sheet(item: $preview) { QuickLookSheet(url: $0).ignoresSafeArea() }
    }

    @ViewBuilder private func view(for block: MarkdownBlock) -> some View {
        switch block {
        case .paragraph(let s):
            Text(inline(s)).font(.system(size: 16)).lineSpacing(3)
        case .image(let alt, let url):
            LumenFileImage(url: url, alt: alt)
        case .heading(let level, let s):
            Text(inline(s))
                .font(.system(size: level == 1 ? 22 : level == 2 ? 19 : 17, weight: .semibold))
                .tracking(-0.3)
                .padding(.top, 4)
        case .list(let items, let ordered):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { i, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(ordered ? "\(i + 1)." : "•")
                            .font(.system(size: 16, weight: ordered ? .medium : .bold).monospacedDigit())
                            .foregroundStyle(p.mutedForeground)
                            .frame(minWidth: 14, alignment: .trailing)
                        taskOrText(item)
                    }
                    .padding(.leading, CGFloat(item.indent) * 16)
                }
            }
        case .code(let lang, let code):
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text(lang.isEmpty ? "code" : lang).font(.system(size: 11, weight: .medium))
                    Spacer()
                    Button {
                        UIPasteboard.general.string = code
                        UINotificationFeedbackGenerator().notificationOccurred(.success)
                    } label: { Image(systemName: "doc.on.doc").font(.system(size: 11)) }
                }
                .foregroundStyle(p.mutedForeground)
                .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 4)
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(code)
                        .font(.system(size: 13, design: .monospaced))
                        .textSelection(.enabled)
                        .padding(.horizontal, 12).padding(.bottom, 12)
                }
            }
            .background(p.muted, in: RoundedRectangle(cornerRadius: 10))
        case .quote(let s):
            HStack(spacing: 10) {
                RoundedRectangle(cornerRadius: 1.5).fill(p.border).frame(width: 3)
                Text(inline(s)).font(.system(size: 15)).foregroundStyle(p.mutedForeground)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .table(let header, let rows):
            ScrollView(.horizontal, showsIndicators: false) {
                Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                    GridRow {
                        ForEach(Array(header.enumerated()), id: \.offset) { _, h in
                            cell(h, bold: true)
                        }
                    }
                    .background(p.muted)
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, r in
                        Divider().overlay(p.border)
                        GridRow {
                            ForEach(0..<header.count, id: \.self) { i in
                                cell(i < r.count ? r[i] : "", bold: false)
                            }
                        }
                    }
                }
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(p.border))
                .clipShape(RoundedRectangle(cornerRadius: 10))
            }
        case .rule:
            Divider().overlay(p.border).padding(.vertical, 4)
        }
    }

    @ViewBuilder private func taskOrText(_ item: MarkdownBlock.Item) -> some View {
        if let done = item.task {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: done ? "checkmark.square.fill" : "square")
                    .foregroundStyle(done ? p.primary : p.mutedForeground)
                Text(inline(item.text)).font(.system(size: 16)).strikethrough(done, color: p.mutedForeground)
            }
        } else {
            Text(inline(item.text)).font(.system(size: 16)).lineSpacing(3)
        }
    }

    private func cell(_ s: String, bold: Bool) -> some View {
        Text(inline(s))
            .font(.system(size: 14, weight: bold ? .semibold : .regular))
            .padding(.horizontal, 10).padding(.vertical, 7)
            .frame(minWidth: 60, alignment: .leading)
    }

    private func inline(_ s: String) -> AttributedString {
        var a = (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(s)
        // `code` en ligne : police à chasse fixe sur fond discret.
        for run in a.runs where run.inlinePresentationIntent?.contains(.code) == true {
            a[run.range].font = .system(size: 14, design: .monospaced)
            a[run.range].backgroundColor = p.muted
        }
        return a
    }
}

enum MarkdownBlock {
    struct Item { let text: String; let indent: Int; let task: Bool? }

    case paragraph(String)
    case heading(Int, String)
    case list([Item], ordered: Bool)
    case code(lang: String, code: String)
    case quote(String)
    case table(header: [String], rows: [[String]])
    case rule
    /// Image du coffre unifié (`![alt](lumenmedia://…)` seule sur sa ligne).
    case image(alt: String, url: String)

    static func parse(_ source: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var para: [String] = []
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var i = 0

        func flush() {
            if !para.isEmpty { blocks.append(.paragraph(para.joined(separator: "\n"))); para = [] }
        }

        while i < lines.count {
            let line = lines[i]
            let t = line.trimmingCharacters(in: .whitespaces)

            // Bloc de code clôturé.
            if t.hasPrefix("```") || t.hasPrefix("~~~") {
                flush()
                let fence = String(t.prefix(3))
                let lang = String(t.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var code: [String] = []
                i += 1
                while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(fence) {
                    code.append(lines[i]); i += 1
                }
                blocks.append(.code(lang: lang, code: code.joined(separator: "\n")))
                i += 1
                continue
            }
            if t.isEmpty { flush(); i += 1; continue }

            // Image(s) du coffre : chacune devient un bloc, le texte autour reste.
            if t.contains("](lumenmedia://localhost/"), t.contains("![") {
                let re = /!\[([^\]]*)\]\((lumenmedia:\/\/localhost\/[^\s)]+)\)/
                let matches = t.matches(of: re)
                if !matches.isEmpty {
                    flush()
                    var rest = t
                    for m in matches { blocks.append(.image(alt: String(m.output.1), url: String(m.output.2))); rest = rest.replacingOccurrences(of: String(m.output.0), with: "") }
                    let leftover = rest.trimmingCharacters(in: .whitespaces)
                    if !leftover.isEmpty { blocks.append(.paragraph(leftover)) }
                    i += 1; continue
                }
            }

            // Titre.
            if let h = t.firstIndex(where: { $0 != "#" }), t.hasPrefix("#"),
               t.distance(from: t.startIndex, to: h) <= 6, t[h] == " " {
                flush()
                blocks.append(.heading(t.distance(from: t.startIndex, to: h), String(t[h...]).trimmingCharacters(in: .whitespaces)))
                i += 1; continue
            }
            // Séparateur.
            if ["---", "***", "___"].contains(t.replacingOccurrences(of: " ", with: "")) {
                flush(); blocks.append(.rule); i += 1; continue
            }
            // Tableau : ligne d'en-tête + ligne de séparation |---|---|.
            if t.hasPrefix("|"), i + 1 < lines.count, isTableSeparator(lines[i + 1]) {
                flush()
                let header = cells(t)
                var rows: [[String]] = []
                i += 2
                while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("|") {
                    rows.append(cells(lines[i])); i += 1
                }
                blocks.append(.table(header: header, rows: rows))
                continue
            }
            // Citation.
            if t.hasPrefix(">") {
                flush()
                var q: [String] = []
                while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(">") {
                    q.append(String(lines[i].trimmingCharacters(in: .whitespaces).dropFirst()).trimmingCharacters(in: .whitespaces))
                    i += 1
                }
                blocks.append(.quote(q.joined(separator: "\n")))
                continue
            }
            // Liste (puces ou numérotée), avec sous-niveaux par indentation.
            if listMarker(line) != nil {
                flush()
                var items: [Item] = []
                let ordered = listMarker(line)!.ordered
                while i < lines.count, let m = listMarker(lines[i]), m.indent > 0 || m.ordered == ordered {
                    var text = m.text
                    var task: Bool?
                    if text.hasPrefix("[ ] ") { task = false; text.removeFirst(4) }
                    else if text.lowercased().hasPrefix("[x] ") { task = true; text.removeFirst(4) }
                    items.append(Item(text: text, indent: m.indent, task: task))
                    i += 1
                }
                blocks.append(.list(items, ordered: ordered))
                continue
            }
            para.append(line)
            i += 1
        }
        flush()
        return blocks
    }

    private static func listMarker(_ line: String) -> (text: String, indent: Int, ordered: Bool)? {
        let spaces = line.prefix { $0 == " " || $0 == "\t" }.reduce(0) { $0 + ($1 == "\t" ? 4 : 1) }
        let t = line.trimmingCharacters(in: .whitespaces)
        for b in ["- ", "* ", "+ "] where t.hasPrefix(b) {
            return (String(t.dropFirst(2)), spaces / 2, false)
        }
        if let dot = t.firstIndex(where: { $0 == "." || $0 == ")" }),
           !t[..<dot].isEmpty, t[..<dot].allSatisfy(\.isNumber),
           t.index(after: dot) < t.endIndex, t[t.index(after: dot)] == " " {
            return (String(t[t.index(dot, offsetBy: 2)...]), spaces / 2, true)
        }
        return nil
    }

    private static func isTableSeparator(_ line: String) -> Bool {
        let t = line.trimmingCharacters(in: .whitespaces)
        return t.hasPrefix("|") && t.contains("-") && t.allSatisfy { "|-: ".contains($0) }
    }

    private static func cells(_ line: String) -> [String] {
        var t = line.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("|") { t.removeFirst() }
        if t.hasSuffix("|") { t.removeLast() }
        return t.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }
}
