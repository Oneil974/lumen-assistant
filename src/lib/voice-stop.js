// Arrêt de TOUTE énonciation en cours, depuis n'importe quelle fenêtre.
//
// Lumen parle par quatre chemins qui s'ignorent l'un l'autre : le lecteur audio
// du backend (Piper/Kokoro, `tts_speak` → processus système), la voix macOS
// (`say`), le raccourci Apple, et la Web Speech API utilisée par les apps
// (Podcast, AIPet, Aventure, consultation, compagnon). Couper « la voix »
// devait donc couper les quatre — et pas seulement dans la fenêtre où l'on
// clique : la barre parle pendant que le bureau affiche autre chose.
//
// D'où deux mécanismes :
//   1. les commandes backend, qui valent pour tout le processus ;
//   2. un ping `localStorage` (clé LOCK), qui réveille l'évènement `storage`
//      dans TOUTES les autres fenêtres de même origine — celles-ci coupent
//      alors leur propre Web Speech.
//
// Le geste qui l'invoque : un double-clic sur l'avatar (cf. orb.js).

const KEY = "lumenVoiceStopAt";

function invoker() {
  try {
    return (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke || null;
  } catch { return null; }
}

/** Coupe la Web Speech de CETTE fenêtre et de ses iframes de même origine. */
function cancelWebSpeech(win = window, depth = 0) {
  try { win.speechSynthesis?.cancel(); } catch { /* API absente */ }
  if (depth > 3) return;
  let frames = [];
  try { frames = Array.from(win.frames || []); } catch { return; }
  for (const f of frames) {
    // Une iframe d'app packagée est sur une autre origine : l'accès jette, et
    // c'est le ping localStorage qui la touchera (elle partage la clé si elle
    // partage l'origine, sinon elle n'a pas de voix à couper).
    try { void f.document; } catch { continue; }
    cancelWebSpeech(f, depth + 1);
  }
}

/**
 * Arrête toute énonciation en cours, partout.
 * @param {{ broadcast?: boolean }} opts `broadcast: false` pour ne couper que
 *   cette fenêtre (utilisé par le récepteur, pour ne pas boucler).
 */
export function stopAllSpeech({ broadcast = true } = {}) {
  cancelWebSpeech();
  const invoke = invoker();
  if (invoke) {
    // `stop_speaking` couvre la voix système et le raccourci Apple ;
    // `tts_stop` le lecteur Piper/Kokoro. Les deux sont idempotentes.
    invoke("stop_speaking").catch(() => {});
    invoke("tts_stop").catch(() => {});
  }
  // Les fenêtres qui pilotent elles-mêmes un <audio> (Podcast, Studio musical)
  // écoutent cet évènement plutôt que d'exposer une fonction.
  try { window.dispatchEvent(new CustomEvent("lumen-voice-stop")); } catch {}
  if (broadcast) {
    try { localStorage.setItem(KEY, String(Date.now())); } catch { /* stockage plein */ }
  }
}

/**
 * Écoute les demandes d'arrêt venues d'une autre fenêtre. Appelée une seule
 * fois par fenêtre, à l'import — un module n'est évalué qu'une fois.
 */
function listen() {
  if (window.__lumenVoiceStopBound) return;
  window.__lumenVoiceStopBound = true;
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) stopAllSpeech({ broadcast: false });
  });
}
listen();
