// Adaptateurs voix du « mode vocal » de la messagerie (lib/messenger-ui.js).
//
// Contrat : { prepare?(onPct), listen({signal,onLevel,onPartial}) → texte,
//             speak(texte,{signal}) → Promise (résolue à la fin de la lecture),
//             stop() }
//
//  - desktopVoice : ordinateur (Mac/PC/Linux) — Whisper local
//    (lib/whisper-dictation.js) pour écouter, Piper/Kokoro (`tts_speak`) pour
//    parler, repli sur la synthèse du système si aucune voix n'est installée ;
//  - webSpeechVoice : compagnon web — reconnaissance et synthèse du navigateur
//    (sur iPhone, Safari s'appuie sur la dictée et les voix d'iOS).
// L'app iOS native a son propre mode vocal (SFSpeechRecognizer + AVSpeech).

import { whisperLoad, whisperDictate, watchBargeIn, speechChunks } from "./whisper-dictation.js";
import { browserSpeak } from "./voice-web.js";
export { webSpeechVoice } from "./voice-web.js";

const SILENCE_MS = 1100;   // fin de tour : plus réactif que la dictée (2 s)


/**
 * Ordinateur : Whisper + voix Piper/Kokoro de Lumen.
 * `invoke` / `listen` : API Tauri (core.invoke, event.listen).
 */
export function desktopVoice({ invoke, listen, lang = "fr" }) {
  let usePiper = true;
  return {
    async prepare(onPct) {
      await whisperLoad((_file, pct) => onPct?.(pct));
    },
    async listen({ signal, onLevel, onPartial } = {}) {
      return whisperDictate({ seconds: 60, silenceMs: SILENCE_MS, signal, onLevel: (lvl) => onLevel?.(lvl), onPartial });
    },
    // Interruption à la voix (« barge-in ») : cf. messenger-ui.
    watchBargeIn,
    /// Lecture phrase par phrase : la première est dite pendant que Piper
    /// prépare les suivantes, au lieu d'attendre la synthèse de tout le texte.
    async speak(text, opts = {}) {
      const parts = speechChunks(text);
      if (parts.length <= 1) return this.speakOne(text, opts);
      for (const p of parts) {
        if (opts.signal?.aborted) return;
        await this.speakOne(p, opts);
      }
    },
    async speakOne(text, { signal, voice = "" } = {}) {
      if (signal?.aborted) return;
      // Voix système choisie pour l'agent (say / SAPI / spd-say) : la commande
      // rend la main en fin de lecture.
      if (voice.startsWith("system:")) {
        const onAbort = () => invoke("stop_speaking").catch(() => {});
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          await invoke("system_speak", { text, lang, voice: voice.slice(7) });
          return;
        } catch (e) {
          console.info("[voice] voix système de l'agent indisponible :", e?.message || e);
        } finally {
          signal?.removeEventListener("abort", onAbort);
        }
      }
      const localVoice = voice.startsWith("local:") ? voice.slice(6) : null;
      if (usePiper || localVoice) {
        let unEnd = null, unErr = null;
        try {
          const ended = new Promise((resolve, reject) => {
            listen("tts-ended", () => resolve()).then((u) => { unEnd = u; });
            listen("tts-error", (e) => reject(new Error(String(e?.payload || "tts")))).then((u) => { unErr = u; });
            signal?.addEventListener("abort", () => { invoke("tts_stop").catch(() => {}); resolve(); }, { once: true });
          });
          await invoke("tts_speak", { text, voice: localVoice });
          await ended;
          return;
        } catch (e) {
          // Aucune voix Piper/Kokoro installée : la voix du système fera l'affaire.
          console.info("[voice] synthèse Lumen indisponible, voix du système :", e?.message || e);
          if (!localVoice) usePiper = false;
        } finally {
          unEnd?.(); unErr?.();
        }
      }
      await browserSpeak(text, { signal, lang });
    },
    stop() {
      invoke("stop_speaking").catch(() => {});   // voix système ET Piper/Kokoro
      if ("speechSynthesis" in window) speechSynthesis.cancel();
    },
  };
}

