// Client de génération EN FLUX, commun à toute l'interface (barre, bureau,
// apps, agents…). Il parle à la commande Rust `llm_stream`, qui ouvre la
// requête en `stream: true` quel que soit le backend (llama.cpp, LiteRT, API
// cloud, Lumen Server, Apple FM, Ollama) et relaie des évènements normalisés :
//   { t: "content" | "reasoning", d }   { t: "tool", i, name, args }   { t: "wait" }
// La promesse renvoie la réponse AGRÉGÉE, dans la forme exacte des anciens
// proxys (llama_post_json, llm_api_request, ollama_post_json) : un appelant
// passe au flux sans toucher à son traitement final.
//
// Les modèles qui raisonnent en ligne (`<think>…</think>` dans le texte, cas
// de Qwen/DeepSeek sans extraction côté serveur) sont démêlés ici : le
// raisonnement ne se mêle jamais à la réponse affichée.

const tauri = () => window.__TAURI__ || window.parent?.__TAURI__;

/** Vrai quand le flux est utilisable (dans Lumen, pas dans un aperçu web). */
export function canStream() {
  return !!tauri()?.core?.Channel;
}

let seq = 0;

/**
 * Boucle de génération : les ~50 derniers caractères reviennent au moins 4 fois
 * dans la fin du texte. Une liste légitime (« Source 1 », « Source 2 »…) varie
 * d'une ligne à l'autre et ne déclenche pas. Renvoie la position où couper
 * (après la première occurrence), ou -1.
 */
export function findLoop(text, { tail = 50, times = 4, window = 4000 } = {}) {
  const src = String(text || "");
  if (src.length < tail * times) return -1;
  const end = src.slice(-tail);
  // Trop pauvre en lettres (séparateurs de tableau, espaces) : pas une boucle.
  if ((end.match(/\p{L}/gu) || []).length < 8) return -1;
  const offset = Math.max(0, src.length - window);
  const hay = src.slice(offset);
  let count = 0, first = -1;
  for (let i = hay.indexOf(end); i >= 0; i = hay.indexOf(end, i + 1)) {
    if (first < 0) first = i;
    if (++count >= times) return offset + first + tail;
  }
  return -1;
}

/** Coupe le texte agrégé d'une réponse (forme OpenAI ou Ollama). */
function trimAggregated(data, at) {
  const msg = data?.choices?.[0]?.message || data?.message;
  if (msg && typeof msg.content === "string" && at > 0 && at < msg.content.length) {
    msg.content = msg.content.slice(0, at).trimEnd();
  }
}

/**
 * Lance une génération en flux.
 * @param {{target:"llama"|"litert"|"api"|"ollama", payload:object, url?:string, backend?:string}} req
 * @param {{onEvent?:(ev:object)=>void, onUpdate?:(state:StreamState)=>void, signal?:AbortSignal}} [hooks]
 * @returns {Promise<object>} réponse agrégée
 */
export async function streamInvoke(req, hooks = {}) {
  const core = tauri()?.core;
  if (!core?.Channel) throw new Error("Flux indisponible");
  const id = `s${Date.now().toString(36)}-${++seq}`;
  const state = new StreamState();
  const channel = new core.Channel();
  // Détection de boucle (modèle qui se répète) : vérifiée tous les ~200
  // caractères, elle coupe le flux ; l'appelant peut relancer plus pénalisé.
  let looped = null, checkedAt = 0;
  channel.onmessage = (ev) => {
    state.push(ev);
    const size = state.rawContent.length + state.serverReasoning.length;
    if (!looped && size - checkedAt >= 200) {
      checkedAt = size;
      const inContent = findLoop(state.rawContent);
      if (inContent >= 0 || findLoop(state.serverReasoning) >= 0) {
        looped = { at: inContent };
        core.invoke("llm_stream_cancel", { id }).catch(() => {});
      }
    }
    try { hooks.onEvent?.(ev); } catch (e) { console.error(e); }
    try { hooks.onUpdate?.(state); } catch (e) { console.error(e); }
  };
  const onAbort = () => core.invoke("llm_stream_cancel", { id }).catch(() => {});
  if (hooks.signal) {
    if (hooks.signal.aborted) onAbort();
    else hooks.signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const data = await core.invoke("llm_stream", {
      id,
      target: req.target,
      payload: req.payload,
      url: req.url ?? null,
      backend: req.backend ?? null,
      onEvent: channel,
    });
    if (looped && data && typeof data === "object") {
      data.looped = true;
      trimAggregated(data, looped.at);
    }
    return data;
  } finally {
    hooks.signal?.removeEventListener?.("abort", onAbort);
  }
}

/**
 * Sépare `<think>…</think>` du texte. Une balise ouverte non refermée (flux en
 * cours) range tout ce qui suit dans le raisonnement.
 */
export function splitThink(text) {
  const src = String(text || "");
  if (!/<think>|<\/think>/i.test(src)) return { reasoning: "", answer: src };
  let reasoning = "";
  let answer = "";
  let rest = src;
  // Certains templates ouvrent le bloc dans le prompt : le texte commence
  // directement par le raisonnement et seule la fermeture apparaît.
  const firstOpen = rest.search(/<think>/i);
  const firstClose = rest.search(/<\/think>/i);
  if (firstClose >= 0 && (firstOpen < 0 || firstClose < firstOpen)) {
    reasoning += rest.slice(0, firstClose);
    rest = rest.slice(firstClose + 8);
  }
  for (;;) {
    const open = rest.search(/<think>/i);
    if (open < 0) { answer += rest; break; }
    answer += rest.slice(0, open);
    rest = rest.slice(open + 7);
    const close = rest.search(/<\/think>/i);
    if (close < 0) { reasoning += rest; break; }
    reasoning += rest.slice(0, close);
    rest = rest.slice(close + 8);
  }
  return { reasoning: reasoning.trim(), answer: answer.replace(/^\s+/, "") };
}

/** État cumulé d'un flux : texte, raisonnement, appels d'outils. */
export class StreamState {
  constructor() {
    this.rawContent = "";
    this.serverReasoning = "";
    this.tools = [];
    this.waiting = false;
    this.startedAt = performance.now();
    this.reasoningStart = 0;
    this.reasoningEnd = 0;
  }
  push(ev) {
    if (!ev || typeof ev !== "object") return;
    if (ev.t === "wait") { this.waiting = true; return; }
    this.waiting = false;
    if (ev.t === "reasoning") {
      if (!this.reasoningStart) this.reasoningStart = performance.now();
      this.serverReasoning += ev.d || "";
    } else if (ev.t === "content") {
      this.rawContent += ev.d || "";
      if (!this.reasoningStart && /<think>/i.test(this.rawContent)) this.reasoningStart = performance.now();
    } else if (ev.t === "tool") {
      this.tools[ev.i || 0] = { name: ev.name || "", args: ev.args || "" };
    }
    // Fin du raisonnement = premier texte de réponse ou premier appel d'outil.
    if (this.reasoningStart && !this.reasoningEnd && (this.answer || this.tools.length)) {
      this.reasoningEnd = performance.now();
    }
  }
  get split() { return splitThink(this.rawContent); }
  get answer() { return this.split.answer; }
  get reasoning() {
    const inline = this.split.reasoning;
    return [this.serverReasoning, inline].filter(Boolean).join("\n\n");
  }
  /** Le modèle raisonne encore (rien d'autre n'est sorti). */
  get thinking() {
    const s = this.split;
    const inlineOpen = /<think>/i.test(this.rawContent) && !/<\/think>/i.test(this.rawContent);
    return (!!this.serverReasoning || inlineOpen) && !s.answer && !this.tools.length;
  }
  get reasoningSeconds() {
    if (!this.reasoningStart) return 0;
    return Math.max(1, Math.round(((this.reasoningEnd || performance.now()) - this.reasoningStart) / 1000));
  }
}

/** Retire un éventuel `<think>` d'une réponse agrégée (repli non-stream). */
export function stripThink(text) {
  return splitThink(text).answer;
}
