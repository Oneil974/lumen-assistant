// Podcast IA — logique front. L'IA (llmChat) écrit un dialogue à deux hôtes ;
// deux voix locales (Piper/Kokoro) ou système lisent en alternance.
// Option RAG : injecte des extraits des Connaissances via la commande rag_search.

import { translatePage, observeTranslations } from "../apps-i18n.js";
import { llmChat } from "../llm.js";
import { mountAiPrompt, tool, T } from "../lib/ai-prompt.js?v=5";
import { createStore } from "../lib/app-state.js";
import { recordOllamaUsage } from "../ollama-usage.js";
import { replyLang } from "../lib/prompt-lang.js";
import { PROMPTS, TONES } from "./prompts.js";
// L'import installe l'écoute des demandes d'arrêt vocal venues d'une autre
// fenêtre (double-clic sur l'avatar) : cette page coupe alors sa propre
// Web Speech. cf. lib/voice-stop.js
import "../lib/voice-stop.js";

const __TAURI = window.__TAURI__ || (window.parent && window.parent.__TAURI__) || {};
const { invoke } = __TAURI.core || {};
const { listen } = __TAURI.event || {};

const $ = (id) => document.getElementById(id);
const synth = window.speechSynthesis;

let voices = [];
let localVoices = [];
let episode = null;          // { title, turns:[{speaker, text}] }
let queue = [];              // [{turnIndex, text}] — phrases à énoncer
let qi = 0;                  // index de lecture dans queue
let playing = false;
// Jeton de lecture. Chaque démarrage l'incrémente : toute chaîne speakNext()
// encore en vol (une phrase dont le onend/tts-ended n'est pas encore revenu)
// se voit alors invalidée. Sans ça, relancer un épisode — surtout depuis la
// bibliothèque, avec d'autres voix — faisait cohabiter deux chaînes et donc
// deux voix simultanées.
let playRun = 0;

// ===== Voix =====
async function loadVoices() {
  voices = synth ? synth.getVoices() : [];
  if (invoke) {
    try {
      localVoices = (await invoke("tts_catalog"))
        .filter((v) => v && v.installed)
        .map((v) => ({ ...v, name: v.label || v.id, lang: v.lang || v.engine || "local" }));
    } catch {
      localVoices = [];
    }
  }
  // Priorité aux voix françaises ; sinon tout.
  const fr = voices.filter((v) => /^fr/i.test(v.lang));
  const webPool = fr.length >= 2 ? fr : voices;
  const localFr = localVoices.filter((v) => /^fr/i.test(v.lang) || /siwis|fr/i.test(v.id));
  const localPool = localFr.length >= 2 ? localFr : localVoices;
  const pool = [...localPool, ...webPool];
  if (!pool.length) return;
  fillVoiceSelect($("voiceA"), pool, 0);
  fillVoiceSelect($("voiceB"), pool, pickSecond(pool));
}
// Choisit un 2e index distinct, en préférant un genre/voix différent du 1er.
function pickSecond(pool) {
  if (pool.length < 2) return 0;
  const female = /(amélie|amelie|aurelie|audrey|marie|chloé|female|femme|samantha|victoria|siwis|heart|emma|amy)/i;
  const firstFem = female.test(pool[0].name);
  for (let i = 1; i < pool.length; i++) {
    if (female.test(pool[i].name) !== firstFem) return i;
  }
  return 1;
}
function fillVoiceSelect(sel, pool, idx) {
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = "";
  pool.forEach((v) => {
    const o = document.createElement("option");
    const isLocal = !!v.id;
    o.value = isLocal ? `local:${v.id}` : `web:${v.name}`;
    o.textContent = isLocal
      ? `${v.name} (${v.engine || "local"} · ${v.lang})`
      : `${v.name} (${v.lang})`;
    sel.appendChild(o);
  });
  const fallback = pool[idx] ? (pool[idx].id ? `local:${pool[idx].id}` : `web:${pool[idx].name}`) : "";
  sel.value = prev && [...sel.options].some((o) => o.value === prev) ? prev : fallback;
}
function webVoiceByValue(value) {
  const name = String(value || "").replace(/^web:/, "");
  return voices.find((v) => v.name === name) || null;
}

// ===== Génération du script =====
const LENGTHS = { short: 6, medium: 11, long: 18 };

async function ragContext(query) {
  if (!invoke) return "";
  try {
    const hits = await invoke("rag_search", { query: query.slice(0, 300), k: 8 });
    if (!Array.isArray(hits) || !hits.length) return "";
    return hits.map((h) => `• ${h.title ? `[${h.title}] ` : ""}${h.text}`).join("\n").slice(0, 6000);
  } catch { return ""; }
}

async function generate() {
  const source = $("source").value.trim();
  if (!source) { hint("Donne d'abord un texte ou un sujet."); return; }
  const nameA = $("nameA").value.trim() || "Alex";
  const nameB = $("nameB").value.trim() || "Sam";
  const turns = LENGTHS[$("length").value] || 11;
  const tone = TONES[$("tone").value] || TONES.expert;

  const btn = $("generate");
  btn.disabled = true; btn.textContent = "✍️ Écriture de l'épisode…";
  hint("L'IA rédige le dialogue…");

  try {
    let context = "";
    if ($("use-rag").checked) {
      hint("Recherche dans tes Connaissances…");
      context = await ragContext(source);
    }
    const { messages, opts } = PROMPTS["app.podcast.episode"].build({ source, context, nameA, nameB, turns, tone, lang: replyLang() });
    const { content, data } = await llmChat(messages, { ...opts, rawSystem: true });
    recordOllamaUsage(data, "podcast");
    episode = parseEpisode(content, nameA, nameB);
    if (!episode.turns.length) throw new Error("script vide");
    renderEpisode();
    hint(`Épisode prêt : ${episode.turns.length} répliques. ▶ pour écouter.`);
  } catch (e) {
    hint("Échec de génération : " + (e.message || e) + ". Vérifie qu'un modèle est sélectionné.");
  } finally {
    btn.disabled = false; btn.textContent = "✨ Générer l'épisode";
  }
}

function parseEpisode(content, nameA, nameB) {
  let obj = {};
  try { obj = JSON.parse(content); }
  catch { const m = content.match(/\{[\s\S]*\}/); if (m) { try { obj = JSON.parse(m[0]); } catch {} } }
  const rawTurns = Array.isArray(obj.turns) ? obj.turns : [];
  const turns = rawTurns.map((t, i) => {
    let sp = t.speaker;
    if (typeof sp === "string") {
      const s = sp.trim().toLowerCase();
      sp = (s === nameB.toLowerCase() || s === "1" || s === "b") ? 1 : (s === nameA.toLowerCase() || s === "0" || s === "a") ? 0 : i % 2;
    }
    return { speaker: sp ? 1 : 0, text: String(t.text || "").trim() };
  }).filter((t) => t.text);
  return { title: String(obj.title || "Épisode").trim(), turns, nameA, nameB };
}

// ===== Rendu transcript =====
function renderEpisode() {
  $("empty").hidden = true;
  $("player").hidden = false;
  $("ep-title").textContent = episode.title;
  $("ep-meta").textContent = `${episode.turns.length} répliques · ${episode.nameA} & ${episode.nameB}`;
  const box = $("transcript");
  box.innerHTML = "";
  episode.turns.forEach((t, i) => {
    const who = t.speaker ? episode.nameB : episode.nameA;
    const line = document.createElement("div");
    line.className = "line " + (t.speaker ? "b" : "a");
    line.dataset.i = i;
    line.innerHTML = `<div class="avatar">${who.slice(0, 1).toUpperCase()}</div>` +
      `<div class="bubble"><span class="who"></span><span class="txt"></span></div>`;
    line.querySelector(".who").textContent = who;
    line.querySelector(".txt").textContent = t.text;
    box.appendChild(line);
  });
  buildQueue();
  resetPlayhead();
}

// Découpe chaque réplique en phrases courtes : utterances brèves = pas de coupure
// à ~15 s (bug connu des WebViews) et surlignage fluide.
function buildQueue() {
  queue = [];
  episode.turns.forEach((t, idx) => {
    const sentences = t.text.match(/[^.!?…]+[.!?…]*/g) || [t.text];
    sentences.map((s) => s.trim()).filter(Boolean).forEach((s) => queue.push({ turnIndex: idx, text: s }));
  });
}

// ===== Lecture =====
async function speakNext(token) {
  if (token !== playRun || !playing) return;
  if (qi >= queue.length) { finishPlayback(); return; }
  const item = queue[qi];
  highlight(item.turnIndex);
  const turn = episode.turns[item.turnIndex];
  const selected = $(turn.speaker ? "voiceB" : "voiceA").value;
  if (selected.startsWith("local:") && invoke) {
    try {
      await speakLocal(item.text, selected.slice(6));
    } catch {
      toast("Voix locale indisponible, lecture avec la voix système.");
      // speakWeb enchaîne lui-même sur la phrase suivante : on s'arrête là.
      await speakWeb(item, selected, token);
      return;
    }
    if (token === playRun && playing) { qi++; speakNext(token); }
    return;
  }
  await speakWeb(item, selected, token);
}

async function speakLocal(text, voice) {
  if (!listen) {
    await invoke("tts_speak", { text, voice });
    return;
  }
  let unlisten = null;
  try {
    await new Promise(async (resolve, reject) => {
      const timer = setTimeout(resolve, 45000);
      try {
        unlisten = await listen("tts-ended", () => {
          clearTimeout(timer);
          resolve();
        });
        await invoke("tts_speak", { text, voice });
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
  } finally {
    try { unlisten?.(); } catch {}
  }
}

function speakWeb(item, selected, token) {
  return new Promise((resolve) => {
    if (!synth) { resolve(); return; }
    const turn = episode.turns[item.turnIndex];
    const u = new SpeechSynthesisUtterance(item.text);
    const v = webVoiceByValue(selected);
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = parseFloat($("rate").value) || 1;
    u.onend = resolve;
    u.onerror = resolve;
    synth.speak(u);
  }).then(() => {
    if (token === playRun && playing) { qi++; speakNext(token); }
  });
}

function hasPlayableVoice() {
  return !!(invoke || synth);
}

function stopAudio() {
  try { synth?.cancel(); } catch {}
  try { invoke?.("tts_stop"); } catch {}
}

function pauseAudio() {
  try { synth?.pause(); } catch {}
  try { invoke?.("tts_stop"); } catch {}
}

function resumeAudio() {
  try { synth?.resume(); } catch {}
}

function isWebPaused() {
  return !!(synth && synth.paused);
}

function cancelWebQueue() {
  try { synth?.cancel(); } catch {}
}

/// Coupe TOUT : la chaîne de lecture en cours (jeton invalidé), la voix web et
/// la voix locale du backend. C'est le point d'entrée unique du bouton ⏹, et
/// tout ce qui repart d'un état propre l'appelle.
function stopAllPlayback() {
  playRun++;
  playing = false;
  stopAudio();
  setPlayUI(false);
}

function play() {
  if (!episode) return;
  if (!hasPlayableVoice()) { toast("Synthèse vocale indisponible dans cet environnement."); return; }
  if (isWebPaused() && playing) { resumeAudio(); return; }
  const token = ++playRun;   // invalide toute chaîne encore en vol
  playing = true;
  setPlayUI(true);
  if (qi >= queue.length) qi = 0;
  resumeAudio();             // sort d'une pause : sinon speak() reste bloqué
  cancelWebQueue();
  speakNext(token);
}
function pause() { playing = false; setPlayUI(false); pauseAudio(); }
function togglePlay() { (playing && !isWebPaused()) ? pause() : play(); }
function restart() { stopAllPlayback(); qi = 0; highlight(-1); play(); }
function stopPlayback() { stopAllPlayback(); qi = 0; highlight(-1); }

function finishPlayback() { playing = false; setPlayUI(false); qi = 0; highlight(-1); }
function resetPlayhead() { stopAllPlayback(); qi = 0; highlight(-1); }

function setPlayUI(on) {
  $("playpause").textContent = on ? "⏸" : "▶";
  $("wave").classList.toggle("on", on);
}
function highlight(turnIndex) {
  document.querySelectorAll(".line").forEach((el) => {
    const active = Number(el.dataset.i) === turnIndex;
    el.classList.toggle("active", active);
    if (active) el.scrollIntoView({ block: "center", behavior: "smooth" });
  });
}

// ===== Bibliothèque (localStorage) — sauver/rejouer un épisode =====
// ===== Assistant IA (boîte de prompt partagée) =====
// Produire un épisode entièrement au prompt : sujet, format, réécriture d'une
// réplique, ajout d'un passage, lecture, sauvegarde, reprise d'un épisode.
const PODCAST_TOOLS = [
  tool("describe_episode", "État de l'épisode courant : titre, hôtes, nombre de répliques, texte.", {}),
  tool("set_brief", "Renseigne le sujet (ou le texte source), le format et les hôtes, sans encore générer.",
    { source: T.str("Sujet ou texte source"), length: T.enum(["short", "medium", "long"], "Durée"),
      tone: T.str("Ton (clé de la liste des tons)"), hostA: T.str("Nom du premier hôte"), hostB: T.str("Nom du second"),
      use_knowledge: T.bool("Puiser dans la base de Connaissances") }),
  tool("generate_episode", "Génère l'épisode à partir du brief courant (le dialogue est écrit par le modèle du studio).", {}),
  tool("write_episode", "Écris toi-même l'épisode, réplique par réplique (utile pour un format précis ou une reprise).",
    { title: T.str("Titre de l'épisode"),
      turns: { type: "array", description: "Répliques dans l'ordre",
        items: { type: "object", properties: { speaker: T.int("0 = premier hôte, 1 = second"), text: T.str("") }, required: ["speaker", "text"] } } },
    ["title", "turns"]),
  tool("rewrite_turn", "Réécrit une réplique précise.", { index: T.int("Numéro de la réplique, à partir de 0"), text: T.str("") }, ["index", "text"]),
  tool("play", "Lance ou arrête la lecture audio de l'épisode.", { on: T.bool("") }, ["on"]),
  tool("save_episode", "Sauvegarde l'épisode courant dans la bibliothèque.", {}),
  tool("list_episodes", "Liste les épisodes sauvegardés.", {}),
];

async function runPodcastTool(name, a) {
  switch (name) {
    case "describe_episode":
      if (!episode) return "Aucun épisode en cours. Brief : " + ($("source").value.trim() || "(vide)");
      return `« ${episode.title} » — ${episode.turns.length} répliques\n`
        + episode.turns.map((t, i) => `${i}. [${t.speaker === 0 ? $("nameA").value : $("nameB").value}] ${t.text}`).join("\n");
    case "set_brief": {
      const changed = [];
      if (a.source) { $("source").value = String(a.source); changed.push("sujet"); }
      if (a.length && LENGTHS[a.length]) { $("length").value = a.length; changed.push("durée"); }
      if (a.tone && TONES[a.tone]) { $("tone").value = a.tone; changed.push("ton"); }
      if (a.hostA) { $("nameA").value = String(a.hostA); changed.push("hôte A"); }
      if (a.hostB) { $("nameB").value = String(a.hostB); changed.push("hôte B"); }
      if (a.use_knowledge != null) { $("use-rag").checked = !!a.use_knowledge; changed.push("connaissances"); }
      if (!changed.length) throw new Error("aucun élément de brief fourni.");
      return `Brief mis à jour : ${changed.join(", ")}.`;
    }
    case "generate_episode": {
      if (!$("source").value.trim()) throw new Error("renseigne d'abord le sujet avec set_brief.");
      await generate();
      return episode ? `Épisode « ${episode.title} » généré (${episode.turns.length} répliques).` : "La génération n'a rien produit.";
    }
    case "write_episode": {
      const turns = (a.turns || []).map((t) => ({ speaker: t.speaker === 1 ? 1 : 0, text: String(t.text || "") })).filter((t) => t.text);
      if (!turns.length) throw new Error("fournis au moins une réplique.");
      episode = { title: String(a.title || "Épisode"), turns };
      renderEpisode();
      return `Épisode « ${episode.title} » écrit (${turns.length} répliques).`;
    }
    case "rewrite_turn": {
      if (!episode) throw new Error("aucun épisode en cours.");
      const i = Number(a.index);
      if (!episode.turns[i]) throw new Error(`la réplique ${i} n'existe pas (0 à ${episode.turns.length - 1}).`);
      episode.turns[i].text = String(a.text || "");
      renderEpisode();
      return `Réplique ${i} réécrite.`;
    }
    case "play": {
      if (!episode) throw new Error("aucun épisode à lire.");
      if (a.on) { play(); return "Lecture lancée."; }
      stopPlayback();
      return "Lecture arrêtée.";
    }
    case "save_episode": { if (!episode) throw new Error("aucun épisode à sauvegarder."); saveEpisode(); return `« ${episode.title} » sauvegardé.`; }
    case "list_episodes": {
      const lib = loadLibrary();
      return lib.length ? lib.map((e, i) => `${i}. ${e.title} (${e.turns?.length || 0} répliques)`).join("\n") : "Bibliothèque vide.";
    }
    default: return `Outil inconnu : ${name}`;
  }
}

function mountPodcastAI() {
  mountAiPrompt(null, {
    app: "Podcast IA",
    intro: "Tu produis des épisodes de podcast à deux voix : brief, écriture, réécriture, lecture.",
    rules: "- Pour un épisode à partir d'un sujet libre, renseigne le brief (set_brief) puis appelle generate_episode.\n- Si l'utilisateur veut un format précis (durée, structure, angle), écris toi-même les répliques avec write_episode.\n- Les répliques alternent entre les deux hôtes et sonnent parlées, pas écrites.",
    placeholder: "Ex. : un épisode de 10 minutes sur l'histoire du café, ton curieux…",
    suggestions: [
      { label: "Produire un épisode", prompt: "Produis un épisode sur un sujet que je vais te donner, format moyen, ton curieux." },
      { label: "Resserrer", prompt: "Relis l'épisode et réécris les répliques trop longues ou plates." },
      { label: "Depuis mes notes", prompt: "Fais un épisode à partir de ma base de Connaissances sur le sujet que je précise." },
      { label: "Écouter", prompt: "Lance la lecture de l'épisode." },
    ],
    tools: PODCAST_TOOLS,
    context: () => episode
      ? `Épisode « ${episode.title} » — ${episode.turns.length} répliques. Hôtes : ${$("nameA").value} et ${$("nameB").value}.`
      : `Aucun épisode. Brief courant : ${$("source").value.trim().slice(0, 200) || "(vide)"}`,
    execute: runPodcastTool,
    onApplied: () => {},
  });
}

// Épisodes sur DISQUE : un dialogue complet pèse plusieurs kilo-octets, et la
// bibliothèque n'a pas de raison de grever le stockage partagé.
const store = createStore("podcast");
const LIB_KEY = "podcast.episodes";
function loadLibrary() { try { const a = JSON.parse(store.get(LIB_KEY) || "[]"); return Array.isArray(a) ? a : []; } catch { return []; } }
function persistLibrary(list) { store.set(LIB_KEY, JSON.stringify(list)); }

function saveEpisode() {
  if (!episode) { toast("Génère d'abord un épisode."); return; }
  const list = loadLibrary();
  const rec = {
    id: "ep-" + Date.now().toString(36),
    title: episode.title, turns: episode.turns, nameA: episode.nameA, nameB: episode.nameB,
    voiceA: $("voiceA").value, voiceB: $("voiceB").value, ts: Date.now(),
  };
  list.unshift(rec);
  persistLibrary(list);
  renderLibrary();
  toast("Épisode sauvegardé 📚");
}

function renderLibrary() {
  const list = loadLibrary();
  const host = $("ep-list");
  $("lib-empty").hidden = list.length > 0;
  host.innerHTML = "";
  list.forEach((rec) => {
    const row = document.createElement("div");
    row.className = "ep-item";
    const d = new Date(rec.ts);
    row.innerHTML = `<button class="ep-open"><span class="ep-it-title"></span>` +
      `<span class="ep-it-sub">${rec.turns.length} répliques · ${d.toLocaleDateString()}</span></button>` +
      `<button class="ep-del" title="Supprimer">🗑</button>`;
    row.querySelector(".ep-it-title").textContent = rec.title;
    row.querySelector(".ep-open").addEventListener("click", () => openSaved(rec));
    row.querySelector(".ep-del").addEventListener("click", () => {
      persistLibrary(loadLibrary().filter((e) => e.id !== rec.id));
      renderLibrary();
    });
    host.appendChild(row);
  });
}

function openSaved(rec) {
  // Arrêt complet AVANT de changer les voix : une chaîne encore en vol lirait
  // la suite avec les nouvelles voix, par-dessus l'épisode qu'on ouvre.
  stopAllPlayback();
  episode = { title: rec.title, turns: rec.turns, nameA: rec.nameA, nameB: rec.nameB };
  // Restaure les voix/noms de l'épisode (si encore disponibles).
  $("nameA").value = rec.nameA; $("nameB").value = rec.nameB;
  setVoiceValue("voiceA", rec.voiceA); setVoiceValue("voiceB", rec.voiceB);
  renderEpisode();
  hint(`« ${rec.title} » chargé. ▶ pour écouter.`);
}
function setVoiceValue(id, name) {
  const sel = $(id);
  if (!name) return;
  if (![...sel.options].some((o) => o.value === name)) {
    const o = document.createElement("option"); o.value = name; o.textContent = name + " (sauvegardée)"; sel.appendChild(o);
  }
  sel.value = name;
}

// ===== Divers =====
function hint(msg) { $("setup-hint").textContent = msg || ""; }
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 3000);
}

async function init() {
  await store.ready({ migrate: (k) => k === LIB_KEY });
  mountPodcastAI();
  translatePage();
  observeTranslations();
  loadVoices();
  if (synth) synth.onvoiceschanged = loadVoices;
  if (!synth && !invoke) hint("Synthèse vocale non disponible : la lecture audio sera désactivée.");
  $("generate").addEventListener("click", generate);
  $("ep-save").addEventListener("click", saveEpisode);
  renderLibrary();
  $("playpause").addEventListener("click", togglePlay);
  $("restart").addEventListener("click", restart);
  $("stop").addEventListener("click", stopPlayback);
  // Changer la vitesse relance la phrase en cours : on repart d'un jeton neuf
  // (sinon l'ancienne chaîne continuait en parallèle).
  $("rate").addEventListener("input", () => { if (playing) { stopAllPlayback(); play(); } });
  // Coupe la voix si la fenêtre se ferme/recharge.
  window.addEventListener("beforeunload", stopAllPlayback);
}
init();
