// Lumen XR — « lis ça » / « traduis ça » avec de TOUT PETITS modèles.
//
// Plus de modèle de vision : il obligeait le Mac à décharger son modèle
// principal pour charger un VLM de 3 milliards de paramètres, à chaque fois.
//
//   1. LECTURE (OCR) dans le casque : Tesseract.js (WASM, quelques Mo),
//      sur l'image de la caméra — « lis ça » s'arrête là, sans aucun modèle d'IA.
//   2. TRADUCTION, au choix (réglage, désactivée par défaut) :
//        • « casque » : Opus-MT (Helsinki-NLP) dans le casque, ≈ 107 Mo par
//          paire de langues, téléchargés une fois — le Mac ne fait rien ;
//        • « Mac »    : le modèle DÉJÀ chargé sur le Mac traduit le texte lu
//          (courte génération, aucun modèle à charger).

const TESS_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
// Deux langues suffisent à lire l'alphabet latin (accents compris) : téléchargement léger.
const OCR_LANGS = "eng+fra";

let tess = null;
async function ocrWorker(onProgress) {
  if (tess) return tess;
  if (!window.Tesseract) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = TESS_URL; s.onload = resolve; s.onerror = () => reject(new Error("Tesseract.js indisponible (réseau ?)"));
      document.head.appendChild(s);
    });
  }
  tess = window.Tesseract.createWorker(OCR_LANGS, 1, {
    logger: (m) => { if (m.status && typeof m.progress === "number") onProgress?.(m.status, m.progress); },
  }).catch((e) => { tess = null; throw e; });
  return tess;
}

/** Texte lu sur l'image (lignes nettoyées), ou "" s'il n'y a rien de lisible. */
export async function readText(canvas, onProgress) {
  const w = await ocrWorker(onProgress);
  const { data } = await w.recognize(canvas);
  return String(data?.text || "")
    .split("\n").map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 1 && /[\p{L}\p{N}]/u.test(l))
    .join("\n");
}

// ---- Langue du texte lu (mots outils, suffisant pour choisir le modèle) -------
const STOP = {
  fr: ["le", "la", "les", "de", "des", "et", "du", "au", "avec", "pour", "est", "une"],
  en: ["the", "and", "of", "with", "for", "to", "is", "a", "in", "your", "on"],
  es: ["el", "los", "las", "de", "con", "para", "y", "del", "es", "una", "por"],
  de: ["der", "die", "das", "und", "mit", "für", "ist", "ein", "eine", "von", "zu"],
  it: ["il", "di", "e", "con", "per", "la", "del", "della", "è", "una", "gli"],
};
export function detectLang(text) {
  const words = ` ${String(text).toLowerCase().replace(/[^\p{L}\s]/gu, " ")} `;
  let best = "en", score = 0;
  for (const [l, list] of Object.entries(STOP)) {
    const s = list.reduce((n, w) => n + (words.split(` ${w} `).length - 1), 0);
    if (s > score) { best = l; score = s; }
  }
  return best;
}

/** Modèles Opus-MT à enchaîner pour aller de `from` à `to` (relais par l'anglais), ou null. */
export function chainFor(from, to) {
  if (from === to) return [];
  const direct = { "en>fr": "Xenova/opus-mt-en-fr", "fr>en": "Xenova/opus-mt-fr-en", "es>en": "Xenova/opus-mt-es-en", "de>en": "Xenova/opus-mt-de-en", "it>en": "Xenova/opus-mt-it-en" };
  if (direct[`${from}>${to}`]) return [direct[`${from}>${to}`]];
  if (to === "fr" && direct[`${from}>en`]) return [direct[`${from}>en`], direct["en>fr"]];
  if (to === "en") return ["Xenova/opus-mt-mul-en"];
  if (to === "fr") return ["Xenova/opus-mt-mul-en", direct["en>fr"]];
  return null; // cible non couverte par les petits modèles
}

// ---- Worker Opus-MT ------------------------------------------------------------
let worker = null, seq = 0;
const pending = new Map();
function call(type, payload, onProgress) {
  if (!worker) {
    worker = new Worker("/lib/translate-worker.js", { type: "module" });
    worker.onmessage = (ev) => {
      const { id, type: t, payload: p } = ev.data || {};
      const job = pending.get(id);
      if (!job) return;
      if (t === "progress") { job.onProgress?.(p); return; }
      pending.delete(id);
      if (t === "error") job.reject(new Error(p)); else job.resolve(p);
    };
    worker.onerror = () => { for (const [, j] of pending) j.reject(new Error("worker de traduction indisponible")); pending.clear(); worker = null; };
  }
  const id = ++seq;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject, onProgress }); worker.postMessage({ id, type, payload }); });
}
function percent(onProgress) {
  const files = new Map();
  return (p) => {
    if (p?.status !== "progress" || !p.total) return;
    files.set(p.file, p);
    let a = 0, b = 0;
    for (const f of files.values()) { a += f.loaded; b += f.total; }
    onProgress?.(Math.round((a / b) * 100));
  };
}

/** Sépare une ligne en texte à traduire et fin à garder (pointillés, prix, quantités). */
export function splitTail(line) {
  const m = String(line).match(/^(.*?\p{L}.*?)((?:\s*[.…·_]{2,}\s*.*)|(?:\s+[€$£]?\s?\d[\d\s.,:]*\s?(?:€|\$|£|%|eur|euros?)?))$/iu);
  return m ? { head: m[1], tail: m[2] } : { head: line, tail: "" };
}

/** Traduit dans le casque (Opus-MT). Lève une erreur si la paire n'est pas couverte. */
export async function translateInHeadset(text, to, onProgress) {
  const from = detectLang(text);
  const chain = chainFor(from, to);
  if (chain === null) throw new Error("paire non couverte");
  if (!chain.length) return text;
  // Prix et pointillés (« Chocolate cake …… 7.00 ») : seule la partie texte est
  // traduite, la fin est recollée telle quelle — un petit modèle les perdait.
  const parts = text.split("\n").map(splitTail);
  const out = await call("translate", { lines: parts.map((p) => p.head), chain }, percent(onProgress));
  return (out?.lines || []).map((l, i) => (parts[i].tail ? `${String(l).replace(/[\s.…·_]+$/u, "")}${parts[i].tail}` : l)).join("\n");
}

/** Prépare la lecture et la traduction la plus courante (vers `to`) : la première fois n'attend pas. */
export async function preloadTranslation(to, onProgress) {
  await ocrWorker();
  await call("load", { models: [to === "en" ? "Xenova/opus-mt-fr-en" : "Xenova/opus-mt-en-fr"] }, percent(onProgress));
}
