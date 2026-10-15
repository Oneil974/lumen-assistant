// Podcast de révision de l'app Études : un cours devient un dialogue à deux
// voix (professeur / élève), écouté comme l'app Podcast — mais écrit POUR
// réviser : notions clés, pièges, questions posées à l'auditeur, récap final.
//
// Même lecture que src/podcast : Web Speech API, chaque réplique découpée en
// phrases courtes (les WebViews coupent une utterance au bout de ~15 s), deux
// voix système alternées, jeton de lecture pour qu'aucune chaîne ne survive
// à un arrêt.

import { llmChat } from "../llm.js";
import { PROMPTS } from "./prompts.js";

const synth = window.speechSynthesis;
const clean = (s) => String(s || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();

export { PODCAST_STYLES as STYLES } from "./prompts.js";
const TURNS = { short: 8, medium: 14, long: 22 };


/**
 * Écrit l'épisode.
 * @returns {Promise<{title:string, turns:{speaker:0|1,text:string}[]}>}
 */
export async function writeEpisode(text, { style = "lesson", length = "medium", lang = "fr", names = ["Claire", "Hugo"] } = {}) {
  const { messages, opts } = PROMPTS["app.studies.podcast"].build({ text, style, turns: TURNS[length] || TURNS.medium, names, lang });
  const { content } = await llmChat(messages, { ...opts, rawSystem: true });
  let data = null;
  const t = clean(content);
  try { data = JSON.parse(t); } catch { const m = t.match(/\{[\s\S]*\}/); if (m) try { data = JSON.parse(m[0]); } catch {} }
  const turns = (data?.turns || []).filter((x) => x && x.text).map((x) => ({ speaker: x.speaker ? 1 : 0, text: String(x.text).replace(/[*_#`$]/g, "").trim() }));
  if (!turns.length) throw new Error("Le modèle n'a pas produit de dialogue exploitable. Réessayez, ou choisissez un modèle plus grand.");
  return { title: String(data.title || "Podcast de révision"), turns };
}

// ---- Voix ------------------------------------------------------------------
export function voicesFor(lang) {
  const all = synth ? synth.getVoices() : [];
  const mine = all.filter((v) => v.lang?.toLowerCase().startsWith(lang));
  return mine.length >= 1 ? mine : all;
}
export function onVoicesReady(cb) {
  if (!synth) return;
  if (synth.getVoices().length) cb();
  synth.addEventListener?.("voiceschanged", cb);
}

// ---- Lecteur ---------------------------------------------------------------
/**
 * Lecteur d'épisode. `onTurn(i)` reçoit la réplique en cours (-1 à l'arrêt).
 * `getVoice(speaker)` et `getRate()` sont relus à chaque phrase : changer de
 * voix ou de vitesse pendant l'écoute prend effet à la phrase suivante.
 */
export function createPlayer({ onTurn, onState, getVoice, getRate }) {
  let ep = null, queue = [], qi = 0, playing = false, run = 0;
  const build = () => {
    queue = [];
    ep.turns.forEach((t, i) => (t.text.match(/[^.!?…]+[.!?…]*/g) || [t.text]).map((s) => s.trim()).filter(Boolean).forEach((s) => queue.push({ i, s })));
  };
  const next = (token) => {
    if (token !== run || !playing) return;
    if (qi >= queue.length) { stop(); return; }
    const item = queue[qi];
    onTurn?.(item.i);
    const u = new SpeechSynthesisUtterance(item.s);
    const v = getVoice?.(ep.turns[item.i].speaker);
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = getRate?.() || 1;
    u.onend = u.onerror = () => { if (token === run && playing) { qi++; next(token); } };
    synth.speak(u);
  };
  function stop() { run++; playing = false; try { synth?.cancel(); } catch {} qi = 0; onTurn?.(-1); onState?.(false); }
  return {
    load(e) { stop(); ep = e; build(); },
    play(fromTurn = null) {
      if (!ep || !synth) return;
      if (fromTurn != null) { run++; try { synth.cancel(); } catch {} qi = Math.max(0, queue.findIndex((q) => q.i === fromTurn)); playing = false; }
      if (playing && synth.paused) { synth.resume(); onState?.(true); return; }
      if (playing) return;
      playing = true; onState?.(true); next(run);
    },
    pause() { if (playing) { synth?.pause(); onState?.(false); } },
    get playing() { return playing && !synth?.paused; },
    stop,
  };
}
