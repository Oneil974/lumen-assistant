// Voix propre à un agent : ses réponses lues à voix haute prennent SA voix.
//
// Valeur stockée dans `agent.voice` :
//   ""               voix réglée dans Lumen (par défaut)
//   "local:<id>"     voix locale Piper/Kokoro installée (tts_speak)
//   "system:<nom>"   voix du système (say / SAPI, via system_speak)

/** Voix proposées : locales installées + voix du système. */
export async function listVoiceChoices(invoke) {
  const local = await invoke("tts_catalog")
    .then((all) => (all || []).filter((v) => v.installed).map((v) => ({ id: v.id, label: v.label || v.id })))
    .catch(() => []);
  const system = await systemVoices();
  return { local, system };
}

// Les voix Web Speech arrivent en différé sur WebKit/WebView2.
function systemVoices() {
  if (!("speechSynthesis" in window)) return Promise.resolve([]);
  const read = () => {
    const all = speechSynthesis.getVoices() || [];
    const lang = (localStorage.getItem("lang") || "fr").slice(0, 2);
    const mine = all.filter((v) => (v.lang || "").toLowerCase().startsWith(lang));
    return (mine.length ? mine : all).map((v) => ({ name: v.name, lang: v.lang || "" }));
  };
  const now = read();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => resolve(read());
    speechSynthesis.addEventListener?.("voiceschanged", done, { once: true });
    setTimeout(done, 1200);
  });
}

/** Remplit un <select> avec les voix disponibles. */
export async function fillVoiceSelect(select, invoke, current = "", { isEn = false } = {}) {
  const { local, system } = await listVoiceChoices(invoke);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  let html = `<option value="">${isEn ? "Lumen's voice (default)" : "Voix de Lumen (par défaut)"}</option>`;
  if (local.length) {
    html += `<optgroup label="${isEn ? "Local voices" : "Voix locales"}">${local
      .map((v) => `<option value="local:${esc(v.id)}">${esc(v.label)}</option>`).join("")}</optgroup>`;
  }
  if (system.length) {
    html += `<optgroup label="${isEn ? "System voices" : "Voix du système"}">${system
      .map((v) => `<option value="system:${esc(v.name)}">${esc(v.name)}${v.lang ? ` (${esc(v.lang)})` : ""}</option>`).join("")}</optgroup>`;
  }
  select.innerHTML = html;
  // Voix choisie mais plus disponible (désinstallée) : on la garde visible.
  if (current && ![...select.options].some((o) => o.value === current)) {
    select.insertAdjacentHTML("beforeend", `<option value="${esc(current)}">${esc(current.replace(/^\w+:/, ""))} ⚠︎</option>`);
  }
  select.value = current || "";
}

/** Lit `text` avec la voix `voice` (test dans l'atelier). */
export async function speakWithVoice(invoke, voice, text) {
  const lang = (localStorage.getItem("lang") || "fr").toLowerCase().startsWith("en") ? "en" : "fr";
  if (voice.startsWith("local:")) return invoke("tts_speak", { text, voice: voice.slice(6) });
  const name = voice.startsWith("system:") ? voice.slice(7) : null;
  return invoke("system_speak", { text, lang, voice: name });
}

// ----- Voix de la dernière réponse d'agent (barre de chat) -----
// Une délégation @agent_x répond : la lecture automatique qui suit doit
// prendre SA voix. Consommée une fois, et seulement si récente.
let pending = null;
export function noteAgentVoice(voice) {
  pending = voice ? { voice, at: Date.now() } : null;
}
export function takeAgentVoice() {
  const p = pending;
  pending = null;
  return p && Date.now() - p.at < 10 * 60 * 1000 ? p.voice : "";
}
