// Commande vocale du bureau — la partie « interface » : push-to-talk, pastille
// d'écoute, exécution et retour utilisateur. L'interprétation elle-même vit dans
// lib/voice-commands.js (pur, testé) ; le bureau nous prête ses gestes via `ctx`.
//
// OPT-IN : le seul écouteur posé d'office est celui du clavier, qui relit le
// réglage à chaque frappe et ne fait RIEN tant qu'il est éteint — ni pastille,
// ni bouton, ni chargement de Whisper. Activer la commande vocale dans les
// Réglages prend donc effet sans redémarrer le bureau.

import { tt } from "../apps-i18n.js";
import { icon as lumenIcon } from "../lib/icons.js";
import { whisperEnabled, whisperDictate } from "../lib/whisper-dictation.js";
import { interpret, voiceControlPrefs, voiceRouterSystem, VOICE_ROUTER_SCHEMA } from "../lib/voice-commands.js";

const invoke = (...a) => window.__TAURI__?.core?.invoke?.(...a);

let pill = null;        // la pastille d'écoute / de retour
let session = null;     // { abort } pendant une écoute
let hideTimer = null;

// ===== Pastille ==============================================================

function ensurePill() {
  if (pill) return pill;
  pill = document.createElement("div");
  pill.className = "dt-voice";
  pill.hidden = true;
  pill.innerHTML = `
    <div class="dt-voice-head">
      <span class="dt-voice-ic">${lumenIcon("mic")}</span>
      <span class="dt-voice-state"></span>
      <span class="dt-voice-level"><i></i></span>
      <button class="dt-voice-x" title="${tt("Fermer")}">×</button>
    </div>
    <div class="dt-voice-text"></div>
    <div class="dt-voice-body"></div>`;
  pill.querySelector(".dt-voice-x").addEventListener("click", () => hidePill(true));
  document.body.appendChild(pill);
  return pill;
}

function showPill({ state = "", text = "", body = null, level = null } = {}) {
  const el = ensurePill();
  clearTimeout(hideTimer);
  el.hidden = false;
  el.querySelector(".dt-voice-state").textContent = state;
  el.querySelector(".dt-voice-text").textContent = text;
  el.querySelector(".dt-voice-level").hidden = level === null;
  const b = el.querySelector(".dt-voice-body");
  b.innerHTML = "";
  if (body) b.appendChild(body);
  b.hidden = !body;
}

function setLevel(v) {
  if (!pill) return;
  pill.querySelector(".dt-voice-level i").style.transform = `scaleX(${Math.max(0.04, Math.min(1, v))})`;
}

function hidePill(cancel = false) {
  if (cancel && session) session.abort.abort();
  clearTimeout(hideTimer);
  if (pill) pill.hidden = true;
}

function hideLater(ms = 2200) {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => hidePill(), ms);
}

// ===== Retour utilisateur =====================================================

async function feedback(ctx, label, ok = true) {
  const prefs = voiceControlPrefs();
  // La capsule Halo reçoit la même ligne : on voit ce que le bureau a compris
  // même si la pastille est cachée derrière une fenêtre.
  invoke("notify_island", { payload: { kind: ok ? "info" : "warn", title: tt("Commande vocale"), body: label, icon: "mic", source: "voice" } })?.catch?.(() => {});
  if (prefs.speak && ok) { try { await ctx.speak?.(label); } catch {} }
}

// ===== Écoute ==================================================================

async function listen(ctx) {
  if (session) return "";
  const abort = new AbortController();
  session = { abort };
  showPill({ state: tt("Chargement de Whisper…"), level: 0 });
  try {
    if (whisperEnabled()) {
      return await whisperDictate({
        seconds: 20,
        silenceMs: 1500,
        signal: abort.signal,
        onLevel: (lvl) => setLevel(lvl),
        onState: (phase) => {
          if (phase === "recording") showPill({ state: tt("Je vous écoute…"), level: 0 });
          else if (phase === "transcribing") showPill({ state: tt("Transcription…") });
        },
      });
    }
    // Sans Whisper : la dictée native (Raccourci Apple), sans niveau sonore.
    showPill({ state: tt("Je vous écoute…") });
    return await invoke("dictate", { shortcutName: localStorage.getItem("dictateShortcut") || "" });
  } finally {
    session = null;
  }
}

/** Arrête l'écoute en cours (relâchement de la touche) : Whisper transcrit ce qu'il a. */
function stopListening() {
  session?.abort.abort();
}

// ===== Exécution ================================================================

function choicesBody(choices, onPick) {
  const wrap = document.createElement("div");
  wrap.className = "dt-voice-choices";
  for (const c of choices.slice(0, 6)) {
    const b = document.createElement("button");
    b.className = "dt-voice-choice";
    b.innerHTML = `<b></b><i></i>`;
    b.querySelector("b").textContent = c.label;
    b.querySelector("i").textContent = c.sub || "";
    b.addEventListener("click", () => onPick(c));
    wrap.appendChild(b);
  }
  return wrap;
}

function confirmBody(onYes, onNo) {
  const wrap = document.createElement("div");
  wrap.className = "dt-voice-confirm";
  const yes = document.createElement("button"); yes.className = "dt-voice-btn primary"; yes.textContent = tt("Confirmer");
  const no = document.createElement("button"); no.className = "dt-voice-btn"; no.textContent = tt("Annuler");
  yes.addEventListener("click", onYes); no.addEventListener("click", onNo);
  wrap.append(yes, no);
  return wrap;
}

async function runResult(ctx, result, text) {
  const done = async (label) => {
    showPill({ state: tt("Commande vocale"), text: label });
    await feedback(ctx, label, true);
    hideLater();
  };
  if (result.choices) {
    showPill({ state: result.label, text, body: choicesBody(result.choices, async (c) => {
      try { await c.run(); } catch (e) { ctx.toast?.(String(e?.message || e)); }
      done(c.label);
    }) });
    return;
  }
  if (result.confirm) {
    showPill({ state: tt("Confirmer ?"), text: result.label, body: confirmBody(async () => {
      try { await result.run(); } catch (e) { ctx.toast?.(String(e?.message || e)); }
      done(result.label);
    }, () => hidePill()) });
    return;
  }
  try { await result.run(); } catch (e) { ctx.toast?.(String(e?.message || e)); }
  done(result.label);
}

/** Interprète et exécute une phrase (dictée, ou texte venu d'ailleurs). */
export async function runVoiceCommand(ctx, text) {
  const clean = String(text || "").trim();
  if (!clean) { showPill({ state: tt("Rien entendu.") }); hideLater(1500); return; }
  showPill({ state: tt("Analyse…"), text: clean });
  const prefs = voiceControlPrefs();
  const lang = ctx.lang();
  const router = prefs.router ? async (t) => {
    const { lfmRoute } = await import("../lib/lfm.js");
    const apps = ctx.apps();
    const workflows = await ctx.workflows().catch(() => []);
    const intents = prefs.intents ? ctx.intents() : [];
    const { decision } = await lfmRoute(t, { system: voiceRouterSystem({ lang, apps, workflows, intents }), schema: VOICE_ROUTER_SCHEMA });
    return decision;
  } : null;
  const result = await interpret(clean, { lang, apps: ctx.apps, files: ctx.files, workflows: ctx.workflows, actions: ctx.actions, router });
  try { ctx.log?.(clean, result); } catch {}
  await runResult(ctx, result, clean);
}

/** Un cycle complet : écoute → transcription → action. */
export async function pushToTalk(ctx) {
  if (session) { stopListening(); return; }
  let text = "";
  try { text = await listen(ctx); }
  catch (e) { showPill({ state: tt("Dictée indisponible"), text: String(e?.message || "") }); hideLater(2500); return; }
  await runVoiceCommand(ctx, text);
}

// ===== Installation ===========================================================

function matchesShortcut(e, shortcut) {
  const parts = String(shortcut || "alt+space").toLowerCase().split("+");
  const key = parts.pop();
  const want = { alt: parts.includes("alt"), ctrl: parts.includes("ctrl"), meta: parts.includes("meta") || parts.includes("cmd"), shift: parts.includes("shift") };
  const k = (e.key || "").toLowerCase();
  const keyOk = key === "space" ? (k === " " || e.code === "Space") : k === key;
  return keyOk && e.altKey === want.alt && e.ctrlKey === want.ctrl && e.metaKey === want.meta && e.shiftKey === want.shift;
}

/**
 * Pose le push-to-talk sur le document. `ctx` :
 *   lang() ; apps() ; files() ; workflows() ; intents() ; actions{…} ;
 *   speak(text) ; toast(msg) ; log(text, result) ; isDesktopActive().
 * Renvoie { trigger } — le même geste, pour un bouton du dock ou de la barre.
 */
export function installVoiceControl(ctx) {
  if (window.__dtVoiceControl) return window.__dtVoiceControl;
  let held = false;
  const onKeyDown = (e) => {
    const prefs = voiceControlPrefs();
    if (!prefs.enabled || !ctx.isDesktopActive?.()) return;
    if (e.repeat || !matchesShortcut(e, prefs.shortcut)) return;
    // Pas dans un champ de saisie : ⌥Espace y reste une frappe normale.
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault();
    if (session) { stopListening(); return; }
    held = true;
    pushToTalk(ctx);
  };
  const onKeyUp = (e) => {
    if (!held) return;
    const k = (e.key || "").toLowerCase();
    if (k === " " || e.code === "Space" || k === "alt" || k === "control" || k === "meta") { held = false; stopListening(); }
  };
  const onEsc = (e) => { if (e.key === "Escape" && pill && !pill.hidden) hidePill(true); };
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("keyup", onKeyUp, true);
  document.addEventListener("keydown", onEsc);
  const api = { trigger: () => pushToTalk(ctx), run: (text) => runVoiceCommand(ctx, text), stop: stopListening };
  window.__dtVoiceControl = api;
  return api;
}
