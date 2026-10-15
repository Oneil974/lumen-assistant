// Prompts par TYPE D'USAGE.
//
// Chaque app garde ses consignes (dans son `prompts.js`), mais les assemble ici
// selon des règles mesurées sur de vrais modèles locaux (banc `npm run bench`,
// LFM2.5 1.2B → 3B) :
//
//   1. Système COURT : le rôle + la règle propre au type d'usage. Un long
//      système noie un petit modèle, qui finit par commenter les consignes.
//   2. Données dans le tour UTILISATEUR, balisées (« ### DOCUMENT »…). Placées
//      dans le système, un 1.2B les prenait pour des consignes et répondait
//      « aucune donnée disponible ».
//   3. Format de sortie rappelé À LA FIN du tour utilisateur : c'est la
//      dernière chose lue avant d'écrire, donc la mieux respectée.
//   4. Langue de réponse explicite, même quand les données sont dans une autre.
//
// Les consignes passent par `resolvePrompt(id, défaut)` : elles restent
// personnalisables dans Paramètres → Prompts système, et le banc les lit.

import { resolvePrompt } from "./prompt-registry.js";
import { schemaFromExample, promptExamples } from "./robust.js";

/** Règle propre à chaque type d'usage (FR ; la langue de réponse est ajoutée à part). */
export const KIND_RULES = {
  // Transformer un texte : réécrire, corriger, traduire, reformuler.
  transform: "Rends uniquement le texte transformé : ni introduction, ni commentaire, ni guillemets autour.",
  // Condenser un contenu fourni.
  summary: "N'utilise que le contenu fourni, n'ajoute aucun fait, et garde les noms, numéros, dates et montants exacts. Pas de préambule ni de conclusion générale.",
  // Répondre d'après des documents, pages, mails, passages.
  grounded: "Réponds uniquement à partir du contenu fourni. Recopie les valeurs exactes (noms, dates, montants). Si l'information n'y est pas, dis-le en une phrase, sans deviner.",
  // Extraire ou produire une structure JSON.
  json: "Réponds uniquement par le JSON demandé (objet ou tableau), valide, sans texte autour et sans bloc ```.",
  // Rédiger un texte nouveau (note, mail, compte rendu).
  write: "Écris directement le texte final, prêt à l'emploi, sans annoncer ce que tu fais.",
  // Histoire, jeu, ambiance, marque.
  creative: "Sois vivant et précis, reste cohérent avec ce qui précède, et respecte exactement le format demandé.",
  // Écrire du code.
  code: "Écris un code complet, correct et exécutable tel quel.",
  // Expliquer (code, cours, notion) à quelqu'un.
  explain: "Explique simplement, avec un exemple concret, sans jargon inutile. Reste bref.",
  // Interpréter des chiffres déjà calculés.
  analysis: "Interprète uniquement les chiffres fournis, sans en inventer : chaque constat cite le chiffre qui le justifie (le plus haut, le plus bas, un dépassement, une proportion). Si une donnée demandée manque, dis-le. Termine par des conseils concrets.",
  // Personnage (compagnon, joueur, maître du jeu).
  persona: "Reste dans ton personnage. Réponses courtes et naturelles.",
  // Image.
  vision: "Décris uniquement ce qui est visible sur l'image, sans rien inventer.",
  // Agent qui modifie des fichiers par JSON.
  agent: "Avance par petites modifications vérifiables. Réponds uniquement par le JSON demandé.",
};

const LANGS = { fr: "français", en: "anglais" };

/** « Réponds en français. » — la langue de RÉPONSE, indépendante de celle des données. */
export function langRule(lang = "fr") {
  return `Réponds en ${LANGS[lang === "en" ? "en" : "fr"]}.`;
}

/**
 * Construit les messages d'un appel.
 *
 * @param {object} p
 * @param {string} p.id        identifiant du prompt (catalogue, banc)
 * @param {string} p.kind      type d'usage (clé de KIND_RULES)
 * @param {string} p.role      consigne propre à l'usage (personnalisable)
 * @param {string} [p.lang]    langue de réponse ("fr" | "en") ; vide = ne pas l'imposer
 * @param {Record<string,string>|string} [p.data]  données à traiter, balisées par leur nom
 * @param {string} [p.request] la demande de l'utilisateur
 * @param {string} [p.format]  format de sortie attendu, rappelé en dernier
 * @param {object|Array} [p.example] réponse JSON d'EXEMPLE, remplie avec des
 *        valeurs réalistes. Un gabarit (« … », « a|b », « 1 à 3 phrases ») est
 *        recopié tel quel par un petit modèle : mesuré au banc, c'était la
 *        première cause d'échec des sorties JSON.
 * @param {string[]} [p.images] images base64 (vision)
 * @param {Array} [p.history]  échanges précédents (personnage, jeu)
 */
export function buildPrompt({ id, kind, role, lang = "fr", data, request = "", format = "", example, images, history = [] }) {
  const rule = KIND_RULES[kind] ? resolvePrompt(`harness.kind.${kind}`, KIND_RULES[kind]) : "";
  const system = [resolvePrompt(id, role), rule, lang ? langRule(lang) : ""].filter(Boolean).join("\n");
  const blocks = [];
  if (typeof data === "string" && data.trim()) blocks.push(data.trim());
  else if (data && typeof data === "object") {
    for (const [name, value] of Object.entries(data)) {
      const v = String(value ?? "").trim();
      if (v) blocks.push(`### ${name}\n${v}`);
    }
  }
  if (request) blocks.push(blocks.length ? `### DEMANDE\n${request}` : request);
  if (example !== undefined) {
    blocks.push(`Exemple de réponse (même forme ; remplace chaque valeur par la tienne, tirée de la demande) :\n${JSON.stringify(example)}`);
  }
  if (format) blocks.push(`Format de la réponse : ${format}`);
  const user = { role: "user", content: blocks.join("\n\n") };
  if (images?.length) user.images = images;
  // Few-shot : une sortie JSON déjà VALIDÉE pour ce même usage, montrée comme
  // échange précédent (cf. robust.js). Seulement hors conversation.
  const input = fewShotInput(data, request);
  const shot = example !== undefined && !history.length && input ? promptExamples.pick(id, input) : null;
  const shots = shot ? [{ role: "user", content: shot.input }, { role: "assistant", content: shot.output }] : [];
  const messages = [{ role: "system", content: system }, ...history, ...shots, user];
  // Métadonnées lues par llmChat (non énumérables : invisibles pour les apps
  // qui recopient le tableau) : le schéma déduit de l'exemple est IMPOSÉ au
  // serveur quand l'appel demande du JSON, et une sortie conforme devient un
  // futur exemple.
  if (example !== undefined) {
    Object.defineProperty(messages, "schema", { value: schemaFromExample(example) });
    Object.defineProperty(messages, "promptId", { value: id });
    Object.defineProperty(messages, "fewShotInput", { value: input });
  }
  return messages;
}

function fewShotInput(data, request) {
  const d = typeof data === "string" ? data : data && typeof data === "object" ? Object.values(data).join("\n") : "";
  return `${d}\n${request || ""}`.trim().slice(0, 1500);
}

/** Lit un JSON de réponse : retire le raisonnement et les clôtures, tolère du texte autour. */
export function parseJsonReply(text) {
  const t = String(text || "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*<\/think>/, "").trim()
    .replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(t); } catch { /* repli ci-dessous */ }
  const obj = t.match(/\{[\s\S]*\}/);
  if (obj) { try { return JSON.parse(obj[0]); } catch { /* tableau ? */ } }
  const arr = t.match(/\[[\s\S]*\]/);
  if (arr) { try { return JSON.parse(arr[0]); } catch { /* rien */ } }
  return null;
}

/** Texte final : sans raisonnement, sans clôture ```…``` englobante ni guillemets. */
export function cleanReply(text) {
  let t = String(text || "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*<\/think>/, "").trim();
  t = t.replace(/^```[a-z]*\n([\s\S]*?)\n```$/i, "$1").trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("«") && t.endsWith("»"))) t = t.slice(1, -1).trim();
  return t;
}

/**
 * Langue d'un texte (« fr » ou « en ») par ses mots outils. Sert à imposer la
 * langue du TEXTE quand une tâche doit la conserver : sans consigne explicite,
 * un petit modèle qui raisonne en anglais répond en anglais à un texte français.
 */
export function textLang(text) {
  const t = ` ${String(text || "").toLowerCase()} `;
  const count = (words) => words.reduce((n, w) => n + (t.split(` ${w} `).length - 1), 0);
  const fr = count(["le", "la", "les", "de", "des", "et", "un", "une", "est", "pour", "que", "pas", "je", "vous", "merci", "avec"]);
  const en = count(["the", "a", "of", "and", "to", "is", "for", "that", "not", "i", "you", "with", "please", "are", "it"]);
  return en > fr ? "en" : "fr";
}

