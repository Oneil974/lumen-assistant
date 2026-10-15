// Bibliothèque libre de l'app Études : importer un cours depuis des sources
// ouvertes, AVEC sa licence et son crédit (conservés sur la source importée
// et réaffichés partout où le cours apparaît).
//
// Il n'existe pas, à notre connaissance, de grand corpus de COURS publié en
// CC0 et interrogeable par API. On propose donc ce qui s'en approche le plus :
//   • Project Gutenberg (via l'API Gutendex) — œuvres du domaine public ;
//   • Wikiversité, Wikilivres, Wikipédia — CC BY-SA 4.0 (attribution + partage
//     à l'identique : le crédit et le lien sont obligatoires, on les garde).
// Chaque source déclare sa licence : l'UI ne présente jamais du CC BY-SA
// comme du domaine public.

const MW = {
  wikiversity: { label: "Wikiversité", host: (l) => `${l}.wikiversity.org`, license: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/deed.fr" },
  wikibooks: { label: "Wikilivres", host: (l) => `${l}.wikibooks.org`, license: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/deed.fr" },
  wikipedia: { label: "Wikipédia", host: (l) => `${l}.wikipedia.org`, license: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/deed.fr" },
};
export const PROVIDERS = [
  { id: "wikiversity", label: "Wikiversité", license: "CC BY-SA 4.0", hint: "Leçons et cours rédigés par des enseignants" },
  { id: "wikibooks", label: "Wikilivres", license: "CC BY-SA 4.0", hint: "Manuels libres" },
  { id: "wikipedia", label: "Wikipédia", license: "CC BY-SA 4.0", hint: "Articles encyclopédiques" },
  { id: "gutenberg", label: "Project Gutenberg", license: "Domaine public", hint: "Œuvres et manuels anciens du domaine public" },
];

const __TAURI = window.__TAURI__ || (window.parent && window.parent.__TAURI__) || {};
const invoke = __TAURI.core?.invoke;

/** fetch direct (les API Wikimedia et Gutendex acceptent CORS), sinon relais Rust. */
async function getText(url) {
  try {
    const r = await fetch(url);
    if (r.ok) return await r.text();
  } catch {}
  if (!invoke) throw new Error("Réseau indisponible.");
  return String(await invoke("web_fetch_raw", { url }));
}
const getJSON = async (url) => JSON.parse(await getText(url));

/** Recherche → [{ provider, id, title, snippet }] */
export async function search(provider, query, lang = "fr") {
  const q = encodeURIComponent(query);
  if (provider === "gutenberg") {
    const data = await getJSON(`https://gutendex.com/books/?search=${q}&languages=${lang}`);
    return (data.results || []).filter((b) => textUrl(b)).slice(0, 20).map((b) => ({
      provider, id: String(b.id), title: b.title, snippet: (b.authors || []).map((a) => a.name).join(", "), book: b,
    }));
  }
  const src = MW[provider];
  const data = await getJSON(`https://${src.host(lang)}/w/api.php?action=query&list=search&srsearch=${q}&srlimit=20&format=json&origin=*`);
  return (data.query?.search || []).map((r) => ({
    provider, id: r.title, title: r.title, snippet: new DOMParser().parseFromString(String(r.snippet || ""), "text/html").body.textContent || "",
  }));
}

function textUrl(b) {
  const f = b.formats || {};
  return f["text/plain; charset=utf-8"] || f["text/plain; charset=us-ascii"] || f["text/plain"] || null;
}

/**
 * Récupère le texte complet + le crédit.
 * @returns {Promise<{ title, text, credit: { source, license, licenseUrl, url, authors } }>}
 */
export async function fetchCourse(hit, lang = "fr") {
  if (hit.provider === "gutenberg") {
    const b = hit.book;
    let text = await getText(textUrl(b));
    // En-tête et pied de licence Gutenberg : hors du cours, mais la mention
    // « Project Gutenberg » reste dans le crédit.
    const s = text.search(/\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG[^\n]*\n/i);
    if (s >= 0) text = text.slice(text.indexOf("\n", s) + 1);
    const e = text.search(/\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG/i);
    if (e >= 0) text = text.slice(0, e);
    return {
      title: b.title,
      text: text.replace(/\r/g, "").trim(),
      credit: { source: "Project Gutenberg", license: "Domaine public", licenseUrl: "https://www.gutenberg.org/policy/license.html",
        url: `https://www.gutenberg.org/ebooks/${b.id}`, authors: (b.authors || []).map((a) => a.name).join(", ") },
    };
  }
  const src = MW[hit.provider];
  const host = src.host(lang);
  const t = encodeURIComponent(hit.title);
  const data = await getJSON(`https://${host}/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=wiki&redirects=1&titles=${t}&format=json&origin=*`);
  const page = Object.values(data.query?.pages || {})[0] || {};
  const text = String(page.extract || "").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) throw new Error("Page vide ou introuvable.");
  const slug = encodeURIComponent(String(page.title || hit.title).replace(/ /g, "_"));
  const url = `https://${host}/wiki/${slug}`;
  return {
    title: page.title || hit.title,
    text,
    credit: { source: src.label, license: src.license, licenseUrl: src.licenseUrl, url,
      authors: `contributeurs de ${src.label}`, history: `https://${host}/w/index.php?title=${slug}&action=history` },
  };
}

/** Ligne de crédit lisible, à afficher sous le cours. */
export const creditLine = (c) => c ? `${c.source} · ${c.license}${c.authors ? ` · ${c.authors}` : ""}` : "";
