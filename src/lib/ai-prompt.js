// Boîte de prompt IA partagée par les applications de Lumen.
//
// Une seule et même boîte partout (fil de conversation, suggestions, champ de
// saisie), mais des OUTILS différents par app : chaque application déclare ce
// que l'IA peut faire chez elle (`tools` + `execute`), et l'utilisateur
// formule sa demande en langage naturel. La boucle agentique ci-dessous est
// celle de la barre (cf. sandbox/desktop.js) : `tool_calls` au format
// OpenAI/Ollama, compatible Ollama, llama.cpp, LiteRT et API cloud.
//
// Usage minimal :
//   const ai = mountAiPrompt(hostEl, {
//     app: "Notes",
//     placeholder: "Range mes notes, résume, crée…",
//     suggestions: [{ label: "Ranger", prompt: "Classe mes notes par thème." }],
//     tools: [tool("create_note", "Crée une note", { title: { type: "string" } }, ["title"])],
//     execute: async (name, args) => "…",   // renvoie une chaîne lue par le modèle
//     context: () => "état courant de l'app",
//     onApplied: () => render(),
//   });

import { llmChat, llmBackend } from "../llm.js";
import { recordOllamaUsage } from "../ollama-usage.js";
import { mountMicButton } from "./mic-button.js";
import { markdownToHtml, looksLikeMarkdown } from "./markdown.js";
import { createStreamView } from "./stream-view.js";
import { stripThink } from "./llm-stream.js";

/** Raccourci de déclaration d'outil au format OpenAI. */
export function tool(name, description, properties = {}, required = []) {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

/** Types de paramètres courants, pour éviter de les réécrire dans chaque app. */
export const T = {
  str: (description) => ({ type: "string", description }),
  int: (description) => ({ type: "integer", description }),
  num: (description) => ({ type: "number", description }),
  bool: (description) => ({ type: "boolean", description }),
  list: (description, items = { type: "string" }) => ({ type: "array", description, items }),
  enum: (values, description) => ({ type: "string", enum: values, description }),
};

const SPARK_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.7 4.6L18 9.3l-4.3 1.7L12 15.6l-1.7-4.6L6 9.3l4.3-1.7z"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/></svg>';
const SEND_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>';

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function baseSystemPrompt(opts, contextText) {
  const now = new Date();
  return `Tu es l'assistant intégré de l'application « ${opts.app} » de Lumen. ${opts.intro || ""}
Nous sommes le ${now.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })} à ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}.
Règles :
- Tu agis UNIQUEMENT par les outils fournis : n'annonce jamais une action sans l'avoir réellement appelée.
- Inspecte l'existant (outils de lecture) avant de modifier ou supprimer ; n'invente jamais un identifiant.
- Enchaîne plusieurs outils si la demande l'exige, puis termine par un résumé court en français de ce que tu as fait.
- Si la demande est ambiguë ou hors de portée des outils, dis-le en une phrase et propose la formulation attendue.
${opts.rules ? opts.rules + "\n" : ""}
État courant de l'application :
${contextText || "(vide)"}`;
}

/**
 * Exécute une demande en langage naturel sur les outils d'une app.
 * `onStep({ kind, name, message })` reçoit la progression.
 * Renvoie le texte final du modèle.
 */
// `view` (facultatif, createStreamView) : réponse EN FLUX, raisonnement et
// appels d'outils en blocs repliables.
export async function runAiTools(opts, prompt, onStep, history = [], view = null) {
  const ctx = typeof opts.context === "function" ? await opts.context() : (opts.context || "");
  const tools = typeof opts.tools === "function" ? await opts.tools() : opts.tools;
  const convo = [
    { role: "system", content: baseSystemPrompt(opts, ctx) },
    ...history,
    { role: "user", content: prompt },
  ];
  const b = llmBackend();
  const maxTurns = opts.maxTurns || 8;
  let finalText = "";
  let acted = false;
  for (let turn = 0; turn < maxTurns; turn++) {
    if (turn > 0) view?.nextTurn();
    const { data } = await llmChat(convo, { backend: b, tools, rawSystem: true, ...(view ? { onUpdate: (st) => view.update(st) } : {}) });
    // Le volet d'assistant est un consommateur de jetons comme un autre : sans
    // cet enregistrement, ses tours n'apparaissaient ni dans le compteur du
    // jour, ni dans le Profiler, ni dans le Journal LLM.
    recordOllamaUsage(data, `assistant:${String(opts.app || "app").toLowerCase().replace(/\s+/g, "-")}`);
    // llama.cpp / LiteRT / API cloud parlent le format OpenAI ; Ollama natif a
    // sa propre enveloppe.
    const msg = (b.api || b.llama || b.litert) ? (data?.choices?.[0]?.message || {}) : (data?.message || {});
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (!calls.length) { finalText = stripThink(msg.content || ""); break; }
    convo.push({ role: "assistant", content: stripThink(msg.content || ""), tool_calls: calls });
    for (const [ci, call] of calls.entries()) {
      const name = call.function?.name;
      let args = call.function?.arguments;
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
      let result;
      try { result = await opts.execute(name, args || {}); }
      catch (e) { result = "Erreur : " + (e?.message || e); }
      result = String(result ?? "");
      acted = true;
      const reply = { role: "tool", content: result, name };
      if (call.id) reply.tool_call_id = call.id;
      convo.push(reply);
      view?.toolResult(ci, name, args || {}, result);
      onStep?.({ kind: "tool", name, args, result, message: `${name} → ${result.split("\n")[0].slice(0, 120)}` });
    }
    await opts.onApplied?.();
  }
  if (acted) await opts.onApplied?.();
  return finalText || (acted ? "C'est fait." : "(aucune réponse du modèle)");
}

/**
 * Monte le volet d'assistant. Il est TOUJOURS posé au même endroit — un tiroir
 * ancré au bord droit de la fenêtre — quelle que soit l'app : l'utilisateur
 * n'a pas à le chercher. Le premier paramètre est conservé pour compatibilité
 * mais n'est plus utilisé pour le placement.
 *
 * Renvoie { el, ask, focus, clear, open, close, toggle, busy }.
 */
export function mountAiPrompt(_host, opts) {
  // Le volet démarre TOUJOURS replié : une app doit s'ouvrir sur son contenu,
  // pas sur un panneau de conversation qui mange le tiers de la fenêtre. Sa
  // présence est signalée autrement, par un bref scintillement de la poignée
  // quelques secondes après l'ouverture (voir plus bas) — d'où l'abandon de
  // l'état mémorisé par app, qui rouvrait le volet à chaque lancement.

  const el = document.createElement("aside");
  el.className = "lumen-ai-dock" + (opts.className ? " " + opts.className : "");
  el.innerHTML = `
    <button class="lumen-ai-handle" type="button" aria-expanded="false">
      <span class="lumen-ai-handle-ic">${SPARK_SVG}</span>
      <span class="lumen-ai-handle-label">${esc(opts.title || "Assistant")}</span>
    </button>
    <section class="lumen-ai" role="complementary" aria-label="${esc(opts.title || "Assistant")}">
      <div class="lumen-ai-head">
        <span class="lumen-ai-dot"></span>
        <span class="lumen-ai-name">${esc(opts.title || "Assistant")}</span>
        <span class="lumen-ai-app">${esc(opts.app || "")}</span>
        <span class="lumen-ai-sp"></span>
        <button class="lumen-ai-clear" type="button" title="Effacer la conversation" aria-label="Effacer la conversation">⟲</button>
        <button class="lumen-ai-close" type="button" title="Replier le volet (Échap)" aria-label="Replier le volet">›</button>
      </div>
      <div class="lumen-ai-log" role="log"></div>
      <div class="lumen-ai-sugg"></div>
      <div class="lumen-ai-box">
        <textarea class="lumen-ai-input" rows="2" placeholder="${esc(opts.placeholder || "Demande ce que tu veux…")}"></textarea>
        <button class="lumen-ai-send" type="button" title="Envoyer (Entrée)">${SEND_SVG}</button>
      </div>
    </section>`;
  document.body.appendChild(el);

  const log = el.querySelector(".lumen-ai-log");
  const input = el.querySelector(".lumen-ai-input");
  const send = el.querySelector(".lumen-ai-send");
  const sugg = el.querySelector(".lumen-ai-sugg");
  // Dictée Whisper : le micro s'arrête seul après 2 s de silence.
  mountMicButton(input, { before: send });
  const handle = el.querySelector(".lumen-ai-handle");

  for (const s of opts.suggestions || []) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = s.label;
    b.title = s.prompt;
    b.addEventListener("click", () => { open(); ask(s.prompt); });
    sugg.appendChild(b);
  }
  if (!(opts.suggestions || []).length) sugg.remove();

  let history = [];
  let busy = false;

  function setOpen(on) {
    el.classList.toggle("open", on);
    handle.setAttribute("aria-expanded", on ? "true" : "false");
    // Le scintillement n'a plus lieu d'être dès que l'utilisateur a touché au
    // volet : il sait qu'il est là.
    if (on) {
      handle.classList.remove("hint");
      clearTimeout(hintTimer);
    }
    if (on) setTimeout(() => input.focus(), 120);
  }
  let hintTimer = null;
  const open = () => setOpen(true);
  const close = () => setOpen(false);
  const toggle = () => setOpen(!el.classList.contains("open"));

  // Les réponses du modèle sont rendues en Markdown (titres, listes, code,
  // tableaux…) : un modèle écrit spontanément en Markdown, et l'afficher brut
  // laissait les `**` et les `#` au milieu du texte. Les messages de
  // l'utilisateur et les étapes restent en texte brut — ils viennent de lui.
  function bubble(role, text) {
    const d = document.createElement("div");
    d.className = "lumen-ai-msg lumen-ai-" + role;
    if (role === "bot" && looksLikeMarkdown(text)) {
      d.classList.add("lumen-ai-md");
      d.innerHTML = markdownToHtml(text);
    } else {
      d.textContent = text;
    }
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }

  async function ask(prompt) {
    const q = String(prompt || "").trim();
    if (!q || busy) return;
    open();
    busy = true;
    input.value = "";
    send.disabled = true;
    el.classList.add("busy");
    bubble("user", q);
    const pending = bubble("step", "…");
    // Bulle de réponse posée d'emblée : blocs repliables + texte en flux.
    const live = document.createElement("div");
    live.className = "lumen-ai-msg lumen-ai-bot lumen-ai-md";
    const liveAnswer = document.createElement("div");
    live.appendChild(liveAnswer);
    let view = null;
    try {
      view = createStreamView({ answerEl: liveAnswer, render: markdownToHtml, onRender: () => {
        if (!live.isConnected) { pending.remove(); log.appendChild(live); }
        log.scrollTop = log.scrollHeight;
      } });
      const answer = await runAiTools(opts, q, (step) => { pending.textContent = "⚙ " + step.message; }, history.slice(-6), view);
      view.finish();
      pending.remove();
      if (!live.isConnected) log.appendChild(live);
      liveAnswer.innerHTML = markdownToHtml(answer);
      log.scrollTop = log.scrollHeight;
      history.push({ role: "user", content: q }, { role: "assistant", content: answer });
    } catch (e) {
      pending.remove();
      view?.finish();
      bubble("err", "Échec : " + (e?.message || e));
    } finally {
      busy = false;
      send.disabled = false;
      el.classList.remove("busy");
      input.focus();
    }
  }

  handle.addEventListener("click", toggle);
  el.querySelector(".lumen-ai-close").addEventListener("click", close);
  send.addEventListener("click", () => ask(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(input.value); }
    if (e.key === "Escape") { e.stopPropagation(); close(); }
  });
  el.querySelector(".lumen-ai-clear").addEventListener("click", () => { history = []; log.innerHTML = ""; });
  // Raccourci commun à toutes les apps : ⌘/Ctrl + J ouvre ou referme le volet.
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === "j" || e.key === "J")) { e.preventDefault(); toggle(); }
  });

  setOpen(false);

  // Signalement discret : la poignée scintille à la couleur d'accent quelques
  // secondes après l'ouverture de l'app, le temps que l'utilisateur ait les
  // yeux sur la fenêtre — puis s'éteint d'elle-même. L'animation elle-même est
  // dans lib/ai-prompt.css, et se désactive en « mouvement réduit ».
  hintTimer = setTimeout(() => {
    if (el.classList.contains("open")) return;
    handle.classList.add("hint");
    hintTimer = setTimeout(() => handle.classList.remove("hint"), 4200);
  }, 1800);

  return { el, ask, focus: () => input.focus(), clear: () => { history = []; log.innerHTML = ""; }, open, close, toggle, get busy() { return busy; } };
}
