// Adaptateur voix « navigateur » du mode vocal de la messagerie : Web Speech
// API (sur iPhone, Safari s'appuie sur la dictée et les voix d'iOS). Sans
// dépendance : servi tel quel au compagnon web (liste blanche companion.rs).
// Contrat : voir lib/voice-adapters.js.

export function langTag(lang) {
  return String(lang || "fr").toLowerCase().startsWith("en") ? "en-US" : "fr-FR";
}

/** Synthèse du navigateur, promesse résolue en fin de lecture. */
export function browserSpeak(text, { signal, lang, voice } = {}) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window) || !text) return resolve();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = typeof voice === "function" ? voice() : voice;
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = langTag(lang);
    const done = () => { signal?.removeEventListener("abort", onAbort); resolve(); };
    const onAbort = () => { speechSynthesis.cancel(); done(); };
    u.onend = done;
    u.onerror = done;
    signal?.addEventListener("abort", onAbort, { once: true });
    speechSynthesis.speak(u);
    // Garde-fou : certains WebKit ne déclenchent jamais `onend`.
    const max = 4000 + text.length * 120;
    setTimeout(() => { if (!speechSynthesis.speaking) done(); }, max);
  });
}

/** Joue un WAV (Blob) ; résolu en fin de lecture ou à l'annulation. */
// Lecteur partagé : Safari iOS n'autorise la lecture qu'à un élément déjà
// « débloqué » par un geste (cf. unlockPlayer, appelé au démarrage du mode).
let player = null;
const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";
function unlockPlayer() {
  try {
    player = player || new Audio();
    player.src = SILENT_WAV;
    player.play().catch(() => {});
  } catch {}
}
function playBlob(blob, signal) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const a = player || new Audio();
    a.src = url;
    const done = () => { signal?.removeEventListener("abort", onAbort); URL.revokeObjectURL(url); resolve(); };
    const onAbort = () => { a.pause(); done(); };
    a.onended = done;
    a.onerror = done;
    signal?.addEventListener("abort", onAbort, { once: true });
    a.play().catch(done);
  });
}

/**
 * Navigateur (compagnon web) : Web Speech API. `voice` = SpeechSynthesisVoice
 * ou fonction. `remoteSynth(text, agentVoice)` (facultatif) → Blob WAV
 * synthétisé par l'ordinateur avec la voix Piper/Kokoro de l'agent, ou null.
 */
export function webSpeechVoice({ lang = "fr", voice = null, remoteSynth = null } = {}) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recog = null;
  return {
    async prepare() {
      if (!SR) throw new Error(lang.startsWith("en") ? "Speech recognition is not available in this browser." : "Reconnaissance vocale indisponible dans ce navigateur.");
      // Débloque la synthèse et le lecteur (iOS exige un geste : c'en est un).
      unlockPlayer();
      if ("speechSynthesis" in window) {
        const u = new SpeechSynthesisUtterance(" ");
        u.volume = 0;
        speechSynthesis.speak(u);
      }
    },
    listen({ signal, onLevel, onPartial } = {}) {
      return new Promise((resolve, reject) => {
        let finalText = "", interim = "", settled = false;
        const r = recog = new SR();
        r.lang = langTag(lang);
        r.interimResults = true;
        r.continuous = false;
        r.onresult = (e) => {
          finalText = ""; interim = "";
          for (let i = 0; i < e.results.length; i++) {
            if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
            else interim += e.results[i][0].transcript;
          }
          onPartial?.((finalText + interim).trim());
          onLevel?.(0.7);
          setTimeout(() => onLevel?.(0.15), 180);
        };
        const end = () => {
          if (settled) return;
          settled = true;
          recog = null;
          signal?.removeEventListener("abort", onAbort);
          resolve((finalText || interim).trim());
        };
        const onAbort = () => { try { r.stop(); } catch { end(); } };
        r.onend = end;
        r.onerror = (e) => {
          if (e.error === "no-speech" || e.error === "aborted") return end();
          if (settled) return;
          settled = true;
          recog = null;
          reject(new Error(e.error === "not-allowed" ? (lang.startsWith("en") ? "Microphone access denied." : "Accès au micro refusé.") : e.error));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        try { r.start(); } catch (err) { settled = true; reject(err); }
      });
    },
    // Voix de l'agent : une voix « system:<nom> » est reprise si l'appareil
    // la possède (même nom) ; une voix Piper locale n'existe que sur
    // l'ordinateur → voix du compagnon.
    speak: async (text, { signal, voice: agentVoice = "" } = {}) => {
      // Voix locale de l'agent (Piper/Kokoro) : seul l'ordinateur sait la
      // produire — on lui demande le WAV, la voix du téléphone en repli.
      if (remoteSynth && agentVoice.startsWith("local:")) {
        const blob = await remoteSynth(text, agentVoice).catch(() => null);
        if (signal?.aborted) return;
        if (blob) return playBlob(blob, signal);
      }
      let v = voice;
      if (agentVoice.startsWith("system:") && "speechSynthesis" in window) {
        const name = agentVoice.slice(7).toLowerCase();
        const hit = speechSynthesis.getVoices().find((x) => x.name.toLowerCase() === name || x.name.toLowerCase().startsWith(name + " "));
        if (hit) v = hit;
      }
      return browserSpeak(text, { signal, lang, voice: v });
    },
    stop() {
      try { recog?.abort(); } catch {}
      if ("speechSynthesis" in window) speechSynthesis.cancel();
    },
  };
}
