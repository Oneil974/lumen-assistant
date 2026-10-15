// Garde-fous pour les PETITS modèles (LFM2.5 1.2B, Tev1 0.8B…).
//
// Principe : le petit modèle ne fait que ce qu'il fait bien — rédiger un texte
// court à partir de données fournies. Le reste passe par du code :
//
//   schemaFromExample  le format JSON est IMPOSÉ (grammaire côté serveur) au
//                      lieu d'être demandé dans le prompt
//   checkGrounding     les chiffres, dates et montants de la réponse doivent se
//                      retrouver dans les données (vérification sans modèle)
//   selectPassages     seuls les passages utiles d'un long document sont envoyés
//   answerBudget       plafond de génération selon l'effort jugé par Tev1
//   createAnswerCache  une réponse validée n'est pas recalculée
//   exampleStore       les sorties JSON validées servent d'exemples (few-shot)
//
// Tout est pur (aucun appel modèle) et testé : scripts/test-robust.mjs.

// ------------------------------------------------------------ 1. Schéma imposé

/**
 * Schéma JSON déduit d'une réponse d'EXEMPLE (celle que les prompts donnent
 * déjà au modèle). Toutes les clés de l'exemple deviennent obligatoires ; un
 * tableau prend la forme de son premier élément. Imposé via `response_format`,
 * il rend un JSON cassé impossible — c'était la première cause d'échec au banc.
 */
export function schemaFromExample(ex) {
  if (ex === null || ex === undefined) return {};
  if (Array.isArray(ex)) return { type: "array", items: ex.length ? schemaFromExample(ex[0]) : {} };
  switch (typeof ex) {
    case "string": return { type: "string" };
    case "number": return { type: Number.isInteger(ex) ? "integer" : "number" };
    case "boolean": return { type: "boolean" };
    case "object": {
      const properties = {};
      for (const [k, v] of Object.entries(ex)) properties[k] = schemaFromExample(v);
      return { type: "object", properties, required: Object.keys(properties) };
    }
    default: return {};
  }
}

/** La valeur respecte-t-elle (en gros) le schéma ? Types et clés obligatoires. */
export function matchesSchema(value, schema) {
  if (!schema || !schema.type) return true;
  if (schema.type === "array") return Array.isArray(value) && value.every((v) => matchesSchema(v, schema.items));
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    if ((schema.required || []).some((k) => !(k in value))) return false;
    return Object.entries(schema.properties || {}).every(([k, s]) => !(k in value) || matchesSchema(value[k], s));
  }
  if (schema.type === "integer" || schema.type === "number") return typeof value === "number";
  if (schema.type === "string") return typeof value === "string";
  if (schema.type === "boolean") return typeof value === "boolean";
  return true;
}

/**
 * Schéma des ARGUMENTS d'un outil (format function-calling), resserré pour une
 * grammaire : un objet aux propriétés connues, rien d'autre.
 */
export function toolArgsSchema(tool) {
  const p = tool?.function?.parameters || tool?.parameters || {};
  const properties = p.properties && typeof p.properties === "object" ? p.properties : {};
  return { type: "object", properties, required: (p.required || []).filter((k) => k in properties), additionalProperties: false };
}

// ------------------------------------------------------ 3. Vérification par code

const num = (s) => {
  // « 1 250,50 » / « 1,250.50 » / « 12,5 » → 1250.5 / 1250.5 / 12.5
  let t = String(s).replace(/[\s  ]/g, "");
  if (/,\d{1,2}$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
  else t = t.replace(/,/g, "");
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const NUM_RE = /(?<![\w.,])\d{1,3}(?:[\s  ]\d{3})+(?:[.,]\d+)?(?![\w])|(?<![\w.,])\d+(?:[.,]\d+)?(?![\w])/g;

/** Nombres présents dans un texte (forme normalisée), heures comprises (« 14 h 30 » → 14, 30). */
export function numbersIn(text) {
  const out = new Set();
  for (const m of String(text || "").matchAll(NUM_RE)) {
    const n = num(m[0]);
    if (n !== null) out.add(n);
  }
  return out;
}

/**
 * Valeurs de la RÉPONSE absentes des DONNÉES : chiffres significatifs, montants,
 * dates. Sans modèle, donc sans faux « tout va bien ». Ignorés : les petits
 * nombres (1 à 10, souvent des listes ou « 2 options »), les renvois [n], les
 * années proches (citées par culture générale) et ce que la question ou la
 * conversation contenait déjà.
 * @returns {string[]} les valeurs suspectes, telles qu'écrites dans la réponse
 */
export function checkGrounding(answer, { data = "", query = "", context = "" } = {}) {
  const text = String(answer || "").replace(/\[\d{1,2}\]/g, " ");
  const known = numbersIn(`${data}\n${query}\n${context}`);
  // Un pourcentage ou une conversion simple (°C arrondi) peut différer d'une
  // unité : on tolère l'arrondi d'une valeur connue.
  // Un CALCUL sur les données (total, écart, pourcentage) n'est pas une
  // invention : sommes et différences de deux valeurs, total général et
  // rapports en % sont acceptés.
  const base = [...known];
  const derived = new Set(base);
  if (base.length <= 150) {
    derived.add(base.reduce((a, b) => a + b, 0));
    for (let i = 0; i < base.length; i++) for (let j = 0; j < base.length; j++) {
      if (i === j) continue;
      derived.add(base[i] + base[j]);
      derived.add(Math.abs(base[i] - base[j]));
      if (base[j]) derived.add((base[i] / base[j]) * 100);
      derived.add(base[i] * base[j]);
    }
    // Total de trois postes (petits jeux de données seulement).
    if (base.length <= 40) for (let i = 0; i < base.length; i++) for (let j = i + 1; j < base.length; j++) for (let k = j + 1; k < base.length; k++) derived.add(base[i] + base[j] + base[k]);
  }
  const close = (n) => [...derived].some((k) => Math.abs(k - n) < 0.51 || (k !== 0 && Math.abs(k - n) / Math.abs(k) < 0.005));
  const year = new Date().getFullYear();
  const suspicious = [];
  for (const m of text.matchAll(NUM_RE)) {
    const n = num(m[0]);
    if (n === null) continue;
    if (Number.isInteger(n) && n >= 0 && n <= 10) continue;
    if (Number.isInteger(n) && n >= year - 3 && n <= year + 2) continue;
    if (close(n)) continue;
    suspicious.push(m[0].trim());
  }
  return [...new Set(suspicious)];
}

// --------------------------------------------------- 4. Passages utiles seulement

const STOP = new Set("le la les de des du un une et ou en au aux est sont pour par sur dans avec que qui quoi ce cet cette ces mon ma mes ton ta tes son sa ses il elle on nous vous ils je tu ne pas plus the a an of to in on for is are and or with what which how".split(" "));
export const terms = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));

/** Découpe un texte en passages d'environ `size` caractères, aux paragraphes puis aux phrases. */
export function chunkText(text, size = 700) {
  const parts = String(text || "").split(/\n\s*\n/);
  const chunks = [];
  let cur = "";
  const push = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ""; };
  for (const p of parts) {
    if (p.length > size) {
      push();
      let buf = "";
      for (const s of p.split(/(?<=[.!?;])\s+|\n/)) {
        if (buf && buf.length + s.length > size) { chunks.push(buf.trim()); buf = ""; }
        buf += (buf ? " " : "") + s;
      }
      if (buf.trim()) chunks.push(buf.trim());
    } else if (cur.length + p.length > size) { push(); cur = p; }
    else cur += (cur ? "\n\n" : "") + p;
  }
  push();
  return chunks;
}

/**
 * Les passages d'un long texte les plus utiles à la question (BM25), rendus
 * DANS L'ORDRE du document, jusqu'à `maxChars`. Le premier passage (titre,
 * en-tête) est gardé s'il reste de la place. `scores` (facultatif) remplace le
 * score lexical — l'hôte peut y mettre une similarité d'embeddings.
 */
export function selectPassages(text, query, maxChars = 3000, { size = 700, scores } = {}) {
  const src = String(text || "");
  if (src.length <= maxChars) return src;
  const chunks = chunkText(src, size);
  const q = [...new Set(terms(query))];
  const docs = chunks.map(terms);
  const avg = docs.reduce((n, d) => n + d.length, 0) / Math.max(1, docs.length);
  const df = new Map(q.map((w) => [w, docs.filter((d) => d.includes(w)).length]));
  const bm25 = (d) => q.reduce((s, w) => {
    const f = d.filter((x) => x === w).length;
    if (!f) return s;
    const idf = Math.log(1 + (docs.length - df.get(w) + 0.5) / (df.get(w) + 0.5));
    return s + idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.length / (avg || 1)));
  }, 0);
  const ranked = chunks.map((c, i) => ({ i, c, s: scores ? scores[i] ?? 0 : bm25(docs[i]) }))
    .sort((a, b) => b.s - a.s || a.i - b.i);
  const keep = new Set();
  let used = 0;
  const take = (r) => { if (used + r.c.length + 6 <= maxChars) { keep.add(r.i); used += r.c.length + 6; } };
  take({ i: 0, c: chunks[0] });
  for (const r of ranked) if (!keep.has(r.i)) take(r);
  return [...keep].sort((a, b) => a - b).map((i, k, arr) => (k && i !== arr[k - 1] + 1 ? "[…]\n" : "") + chunks[i]).join("\n\n");
}

// ------------------------------------------------------ 7. Budget de génération

/**
 * Plafond de jetons de la RÉDACTION selon l'effort (niveau 0 à 3, Tev1). Un
 * modèle « Thinking » compte son raisonnement dans le plafond : il lui faut
 * plus de marge, sinon il est coupé avant d'avoir écrit un mot.
 */
export function answerBudget(level, { thinking = false } = {}) {
  if (level == null || level < 0) return 0; // inconnu : pas de plafond
  const plain = [400, 900, 2000, 4000];
  const think = [1024, 1536, 3072, 6144];
  return (thinking ? think : plain)[Math.min(3, level)];
}

// ------------------------------------------------------------- 6. Mémoire

/** Empreinte courte et stable d'un texte (FNV-1a 32 bits). */
export function hash(s) {
  let h = 0x811c9dc5;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

const memoryStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
};
const defaultStorage = () => { try { return globalThis.localStorage || memoryStorage(); } catch { return memoryStorage(); } };

/**
 * Cache des réponses VALIDÉES : même question, mêmes données, même contexte →
 * même réponse, sans rappeler le modèle. Borné (LRU) et périssable (`ttlMs`).
 */
export function createAnswerCache({ key = "lumenAnswerCache", max = 60, ttlMs = 12 * 3600e3, storage = defaultStorage(), now = () => Date.now() } = {}) {
  const read = () => { try { return JSON.parse(storage.getItem(key) || "[]"); } catch { return []; } };
  const write = (rows) => { try { storage.setItem(key, JSON.stringify(rows.slice(-max))); } catch { /* quota : cache facultatif */ } };
  const id = (parts) => hash(parts.map((p) => String(p ?? "").replace(/\s+/g, " ").trim().toLowerCase()).join("\u0001"));
  return {
    id,
    get(parts) {
      const k = id(parts);
      const hit = read().find((r) => r.k === k && now() - r.t < ttlMs);
      return hit ? hit.v : null;
    },
    set(parts, value) {
      const k = id(parts);
      write([...read().filter((r) => r.k !== k && now() - r.t < ttlMs), { k, t: now(), v: value }]);
    },
  };
}

/**
 * Exemples validés par prompt (few-shot) : la dernière sortie JSON conforme
 * d'un même usage, choisie par ressemblance avec la nouvelle demande, est
 * montrée au modèle comme échange précédent. Au plus `perId` exemples gardés.
 */
export function createExampleStore({ key = "lumenPromptExamples", perId = 6, storage = defaultStorage() } = {}) {
  const read = () => { try { return JSON.parse(storage.getItem(key) || "{}"); } catch { return {}; } };
  return {
    remember(id, input, output) {
      if (!id || !input || !output || String(input).length > 1500 || String(output).length > 1500) return;
      const all = read();
      const list = (all[id] || []).filter((e) => e.input !== input);
      list.push({ input, output });
      all[id] = list.slice(-perId);
      try { storage.setItem(key, JSON.stringify(all)); } catch { /* facultatif */ }
    },
    /** L'exemple le plus proche de `input` (différent de lui), ou null. */
    pick(id, input) {
      const list = read()[id] || [];
      const q = new Set(terms(input));
      let best = null, bestScore = 0;
      for (const e of list) {
        if (e.input === input) continue;
        const t = terms(e.input);
        const s = t.filter((w) => q.has(w)).length / Math.max(1, Math.sqrt(t.length * q.size));
        if (s > bestScore) { best = e; bestScore = s; }
      }
      // Seulement un exemple du même sujet : un exemple sans rapport, un
      // petit modèle le recopie (constaté au banc avec l'exemple des prompts).
      return bestScore >= 0.3 ? best : null;
    },
  };
}
export const promptExamples = createExampleStore();
