// Bouton micro partagé — dictée Whisper locale dans n'importe quel champ IA.
//
// Un seul composant pour toutes les zones de saisie (feuille IA, volet
// Assistant des apps, boîtes de génération…) : un clic écoute, l'arrêt est
// AUTOMATIQUE après 2 s de silence (cf. whisper-dictation.js), un second clic
// arrête plus tôt. Le texte reconnu s'ajoute au champ, à la suite de ce qui s'y
// trouve, et déclenche `input` pour que l'app le voie.
//
//   mountMicButton(textarea, { before: sendButton });
//
// Le modèle Whisper est téléchargé au premier usage (progression dans
// l'info-bulle) puis servi depuis le cache.

import { whisperDictate } from "./whisper-dictation.js";

const MIC_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>';
const STOP_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

const L = {
  fr: { idle: "Dicter (Whisper, arrêt après 2 s de silence)", loading: "Chargement de Whisper…", recording: "Écoute… (clic pour arrêter)", transcribing: "Transcription…", nothing: "Rien entendu.", failed: "Dictée indisponible : " },
  en: { idle: "Dictate (Whisper, stops after 2 s of silence)", loading: "Loading Whisper…", recording: "Listening… (click to stop)", transcribing: "Transcribing…", nothing: "Nothing heard.", failed: "Dictation unavailable: " },
};
const lang = () => ((localStorage.getItem("lang") || "fr").toLowerCase().startsWith("en") ? "en" : "fr");

let styleDone = false;
function ensureStyle(doc) {
  if (styleDone || doc.getElementById("lumen-mic-css")) { styleDone = true; return; }
  const st = doc.createElement("style");
  st.id = "lumen-mic-css";
  st.textContent = `
.lumen-mic { position: relative; flex: none; width: 30px; height: 30px; border-radius: 50%; border: 1px solid var(--border, #ddd);
  background: var(--secondary, #f4f4f5); color: var(--muted-foreground, #666); display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer; padding: 0; transition: background .15s, color .15s; }
.lumen-mic:hover { color: var(--foreground, #111); border-color: var(--primary, #4f7cff); }
.lumen-mic.loading { color: var(--muted-foreground, #666); cursor: progress; }
.lumen-mic.recording { background: var(--destructive, #e5484d); color: #fff; border-color: transparent; }
.lumen-mic.recording::before { content: ""; position: absolute; inset: -3px; border-radius: 50%; border: 2px solid var(--destructive, #e5484d);
  opacity: 0; transform: scale(calc(1 + var(--lvl, 0) * .35)); transition: transform .08s; animation: lumen-mic-pulse 1.4s ease-out infinite; }
.lumen-mic.transcribing { color: var(--primary, #4f7cff); cursor: progress; }
.lumen-mic.transcribing svg { animation: lumen-mic-blink 1s ease-in-out infinite; }
@keyframes lumen-mic-pulse { 0% { opacity: .7; } 100% { opacity: 0; transform: scale(1.6); } }
@keyframes lumen-mic-blink { 50% { opacity: .35; } }`;
  doc.head.appendChild(st);
  styleDone = true;
}

/** Insère `text` dans le champ (input/textarea/contenteditable), à la suite. */
function appendText(target, text) {
  if (!text) return;
  if (target.isContentEditable) {
    target.focus();
    const sep = target.textContent.trim() ? " " : "";
    try { document.execCommand("insertText", false, sep + text); } catch { target.textContent += sep + text; }
  } else {
    const cur = target.value || "";
    target.value = cur.trim() ? `${cur.replace(/\s+$/, "")} ${text}` : text;
    target.focus();
    try { target.setSelectionRange(target.value.length, target.value.length); } catch {}
  }
  target.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Monte un bouton micro pour `target`.
 * @param {HTMLElement} target  champ qui reçoit le texte
 * @param {object} [opts]  { before: élément devant lequel insérer (sinon juste après le champ),
 *                           onText(text), onError(err), className }
 */
export function mountMicButton(target, opts = {}) {
  if (!target || !navigator.mediaDevices?.getUserMedia) return null;
  const doc = target.ownerDocument || document;
  ensureStyle(doc);
  const T = L[lang()];
  const btn = doc.createElement("button");
  btn.type = "button";
  btn.className = "lumen-mic" + (opts.className ? " " + opts.className : "");
  btn.title = T.idle;
  btn.setAttribute("aria-label", T.idle);
  btn.innerHTML = MIC_SVG;
  if (opts.before?.parentNode) opts.before.parentNode.insertBefore(btn, opts.before);
  else target.parentNode?.insertBefore(btn, target.nextSibling);

  let abort = null;
  const setState = (state) => {
    btn.classList.remove("loading", "recording", "transcribing");
    if (state !== "idle") btn.classList.add(state);
    btn.innerHTML = state === "recording" ? STOP_SVG : MIC_SVG;
    btn.title = T[state] || T.idle;
  };

  btn.addEventListener("click", async (e) => {
    e.preventDefault(); e.stopPropagation();
    if (abort) { abort.abort(); return; } // clic pendant l'écoute : on arrête et on transcrit
    if (btn.classList.contains("loading") || btn.classList.contains("transcribing")) return;
    abort = new AbortController();
    try {
      const text = await whisperDictate({
        signal: abort.signal,
        onState: setState,
        onProgress: (_file, pct) => { btn.title = `${T.loading} ${pct}%`; },
        onLevel: (lvl) => btn.style.setProperty("--lvl", String(lvl)),
      });
      if (text) { appendText(target, text); opts.onText?.(text); }
      else btn.title = T.nothing;
    } catch (err) {
      btn.title = T.failed + String(err?.message || err);
      opts.onError?.(err);
    } finally {
      abort = null;
      btn.classList.remove("loading", "recording", "transcribing");
      btn.innerHTML = MIC_SVG;
      btn.style.removeProperty("--lvl");
      setTimeout(() => { if (!abort) btn.title = T.idle; }, 4000);
    }
  });
  return btn;
}
