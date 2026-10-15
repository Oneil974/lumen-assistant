// Rédaction des réponses par un PETIT modèle (LFM2.5 1.2B…), bornée par du code.
//
// Mesuré au banc (03/10/2026) : avec les bonnes données sous les yeux, le 1.2B
// recopiait souvent la consigne au lieu des valeurs (« La source indique la
// principale action. »). Ici :
//   - un prompt court, les données en liste, la question en dernier ;
//   - la réponse doit reprendre au moins une valeur saillante des données,
//     sinon une relance simple, puis une réponse EXTRACTIVE construite par
//     code (toujours juste, moins fluide) ;
//   - ce que le code sait faire mieux que le modèle est fait par le code :
//     calculs, durées, liens de fichiers, confirmations d'actions, erreurs.

import { textLang } from "./prompt-kit.js";
import { terms } from "./robust.js";
import { resolvePrompt } from "./prompt-registry.js";

const FR = (lang) => lang !== "en";

/** Langue de la RÉPONSE : celle de la question si elle est nette, sinon celle de l'interface. */
export function answerLang(query, uiLang = "fr") {
  const words = String(query || "").trim().split(/\s+/).length;
  return words >= 4 ? textLang(query) : uiLang === "en" ? "en" : "fr";
}

/** Nettoie une réponse : raisonnement, titres génériques, préfixes « Réponse : ». */
export function cleanAnswer(text) {
  // Raisonnement coupé par le plafond (« <think> Okay… » sans fin) : ce n'est
  // pas une réponse.
  if (/<think>/.test(text) && !/<\/think>/.test(text)) return "";
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*<\/think>/, "")
    .split("\n").filter((l) => !/^\s*#{1,6}\s*(r[ée]ponse( finale)?|final answer|answer)\s*:?\s*$/i.test(l)).join("\n")
    .replace(/^\s*(r[ée]ponse( finale)?|answer)\s*:\s*/i, "")
    .replace(/\n{3,}/g, "\n\n").trim();
}

// Lignes techniques des résultats d'outils, inutiles pour l'utilisateur.
const tech = (l) => l.replace(/\s*\[id [^\]]*\]/g, "").replace(/\s*\((?:recherche|search|query) ?: [^)]*\)\s*$/gim, "");

/** Valeurs saillantes d'un texte : nombres, Noms Propres, «citations», liens. */
export function salientTokens(text) {
  const t = tech(String(text || ""));
  const out = new Set();
  for (const m of t.matchAll(/\d+(?:[.,:h]\d+)?/g)) if (m[0].length >= 2) out.add(m[0].replace(",", "."));
  for (const m of t.matchAll(/(?<![.!?]\s|^)\b[A-ZÀ-Ö][a-zà-ÿ]{2,}(?:[\s-][A-ZÀ-Ö][a-zà-ÿ]+)*/gm)) out.add(m[0].toLowerCase());
  for (const m of t.matchAll(/[«"]\s*([^»"]{3,60})\s*[»"]/g)) out.add(m[1].toLowerCase().trim());
  for (const m of t.matchAll(/\]\(([^)\s]+)\)/g)) out.add(m[1]);
  return [...out];
}

/** Réponse inutilisable : vide, écho de la consigne, ou sans aucune valeur des données. */
export function badAnswer(answer, dataText) {
  const a = String(answer || "").trim();
  if (a.length < 2) return "vide";
  if (/\b(la|les) sources?\b|\bDONN[ÉE]ES\b|informations (trouv[ée]es|fournies)\b|\bthe (data|sources?)\b/i.test(a) && a.length < 160) return "écho de la consigne";
  // Montants, mesures, heures : si les données en ont, la réponse en cite une.
  const units = [...tech(String(dataText || "")).matchAll(/(\d+(?:[ .,]\d+)*)\s?(€|\$|%|°C?|km|kg|g\b|h\b|heures?|min|pas\b|bpm|euros?)/gi)].map((m) => m[1].replace(/\s/g, ""));
  if (units.length) {
    const flat = a.replace(/(\d)[\s\u202f](?=\d{3}\b)/g, "$1");
    if (!units.some((u) => flat.includes(u) || flat.includes(u.replace(".", ",")) || flat.includes(u.replace(",", ".")))) return "aucune valeur chiffrée des données";
  }
  // Données en liste (« • Dentiste — lun. … ») : une réponse qui n'en cite
  // qu'une partie est incomplète (le 1.2B s'arrête souvent au premier).
  const items = [...tech(String(dataText || "")).matchAll(/^\s*[•\-*]\s+([^—\n:]+)/gm)].map((m) => m[1].trim().toLowerCase().split(/\s+/).slice(0, 2).join(" ")).filter((x) => x.length >= 3);
  if (items.length >= 2 && items.length <= 5) {
    const low = a.toLowerCase();
    const missing = items.filter((it) => !low.includes(it.split(" ")[0]));
    if (missing.length) return "liste incomplète";
  }
  const salient = salientTokens(dataText);
  if (!salient.length) return "";
  const low = a.toLowerCase().replace(",", ".");
  const hit = salient.some((s) => low.includes(s) || low.includes(s.replace(".", ",")) || low.includes(s.replace(/(\d+)h(\d+)/, "$1 h $2")));
  return hit ? "" : "aucune valeur des données";
}

/** La donnée parle-t-elle de la demande ? (un mot utile de la question s'y retrouve) */
export function relevantTo(result, query) {
  const q = terms(query).filter((w) => w.length >= 4 && !/^(quel|quelle|quels|comment|combien|pourquoi|donne|montre|regarde|cherche|trouve|retrouve|dis|lis|veux|voudrais|faire|avoir|etre|recapitule|resume|rappelle|point|important)/.test(w));
  if (!q.length) return true;
  // Sans l'écho de la recherche (« (recherche : … ) », « pour « question » ») :
  // il contient les mots de la question sans rien dire d'elle.
  const qs = String(query || "").replace(/[?!.]+$/, "").trim();
  let r = tech(String(result || ""));
  if (qs.length > 6) r = r.split(qs).join(" ");
  const d = new Set(terms(r));
  const stem = (w) => w.replace(/(es|s|e|x)$/, "");
  return q.some((w) => d.has(w) || [...d].some((x) => x.length >= 4 && stem(x) === stem(w)));
}

// ---------------------------------------------------------------- Calculs

const num = (s) => Number(String(s).replace(",", "."));
/**
 * Calculs qu'un petit modèle rate et que le code fait juste : opérations
 * (« 17 × 23 », « 15 % de 80 ») et durées entre deux heures (« de 14h10 à
 * 17h45 »). Rendus comme une donnée que la réponse reprend.
 */
export function calcFacts(query) {
  const q = String(query || "");
  const facts = [];
  for (const m of q.matchAll(/(\d+(?:[.,]\d+)?)\s*([×x*+\-−÷/])\s*(\d+(?:[.,]\d+)?)/g)) {
    const a = num(m[1]), b = num(m[3]);
    const op = m[2];
    const r = op === "+" ? a + b : op === "-" || op === "−" ? a - b : op === "÷" || op === "/" ? (b ? a / b : NaN) : a * b;
    if (Number.isFinite(r)) facts.push(`${m[1]} ${op} ${m[3]} = ${Math.round(r * 1000) / 1000}`);
  }
  const pct = q.match(/(\d+(?:[.,]\d+)?)\s*%\s*de\s*(\d+(?:[.,]\d+)?)/i);
  if (pct) facts.push(`${pct[1]} % de ${pct[2]} = ${Math.round(num(pct[1]) * num(pct[2])) / 100}`);
  const times = [...q.matchAll(/\b(\d{1,2})\s?[h:]\s?(\d{2})?\b/g)].map((m) => +m[1] * 60 + (+m[2] || 0));
  if (times.length === 2 && /\b(dur|combien de temps|how long|trajet|entre)/i.test(q)) {
    let d = times[1] - times[0];
    if (d < 0) d += 1440;
    facts.push(`Durée de ${fmt(times[0])} à ${fmt(times[1])} = ${Math.floor(d / 60)} h ${String(d % 60).padStart(2, "0")} (${d} minutes)`);
  }
  return facts;
}
const fmt = (m) => `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;

// ------------------------------------------------------- Réponses par code

/** Confirmation d'actions réussies (rappel créé, souvenir retenu…), sans modèle. */
export function actionConfirmation(notes, lang = "fr") {
  const lines = notes.map((e) => `- ${tech(e.result).split("\n")[0].trim()}`);
  return `${FR(lang) ? "C'est fait :" : "Done:"}\n${lines.join("\n")}`;
}

/** Tous les outils ont échoué : on le dit, sans modèle (et sans inventer). */
export function failureAnswer(notes, lang = "fr", label = (e) => e.name) {
  const parts = notes.map((e) => `${label(e)} (${tech(e.result).replace(/^Erreur\s*:\s*/i, "").slice(0, 140)})`);
  return FR(lang)
    ? `Je n'ai pas pu obtenir ${parts.join(", ")}. Réessaie dans un moment.`
    : `I couldn't get ${parts.join(", ")}. Please try again in a moment.`;
}

/** Rien de pertinent trouvé dans les données de l'utilisateur. */
export function notFoundAnswer(query, lang = "fr") {
  const what = String(query || "").replace(/[?!.]+$/, "").trim();
  return FR(lang)
    ? `Je n'ai rien trouvé à ce sujet dans tes données (« ${what} »). Si tu me donnes l'information, je peux la retenir.`
    : `I couldn't find anything about that in your data ("${what}"). If you tell me, I can remember it.`;
}

/**
 * Réponse EXTRACTIVE : les lignes utiles de chaque donnée, telles quelles.
 * Dernier recours quand le modèle n'a rien produit d'exploitable : moins
 * fluide, mais chaque valeur est juste.
 */
export function extractiveAnswer(notes, query, lang = "fr", label = (e) => e.name) {
  const q = new Set(terms(query));
  const blocks = notes.map((e) => {
    const lines = tech(e.result).split("\n").map((l) => l.trim()).filter((l) => l && !/^\(.*\)$/.test(l));
    const scored = lines.map((l, i) => ({ l, i, s: terms(l).filter((w) => q.has(w)).length + (/\d/.test(l) ? 0.5 : 0) + (/\]\(/.test(l) ? 1 : 0) }));
    const keep = (lines.length <= 6 ? scored : scored.sort((a, b) => b.s - a.s || a.i - b.i).slice(0, 6).sort((a, b) => a.i - b.i)).map((x) => x.l);
    return `**${label(e)}** — ${keep.join(" ; ").slice(0, 700)}`;
  });
  return `${FR(lang) ? "Voici ce que j'ai trouvé :" : "Here is what I found:"}\n\n${blocks.join("\n\n")}`;
}

// ---------------------------------------------------------------- Finitions

/** Demande de voir/obtenir un fichier : ses liens trouvés sont joints s'ils manquent. */
export function appendLinks(answer, notes, query) {
  if (!/\b(montre|affiche|donne|envoie|ouvre|telecharge|télécharge|partage|lien|photo|image|pdf|fichier|document|show|send|open|give|link|file)\b/i.test(query)) return answer;
  const links = [];
  for (const e of notes) for (const m of String(e.result).matchAll(/!?\[[^\]]+\]\([^)\s]+\)/g)) links.push(m[0]);
  const missing = [...new Set(links)].filter((l) => !answer.includes(l.replace(/^!?\[[^\]]+\]/, "")));
  return missing.length ? `${answer.trim()}\n\n${missing.join("\n")}` : answer;
}

/** « Exactement 3 idées » : une liste plus longue est coupée au nombre demandé. */
export function enforceListCount(answer, query) {
  const m = String(query).match(/\b(?:exactement|seulement|juste|only|exactly)\s+(\d{1,2})\b|\b(\d{1,2})\s+(?:id[ée]es|points|conseils|exemples|raisons|options|suggestions|ideas|tips|reasons)\b/i);
  const n = m ? +(m[1] || m[2]) : 0;
  if (!n) return answer;
  const lines = String(answer).split("\n");
  let count = 0, cut = -1;
  lines.forEach((l, i) => { if (/^\s*(\d{1,2}[.)]|[-*•])\s+/.test(l)) { count++; if (count === n + 1 && cut < 0) cut = i; } });
  return cut > 0 ? lines.slice(0, cut).join("\n").trim() : answer;
}

// ---------------------------------------------------------------- Messages

/**
 * Messages de rédaction pour un petit modèle.
 * @param {object} p
 * @param {Array<{label:string, text:string}>} p.data  données (déjà étiquetées)
 * @param {Array} p.convo   derniers échanges (role/content)
 * @param {string} p.memo   faits anciens de la conversation
 * @param {string} p.note   consigne supplémentaire (rien trouvé…)
 * @param {boolean} p.simple  relance : consigne encore plus courte
 */
export function smallAnswerMessages({ query, lang = "fr", data = [], convo = [], memo = "", note = "", simple = false }) {
  const fr = FR(lang);
  const system = resolvePrompt(`harness.small.${fr ? "fr" : "en"}`, fr
    ? "Tu es Lumen, un assistant personnel. Réponds directement à l'utilisateur, en français, en 1 à 4 phrases ou une courte liste. Pas de titre ni de préambule."
    : "You are Lumen, a personal assistant. Answer the user directly, in English, in 1 to 4 sentences or a short list. No heading, no preamble.")
    + (data.length ? (fr
      ? " Appuie-toi uniquement sur les informations fournies et recopie leurs valeurs exactes (noms, dates, heures, chiffres, liens)."
      : " Use only the information provided and copy its exact values (names, dates, times, numbers, links).") : "")
    + (memo ? `\n\n${fr ? "Ce que l'utilisateur t'a dit plus tôt" : "What the user told you earlier"} :\n${memo}` : "")
    + (note ? `\n\n${note}` : "");
  if (!data.length) {
    // Relance elliptique (« Et pour 8 personnes ? ») : le petit modèle ne
    // relie pas seul la question à sa réponse précédente ; on la lui rappelle.
    const prevUser = [...convo].reverse().find((m) => m.role === "user")?.content || "";
    const prevAnswer = [...convo].reverse().find((m) => m.role === "assistant")?.content || "";
    const elliptic = prevAnswer && String(query).length < 60 && /^(et|mais|plutot|plutôt|pour|avec|sans|and|what about|with|for)\b/i.test(String(query).trim());
    const user = elliptic
      ? (fr ? `Ma demande précédente : « ${prevUser.slice(0, 300)} »\nTa réponse : « ${prevAnswer.slice(0, 700)} »\n\nMaintenant : ${query}\nAdapte ta réponse précédente à cette nouvelle demande (quantités, durées, chiffres compris).`
        : `My previous request: "${prevUser.slice(0, 300)}"\nYour answer: "${prevAnswer.slice(0, 700)}"\n\nNow: ${query}\nAdapt your previous answer to this new request (quantities and numbers included).`)
      : query;
    return [{ role: "system", content: system }, ...convo.slice(-6), { role: "user", content: user }];
  }
  const info = data.map((d) => `• ${d.label} : ${d.text}`).join("\n");
  const user = simple
    ? (fr ? `${info}\n\nAvec ces informations, réponds en deux phrases à : ${query}` : `${info}\n\nUsing this information, answer in two sentences: ${query}`)
    : (fr ? `Informations :\n${info}\n\nQuestion : ${query}` : `Information:\n${info}\n\nQuestion: ${query}`);
  const recap = convo.slice(-2).map((m) => `${m.role === "user" ? (fr ? "Utilisateur" : "User") : "Lumen"} : ${String(m.content).replace(/\s+/g, " ").slice(0, 200)}`).join("\n");
  return [{ role: "system", content: system + (recap ? `\n\n${fr ? "Échange précédent (pour le contexte seulement)" : "Previous exchange (context only)"} :\n${recap}` : "") }, { role: "user", content: user }];
}

/** Texte d'une donnée pour le prompt : sans balises techniques, borné. */
export function dataText(result, max = 1800) {
  const t = tech(String(result || ""))
    .split("\n").filter((l) => !/^\s*(évènement|evenement|event|mesure|image|document|fichier|tâche|tache|note|contact|courriel)\b[^\n]*·/i.test(l)).join("\n")
    .replace(/\n{2,}/g, "\n").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
