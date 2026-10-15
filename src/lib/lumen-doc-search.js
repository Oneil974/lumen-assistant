// Recherche commune aux interfaces Application et Bureau.
let lumenDocsIndex = null;
async function loadLumenDocsIndex() {
  if (lumenDocsIndex) return lumenDocsIndex;
  const response = await fetch("/docs/docs.html");
  if (!response.ok) throw new Error(`Documentation indisponible (${response.status})`);
  const html = await response.text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  const navLabels = {};
  doc.querySelectorAll(".nav-item[data-page]").forEach((n) => {
    navLabels[n.dataset.page] = (n.textContent || "").trim();
  });
  lumenDocsIndex = Array.from(doc.querySelectorAll("section.page[data-page]")).map((section) => {
    const page = section.dataset.page || "";
    const title = section.querySelector("h1,h2")?.textContent?.trim() || navLabels[page] || page;
    const text = (section.textContent || "").replace(/\s+/g, " ").trim();
    return { page, title, text };
  }).filter((s) => s.text);
  return lumenDocsIndex;
}

export async function searchLumenDocs(query, category = "") {
  const docs = await loadLumenDocsIndex();
  const qWords = String(query || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const cat = String(category || "").toLowerCase().trim();
  const scored = docs.map((d) => {
    const hay = `${d.page} ${d.title} ${d.text}`.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    let score = qWords.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
    if (cat && (d.page.toLowerCase() === cat || d.title.toLowerCase().includes(cat))) score += 4;
    return { ...d, score };
  }).filter((d) => d.score > 0 || cat && d.page.toLowerCase() === cat)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  if (!scored.length) return "Aucune page pertinente trouvée dans la documentation Lumen.";
  return scored.map((d, i) => {
    const snippet = d.text.slice(0, 1800);
    return `[${i + 1}] ${d.title} (${d.page})\n${snippet}`;
  }).join("\n\n");
}

