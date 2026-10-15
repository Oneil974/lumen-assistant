//! Recherche plein texte dans la **documentation de Lumen** (le manuel), par
//! opposition à la base de connaissances de l'utilisateur (`lumen_search_documents`).
//!
//! La documentation vit dans `src/docs/docs.html`, servie par la fenêtre
//! Documentation. Le frontend étant embarqué dans le binaire par Tauri, il n'y a
//! pas de fichier à lire sur le disque en production : le HTML est donc inclus à
//! la compilation (`include_str!`) puis découpé une fois pour toutes en extraits
//! (une page × un titre de niveau 2). La recherche est purement lexicale — aucun
//! modèle, aucun réseau — pour qu'une question de l'utilisateur trouve ses
//! passages instantanément, y compris hors ligne.
//!
//! Note : le HTML source est en français ; la version anglaise du manuel est
//! produite côté frontend par substitution de fragments. Les extraits renvoyés
//! ici sont donc en français, et c'est le modèle qui répond dans la langue de
//! l'utilisateur à partir de ces extraits.

use std::sync::OnceLock;

const DOCS_HTML: &str = include_str!("../../src/docs/docs.html");

/// Un passage indexable : la page du sommaire, son titre, et le texte brut.
#[derive(Debug, Clone)]
pub struct DocChunk {
    pub page: String,
    pub heading: String,
    pub text: String,
}

/// Minuscules sans accents : « Réglages » et « reglages » doivent matcher.
fn normalize(input: &str) -> String {
    input
        .chars()
        .flat_map(|c| c.to_lowercase())
        .map(|c| match c {
            'à' | 'â' | 'ä' | 'á' | 'ã' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'î' | 'ï' | 'í' => 'i',
            'ô' | 'ö' | 'ó' | 'õ' => 'o',
            'ù' | 'û' | 'ü' | 'ú' => 'u',
            'ç' => 'c',
            'ÿ' => 'y',
            other => other,
        })
        .collect()
}

/// Mots significatifs d'une requête : au moins 3 caractères, hors mots-outils
/// français et anglais qui apparaîtraient dans presque tous les extraits.
fn keywords(query: &str) -> Vec<String> {
    const STOP: &[&str] = &[
        "les", "des", "une", "que", "qui", "quoi", "pour", "avec", "dans", "sur", "est", "sont",
        "comment", "puis", "peux", "peut", "faire", "lumen", "the", "and", "for", "with", "how",
        "what", "can", "does", "you", "your", "this", "that", "from",
    ];
    normalize(query)
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.chars().count() >= 3 && !STOP.contains(w))
        .map(|w| w.to_string())
        .collect()
}

/// Retire le balisage et normalise les espaces. Les `<svg>` du manuel ne
/// contiennent aucun texte : les vider suffit à les faire disparaître.
fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 2);
    let mut depth = 0_usize;
    for c in html.chars() {
        match c {
            '<' => depth += 1,
            '>' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    let decoded = out
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'");
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Valeur d'un attribut HTML à partir du début d'une balise ouvrante.
fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let needle = format!("{name}=\"");
    let start = tag.find(&needle)? + needle.len();
    let rest = &tag[start..];
    let end = rest.find('"')?;
    Some(&rest[..end])
}

/// Découpe le manuel en extraits. Chaque `<section data-page="…">` du sommaire
/// est scindée à chaque `<h2>` : c'est le grain de lecture naturel de la
/// documentation, et il tient dans un message Telegram.
fn build_index() -> Vec<DocChunk> {
    let mut chunks = Vec::new();
    // Les blocs <script>/<style> ne sont pas du contenu : les retirer évite
    // d'indexer du CSS.
    let body = strip_blocks(DOCS_HTML, "script");
    let body = strip_blocks(&body, "style");

    let mut rest = body.as_str();
    let mut sections: Vec<(String, &str)> = Vec::new();
    while let Some(pos) = rest.find("<section") {
        let after = &rest[pos..];
        let tag_end = match after.find('>') {
            Some(i) => i,
            None => break,
        };
        let page = attr(&after[..tag_end], "data-page").unwrap_or("").to_string();
        let content_start = pos + tag_end + 1;
        // Fin de section = début de la suivante (le manuel ne les imbrique pas)
        // ou fin du document.
        let content = &rest[content_start..];
        let end = content.find("<section").unwrap_or(content.len());
        if !page.is_empty() {
            sections.push((page, &content[..end]));
        }
        rest = &content[end..];
        if rest.is_empty() {
            break;
        }
    }

    for (page, html) in sections {
        // Titre de page : le premier <h1>, sinon l'identifiant du sommaire.
        let page_title = between(html, "<h1", "</h1>")
            .map(strip_tags)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| page.clone());
        let mut heading = page_title.clone();
        for (index, part) in html.split("<h2").enumerate() {
            let (title, body) = if index == 0 {
                (heading.clone(), part.to_string())
            } else {
                let close = part.find("</h2>").unwrap_or(0);
                let title = strip_tags(part[..close].split_once('>').map(|x| x.1).unwrap_or(""));
                let body = part[close.saturating_add(5).min(part.len())..].to_string();
                (title, body)
            };
            let text = strip_tags(&body);
            if text.chars().count() < 40 {
                continue; // sommaire, encadré décoratif : rien à chercher dedans
            }
            heading = title.clone();
            chunks.push(DocChunk {
                page: page_title.clone(),
                heading: title,
                text,
            });
        }
    }
    chunks
}

/// Supprime les paires `<tag …>…</tag>` (scripts, styles).
fn strip_blocks(html: &str, tag: &str) -> String {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(start) = rest.find(&open) {
        out.push_str(&rest[..start]);
        rest = match rest[start..].find(&close) {
            Some(end) => &rest[start + end + close.len()..],
            None => "",
        };
    }
    out.push_str(rest);
    out
}

fn between<'a>(haystack: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let start = haystack.find(open)? + open.len();
    let rest = &haystack[start..];
    let end = rest.find(close)?;
    Some(&rest[..end])
}

fn index() -> &'static [DocChunk] {
    static INDEX: OnceLock<Vec<DocChunk>> = OnceLock::new();
    INDEX.get_or_init(build_index)
}

/// Les `limit` passages les plus pertinents pour `query`.
///
/// Score lexical simple : un mot-clé dans le titre pèse cinq fois un mot-clé
/// dans le corps, et les occurrences répétées sont plafonnées pour qu'une page
/// longue ne l'emporte pas sur une page précise. Un extrait qui ne contient
/// aucun mot-clé n'est jamais renvoyé — mieux vaut « rien trouvé » qu'un
/// passage au hasard, qui ferait halluciner le modèle en aval.
pub fn search(query: &str, limit: usize) -> Vec<&'static DocChunk> {
    let words = keywords(query);
    if words.is_empty() {
        return Vec::new();
    }
    let mut scored: Vec<(usize, &'static DocChunk)> = index()
        .iter()
        .filter_map(|chunk| {
            let heading = normalize(&format!("{} {}", chunk.page, chunk.heading));
            let text = normalize(&chunk.text);
            let mut score = 0_usize;
            let mut matched = 0_usize;
            for word in &words {
                let in_heading = heading.matches(word.as_str()).count();
                let in_text = text.matches(word.as_str()).count().min(3);
                if in_heading + in_text > 0 {
                    matched += 1;
                }
                score += in_heading * 5 + in_text;
            }
            // Exiger la moitié des mots-clés évite les correspondances sur un
            // seul mot commun (« modèle », « fichier »…).
            (matched * 2 >= words.len() && score > 0).then_some((score, chunk))
        })
        .collect();
    scored.sort_by_key(|(score, _)| std::cmp::Reverse(*score));
    scored.into_iter().take(limit).map(|(_, c)| c).collect()
}

/// Extraits mis en forme pour être injectés dans un prompt (ou lus tels quels).
/// `budget` borne la taille totale : le manuel est long, la fenêtre de contexte
/// d'un petit modèle local ne l'est pas.
pub fn search_text(query: &str, limit: usize, budget: usize) -> String {
    let hits = search(query, limit);
    if hits.is_empty() {
        return String::new();
    }
    let per_chunk = (budget / hits.len()).max(200);
    hits.iter()
        .map(|c| {
            let text: String = c.text.chars().take(per_chunk).collect();
            format!("## {} › {}\n{text}", c.page, c.heading)
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_is_not_empty() {
        assert!(index().len() > 20, "le manuel doit produire des extraits");
    }

    #[test]
    fn index_has_no_markup() {
        // Les `<` restants viennent des exemples du manuel (`&lt;clé&gt;`), pas
        // du balisage : on traque donc des motifs de balise, pas le caractère.
        for chunk in index() {
            for pattern in ["</", "<div", "<p>", "<span", "<svg", "<h2"] {
                assert!(
                    !chunk.text.contains(pattern),
                    "balisage résiduel ({pattern}) dans : {}",
                    chunk.heading
                );
            }
        }
    }

    #[test]
    fn finds_a_known_topic() {
        let hits = search("comment installer Lumen sur Linux", 3);
        assert!(!hits.is_empty(), "l'installation doit être trouvable");
    }

    #[test]
    fn unrelated_query_returns_nothing() {
        assert!(search("zzzz quuxbaz", 3).is_empty());
    }
}

