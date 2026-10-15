// Génération pédagogique de l'app Études : fiches, quiz, correction expliquée.
//
// Tout passe par `llmChat` sur le modèle choisi dans Lumen : avec un modèle
// local (llama.cpp, Ollama, Apple), rien ne quitte la machine. Les sorties
// sont contraintes par un schéma JSON (grammaire côté llama.cpp) — c'est ce
// qui rend un petit modèle fiable pour produire 20 fiches bien formées.
// Un cours long est découpé en tranches, traitées l'une après l'autre.

import { llmChat, llmBackend } from "../llm.js";
import { PROMPTS } from "./prompts.js";

const CHUNK = 7000;

export function isLocalModel() {
  const src = (localStorage.getItem("aiSource") || "").toLowerCase();
  return !["api", "lumen"].includes(src);
}
export const backendLabel = () => { try { return llmBackend()?.model || ""; } catch { return ""; } };

function chunks(text, size = CHUNK) {
  const out = [];
  const paras = String(text || "").split(/\n{2,}/);
  let cur = "";
  for (const p of paras) {
    if ((cur + p).length > size && cur) { out.push(cur); cur = ""; }
    cur += (cur ? "\n\n" : "") + p.slice(0, size);
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const clean = (s) => String(s || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
function parseJson(text) {
  const t = clean(text);
  try { return JSON.parse(t); } catch {}
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

async function ask({ messages, opts }) {
  const { content } = await llmChat(messages, { ...opts, rawSystem: true });
  const data = parseJson(content);
  if (!data) throw new Error("Réponse du modèle illisible. Réessayez, ou choisissez un modèle plus grand dans les Réglages.");
  return data;
}


// ---- Fiches -------------------------------------------------------------------

/**
 * Fiches question/réponse à partir d'un cours.
 * @param {string} text  cours brut
 * @param {{ count?: number, lang?: string, onProgress?: (done:number,total:number)=>void }} opts
 */
export async function generateCards(text, { count = 20, lang = "fr", onProgress } = {}) {
  const parts = chunks(text);
  const per = Math.max(3, Math.ceil(count / parts.length));
  const out = [];
  for (let i = 0; i < parts.length && out.length < count; i++) {
    onProgress?.(i, parts.length);
    const data = await ask(PROMPTS["app.studies.cards"].build({ text: parts[i], count: per, lang }));
    for (const c of data.cards || []) if (c?.q && c?.a) out.push({ q: String(c.q).trim(), a: String(c.a).trim() });
  }
  onProgress?.(parts.length, parts.length);
  return out.slice(0, count);
}

// ---- Quiz ---------------------------------------------------------------------

export async function generateQuiz(text, { count = 10, lang = "fr", level = "standard", onProgress } = {}) {
  const parts = chunks(text);
  const per = Math.max(2, Math.ceil(count / parts.length));
  const out = [];
  for (let i = 0; i < parts.length && out.length < count; i++) {
    onProgress?.(i, parts.length);
    const data = await ask(PROMPTS["app.studies.quiz"].build({ text: parts[i], count: per, level, lang }));
    for (const q of data.questions || []) {
      if (!q?.question || !Array.isArray(q.choices) || q.choices.length < 2) continue;
      const answer = Math.max(0, Math.min(q.choices.length - 1, Number(q.answer) || 0));
      out.push({ question: q.question, choices: q.choices.slice(0, 5), answer, explanation: q.explanation || "" });
    }
  }
  onProgress?.(parts.length, parts.length);
  return out.slice(0, count);
}

// ---- Correction de devoir ---------------------------------------------------------

/**
 * Correction EXPLIQUÉE : chaque erreur est citée, expliquée (la règle ou la
 * notion en jeu), puis corrigée. Mode « indices » : on signale et on met sur la
 * voie sans donner la correction, pour que l'étudiant corrige lui-même.
 */
export async function correctHomework({ subject, statement, work, hintsOnly = false, lang = "fr" }) {
  return ask(PROMPTS["app.studies.correct"].build({ subject, statement, work, hintsOnly, lang }));
}

/** Explication libre (bouton « Je ne comprends pas » d'une fiche). */
// `onDelta(texte)` facultatif : explication en flux.
export async function explain(question, answer, lang = "fr", onDelta) {
  const { messages } = PROMPTS["app.studies.explain"].build({ question, answer, lang });
  const { content } = await llmChat(messages, { rawSystem: true, ...(onDelta ? { onDelta } : {}) });
  return clean(content);
}
