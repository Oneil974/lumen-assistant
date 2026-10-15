// Support des modèles Liquid AI (LFM2 / LFM2.5) servis par llama-server.
//
// Ces modèles ne sont PAS des modèles de conversation : ce sont des moteurs de
// décision rapides (classification d'intention, choix d'outil, tool calling,
// extraction de paramètres, JSON structuré). La réponse en langage naturel est
// produite ensuite par un autre modèle. Ce fichier regroupe donc :
//   - la détection de la famille et les réglages d'échantillonnage officiels ;
//   - le prompt système court du routeur et son schéma de sortie ;
//   - `lfmRoute()`, qui exécute un tour de routage et renvoie du JSON validé.
//
// Le rendu ChatML est délégué à llama-server (`--jinja`) : il applique le
// template Jinja embarqué dans le GGUF, exactement comme `apply_chat_template()`
// côté Python. On n'assemble JAMAIS le prompt à la main, et les outils passent
// par le champ `tools` de l'API OpenAI — llama.cpp b10002 reconnaît le template
// LFM2.5 et parse nativement `<|tool_call_start|>…<|tool_call_end|>`.

import { resolvePrompt } from "./prompt-registry.js";
import { inLang } from "./prompt-lang.js";

/** Vrai pour tout GGUF de la famille LFM2 / LFM2.5 (nom de fichier ou alias). */
export function isLfmModel(model) {
  return /\bLFM2(\.5)?\b/i.test(String(model || ""));
}

/** Variante « Thinking » : elle produit un bloc <think> avant sa réponse. */
export function isLfmThinkingModel(model) {
  return /LFM2\.5?-.*Thinking/i.test(String(model || ""));
}

// Réglages recommandés par Liquid AI sur les fiches de modèle Hugging Face.
// Instruct / 350M : temperature 0.1 ; Thinking : temperature 0.05 ; top_k 50
// partout. La pénalité de répétition, elle, N'EST PAS la même selon la taille :
// 1,05 pour 350M et 1.2B, mais **1,1 pour le 2.6B** (fiche officielle). Un LFM
// échantillonné avec les valeurs génériques de llama-server (temp 0.8) part en
// roue libre sur du JSON.
export function lfmSampling(model) {
  if (!isLfmModel(model)) return null;
  return {
    temperature: isLfmThinkingModel(model) ? 0.05 : 0.1,
    top_k: 50,
    repeat_penalty: /2\.6b/i.test(String(model || "")) ? 1.1 : 1.05,
  };
}

// Prompt système du routeur : court et explicite, comme le demande Liquid AI.
// Toute consigne longue (mémoire, profil, ton) est nuisible ici — le modèle doit
// voir la requête utilisateur et la liste d'outils, rien d'autre.
export const LFM_ROUTER_SYSTEM = [
  "Tu es le moteur de routage de Lumen.",
  "Tu ne réponds jamais directement à l'utilisateur.",
  "Tu analyses la requête pour déterminer l'intention, choisir le meilleur outil,",
  "choisir le meilleur modèle et extraire les arguments.",
  "Output function calls as JSON.",
  "Retourne exclusivement un JSON valide conforme au schéma.",
].join("\n");

// Prompt système du MODE OUTILS de la barre, quand le modèle actif est un LFM.
//
// Le prompt Lumen complet (identité, profil, mémoires, règles de conversation)
// fait ~1 400 tokens et transforme un moteur de décision de 350M en bavard :
// observé en conditions réelles, il répondait en anglais, hors sujet, sans
// jamais appeler l'outil qui convenait. La fiche officielle Liquid AI est
// explicite — prompt court, tâche unique, outils dans le champ `tools`.
//
// Contrairement au routeur, ce prompt-ci autorise une réponse en langage
// naturel : c'est bien le modèle qui rend la réponse finale après l'appel
// d'outil. D'où deux constantes distinctes.
export const LFM_TOOLS_SYSTEM = [
  "Tu es Lumen, assistant de l'utilisateur.",
  "Tu disposes d'outils : appelle celui qui convient quand la demande l'exige.",
  "Output function calls as JSON.",
  "N'invente jamais le résultat d'un outil ; attends-le.",
  "Sans outil pertinent, réponds directement et brièvement.",
  `Réponds toujours ${inLang()}.`,
].join("\n");

// Schéma de la décision. Transmis à llama-server en `response_format:
// json_schema` : le serveur le compile en grammaire GBNF, ce qui *garantit* du
// JSON conforme au lieu d'espérer que le modèle obéisse au prompt.
export const LFM_ROUTER_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    execution: { type: "string", enum: ["tool", "model", "clarify"] },
    tool: { type: "string" },
    model: { type: "string" },
    arguments: { type: "object", additionalProperties: true },
    needs_clarification: { type: "boolean" },
  },
  required: ["intent", "confidence", "execution", "needs_clarification"],
  additionalProperties: false,
};

/**
 * Restreint le catalogue d'outils à ceux réellement disponibles pour ce tour.
 * Le contexte d'un LFM2.5-350M est précieux : chaque définition d'outil inutile
 * est du budget en moins pour la requête. `allowed` accepte des noms exacts ou
 * des expressions régulières.
 */
export function pickTools(tools, allowed) {
  const list = Array.isArray(tools) ? tools : [];
  if (!allowed || (Array.isArray(allowed) && !allowed.length)) return list;
  const rules = Array.isArray(allowed) ? allowed : [allowed];
  return list.filter((tool) => {
    const name = tool?.function?.name || tool?.name || "";
    return rules.some((rule) => (rule instanceof RegExp ? rule.test(name) : rule === name));
  });
}

/** Extrait un objet JSON d'une sortie modèle (tolère un liseré de texte). */
export function parseJsonDecision(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch (_) {
      return null;
    }
  }
}

/**
 * Un tour de routage LFM.
 *
 * @param {string} userText   requête utilisateur, transmise telle quelle.
 * @param {object} opts
 *   - tools   : outils au format OpenAI (`{type:"function", function:{…}}`).
 *   - allow   : sous-ensemble d'outils à exposer (cf. `pickTools`).
 *   - models  : identifiants de modèles parmi lesquels router (contexte court).
 *   - model   : GGUF du routeur (défaut : le modèle actif de llama-server).
 *   - schema  : schéma de sortie personnalisé (défaut : `LFM_ROUTER_SCHEMA`).
 *   - history : tours précédents ({role, content}), rôles ChatML uniquement.
 * @returns {Promise<{decision, toolCalls, data}>}
 *   `toolCalls` est renseigné quand le modèle a choisi d'appeler un outil via le
 *   canal natif (le parseur LFM2 de llama.cpp) plutôt que par le champ JSON.
 */
export async function lfmRoute(userText, opts = {}) {
  const { llmChat } = await import("../llm.js");
  const tools = pickTools(opts.tools, opts.allow);
  const catalogue = Array.isArray(opts.models) && opts.models.length
    ? `\nModèles disponibles : ${opts.models.join(", ")}.`
    : "";

  const messages = [
    { role: "system", content: (opts.system || resolvePrompt("router.lfm", LFM_ROUTER_SYSTEM)) + catalogue },
    ...(Array.isArray(opts.history) ? opts.history : []),
    { role: "user", content: String(userText || "") },
  ];

  const { content, data } = await llmChat(messages, {
    model: opts.model,
    // Prompt système brut : jamais le prompt Lumen complet, qui noierait un
    // routeur de 350M sous des consignes de conversation.
    rawSystem: true,
    // Pas de <think> : le routeur doit répondre en un seul jet.
    think: false,
    tools,
    tool_choice: opts.tool_choice || (tools.length ? "auto" : undefined),
    // Le schéma n'est appliqué que si aucun outil n'est proposé : llama.cpp ne
    // combine pas grammaire d'outils et grammaire de réponse sur le même tour.
    schema: tools.length ? undefined : (opts.schema || LFM_ROUTER_SCHEMA),
  });

  const message = data?.choices?.[0]?.message || data?.message || {};
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return { decision: parseJsonDecision(content), toolCalls, data };
}

// ---- Appels d'outils LFM restés dans le texte --------------------------------
// llama-server ne reconnaît pas toujours le format LFM (template du modèle VL,
// tour sans `tools`…) : la réponse arrive alors avec
//   <|tool_call_start|>[weather_now(place='Le Tampon'), b(x=1)]<|tool_call_end|>
// en CONTENU. On le convertit en `tool_calls` OpenAI, et on le retire du texte
// dans tous les cas — l'utilisateur ne doit jamais voir ce balisage.
const LFM_CALL_RE = /<\|tool_call_start\|>([\s\S]*?)(?:<\|tool_call_end\|>|$)/g;

function parsePyValue(src, i) {
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  ws();
  const c = src[i];
  if (c === "'" || c === '"') {
    let out = "";
    i++;
    while (i < src.length && src[i] !== c) {
      if (src[i] === "\\" && i + 1 < src.length) { const n = src[++i]; out += n === "n" ? "\n" : n === "t" ? "\t" : n; i++; continue; }
      out += src[i++];
    }
    return [out, i + 1];
  }
  if (c === "[" || c === "(") {
    const close = c === "[" ? "]" : ")";
    const arr = [];
    i++;
    for (;;) {
      ws();
      if (src[i] === close) return [arr, i + 1];
      if (i >= src.length) return [arr, i];
      const [v, j] = parsePyValue(src, i);
      arr.push(v);
      i = j; ws();
      if (src[i] === ",") i++;
    }
  }
  if (c === "{") {
    const obj = {};
    i++;
    for (;;) {
      ws();
      if (src[i] === "}") return [obj, i + 1];
      if (i >= src.length) return [obj, i];
      const [k, j] = parsePyValue(src, i);
      i = j; ws();
      if (src[i] === ":") i++;
      const [v, j2] = parsePyValue(src, i);
      obj[String(k)] = v;
      i = j2; ws();
      if (src[i] === ",") i++;
    }
  }
  const m = /^[^,)\]}\s]+/.exec(src.slice(i));
  const tok = m ? m[0] : "";
  const val = tok === "True" || tok === "true" ? true : tok === "False" || tok === "false" ? false
    : tok === "None" || tok === "null" ? null : tok !== "" && !Number.isNaN(Number(tok)) ? Number(tok) : tok;
  return [val, i + tok.length];
}

/** `[a(x='1'), b(y=2)]` (ou JSON) → [{ name, arguments }] */
export function parseLfmCallList(body) {
  const src = String(body || "").trim();
  try {
    const j = JSON.parse(src);
    const list = Array.isArray(j) ? j : [j];
    if (list.every((x) => x && typeof x.name === "string")) {
      return list.map((x) => ({ name: x.name, arguments: x.arguments || x.parameters || {} }));
    }
  } catch { /* format Python */ }
  const calls = [];
  const re = /([A-Za-z_][\w.-]*)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    const args = {};
    for (;;) {
      while (i < src.length && /[\s,]/.test(src[i])) i++;
      if (i >= src.length || src[i] === ")") { i++; break; }
      const km = /^([A-Za-z_]\w*)\s*=/.exec(src.slice(i));
      if (!km) break;
      i += km[0].length;
      const [v, j] = parsePyValue(src, i);
      args[km[1]] = v;
      i = j;
    }
    calls.push({ name: m[1], arguments: args });
    re.lastIndex = i;
  }
  return calls;
}

/**
 * Extrait les appels LFM d'un texte : { content (nettoyé), calls }.
 * `calls` est au format OpenAI (`tool_calls`).
 */
export function extractLfmToolCalls(text) {
  const s = String(text || "");
  if (!s.includes("<|tool_call_start|>")) return { content: s, calls: [] };
  const calls = [];
  const content = s.replace(LFM_CALL_RE, (_, body) => {
    for (const c of parseLfmCallList(body)) {
      calls.push({ id: `lfm_${Date.now().toString(36)}_${calls.length}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } });
    }
    return "";
  }).replace(/<\|tool_call_end\|>/g, "").trim();
  return { content, calls };
}
