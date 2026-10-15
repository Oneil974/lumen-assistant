// Polices de projet — téléchargement HORS-LIGNE des Google Fonts.
//
// À la création d'une charte, on récupère le CSS Google Fonts de la famille, on
// télécharge les fichiers .woff2 et on les ENREGISTRE dans le dossier du projet
// (`canevas/<slug>/fonts/`). On injecte alors des @font-face en data URL (lus
// depuis la sandbox), si bien qu'à la réouverture le rendu ne dépend plus du
// réseau. `project.fonts` (dans project.json) référence les fichiers par famille.

import * as store from "./store.js";

const injected = new Set(); // `${family}@${weight}` déjà injectés dans le DOM

function styleEl() {
  let s = document.getElementById("canvas-fonts");
  if (!s) { s = document.createElement("style"); s.id = "canvas-fonts"; document.head.appendChild(s); }
  return s;
}
const fontSlug = (f) => String(f).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000; // conversion par blocs (évite le dépassement de pile)
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}

function injectFace(family, weight, b64) {
  const key = `${family}@${weight}`;
  if (injected.has(key)) return;
  injected.add(key);
  styleEl().appendChild(document.createTextNode(
    `@font-face{font-family:'${String(family).replace(/'/g, "")}';font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${b64}) format('woff2');}`));
}

// Télécharge les .woff2 d'une famille et les enregistre dans le projet.
// Renvoie [{ weight, file }]. Une entrée par graisse (sous-ensemble latin).
async function downloadFamily(slug, family) {
  const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}:wght@400;500;600;700&display=swap`;
  const css = await (await fetch(url)).text();
  const out = [], seen = new Set();
  const re = /@font-face\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const block = m[1];
    const weight = (block.match(/font-weight:\s*(\d+)/) || [])[1] || "400";
    if (seen.has(weight)) continue; // 1re occurrence = latin, suffisant
    const src = (block.match(/url\(([^)]+\.woff2)\)/) || [])[1];
    if (!src) continue;
    seen.add(weight);
    const buf = await (await fetch(src.replace(/['"]/g, ""))).arrayBuffer();
    const b64 = bufToB64(buf);
    const file = `fonts/${fontSlug(family)}-${weight}.woff2`;
    await store.importBinary(slug, file, b64);
    injectFace(family, weight, b64);
    out.push({ weight: Number(weight), file });
  }
  if (!out.length) throw new Error("Aucune woff2 trouvée pour " + family);
  return out;
}

async function injectFromStore(project, family) {
  for (const f of project.fonts[family] || []) {
    if (injected.has(`${family}@${f.weight}`)) continue;
    try { injectFace(family, f.weight, await store.readBinaryB64(project.slug, f.file)); } catch {}
  }
}

// Garantit que les familles sont présentes (téléchargées) et injectées.
// Met à jour `project.fonts` ; le caller persiste le projet ensuite.
export async function ensureProjectFonts(project, families) {
  project.fonts = project.fonts || {};
  for (const fam of families) {
    if (!fam) continue;
    if (project.fonts[fam] && project.fonts[fam].length) { await injectFromStore(project, fam); continue; }
    try { project.fonts[fam] = await downloadFamily(project.slug, fam); }
    catch { /* hors-ligne ou famille absente : on retombe sur le CDN (loadGoogleFont) */ }
  }
}

// À l'ouverture d'un projet : ré-injecte toutes les polices déjà enregistrées,
// sans réseau.
export async function injectProjectFonts(project) {
  if (!project || !project.fonts) return;
  for (const fam of Object.keys(project.fonts)) await injectFromStore(project, fam);
}
