//! Rendu PDF de fichiers texte (Markdown & formats faciles à transformer).
//!
//! 100 % Rust : `pulldown-cmark` pour analyser le Markdown, `pdf-writer` pour
//! écrire le PDF avec les polices de base PDF (Helvetica/Courier) —
//! donc aucun binaire externe ni fichier de police à embarquer.
//!
//! La conversion produit une liste de lignes déjà stylées et coupées à la
//! largeur de page (`Line`), qu'un petit moteur de mise en page pagine ensuite.

use image::{DynamicImage, GenericImageView};
use miniz_oxide::deflate::{compress_to_vec_zlib, CompressionLevel};
use pdf_writer::{Content, Filter, Finish, Name, Pdf, Rect, Ref, Str, TextStr};
use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use serde_json::Value;

// Géométrie A4 (en points PostScript, 1 pt = 1/72").
const PAGE_W_PT: f32 = 595.28;
const PAGE_H_PT: f32 = 841.89;
const MARGIN_PT: f32 = 56.69; // ~20 mm
const TEXT_W_PT: f32 = PAGE_W_PT - 2.0 * MARGIN_PT;

#[derive(Clone, Copy, PartialEq)]
enum Style {
    Regular,
    Bold,
    Italic,
    Mono,
}

/// Fragment de ligne portant son propre style. Une ligne Markdown mélange
/// couramment du romain, du **gras**, de l'*italique* et du `code` : sans
/// segments, tout retombait en romain et le PDF perdait la structure du texte.
#[derive(Clone)]
struct Span {
    text: String,
    style: Style,
}

#[derive(Clone)]
struct Line {
    spans: Vec<Span>,
    size: f32,
    indent: f32,      // retrait gauche en points
    space_after: f32, // espace ajouté sous la ligne, en points
    /// Rangée de tableau : cellules dessinées à des positions fixes, avec un
    /// filet. `None` pour une ligne de texte ordinaire.
    table: Option<TableRow>,
    /// Filet horizontal seul (`---` en Markdown) : dessiné, pas écrit.
    rule: bool,
}

#[derive(Clone)]
struct TableCell {
    text: String,
    x: f32,      // décalage depuis la marge, en points
    width: f32,  // largeur de la colonne
    numeric: bool,
}

#[derive(Clone)]
struct TableRow {
    cells: Vec<TableCell>,
    header: bool,
    /// Dernière rangée du tableau : filet plus appuyé dessous.
    last: bool,
}

impl Line {
    fn simple(text: String, size: f32, style: Style, indent: f32, space_after: f32) -> Self {
        Line {
            spans: vec![Span { text, style }],
            size,
            indent,
            space_after,
            table: None,
            rule: false,
        }
    }
    fn is_blank(&self) -> bool {
        self.spans.iter().all(|s| s.text.is_empty())
    }
}

/// Formats pris en charge → libellé humain. Sert aussi de garde côté commande.
pub fn is_supported(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "md" | "markdown"
            | "mdown"
            | "txt"
            | "text"
            | "log"
            | "csv"
            | "tsv"
            | "json"
            | "html"
            | "htm"
    )
}

/// Convertit un contenu texte en PDF (octets). `title` figure dans les métadonnées.
pub fn render_to_pdf(title: &str, ext: &str, content: &str) -> Result<Vec<u8>, String> {
    let ext = ext.to_ascii_lowercase();
    let lines = match ext.as_str() {
        // Le Markdown passe par le flux : c'est lui qui sait poser les images
        // embarquées (`![…](data:image/png;base64,…)`) — un rapport exporté
        // avec ses graphiques, pas seulement ses titres.
        "md" | "markdown" | "mdown" => return layout_flow(title, &markdown_flow(content)),
        "csv" => from_separated(content, ','),
        "tsv" => from_separated(content, '\t'),
        "json" => from_code(content),
        "html" | "htm" => from_plain(&strip_html(content)),
        _ => from_plain(content), // txt, log, text, et repli générique
    };
    layout(title, &lines)
}

enum FlowItem {
    Lines(Vec<Line>),
    Image { bytes: Vec<u8>, alt: String },
}

/// Markdown → flux : le texte va au moteur Markdown (titres, gras, listes,
/// tableaux), et chaque ligne `![alt](data:image/…;base64,…)` devient une image
/// posée dans le flux. Sans cela, un graphique exporté n'était qu'un lien mort.
fn markdown_flow(md: &str) -> Vec<FlowItem> {
    let mut items = Vec::new();
    let mut buf = String::new();
    for line in md.lines() {
        let t = line.trim();
        let is_data_img = t.starts_with("![") && t.ends_with(')') && t.contains("](data:image");
        if is_data_img {
            if !buf.trim().is_empty() {
                items.push(FlowItem::Lines(from_markdown(&buf)));
            }
            buf.clear();
            let alt = t[2..].split("](").next().unwrap_or("").to_string();
            let src = t.rfind("](").map(|i| &t[i + 2..t.len() - 1]).unwrap_or("");
            match data_uri_bytes(src) {
                Some(bytes) => items.push(FlowItem::Image { bytes, alt }),
                None => items.push(FlowItem::Lines(from_plain(&format!("[Image : {alt}]")))),
            }
        } else {
            buf.push_str(line);
            buf.push('\n');
        }
    }
    if !buf.trim().is_empty() {
        items.push(FlowItem::Lines(from_markdown(&buf)));
    }
    if items.is_empty() {
        items.push(FlowItem::Lines(from_plain("")));
    }
    items
}

/// Rendu PDF spécifique aux documents visuels Lumen. Il reste volontairement
/// simple, mais conserve les images sandbox au lieu de les remplacer par texte.
pub fn render_creative_html_to_pdf<F>(
    title: &str,
    html: &str,
    mut load_asset: F,
) -> Result<Vec<u8>, String>
where
    F: FnMut(&str) -> Result<Vec<u8>, String>,
{
    let items = creative_flow(html, &mut load_asset);
    layout_flow(title, &items)
}

// ============================ Conversions ============================

// Largeur moyenne d'un caractère pour estimer la coupure de ligne. Approximation
// volontairement prudente (on préfère couper un peu tôt que déborder).
fn char_w(size: f32, style: Style) -> f32 {
    let factor = if style == Style::Mono { 0.60 } else { 0.48 };
    size * factor
}

// Coupe `text` en lignes tenant dans la largeur dispo (mots préservés).
fn wrap(text: &str, size: f32, style: Style, indent: f32) -> Vec<String> {
    wrap_width(text, size, style, (TEXT_W_PT - indent).max(40.0))
}

// Variante avec largeur disponible explicite (boîtes de texte positionnées).
fn wrap_width(text: &str, size: f32, style: Style, avail: f32) -> Vec<String> {
    let max_chars = (avail / char_w(size, style)).floor().max(8.0) as usize;
    let mut out = Vec::new();
    for raw in text.split('\n') {
        if raw.is_empty() {
            out.push(String::new());
            continue;
        }
        let mut cur = String::new();
        for word in raw.split_whitespace() {
            // Mot plus long que la ligne : coupe brutalement.
            if word.len() > max_chars {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
                for chunk in word.as_bytes().chunks(max_chars) {
                    out.push(String::from_utf8_lossy(chunk).into_owned());
                }
                continue;
            }
            if cur.is_empty() {
                cur = word.to_string();
            } else if cur.chars().count() + 1 + word.chars().count() <= max_chars {
                cur.push(' ');
                cur.push_str(word);
            } else {
                out.push(std::mem::take(&mut cur));
                cur = word.to_string();
            }
        }
        out.push(cur);
    }
    out
}

fn push_wrapped(
    lines: &mut Vec<Line>,
    text: &str,
    size: f32,
    style: Style,
    indent: f32,
    space_after: f32,
) {
    let wrapped = wrap(text, size, style, indent);
    let last = wrapped.len().saturating_sub(1);
    for (i, w) in wrapped.into_iter().enumerate() {
        lines.push(Line::simple(
            w,
            size,
            style,
            indent,
            if i == last { space_after } else { 2.0 },
        ));
    }
}

/// Coupe une suite de segments stylés à la largeur de page, en gardant le style
/// de chaque mot. La largeur est estimée mot à mot (comme `wrap`), ce qui suffit
/// avec les polices de base PDF.
fn push_wrapped_spans(
    lines: &mut Vec<Line>,
    spans: &[Span],
    size: f32,
    indent: f32,
    space_after: f32,
) {
    let avail = (TEXT_W_PT - indent).max(40.0);
    let mut out: Vec<Vec<Span>> = Vec::new();
    let mut cur: Vec<Span> = Vec::new();
    let mut cur_w = 0.0f32;

    let push_word = |cur: &mut Vec<Span>, word: &str, style: Style| match cur.last_mut() {
        Some(last) if last.style == style => last.text.push_str(word),
        _ => cur.push(Span {
            text: word.to_string(),
            style,
        }),
    };

    for span in spans {
        for (i, word) in span.text.split_whitespace().enumerate() {
            let w = text_width(word, size, span.style);
            let sep = if cur.is_empty() { 0.0 } else { char_w(size, span.style) };
            if !cur.is_empty() && cur_w + sep + w > avail {
                out.push(std::mem::take(&mut cur));
                cur_w = 0.0;
            } else if !cur.is_empty() {
                push_word(&mut cur, " ", span.style);
                cur_w += sep;
            }
            let _ = i;
            push_word(&mut cur, word, span.style);
            cur_w += w;
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    let last = out.len().saturating_sub(1);
    for (i, spans) in out.into_iter().enumerate() {
        lines.push(Line {
            spans,
            size,
            indent,
            space_after: if i == last { space_after } else { 2.0 },
            table: None,
            rule: false,
        });
    }
}

fn from_plain(content: &str) -> Vec<Line> {
    let mut lines = Vec::new();
    for para in content.split("\n\n") {
        push_wrapped(&mut lines, para.trim_end(), 11.0, Style::Regular, 0.0, 8.0);
    }
    lines
}

fn from_code(content: &str) -> Vec<Line> {
    let mut lines = Vec::new();
    for raw in content.split('\n') {
        push_wrapped(&mut lines, raw, 9.5, Style::Mono, 0.0, 1.5);
    }
    lines
}

// CSV/TSV → tableau monospace aligné par colonnes.
fn from_separated(content: &str, sep: char) -> Vec<Line> {
    let rows: Vec<Vec<String>> = content
        .lines()
        .map(|l| l.split(sep).map(|c| c.trim().to_string()).collect())
        .collect();
    if rows.is_empty() {
        return Vec::new();
    }
    let cols = rows.iter().map(|r| r.len()).max().unwrap_or(0);
    let mut widths = vec![0usize; cols];
    for r in &rows {
        for (i, c) in r.iter().enumerate() {
            widths[i] = widths[i].max(c.chars().count());
        }
    }
    let mut lines = Vec::new();
    for (ri, r) in rows.iter().enumerate() {
        let mut cells = Vec::new();
        for i in 0..cols {
            let c = r.get(i).map(String::as_str).unwrap_or("");
            cells.push(format!("{:<width$}", c, width = widths[i]));
        }
        let style = if ri == 0 { Style::Bold } else { Style::Mono };
        push_wrapped(&mut lines, &cells.join("  "), 9.5, style, 0.0, 1.5);
    }
    lines
}

// Retire grossièrement les balises HTML pour un rendu texte lisible.
fn strip_html(html: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    let mut in_skip = false; // <script>/<style>
    let lower = html.to_ascii_lowercase();
    let lower_bytes = lower.as_bytes();
    for (i, ch) in html.char_indices() {
        if lower_bytes[i..].starts_with(b"<script") || lower_bytes[i..].starts_with(b"<style") {
            in_skip = true;
        }
        if lower_bytes[i..].starts_with(b"</script") || lower_bytes[i..].starts_with(b"</style") {
            in_skip = false;
        }
        if ch == '<' {
            in_tag = true;
        } else if ch == '>' {
            in_tag = false;
            if !in_skip {
                out.push(' ');
            }
        } else if !in_tag && !in_skip {
            out.push(ch);
        }
    }
    out.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

fn attr_value(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let needle = format!("{name}=");
    let idx = lower.find(&needle)? + needle.len();
    let rest = &tag[idx..];
    let quote = rest.chars().next()?;
    if quote == '"' || quote == '\'' {
        let end = rest[1..].find(quote)? + 1;
        Some(rest[1..end].to_string())
    } else {
        Some(
            rest.split_whitespace()
                .next()
                .unwrap_or("")
                .trim_matches('>')
                .to_string(),
        )
    }
}

fn creative_flow<F>(html: &str, load_asset: &mut F) -> Vec<FlowItem>
where
    F: FnMut(&str) -> Result<Vec<u8>, String>,
{
    let mut items = Vec::new();
    let mut pos = 0usize;
    let lower = html.to_ascii_lowercase();
    while let Some(rel) = lower[pos..].find("<img") {
        let start = pos + rel;
        let before = strip_html(&html[pos..start]);
        if !before.trim().is_empty() {
            items.push(FlowItem::Lines(from_plain(&before)));
        }
        let Some(end_rel) = lower[start..].find('>') else {
            break;
        };
        let end = start + end_rel + 1;
        let tag = &html[start..end];
        let src = attr_value(tag, "src")
            .or_else(|| attr_value(tag, "data-sandbox-image"))
            .unwrap_or_default();
        let alt = attr_value(tag, "alt").unwrap_or_else(|| src.clone());
        let path = src
            .strip_prefix("sandbox://")
            .or_else(|| src.strip_prefix("sandbox:"))
            .unwrap_or("")
            .trim_start_matches('/');
        if !path.is_empty() {
            match load_asset(path) {
                Ok(bytes) => items.push(FlowItem::Image { bytes, alt }),
                Err(_) => items.push(FlowItem::Lines(from_plain(&format!("[Image : {alt}]")))),
            }
        }
        pos = end;
    }
    if pos < html.len() {
        let tail = strip_html(&html[pos..]);
        if !tail.trim().is_empty() {
            items.push(FlowItem::Lines(from_plain(&tail)));
        }
    }
    if items.is_empty() {
        items.push(FlowItem::Lines(from_plain(&strip_html(html))));
    }
    items
}

fn heading_size(level: HeadingLevel) -> f32 {
    match level {
        HeadingLevel::H1 => 22.0,
        HeadingLevel::H2 => 18.0,
        HeadingLevel::H3 => 15.0,
        HeadingLevel::H4 => 13.0,
        _ => 12.0,
    }
}

// Markdown → lignes stylées (blocs : titres, paragraphes, listes, code, citation).
fn from_markdown(md: &str) -> Vec<Line> {
    let mut lines = Vec::new();
    let mut buf: Vec<Span> = Vec::new();
    let mut size = 11.0f32;
    let mut block = Style::Regular; // style de base du bloc courant (titre, citation…)
    let mut bold = 0u32;
    let mut italic = 0u32;
    let mut indent = 0.0f32;
    let mut in_code = false;
    let mut list_stack: Vec<Option<u64>> = Vec::new(); // None = puce, Some(n) = numéro courant
    // Tableau en cours de collecte : les cellules sont accumulées puis mises en
    // colonnes d'un coup, une fois toutes les largeurs connues.
    let mut table: Option<Vec<Vec<String>>> = None;
    let mut in_table_head = false;

    // Style effectif d'un fragment : le gras d'un titre l'emporte, sinon
    // l'emphase inline décide.
    let inline_style = |block: Style, bold: u32, italic: u32| -> Style {
        if block == Style::Bold || bold > 0 {
            Style::Bold
        } else if block == Style::Italic || italic > 0 {
            Style::Italic
        } else {
            Style::Regular
        }
    };

    fn flush(lines: &mut Vec<Line>, buf: &mut Vec<Span>, size: f32, indent: f32, sa: f32) {
        if buf.iter().any(|s| !s.text.trim().is_empty()) {
            push_wrapped_spans(lines, buf, size, indent, sa);
        }
        buf.clear();
    }

    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TASKLISTS);
    opts.insert(Options::ENABLE_FOOTNOTES);

    for ev in Parser::new_ext(md, opts) {
        match ev {
            Event::Start(Tag::Heading { level, .. }) => {
                flush(&mut lines, &mut buf, size, indent, 6.0);
                size = heading_size(level);
                block = Style::Bold;
            }
            Event::End(TagEnd::Heading(_)) => {
                flush(&mut lines, &mut buf, size, 0.0, 10.0);
                size = 11.0;
                block = Style::Regular;
            }
            Event::Start(Tag::Paragraph) => {
                block = Style::Regular;
                size = 11.0;
            }
            Event::End(TagEnd::Paragraph) => {
                flush(&mut lines, &mut buf, 11.0, indent, 8.0);
                block = Style::Regular;
            }
            Event::Start(Tag::Strong) => bold += 1,
            Event::End(TagEnd::Strong) => bold = bold.saturating_sub(1),
            Event::Start(Tag::Emphasis) => italic += 1,
            Event::End(TagEnd::Emphasis) => italic = italic.saturating_sub(1),
            Event::Start(Tag::List(start)) => {
                list_stack.push(start);
            }
            Event::End(TagEnd::List(_)) => {
                list_stack.pop();
            }
            Event::Start(Tag::Item) => {
                let depth = list_stack.len().max(1);
                indent = 16.0 * depth as f32;
                let marker = match list_stack.last_mut() {
                    Some(Some(n)) => {
                        let m = format!("{}. ", n);
                        *n += 1;
                        m
                    }
                    _ => "•  ".to_string(),
                };
                buf.push(Span {
                    text: marker,
                    style: Style::Regular,
                });
            }
            Event::End(TagEnd::Item) => {
                flush(&mut lines, &mut buf, 11.0, indent, 3.0);
                indent = 0.0;
            }
            Event::TaskListMarker(done) => buf.push(Span {
                text: if done { "☑ ".into() } else { "☐ ".into() },
                style: Style::Regular,
            }),
            Event::Start(Tag::CodeBlock(_)) => {
                flush(&mut lines, &mut buf, size, indent, 4.0);
                in_code = true;
            }
            Event::End(TagEnd::CodeBlock) => {
                in_code = false;
            }
            Event::Start(Tag::BlockQuote(_)) => {
                block = Style::Italic;
                indent = 16.0;
            }
            Event::End(TagEnd::BlockQuote(_)) => {
                flush(&mut lines, &mut buf, 11.0, indent, 8.0);
                block = Style::Regular;
                indent = 0.0;
            }
            // ----- Tableaux -----
            Event::Start(Tag::Table(_)) => {
                flush(&mut lines, &mut buf, 11.0, indent, 6.0);
                table = Some(Vec::new());
            }
            Event::End(TagEnd::Table) => {
                if let Some(rows) = table.take() {
                    push_table(&mut lines, &rows);
                }
            }
            Event::Start(Tag::TableHead) => in_table_head = true,
            Event::End(TagEnd::TableHead) => in_table_head = false,
            Event::Start(Tag::TableRow) => {
                if let Some(t) = table.as_mut() {
                    t.push(Vec::new());
                }
            }
            Event::Start(Tag::TableCell) => {
                if let Some(t) = table.as_mut() {
                    // La ligne d'en-tête n'émet pas de TableRow : on l'ouvre ici.
                    if t.is_empty() && in_table_head {
                        t.push(Vec::new());
                    }
                    if let Some(row) = t.last_mut() {
                        row.push(String::new());
                    }
                }
            }
            Event::Text(t) => {
                if let Some(tb) = table.as_mut() {
                    if let Some(cell) = tb.last_mut().and_then(|r| r.last_mut()) {
                        cell.push_str(&t);
                    }
                } else if in_code {
                    for raw in t.split('\n') {
                        push_wrapped(&mut lines, raw, 9.5, Style::Mono, indent + 8.0, 1.5);
                    }
                } else {
                    buf.push(Span {
                        text: t.to_string(),
                        style: inline_style(block, bold, italic),
                    });
                }
            }
            // `code` inline : rendu en chasse fixe, comme dans l'app.
            Event::Code(t) => {
                if let Some(tb) = table.as_mut() {
                    if let Some(cell) = tb.last_mut().and_then(|r| r.last_mut()) {
                        cell.push_str(&t);
                    }
                } else {
                    buf.push(Span {
                        text: t.to_string(),
                        style: Style::Mono,
                    });
                }
            }
            Event::SoftBreak | Event::HardBreak => {
                if table.is_none() {
                    buf.push(Span {
                        text: " ".into(),
                        style: Style::Regular,
                    });
                }
            }
            Event::Rule => {
                flush(&mut lines, &mut buf, size, indent, 4.0);
                // Un filet se TRACE : la police de base n'a pas le glyphe « ─ »,
                // qui sortait en rangée de points d'interrogation.
                let mut l = Line::simple(String::new(), 6.0, Style::Regular, 0.0, 8.0);
                l.rule = true;
                lines.push(l);
            }
            _ => {}
        }
    }
    flush(&mut lines, &mut buf, size, indent, 8.0);
    lines
}

/// Met un tableau Markdown en VRAIES colonnes : largeur proportionnelle au
/// contenu (bornée), texte en police normale, en-tête en gras, nombres alignés
/// à droite, filets tracés. L'ancienne version alignait en chasse fixe avec
/// des « ─ » que la police de base ne connaît pas : un rapport sortait en
/// caractères de machine à écrire coupés de rangées de « ? ».
fn push_table(lines: &mut Vec<Line>, rows: &[Vec<String>]) {
    let rows: Vec<Vec<String>> = rows
        .iter()
        .map(|r| {
            r.iter()
                .map(|c| c.split_whitespace().collect::<Vec<_>>().join(" "))
                .collect()
        })
        .filter(|r: &Vec<String>| !r.is_empty())
        .collect();
    if rows.is_empty() {
        return;
    }
    let cols = rows.iter().map(|r| r.len()).max().unwrap_or(0);
    // Taille de police : rétrécie quand il y a beaucoup de colonnes, pour
    // qu'un croisé de dix colonnes tienne sur la largeur de la page.
    let size: f32 = if cols <= 5 { 9.5 } else if cols <= 8 { 8.5 } else { 7.5 };
    let pad = 4.0f32;
    // Largeur naturelle de chaque colonne (texte le plus long), bornée.
    let mut widths: Vec<f32> = (0..cols)
        .map(|i| {
            rows.iter()
                .map(|r| text_width(r.get(i).map(String::as_str).unwrap_or(""), size, Style::Regular))
                .fold(0.0f32, f32::max)
                .max(text_width("—", size, Style::Regular))
                + pad * 2.0
        })
        .collect();
    let numeric: Vec<bool> = (0..cols)
        .map(|i| {
            rows.iter().skip(1).filter(|r| r.get(i).map(|c| !c.trim().is_empty()).unwrap_or(false)).count() > 0
                && rows.iter().skip(1).all(|r| {
                    let c = r.get(i).map(String::as_str).unwrap_or("").trim();
                    c.is_empty() || c == "—" || c == "-" || looks_numeric(c)
                })
        })
        .collect();
    let mut total: f32 = widths.iter().sum();
    if total < TEXT_W_PT {
        // Comme un tableau HTML en `width: 100%` : l'espace libre se répartit
        // au prorata, le fond d'en-tête et les filets couvrent alors les colonnes.
        let scale = TEXT_W_PT / total;
        for w in widths.iter_mut() {
            *w *= scale;
        }
        total = TEXT_W_PT;
    }
    if total > TEXT_W_PT {
        // Trop large : on répartit au prorata, avec un minimum par colonne, et
        // les textes trop longs seront tronqués avec « … ».
        let min_w = 34.0f32;
        let scale = TEXT_W_PT / total;
        for w in widths.iter_mut() {
            *w = (*w * scale).max(min_w);
        }
        total = widths.iter().sum();
        if total > TEXT_W_PT {
            let scale = TEXT_W_PT / total;
            for w in widths.iter_mut() {
                *w *= scale;
            }
        }
    }
    let xs: Vec<f32> = widths
        .iter()
        .scan(0.0f32, |acc, w| {
            let x = *acc;
            *acc += w;
            Some(x)
        })
        .collect();
    let fit = |cell: &str, w: f32, style: Style| -> String {
        let avail = w - pad * 2.0;
        if text_width(cell, size, style) <= avail + 0.5 {
            return cell.to_string();
        }
        let max = ((avail / char_w(size, style)).floor() as usize).saturating_sub(1).max(1);
        let mut t: String = cell.chars().take(max).collect();
        t.push('…');
        t
    };
    let n = rows.len();
    for (r, row) in rows.iter().enumerate() {
        let header = r == 0;
        let style = if header { Style::Bold } else { Style::Regular };
        let cells = (0..cols)
            .map(|i| TableCell {
                text: fit(row.get(i).map(String::as_str).unwrap_or(""), widths[i], style),
                x: xs[i] + pad,
                width: widths[i] - pad * 2.0,
                numeric: numeric[i],
            })
            .collect();
        lines.push(Line {
            spans: vec![Span { text: String::new(), style }],
            size,
            indent: 0.0,
            space_after: 3.0,
            table: Some(TableRow { cells, header, last: r + 1 == n }),
            rule: false,
        });
    }
    if let Some(last) = lines.last_mut() {
        last.space_after = 12.0;
    }
}

/// « 1 234,56 », « 12 % », « -3 », « 1 200,00 € » : un nombre à l'affichage.
fn looks_numeric(s: &str) -> bool {
    let t: String = s.chars().filter(|c| !c.is_whitespace() && !matches!(c, '€' | '$' | '%' | '£')).collect();
    !t.is_empty() && t.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | ',' | '-' | '+' | '▲' | '▼' | '=' | '\u{a0}'))
        && t.chars().any(|c| c.is_ascii_digit())
}

// ============================ Mise en page ============================

const FONT_REGULAR: &[u8] = b"F1";
const FONT_BOLD: &[u8] = b"F2";
const FONT_ITALIC: &[u8] = b"F3";
const FONT_MONO: &[u8] = b"F4";

fn font_name(style: Style) -> Name<'static> {
    match style {
        Style::Regular => Name(FONT_REGULAR),
        Style::Bold => Name(FONT_BOLD),
        Style::Italic => Name(FONT_ITALIC),
        Style::Mono => Name(FONT_MONO),
    }
}

/// Encodage CP1252 (WinAnsi) partagé avec le module de facturation, qui écrit
/// ses propres PDF Factur-X sans repasser par le moteur Markdown.
pub(crate) fn pdf_text_bytes(text: &str) -> Vec<u8> {
    text.chars()
        .map(|ch| match ch {
            '\u{20ac}' => 0x80,
            '\u{201a}' => 0x82,
            '\u{0192}' => 0x83,
            '\u{201e}' => 0x84,
            '\u{2026}' => 0x85,
            '\u{2020}' => 0x86,
            '\u{2021}' => 0x87,
            '\u{02c6}' => 0x88,
            '\u{2030}' => 0x89,
            '\u{0160}' => 0x8a,
            '\u{2039}' => 0x8b,
            '\u{0152}' => 0x8c,
            '\u{017d}' => 0x8e,
            '\u{2018}' => 0x91,
            '\u{2019}' => 0x92,
            '\u{201c}' => 0x93,
            '\u{201d}' => 0x94,
            '\u{2022}' => 0x95,
            '\u{2013}' => 0x96,
            '\u{2014}' => 0x97,
            '\u{02dc}' => 0x98,
            '\u{2122}' => 0x99,
            '\u{0161}' => 0x9a,
            '\u{203a}' => 0x9b,
            '\u{0153}' => 0x9c,
            '\u{017e}' => 0x9e,
            '\u{0178}' => 0x9f,
            c if (c as u32) <= 0xff => c as u8,
            _ => b'?',
        })
        .collect()
}

struct PdfImage {
    name: String,
    width: u32,
    height: u32,
    rgb: Vec<u8>,
    alpha: Option<Vec<u8>>,
}

struct PdfPageData {
    width: f32,
    height: f32,
    content: Vec<u8>,
    images: Vec<PdfImage>,
}

struct PdfDoc {
    title: String,
    pages: Vec<PdfPageData>,
    next_image: usize,
}

impl PdfDoc {
    fn new(title: &str) -> Self {
        Self {
            title: title.to_string(),
            pages: Vec::new(),
            next_image: 1,
        }
    }

    fn add_page(&mut self, width: f32, height: f32) -> PdfPage {
        PdfPage {
            width,
            height,
            content: Content::new(),
            images: Vec::new(),
        }
    }

    fn push_page(&mut self, page: PdfPage) {
        self.pages.push(PdfPageData {
            width: page.width,
            height: page.height,
            content: page.content.finish().to_vec(),
            images: page.images,
        });
    }

    fn next_image_name(&mut self) -> String {
        let name = format!("Im{}", self.next_image);
        self.next_image += 1;
        name
    }

    fn finish(self) -> Vec<u8> {
        let mut pdf = Pdf::new();
        let mut alloc = Ref::new(1);
        let catalog_id = alloc.bump();
        let pages_id = alloc.bump();
        let info_id = alloc.bump();
        let font_regular_id = alloc.bump();
        let font_bold_id = alloc.bump();
        let font_italic_id = alloc.bump();
        let font_mono_id = alloc.bump();

        let mut page_ids = Vec::new();
        let mut content_ids = Vec::new();
        let mut image_ids: Vec<Vec<(String, Ref, Option<Ref>)>> = Vec::new();
        for page in &self.pages {
            page_ids.push(alloc.bump());
            content_ids.push(alloc.bump());
            image_ids.push(
                page.images
                    .iter()
                    .map(|img| {
                        let image_id = alloc.bump();
                        let alpha_id = img.alpha.as_ref().map(|_| alloc.bump());
                        (img.name.clone(), image_id, alpha_id)
                    })
                    .collect(),
            );
        }

        pdf.catalog(catalog_id).pages(pages_id);
        pdf.document_info(info_id).title(TextStr(&self.title));
        pdf.pages(pages_id)
            .kids(page_ids.iter().copied())
            .count(page_ids.len() as i32);

        // /Encoding WinAnsiEncoding : indispensable pour que les octets produits
        // par pdf_text_bytes (CP1252) rendent correctement les accents.
        pdf.type1_font(font_regular_id)
            .base_font(Name(b"Helvetica"))
            .encoding_predefined(Name(b"WinAnsiEncoding"));
        pdf.type1_font(font_bold_id)
            .base_font(Name(b"Helvetica-Bold"))
            .encoding_predefined(Name(b"WinAnsiEncoding"));
        pdf.type1_font(font_italic_id)
            .base_font(Name(b"Helvetica-Oblique"))
            .encoding_predefined(Name(b"WinAnsiEncoding"));
        pdf.type1_font(font_mono_id)
            .base_font(Name(b"Courier"))
            .encoding_predefined(Name(b"WinAnsiEncoding"));

        for (idx, page_data) in self.pages.iter().enumerate() {
            let mut page = pdf.page(page_ids[idx]);
            page.media_box(Rect::new(0.0, 0.0, page_data.width, page_data.height));
            page.parent(pages_id);
            page.contents(content_ids[idx]);
            let mut resources = page.resources();
            resources.fonts().pairs([
                (Name(FONT_REGULAR), font_regular_id),
                (Name(FONT_BOLD), font_bold_id),
                (Name(FONT_ITALIC), font_italic_id),
                (Name(FONT_MONO), font_mono_id),
            ]);
            if !image_ids[idx].is_empty() {
                resources.x_objects().pairs(
                    image_ids[idx]
                        .iter()
                        .map(|(name, id, _)| (Name(name.as_bytes()), *id)),
                );
            }
            resources.finish();
            page.finish();

            pdf.stream(content_ids[idx], &page_data.content);
            for (img, (_, image_id, alpha_id)) in page_data.images.iter().zip(&image_ids[idx]) {
                let mut image = pdf.image_xobject(*image_id, &img.rgb);
                image.filter(Filter::FlateDecode);
                image.width(img.width as i32);
                image.height(img.height as i32);
                image.color_space().device_rgb();
                image.bits_per_component(8);
                if let Some(mask_id) = alpha_id {
                    image.s_mask(*mask_id);
                }
                image.finish();

                if let (Some(mask), Some(mask_id)) = (&img.alpha, alpha_id) {
                    let mut smask = pdf.image_xobject(*mask_id, mask);
                    smask.filter(Filter::FlateDecode);
                    smask.width(img.width as i32);
                    smask.height(img.height as i32);
                    smask.color_space().device_gray();
                    smask.bits_per_component(8);
                }
            }
        }

        pdf.finish()
    }
}

struct PdfPage {
    width: f32,
    height: f32,
    content: Content,
    images: Vec<PdfImage>,
}

impl PdfPage {
    fn text(&mut self, text: &str, x: f32, y: f32, size: f32, style: Style) {
        if text.is_empty() {
            return;
        }
        let bytes = pdf_text_bytes(text);
        self.content.begin_text();
        self.content.set_font(font_name(style), size);
        self.content.next_line(x, y);
        self.content.show(Str(&bytes));
        self.content.end_text();
    }

    fn fill_rgb(&mut self, color: (f32, f32, f32)) {
        self.content.set_fill_rgb(color.0, color.1, color.2);
    }

    fn rect(&mut self, x: f32, y: f32, w: f32, h: f32) {
        self.content.rect(x, y, w, h);
        self.content.fill_nonzero();
    }

    fn polygon(&mut self, points: &[(f32, f32)]) {
        let Some((first, rest)) = points.split_first() else {
            return;
        };
        self.content.move_to(first.0, first.1);
        for (x, y) in rest {
            self.content.line_to(*x, *y);
        }
        self.content.close_path();
        self.content.fill_nonzero();
    }

    fn image(&mut self, name: &str, img: DynamicImage, x: f32, y: f32, w: f32, h: f32) {
        let width = img.width().max(1);
        let height = img.height().max(1);
        let level = CompressionLevel::DefaultLevel as u8;
        let rgb = compress_to_vec_zlib(img.to_rgb8().as_raw(), level);
        let alpha = img.color().has_alpha().then(|| {
            let alphas: Vec<_> = img.pixels().map(|p| (p.2).0[3]).collect();
            compress_to_vec_zlib(&alphas, level)
        });
        self.images.push(PdfImage {
            name: name.to_string(),
            width,
            height,
            rgb,
            alpha,
        });
        self.content.save_state();
        self.content.transform([w, 0.0, 0.0, h, x, y]);
        self.content.x_object(Name(name.as_bytes()));
        self.content.restore_state();
    }
}

fn layout(title: &str, lines: &[Line]) -> Result<Vec<u8>, String> {
    layout_flow(title, &[FlowItem::Lines(lines.to_vec())])
}

fn layout_flow(title: &str, items: &[FlowItem]) -> Result<Vec<u8>, String> {
    let mut doc = PdfDoc::new(title);
    let mut page = doc.add_page(PAGE_W_PT, PAGE_H_PT);
    let mut y = PAGE_H_PT - MARGIN_PT; // curseur vertical (depuis le bas), en pt

    for item in items {
        match item {
            FlowItem::Lines(lines) => {
                for line in lines {
                    let line_h = if line.table.is_some() { line.size * 1.7 } else { line.size * 1.32 };
                    if y - line_h < MARGIN_PT {
                        doc.push_page(page);
                        page = doc.add_page(PAGE_W_PT, PAGE_H_PT);
                        y = PAGE_H_PT - MARGIN_PT;
                    }
                    y -= line_h;
                    if line.rule {
                        page.fill_rgb((0.78, 0.78, 0.8));
                        page.rect(MARGIN_PT, y + line.size * 0.4, TEXT_W_PT, 0.6);
                        page.fill_rgb((0.11, 0.11, 0.12));
                    } else if let Some(t) = &line.table {
                        // Fond discret sur l'en-tête, texte, puis filet sous la rangée.
                        let top = y + line_h - 2.0;
                        if t.header {
                            page.fill_rgb((0.94, 0.94, 0.95));
                            page.rect(MARGIN_PT, y - 3.0, TEXT_W_PT, line_h + 1.0);
                        }
                        page.fill_rgb((0.11, 0.11, 0.12));
                        let style = line.spans.first().map(|s| s.style).unwrap_or(Style::Regular);
                        for c in &t.cells {
                            let tw = text_width(&c.text, line.size, style);
                            let x = if c.numeric { MARGIN_PT + c.x + (c.width - tw).max(0.0) } else { MARGIN_PT + c.x };
                            page.text(&c.text, x, y, line.size, style);
                        }
                        let _ = top;
                        page.fill_rgb(if t.header || t.last { (0.55, 0.55, 0.58) } else { (0.86, 0.86, 0.88) });
                        page.rect(MARGIN_PT, y - 3.0, TEXT_W_PT, if t.header { 0.8 } else { 0.4 });
                        page.fill_rgb((0.11, 0.11, 0.12));
                    } else if !line.is_blank() {
                        let mut x = MARGIN_PT + line.indent;
                        for span in &line.spans {
                            if !span.text.is_empty() {
                                page.text(&span.text, x, y, line.size, span.style);
                                x += text_width(&span.text, line.size, span.style);
                            }
                        }
                    }
                    y -= line.space_after;
                }
            }
            FlowItem::Image { bytes, alt } => {
                let dyn_img = match image::load_from_memory(bytes) {
                    Ok(img) => img,
                    Err(_) => {
                        for line in from_plain(&format!("[Image : {alt}]")) {
                            y -= line.size * 1.32;
                            for span in &line.spans {
                                page.text(&span.text, MARGIN_PT, y, line.size, span.style);
                            }
                        }
                        continue;
                    }
                };
                let img_w = dyn_img.width().max(1) as f32;
                let img_h = dyn_img.height().max(1) as f32;
                // Une image large (un graphique) prend toute la largeur de
                // texte ; une image haute reste bornée pour ne pas manger la page.
                let draw_w = if img_w / img_h >= 1.3 { TEXT_W_PT } else { TEXT_W_PT.min(360.0) };
                let draw_h = (draw_w * img_h / img_w).min(PAGE_H_PT - 2.0 * MARGIN_PT - 20.0);
                if y - draw_h < MARGIN_PT {
                    doc.push_page(page);
                    page = doc.add_page(PAGE_W_PT, PAGE_H_PT);
                    y = PAGE_H_PT - MARGIN_PT;
                }
                y -= draw_h;
                let name = doc.next_image_name();
                page.image(&name, dyn_img, MARGIN_PT, y, draw_w, draw_h);
                y -= 10.0;
            }
        }
    }

    doc.push_page(page);
    Ok(doc.finish())
}

// ===================== Rendu fidèle (modèle objet) =====================
//
// Reproduit fidèlement le canevas de l'éditeur créatif : chaque page devient
// une page PDF aux mêmes proportions, et chaque élément (texte, image, forme)
// est dessiné à sa position absolue. Le canevas est en pixels logiques @96dpi,
// le PDF en points @72dpi → facteur d'échelle 72/96.

const PX_TO_PT: f32 = 72.0 / 96.0;

fn num(v: &Value, k: &str, d: f32) -> f32 {
    v.get(k)
        .and_then(Value::as_f64)
        .map(|x| x as f32)
        .unwrap_or(d)
}
fn text_of(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

// "#rgb" / "#rrggbb" → composantes 0..1. None si transparent/illisible.
fn parse_hex(hex: &str) -> Option<(f32, f32, f32)> {
    let h = hex.trim().trim_start_matches('#');
    let full = match h.len() {
        3 => h.chars().flat_map(|c| [c, c]).collect::<String>(),
        6 => h.to_string(),
        _ => return None,
    };
    let n = u32::from_str_radix(&full, 16).ok()?;
    Some((
        ((n >> 16) & 255) as f32 / 255.0,
        ((n >> 8) & 255) as f32 / 255.0,
        (n & 255) as f32 / 255.0,
    ))
}

// HTML d'un bloc texte → texte brut multi-lignes (<br>, fins de blocs → \n).
fn html_to_text(html: &str) -> String {
    let s = html
        .replace("<br>", "\n")
        .replace("<br/>", "\n")
        .replace("<br />", "\n")
        .replace("</p>", "\n")
        .replace("</div>", "\n");
    strip_html(&s)
        .split('\n')
        .map(str::trim)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn text_width(line: &str, size: f32, style: Style) -> f32 {
    line.chars().count() as f32 * char_w(size, style)
}

/// Rendu PDF fidèle au canevas à partir du modèle objet JSON ({ pages: [...] }).
pub fn render_creative_doc_to_pdf<F>(
    title: &str,
    doc_json: &str,
    mut load_asset: F,
) -> Result<Vec<u8>, String>
where
    F: FnMut(&str) -> Result<Vec<u8>, String>,
{
    let doc: Value = serde_json::from_str(doc_json).map_err(|e| e.to_string())?;
    let empty = Vec::new();
    let pages = doc.get("pages").and_then(Value::as_array).unwrap_or(&empty);
    if pages.is_empty() {
        return Err("Document vide".into());
    }

    let page_pt = |p: &Value| {
        (
            num(p, "w", 794.0) * PX_TO_PT,
            num(p, "h", 1123.0) * PX_TO_PT,
        )
    };
    let mut pdoc = PdfDoc::new(title);

    for page in pages {
        let (pw, ph) = page_pt(page);
        let mut pdf_page = pdoc.add_page(pw, ph);

        // Fond de page.
        if let Some(c) = parse_hex(&text_of(page, "background")) {
            pdf_page.fill_rgb(c);
            pdf_page.rect(0.0, 0.0, pw, ph);
        }

        let no_els = Vec::new();
        let els = page
            .get("elements")
            .and_then(Value::as_array)
            .unwrap_or(&no_els);
        for el in els {
            let kind = text_of(el, "type");
            let x = num(el, "x", 0.0) * PX_TO_PT;
            let y = num(el, "y", 0.0) * PX_TO_PT;
            let w = num(el, "w", 100.0) * PX_TO_PT;
            let h = num(el, "h", 100.0) * PX_TO_PT;

            match kind.as_str() {
                "table" => draw_table(&mut pdf_page, el, x, y, w, h, ph),
                "text" => {
                    // Fond de la zone de texte (encadré coloré).
                    if let Some(bg) = parse_hex(&text_of(el, "bg")) {
                        pdf_page.fill_rgb(bg);
                        pdf_page.rect(x, ph - (y + h), w, h);
                    }
                    let text = html_to_text(&text_of(el, "html"));
                    if text.is_empty() {
                        continue;
                    }
                    let size = num(el, "fontSize", 24.0) * PX_TO_PT;
                    let weight = num(el, "weight", 400.0);
                    let style = if weight >= 600.0 {
                        Style::Bold
                    } else {
                        Style::Regular
                    };
                    let lh = num(el, "lineHeight", 1.35);
                    let color = parse_hex(&text_of(el, "color")).unwrap_or((0.11, 0.11, 0.12));
                    let align = text_of(el, "align");
                    pdf_page.fill_rgb(color);
                    // Première ligne de base, fidèle au modèle de boîte CSS :
                    // chaque ligne occupe `lh*size`, le glyphe est centré dans
                    // cette boîte et sa ligne de base est à ~0,8·size de son haut.
                    let mut baseline = ph - y - size * ((lh - 1.0) / 2.0 + 0.8);
                    for ln in wrap_width(&text, size, style, w.max(20.0)) {
                        if !ln.is_empty() {
                            let lw = text_width(&ln, size, style);
                            let dx = match align.as_str() {
                                "center" => ((w - lw) / 2.0).max(0.0),
                                "right" => (w - lw).max(0.0),
                                _ => 0.0,
                            };
                            pdf_page.text(&ln, x + dx, baseline, size, style);
                        }
                        baseline -= size * lh;
                    }
                }
                "image" => {
                    let path = text_of(el, "sandboxPath");
                    let bytes = if !path.is_empty() {
                        load_asset(&path).ok()
                    } else {
                        data_uri_bytes(&text_of(el, "src"))
                    };
                    let Some(bytes) = bytes else { continue };
                    let Ok(dyn_img) = image::load_from_memory(&bytes) else {
                        continue;
                    };
                    let fit = text_of(el, "fit");
                    // Reproduit object-fit : `cover` recadre l'image centrée pour
                    // remplir la boîte sans déformation ; `contain` la place
                    // entière centrée ; `fill` étire (défaut historique).
                    let (img, draw_x, draw_y, draw_w, draw_h) = match fit.as_str() {
                        "contain" => {
                            let s = (w / dyn_img.width() as f32).min(h / dyn_img.height() as f32);
                            let dw = dyn_img.width() as f32 * s;
                            let dh = dyn_img.height() as f32 * s;
                            (dyn_img, x + (w - dw) / 2.0, y + (h - dh) / 2.0, dw, dh)
                        }
                        "fill" => (dyn_img, x, y, w, h),
                        _ => {
                            // cover (défaut) : on rogne l'image au ratio de la boîte.
                            let iw = dyn_img.width();
                            let ih = dyn_img.height();
                            let box_ar = w / h;
                            let img_ar = iw as f32 / ih as f32;
                            let (cw, ch) = if img_ar > box_ar {
                                ((ih as f32 * box_ar).round() as u32, ih)
                            } else {
                                (iw, (iw as f32 / box_ar).round() as u32)
                            };
                            let cx = (iw - cw) / 2;
                            let cy = (ih - ch) / 2;
                            let cropped = dyn_img.crop_imm(cx, cy, cw.max(1), ch.max(1));
                            (cropped, x, y, w, h)
                        }
                    };
                    let bottom = ph - (draw_y + draw_h);
                    let name = pdoc.next_image_name();
                    pdf_page.image(&name, img, draw_x, bottom, draw_w, draw_h);
                }
                "shape" => {
                    let fill = parse_hex(&text_of(el, "fill")).unwrap_or((0.04, 0.52, 1.0));
                    pdf_page.fill_rgb(fill);
                    let shape = text_of(el, "shape");
                    match shape.as_str() {
                        "ellipse" => {
                            let cx = x + w / 2.0;
                            let cy = y + h / 2.0;
                            let points = (0..40)
                                .map(|k| {
                                    let a = k as f32 / 40.0 * std::f32::consts::TAU;
                                    let px = cx + (w / 2.0) * a.cos();
                                    let py = cy + (h / 2.0) * a.sin();
                                    (px, ph - py)
                                })
                                .collect::<Vec<_>>();
                            pdf_page.polygon(&points);
                        }
                        "triangle" => pdf_page.polygon(&[
                            (x + w / 2.0, ph - y),
                            (x + w, ph - (y + h)),
                            (x, ph - (y + h)),
                        ]),
                        "line" => {
                            // Trait horizontal centré : fin rectangle plein.
                            let sw = (num(el, "strokeWidth", 0.0) * PX_TO_PT).max(2.0);
                            pdf_page.rect(x, ph - (y + h / 2.0 + sw / 2.0), w, sw);
                        }
                        _ => pdf_page.rect(x, ph - (y + h), w, h), // rect (rayon ignoré)
                    }
                }
                _ => {}
            }
        }
        pdoc.push_page(pdf_page);
    }

    Ok(pdoc.finish())
}

/// Tableau de l'éditeur créatif : matrice `rows` de cellules HTML, ligne
/// d'en-tête optionnelle, zébrures et filets — une ligne de texte par cellule,
/// tronquée à la largeur de sa colonne.
fn draw_table(page: &mut PdfPage, el: &Value, x: f32, y: f32, w: f32, h: f32, ph: f32) {
    let rows: Vec<Vec<String>> = el
        .get("rows")
        .and_then(Value::as_array)
        .map(|rs| {
            rs.iter()
                .map(|r| {
                    r.as_array()
                        .map(|cs| cs.iter().map(|c| html_to_text(c.as_str().unwrap_or("")).replace('\n', " ")).collect())
                        .unwrap_or_default()
                })
                .collect()
        })
        .unwrap_or_default();
    let n_rows = rows.len();
    let n_cols = rows.iter().map(Vec::len).max().unwrap_or(0);
    if n_rows == 0 || n_cols == 0 {
        return;
    }
    let header = el.get("header").and_then(Value::as_bool).unwrap_or(true);
    let zebra = el.get("zebra").and_then(Value::as_bool).unwrap_or(true);
    let size = (num(el, "fontSize", 14.0) * PX_TO_PT).max(4.0);
    let color = parse_hex(&text_of(el, "color")).unwrap_or((0.11, 0.11, 0.12));
    let head_bg = parse_hex(&text_of(el, "headerBg")).unwrap_or((0.95, 0.95, 0.97));
    let border = parse_hex(&text_of(el, "borderColor")).unwrap_or((0.82, 0.82, 0.84));
    let align = text_of(el, "align");
    let rh = h / n_rows as f32;
    let cw = w / n_cols as f32;
    let pad = (size * 0.5).min(cw / 4.0);
    for (ri, row) in rows.iter().enumerate() {
        let top = y + rh * ri as f32;
        let is_head = header && ri == 0;
        let bg = if is_head {
            Some(head_bg)
        } else if zebra && (ri + usize::from(!header)) % 2 == 0 {
            Some((0.975, 0.975, 0.98))
        } else {
            None
        };
        if let Some(c) = bg {
            page.fill_rgb(c);
            page.rect(x, ph - (top + rh), w, rh);
        }
        let style = if is_head { Style::Bold } else { Style::Regular };
        for (ci, cell) in row.iter().enumerate() {
            let avail = (cw - pad * 2.0).max(4.0);
            let mut txt = cell.trim().to_string();
            if text_width(&txt, size, style) > avail {
                while !txt.is_empty() && text_width(&format!("{txt}…"), size, style) > avail {
                    txt.pop();
                }
                txt.push('…');
            }
            let tw = text_width(&txt, size, style);
            let left = x + cw * ci as f32;
            let numeric = !is_head && looks_numeric(cell.trim());
            let dx = match (align.as_str(), numeric) {
                ("center", _) => ((cw - tw) / 2.0).max(pad),
                ("right", _) | (_, true) => (cw - pad - tw).max(pad),
                _ => pad,
            };
            page.fill_rgb(color);
            page.text(&txt, left + dx, ph - (top + rh / 2.0 + size * 0.35), size, style);
        }
    }
    // Filets : horizontaux puis verticaux (fins rectangles pleins).
    let lw = 0.6;
    page.fill_rgb(border);
    for ri in 0..=n_rows {
        page.rect(x, ph - (y + rh * ri as f32) - lw / 2.0, w, lw);
    }
    for ci in 0..=n_cols {
        page.rect(x + cw * ci as f32 - lw / 2.0, ph - (y + h), lw, h);
    }
}

// "data:...;base64,XXXX" → octets décodés.
fn data_uri_bytes(src: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    let comma = src.find(',')?;
    if !src[..comma].contains("base64") {
        return None;
    }
    base64::engine::general_purpose::STANDARD
        .decode(src[comma + 1..].as_bytes())
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    // PNG 1×1 rouge, le plus petit fichier valide qui soit.
    const PNG_1PX: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

    #[test]
    fn markdown_flow_pose_les_images_embarquees() {
        let md = format!("# Titre\n\n### Graphique\n![Graphique](data:image/png;base64,{PNG_1PX})\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n");
        let items = markdown_flow(&md);
        assert!(items.iter().any(|i| matches!(i, FlowItem::Image { .. })), "l'image data-URI doit devenir un FlowItem::Image");
        let pdf = render_to_pdf("t", "md", &md).expect("pdf");
        assert!(pdf.starts_with(b"%PDF"));
        assert!(pdf.len() > 500);
    }

    /// Écrit un PDF d'exemple pour l'œil : `LUMEN_PDF_OUT=/chemin.pdf cargo test --lib pdf::tests::apercu -- --ignored`.
    #[test]
    #[ignore]
    fn apercu_visuel() {
        let Ok(out) = std::env::var("LUMEN_PDF_OUT") else { return };
        let md = format!("# Rapport mensuel\n\n*Test_2*\n\nPériode du 01/09/2026 au 07/09/2026 · base « MyLocalData »\n\n## Rapport Mensuel\n\n**NB Etablissement** : **682** — = 0 % vs période précédente (682)\n\n### Graphique\n![Graphique](data:image/png;base64,{PNG_1PX})\n\n### Test Croisé\n| com_nom | college | kindergarten | school | university | Total |\n| --- | --- | --- | --- | --- | --- |\n| Bras-Panon | — | 1 | 8 | — | 9 |\n| L'Étang-Salé | — | — | 15 | — | 15 |\n| Saint-Denis | 3 | 8 | 95 | 21 | 127 |\n| Total général | 27 | 47 | 580 | 28 | 682 |\n\n---\n\nFin.");
        std::fs::write(out, render_to_pdf("t", "md", &md).expect("pdf")).expect("write");
    }

    #[test]
    fn renders_markdown_to_valid_pdf() {
        let md =
            "# Titre\n\nUn **paragraphe** avec du texte.\n\n- item 1\n- item 2\n\n```\ncode\n```\n";
        let bytes = render_to_pdf("doc", "md", md).expect("rendu");
        assert!(bytes.starts_with(b"%PDF"), "en-tête PDF manquant");
        assert!(bytes.len() > 400, "PDF suspectement petit");
    }
    #[test]
    fn markdown_conserve_les_styles_inline() {
        let lines = from_markdown("Du **gras**, de l'*italique* et du `code`.");
        let styles: Vec<Style> = lines
            .iter()
            .flat_map(|l| l.spans.iter().map(|s| s.style))
            .collect();
        assert!(styles.contains(&Style::Bold), "gras perdu");
        assert!(styles.contains(&Style::Italic), "italique perdu");
        assert!(styles.contains(&Style::Mono), "code inline perdu");
    }

    #[test]
    fn markdown_met_les_tableaux_en_colonnes() {
        let md = "| Produit | Prix |\n| --- | --- |\n| Café | 3 |\n| Thé | 2 |\n";
        let lines = from_markdown(md);
        let rows: Vec<&TableRow> = lines.iter().filter_map(|l| l.table.as_ref()).collect();
        assert_eq!(rows.len(), 3, "trois rangées (en-tête + deux lignes)");
        assert!(rows[0].header && !rows[2].header);
        assert!(rows[2].last, "la dernière rangée porte le filet de fin");
        let cells: Vec<&str> = rows[0].cells.iter().map(|c| c.text.as_str()).collect();
        assert_eq!(cells, ["Produit", "Prix"]);
        assert!(rows[1].cells[1].numeric, "la colonne Prix est numérique (alignée à droite)");
        assert!(!rows[1].cells[0].numeric);
        // Les colonnes ne se chevauchent pas et tiennent dans la page.
        let last = rows[0].cells.last().unwrap();
        assert!(last.x + last.width <= TEXT_W_PT + 0.5);
        assert!(rows[0].cells[1].x > rows[0].cells[0].x + rows[0].cells[0].width);
    }

    #[test]
    fn csv_and_supported() {
        assert!(is_supported("MD"));
        assert!(is_supported("csv"));
        assert!(!is_supported("png"));
        let bytes = render_to_pdf("t", "csv", "a,b\n1,2\n").expect("rendu csv");
        assert!(bytes.starts_with(b"%PDF"));
    }
    #[test]
    fn renders_creative_doc_to_valid_pdf() {
        let doc = r##"{"pages":[{"w":794,"h":1123,"background":"#ffffff","elements":[
            {"type":"text","x":90,"y":130,"w":614,"h":120,"html":"Titre","fontSize":52,"weight":800,"color":"#1d1d1f","align":"left"},
            {"type":"shape","shape":"rect","x":90,"y":300,"w":200,"h":100,"fill":"#0a84ff"}
        ]}]}"##;
        let bytes = render_creative_doc_to_pdf("doc", doc, |_| Err("pas d'image".into()))
            .expect("rendu créatif");
        assert!(bytes.starts_with(b"%PDF"), "en-tête PDF manquant");
        assert!(bytes.len() > 400, "PDF suspectement petit");
    }
    #[test]
    fn renders_creative_tables_and_images() {
        const PNG_1PX: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
        let doc = format!(r##"{{"pages":[{{"w":1280,"h":720,"background":"#ffffff","elements":[
            {{"type":"table","x":80,"y":80,"w":600,"h":160,"header":true,"rows":[["Ville","CA"],["Lyon","43 210,50 €"],["Une ville au nom vraiment très très long","12"]]}},
            {{"type":"image","x":700,"y":80,"w":400,"h":300,"fit":"contain","src":"data:image/png;base64,{PNG_1PX}"}},
            {{"type":"text","x":80,"y":400,"w":400,"h":60,"html":"Encadré","bg":"#f2f2f7"}}
        ]}}]}}"##);
        let bytes = render_creative_doc_to_pdf("doc", &doc, |_| Err("pas d'image".into())).expect("rendu");
        let raw = String::from_utf8_lossy(&bytes);
        assert!(raw.contains("/Im"), "image absente du PDF");
        assert!(bytes.windows(4).any(|w| w == b"Lyon"), "cellule de tableau absente");
    }
    #[test]
    fn parses_hex_colors() {
        assert_eq!(parse_hex("#fff"), Some((1.0, 1.0, 1.0)));
        assert_eq!(parse_hex("#000000"), Some((0.0, 0.0, 0.0)));
        assert_eq!(parse_hex("transparent"), None);
    }
}

// ===========================================================================
// Export depuis le chat (tool calling)
// ===========================================================================
// L'IA de la barre peut produire un PDF à la demande : elle appelle l'outil
// `export_pdf` avec un titre et du Markdown, et le fichier atterrit dans le
// dossier Téléchargements de l'utilisateur. Rien de nouveau côté rendu — c'est
// le même `render_to_pdf` que l'export de la sandbox.
//
// Deux garde-fous, parce que le nom de fichier vient ici d'un MODÈLE :
//  - le nom est assaini et borné (séparateurs de chemin retirés, longueur
//    plafonnée) : un titre halluciné ne doit pas pouvoir écrire ailleurs ;
//  - un fichier existant n'est jamais écrasé, on suffixe.

/// Nom de fichier sûr, dérivé d'un titre libre.
///
/// Le titre est écrit par le modèle : il peut contenir des `/`, des `..`, des
/// caractères interdits par le système de fichiers, ou faire trois mille signes.
/// On ne garde que ce qui est inoffensif, et on borne en OCTETS (la limite du
/// système de fichiers l'est aussi, et « é » en fait deux).
pub(crate) fn safe_stem(title: &str) -> String {
    const MAX_BYTES: usize = 60;
    let mut out = String::new();
    let mut pending_space = false;
    for c in title.chars() {
        let keep = c.is_alphanumeric() || matches!(c, '-' | '_' | '\'' | '(' | ')');
        if keep {
            if pending_space && !out.is_empty() {
                if out.len() + 1 + c.len_utf8() > MAX_BYTES {
                    break;
                }
                out.push(' ');
            }
            pending_space = false;
            if out.len() + c.len_utf8() > MAX_BYTES {
                break;
            }
            out.push(c);
        } else {
            pending_space = true;
        }
    }
    let out = out.trim().trim_matches('.').to_string();
    if out.is_empty() {
        "Document Lumen".into()
    } else {
        out
    }
}

/// Chemin libre dans `dir` pour `<stem>.pdf`. On ne remplace jamais un fichier
/// existant : deux demandes de suite au même titre produisent deux documents,
/// et non un écrasement silencieux de ce que l'utilisateur venait d'obtenir.
pub(crate) fn free_path(dir: &std::path::Path, stem: &str) -> std::path::PathBuf {
    let first = dir.join(format!("{stem}.pdf"));
    if !first.exists() {
        return first;
    }
    for n in 2..1000 {
        let candidate = dir.join(format!("{stem} ({n}).pdf"));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!(
        "{stem} ({}).pdf",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    ))
}

/// Génère un PDF depuis le chat et l'enregistre dans les Téléchargements.
/// Renvoie le chemin complet, le nom de fichier et la taille.
#[tauri::command]
pub fn chat_export_pdf(
    app: tauri::AppHandle,
    title: String,
    content: String,
) -> Result<Value, String> {
    use tauri::Manager;
    if content.trim().is_empty() {
        return Err("Contenu vide : rien à mettre dans le PDF.".into());
    }
    let stem = safe_stem(&title);
    let bytes = render_to_pdf(&stem, "md", &content)?;

    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().desktop_dir())
        .or_else(|_| app.path().home_dir())
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = free_path(&dir, &stem);
    std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "path": dest.to_string_lossy(),
        "name": dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        "bytes": bytes.len(),
    }))
}

/// Ouvre un fichier produit par Lumen avec l'application système. Réservé aux
/// chemins que Lumen vient d'écrire — le front ne passe ici que le chemin
/// renvoyé par `chat_export_pdf`.
#[tauri::command]
pub fn open_exported_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod export_tests {
    use super::safe_stem;

    #[test]
    fn neutralise_un_titre_hostile() {
        // Le titre vient d'un modèle : ni traversée de chemin, ni séparateur.
        let stem = safe_stem("../../etc/passwd");
        assert!(!stem.contains('/'));
        assert!(!stem.contains(".."));
        assert_eq!(stem, "etc passwd");
    }

    #[test]
    fn borne_la_longueur_en_octets() {
        let stem = safe_stem(&"éàü ".repeat(200));
        assert!(stem.len() <= 60, "{} octets", stem.len());
        assert!(stem.is_char_boundary(stem.len()));
    }

    #[test]
    fn garde_un_titre_lisible_et_ne_rend_jamais_vide() {
        assert_eq!(safe_stem("Rapport trimestriel (T3)"), "Rapport trimestriel (T3)");
        assert_eq!(safe_stem("///"), "Document Lumen");
        assert_eq!(safe_stem(""), "Document Lumen");
    }
}
