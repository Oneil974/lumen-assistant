//! Facture Factur-X : PDF lisible + XML CII embarqué dans le même fichier.
//!
//! Factur-X est un fichier HYBRIDE : un PDF que l'humain lit, portant en pièce
//! jointe le XML `factur-x.xml` que la machine lit. Les deux doivent dire la
//! même chose — c'est le XML qui fait foi pour la plateforme de dématérialisation.
//!
//! Ce module écrit :
//!   * la page (mise en page facture : émetteur, client, lignes, ventilation
//!     de TVA, totaux, mentions légales) ;
//!   * la pièce jointe `factur-x.xml` avec `/AFRelationship /Alternative`,
//!     référencée à la fois par `/Names /EmbeddedFiles` (lisible par tous les
//!     lecteurs PDF) et par `/AF` sur le catalogue (exigence Factur-X) ;
//!   * les métadonnées XMP portant l'extension Factur-X (profil, nom du
//!     fichier, version), ce que les logiciels comptables lisent pour savoir
//!     qu'ils ont affaire à une facture structurée.
//!
//! LIMITE ASSUMÉE : le PDF produit n'est pas encore *certifié* PDF/A-3. Il lui
//! manque les polices embarquées et l'intention de sortie ICC, que les polices
//! de base PDF (Helvetica) ne permettent pas. Le XML, lui, est complet et
//! exportable seul — c'est la pièce qu'attend une plateforme de dématérialisation.

use pdf_writer::types::AssociationKind;
use pdf_writer::{Content, Finish, Name, Pdf, Rect, Ref, Str, TextStr};
use serde_json::Value;

use crate::pdf::pdf_text_bytes;

const PAGE_W: f32 = 595.28;
const PAGE_H: f32 = 841.89;
const MARGIN: f32 = 42.0;
const F_REG: &[u8] = b"F1";
const F_BOLD: &[u8] = b"F2";

const FACTURX_VERSION: &str = "1.0";
const FACTURX_FILENAME: &str = "factur-x.xml";

fn s(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .unwrap_or_default()
        .to_string()
}

fn arr<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key).and_then(|x| x.as_array()).map(|a| a.as_slice()).unwrap_or(&[])
}

/// Largeur approchée d'un texte en Helvetica, suffisante pour couper une
/// cellule et aligner à droite sans embarquer les métriques complètes.
fn text_width(text: &str, size: f32) -> f32 {
    text.chars()
        .map(|c| match c {
            'i' | 'l' | 'j' | '.' | ',' | ':' | ';' | '\'' | '|' | ' ' => 0.29,
            'f' | 't' | 'r' | '(' | ')' | '[' | ']' | '-' => 0.36,
            'm' | 'w' | 'M' | 'W' => 0.86,
            'A'..='Z' => 0.68,
            '0'..='9' => 0.556,
            _ => 0.52,
        })
        .sum::<f32>()
        * size
}

/// Coupe un texte à la largeur donnée, en lignes.
fn wrap(text: &str, size: f32, width: f32) -> Vec<String> {
    let mut out = Vec::new();
    for para in text.split('\n') {
        let mut line = String::new();
        for word in para.split_whitespace() {
            let candidate = if line.is_empty() {
                word.to_string()
            } else {
                format!("{line} {word}")
            };
            if text_width(&candidate, size) > width && !line.is_empty() {
                out.push(std::mem::take(&mut line));
                line = word.to_string();
            } else {
                line = candidate;
            }
        }
        out.push(line);
    }
    if out.is_empty() {
        out.push(String::new());
    }
    out
}

struct Page {
    content: Content,
}

impl Page {
    fn new() -> Self {
        Self {
            content: Content::new(),
        }
    }

    fn text(&mut self, txt: &str, x: f32, y: f32, size: f32, bold: bool) {
        if txt.is_empty() {
            return;
        }
        let bytes = pdf_text_bytes(txt);
        self.content.begin_text();
        self.content
            .set_font(Name(if bold { F_BOLD } else { F_REG }), size);
        self.content.next_line(x, y);
        self.content.show(Str(&bytes));
        self.content.end_text();
    }

    fn right(&mut self, txt: &str, right_x: f32, y: f32, size: f32, bold: bool) {
        let w = text_width(txt, size);
        self.text(txt, right_x - w, y, size, bold);
    }

    fn gray(&mut self, level: f32) {
        self.content.set_fill_rgb(level, level, level);
    }

    fn rgb(&mut self, r: f32, g: f32, b: f32) {
        self.content.set_fill_rgb(r, g, b);
    }

    fn rect(&mut self, x: f32, y: f32, w: f32, h: f32) {
        self.content.rect(x, y, w, h);
        self.content.fill_nonzero();
    }
}

/// Rend la facture et renvoie les octets du PDF Factur-X.
///
/// `doc` est le descriptif de rendu produit par l'app (libellés déjà traduits
/// et montants déjà formatés côté JS : ce module ne recalcule rien, pour que le
/// PDF ne puisse pas diverger du XML).
#[tauri::command]
pub fn facturx_pdf(doc: Value, xml: String) -> Result<Vec<u8>, String> {
    let mut page = Page::new();
    let content_w = PAGE_W - 2.0 * MARGIN;

    // --- Bandeau de titre ---
    page.rgb(0.09, 0.09, 0.12);
    page.rect(0.0, PAGE_H - 96.0, PAGE_W, 96.0);
    page.rgb(1.0, 1.0, 1.0);
    page.text(&s(&doc, "title"), MARGIN, PAGE_H - 48.0, 22.0, true);
    page.text(&s(&doc, "subtitle"), MARGIN, PAGE_H - 68.0, 10.0, false);
    let badge = s(&doc, "badge");
    if !badge.is_empty() {
        page.right(&badge, PAGE_W - MARGIN, PAGE_H - 48.0, 10.0, true);
    }
    page.right(
        &s(&doc, "badge_sub"),
        PAGE_W - MARGIN,
        PAGE_H - 64.0,
        9.0,
        false,
    );
    let mut y = PAGE_H - 96.0 - 26.0;

    // --- Émetteur / client, en deux colonnes ---
    let col_w = (content_w - 18.0) / 2.0;
    let start_y = y;
    let mut left_y = y;
    page.gray(0.35);
    page.text("ÉMETTEUR", MARGIN, left_y, 8.0, true);
    left_y -= 13.0;
    page.gray(0.0);
    for (i, line) in arr(&doc, "seller").iter().enumerate() {
        let txt = line.as_str().unwrap_or_default();
        for l in wrap(txt, 9.0, col_w) {
            page.text(&l, MARGIN, left_y, 9.0, i == 0);
            left_y -= 11.5;
        }
    }
    let mut right_y = start_y;
    let bx = MARGIN + col_w + 18.0;
    page.gray(0.35);
    page.text("CLIENT", bx, right_y, 8.0, true);
    right_y -= 13.0;
    page.gray(0.0);
    for (i, line) in arr(&doc, "buyer").iter().enumerate() {
        let txt = line.as_str().unwrap_or_default();
        for l in wrap(txt, 9.0, col_w) {
            page.text(&l, bx, right_y, 9.0, i == 0);
            right_y -= 11.5;
        }
    }
    y = left_y.min(right_y) - 12.0;

    // --- Bandeau d'informations (dates, références) ---
    let meta = arr(&doc, "meta");
    if !meta.is_empty() {
        let h = 30.0;
        page.gray(0.95);
        page.rect(MARGIN, y - h + 8.0, content_w, h);
        page.gray(0.0);
        let step = content_w / meta.len().max(1) as f32;
        for (i, m) in meta.iter().enumerate() {
            let x = MARGIN + 9.0 + step * i as f32;
            page.gray(0.42);
            page.text(&s(m, "label"), x, y - 2.0, 7.5, false);
            page.gray(0.0);
            page.text(&s(m, "value"), x, y - 14.0, 9.5, true);
        }
        y -= h + 14.0;
    }

    // --- Tableau des lignes ---
    // Colonnes : désignation | qté | unité | PU HT | remise | TVA | total HT
    let x_desc = MARGIN;
    let x_qty = MARGIN + content_w - 250.0;
    let x_unit = MARGIN + content_w - 205.0;
    let x_price = MARGIN + content_w - 140.0;
    let x_disc = MARGIN + content_w - 95.0;
    let x_vat = MARGIN + content_w - 60.0;
    let x_total = MARGIN + content_w;

    page.gray(0.09);
    page.rect(MARGIN, y - 4.0, content_w, 18.0);
    page.rgb(1.0, 1.0, 1.0);
    page.text("Désignation", x_desc + 6.0, y + 1.0, 8.0, true);
    page.right("Qté", x_qty + 34.0, y + 1.0, 8.0, true);
    page.text("Unité", x_unit, y + 1.0, 8.0, true);
    page.right("P.U. HT", x_price + 40.0, y + 1.0, 8.0, true);
    page.right("Rem.", x_disc + 28.0, y + 1.0, 8.0, true);
    page.right("TVA", x_vat + 26.0, y + 1.0, 8.0, true);
    page.right("Total HT", x_total - 6.0, y + 1.0, 8.0, true);
    y -= 18.0;

    page.gray(0.0);
    for (i, line) in arr(&doc, "lines").iter().enumerate() {
        let label = s(line, "label");
        let reference = s(line, "ref");
        let desc_w = x_qty - x_desc - 14.0;
        let mut wrapped = wrap(&label, 9.0, desc_w);
        if !reference.is_empty() {
            wrapped.push(format!("Réf. {reference}"));
        }
        let h = 6.0 + wrapped.len() as f32 * 11.0;
        if i % 2 == 1 {
            page.gray(0.965);
            page.rect(MARGIN, y - h + 9.0, content_w, h);
            page.gray(0.0);
        }
        let base_y = y;
        for (j, l) in wrapped.iter().enumerate() {
            page.gray(if j > 0 && !reference.is_empty() && j == wrapped.len() - 1 {
                0.45
            } else {
                0.0
            });
            page.text(l, x_desc + 6.0, base_y - j as f32 * 11.0, if j == 0 { 9.0 } else { 8.0 }, false);
        }
        page.gray(0.0);
        page.right(&s(line, "qty"), x_qty + 34.0, base_y, 9.0, false);
        page.text(&s(line, "unit"), x_unit, base_y, 9.0, false);
        page.right(&s(line, "price"), x_price + 40.0, base_y, 9.0, false);
        page.right(&s(line, "discount"), x_disc + 28.0, base_y, 9.0, false);
        page.right(&s(line, "vat"), x_vat + 26.0, base_y, 9.0, false);
        page.right(&s(line, "total"), x_total - 6.0, base_y, 9.0, true);
        y -= h;
    }
    page.gray(0.8);
    page.rect(MARGIN, y + 6.0, content_w, 0.6);
    y -= 16.0;

    // --- Ventilation de TVA + totaux, côte à côte ---
    let vat_rows = arr(&doc, "vat");
    let block_y = y;
    if !vat_rows.is_empty() {
        page.gray(0.35);
        page.text("VENTILATION DE TVA", MARGIN, y, 8.0, true);
        page.gray(0.0);
        let mut vy = y - 13.0;
        page.gray(0.45);
        page.text("Base HT", MARGIN, vy, 7.5, false);
        page.text("Taux", MARGIN + 78.0, vy, 7.5, false);
        page.text("Catégorie", MARGIN + 118.0, vy, 7.5, false);
        page.text("TVA", MARGIN + 190.0, vy, 7.5, false);
        page.gray(0.0);
        vy -= 12.0;
        for row in vat_rows {
            page.text(&s(row, "base"), MARGIN, vy, 9.0, false);
            page.text(&s(row, "rate"), MARGIN + 78.0, vy, 9.0, false);
            page.text(&s(row, "category"), MARGIN + 118.0, vy, 9.0, false);
            page.text(&s(row, "tax"), MARGIN + 190.0, vy, 9.0, false);
            vy -= 12.0;
        }
        y = vy;
    }

    let mut ty = block_y;
    let tx = MARGIN + content_w;
    for total in arr(&doc, "totals") {
        let strong = total.get("strong").and_then(|v| v.as_bool()).unwrap_or(false);
        if strong {
            page.gray(0.94);
            page.rect(tx - 220.0, ty - 5.0, 220.0, 20.0);
            page.gray(0.0);
        }
        page.text(&s(total, "label"), tx - 210.0, ty, if strong { 10.5 } else { 9.5 }, strong);
        page.right(&s(total, "value"), tx - 8.0, ty, if strong { 10.5 } else { 9.5 }, strong);
        ty -= if strong { 22.0 } else { 14.0 };
    }
    y = y.min(ty) - 18.0;

    // --- Mentions légales ---
    for note in arr(&doc, "notes") {
        let txt = note.as_str().unwrap_or_default();
        for l in wrap(txt, 8.0, content_w) {
            page.gray(0.28);
            page.text(&l, MARGIN, y, 8.0, false);
            y -= 10.0;
        }
        y -= 3.0;
    }

    // --- Pied de page ---
    page.gray(0.5);
    let footer = s(&doc, "footer");
    for (i, l) in wrap(&footer, 7.5, content_w).iter().enumerate() {
        page.text(l, MARGIN, 42.0 - i as f32 * 9.0, 7.5, false);
    }
    page.right(
        &format!("Factur-X {} · profil {}", FACTURX_VERSION, s(&doc, "profile")),
        PAGE_W - MARGIN,
        42.0,
        7.5,
        false,
    );

    // ===================== Assemblage du PDF =====================
    let mut pdf = Pdf::new();
    let mut alloc = Ref::new(1);
    let catalog_id = alloc.bump();
    let pages_id = alloc.bump();
    let page_id = alloc.bump();
    let content_id = alloc.bump();
    let info_id = alloc.bump();
    let font_reg_id = alloc.bump();
    let font_bold_id = alloc.bump();
    let file_spec_id = alloc.bump();
    let embedded_id = alloc.bump();
    let metadata_id = alloc.bump();

    let title = s(&doc, "title");
    let number = s(&doc, "number");

    let xml_bytes = xml.into_bytes();
    let mut embedded = pdf.embedded_file(embedded_id, &xml_bytes);
    embedded.subtype(Name(b"text/xml"));
    embedded.pair(Name(b"Type"), Name(b"EmbeddedFile"));
    embedded.params().size(xml_bytes.len() as i32);
    embedded.finish();

    let mut spec = pdf.file_spec(file_spec_id);
    spec.path(Str(FACTURX_FILENAME.as_bytes()));
    spec.unic_file(TextStr(FACTURX_FILENAME));
    spec.description(TextStr("Facture électronique au format Factur-X (CII)"));
    spec.association_kind(AssociationKind::Alternative);
    spec.embedded_file(embedded_id);
    spec.finish();

    let xmp = facturx_xmp(&title, &number, &s(&doc, "profile"));
    pdf.metadata(metadata_id, xmp.as_bytes());

    {
        let mut catalog = pdf.catalog(catalog_id);
        catalog.pages(pages_id);
        catalog.metadata(metadata_id);
        // `/AF` doit référencer la pièce jointe par objet indirect : le tableau
        // typé de pdf-writer n'accepte que des dictionnaires écrits sur place.
        catalog.insert(Name(b"AF")).array().item(file_spec_id);
        catalog
            .names()
            .embedded_files()
            .names()
            .insert(Str(FACTURX_FILENAME.as_bytes()), file_spec_id);
        catalog.finish();
    }

    pdf.document_info(info_id)
        .title(TextStr(&title))
        .creator(TextStr("Lumen — Facturation"));

    pdf.pages(pages_id).kids([page_id]).count(1);
    {
        let mut p = pdf.page(page_id);
        p.media_box(Rect::new(0.0, 0.0, PAGE_W, PAGE_H));
        p.parent(pages_id);
        p.contents(content_id);
        let mut resources = p.resources();
        resources
            .fonts()
            .pairs([(Name(F_REG), font_reg_id), (Name(F_BOLD), font_bold_id)]);
        resources.finish();
        p.finish();
    }
    pdf.type1_font(font_reg_id)
        .base_font(Name(b"Helvetica"))
        .encoding_predefined(Name(b"WinAnsiEncoding"));
    pdf.type1_font(font_bold_id)
        .base_font(Name(b"Helvetica-Bold"))
        .encoding_predefined(Name(b"WinAnsiEncoding"));

    let data = page.content.finish();
    pdf.stream(content_id, &data);

    Ok(pdf.finish())
}

/// Métadonnées XMP portant l'extension Factur-X : c'est par elles qu'un
/// logiciel comptable reconnaît une facture structurée avant même d'ouvrir la
/// pièce jointe.
fn facturx_xmp(title: &str, number: &str, profile: &str) -> String {
    let esc = |s: &str| {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    format!(
        r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">{title}</rdf:li></rdf:Alt></dc:title>
   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">Facture {number}</rdf:li></rdf:Alt></dc:description>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
   <pdf:Producer>Lumen</pdf:Producer>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#">
   <fx:DocumentType>INVOICE</fx:DocumentType>
   <fx:DocumentFileName>{file}</fx:DocumentFileName>
   <fx:Version>{version}</fx:Version>
   <fx:ConformanceLevel>{profile}</fx:ConformanceLevel>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"#,
        title = esc(title),
        number = esc(number),
        file = FACTURX_FILENAME,
        version = FACTURX_VERSION,
        profile = esc(profile),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Value {
        json!({
            "title": "Facture F2026-0001",
            "subtitle": "Atelier Lumen — émise le 03/09/2026",
            "number": "F2026-0001",
            "badge": "2 993,94 €",
            "badge_sub": "Échéance 03/10/2026",
            "profile": "EN 16931",
            "seller": ["Atelier Lumen", "3 rue des Lilas", "75011 Paris", "SIREN 123456789"],
            "buyer": ["Dupont SAS", "8 avenue du Port", "44000 Nantes"],
            "meta": [{"label": "NUMÉRO", "value": "F2026-0001"}, {"label": "DATE", "value": "03/09/2026"}],
            "lines": [{"label": "Formation à l'usage des modèles locaux", "ref": "FORM-01",
                       "qty": "3", "unit": "jour", "price": "800,00 €", "discount": "—",
                       "vat": "20 %", "total": "2 400,00 €"}],
            "vat": [{"base": "2 400,00 €", "rate": "20 %", "category": "S", "tax": "480,00 €"}],
            "totals": [{"label": "Total TTC", "value": "2 880,00 €", "strong": true}],
            "notes": ["Pénalités de retard : 10,85 % par an."],
            "footer": "Atelier Lumen · SIREN 123456789",
        })
    }

    #[test]
    fn pdf_embarque_le_xml_facturx() {
        let xml = "<?xml version=\"1.0\"?><rsm:CrossIndustryInvoice/>";
        let bytes = facturx_pdf(sample(), xml.to_string()).expect("rendu");
        assert!(bytes.starts_with(b"%PDF-"));
        let text = String::from_utf8_lossy(&bytes);
        // La pièce jointe est nommée, reliée au catalogue et déclarée comme
        // représentation alternative de la facture : c'est ce triptyque que
        // cherchent les logiciels comptables.
        assert!(text.contains("factur-x.xml"), "pièce jointe absente");
        assert!(text.contains("/AFRelationship /Alternative"), "relation Factur-X absente");
        assert!(text.contains("/EmbeddedFiles"), "arbre des pièces jointes absent");
        assert!(text.contains("fx:DocumentType"), "métadonnées XMP Factur-X absentes");
        assert!(text.contains("CrossIndustryInvoice"), "XML non embarqué");
    }

    #[test]
    fn le_texte_est_coupe_a_la_largeur() {
        let lines = wrap("un texte assez long pour devoir être coupé en morceaux", 9.0, 60.0);
        assert!(lines.len() > 1);
        assert!(lines.iter().all(|l| text_width(l, 9.0) <= 60.0 || !l.contains(' ')));
    }
}
