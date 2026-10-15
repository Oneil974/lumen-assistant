// Feuille IA flottante — la réponse de Lumen là où la question est née.
//
// Jusqu'ici, tout geste contextuel (« Comprendre cet écran », « Demander à
// Lumen » depuis un texte sélectionné…) partait dans la fenêtre Assistant, une
// conversation complète qui prend la place et fait perdre de vue ce qu'on
// regardait. Cette feuille fait l'inverse : une petite carte, posée près de la
// zone interrogée, avec la question, la réponse, et un champ pour continuer.
// Quand l'échange mérite plus de place, « Agrandir » le verse dans la vraie
// fenêtre Assistant, avec tout l'historique.
//
// Le module ne sait rien du bureau : il reçoit une fonction `send` (par défaut
// llmChat) et un `onExpand` optionnel. Une seule feuille à la fois — en ouvrir
// une remplace la précédente.
//
// Usage :
//   openAiSheet({
//     anchor: { x, y, w, h },            // coordonnées fenêtre du haut ; null = centré
//     title: "Comprendre cet écran",
//     question: "Que montre cette capture ?",
//     images: [{ dataUrl, b64 }],
//     context: "texte sélectionné",       // envoyé au modèle, montré en citation
//     actions: [{ label, icon, run(sheet) }],
//     onExpand: (messages) => …,
//   });

import { llmChat } from "../llm.js";
import { createStreamView } from "./stream-view.js";
import { renderMarkdown, escapeHtml } from "../sandbox/render.js";
import { defaultOrbColors } from "./orb-palette.js";
import { icon } from "./icons.js?v=2";
import { mountMicButton } from "./mic-button.js";

let current = null;
let styleReady = false;

function ensureStyle(doc) {
  if (styleReady && doc.getElementById("lumen-sheet-css")) return;
  const link = doc.createElement("link");
  link.id = "lumen-sheet-css";
  link.rel = "stylesheet";
  link.href = new URL("./ai-sheet.css?v=2", import.meta.url).href;
  doc.head.appendChild(link);
  styleReady = true;
}

function orbColors() {
  try {
    const c = JSON.parse(localStorage.getItem("orbColors") || "null");
    if (Array.isArray(c) && c.length >= 4) return c;
  } catch {}
  return defaultOrbColors();
}

const L = {
  fr: { ask: "Demander à Lumen…", expand: "Ouvrir dans l'Assistant", close: "Fermer", copy: "Copier", copied: "Copié", thinking: "Lumen réfléchit…", empty: "(réponse vide)", ctx: "Contexte" },
  en: { ask: "Ask Lumen…", expand: "Open in Assistant", close: "Close", copy: "Copy", copied: "Copied", thinking: "Lumen is thinking…", empty: "(empty answer)", ctx: "Context" },
};

export function sheetLang() {
  return (localStorage.getItem("lang") || "fr").toLowerCase().startsWith("en") ? "en" : "fr";
}

/** Position : à côté de l'ancre si possible, sinon au centre. Toujours dans l'écran. */
function place(el, anchor, win) {
  const W = win.innerWidth, H = win.innerHeight;
  const w = el.offsetWidth || 460, h = el.offsetHeight || 320;
  let x, y;
  if (anchor && Number.isFinite(anchor.x)) {
    const aw = anchor.w || 0, ah = anchor.h || 0;
    // Sous l'ancre, aligné à gauche ; au-dessus s'il n'y a plus de place.
    x = anchor.x;
    y = anchor.y + ah + 10;
    if (y + h > H - 12) y = anchor.y - h - 10;
    if (y < 12) y = Math.max(12, Math.min(H - h - 12, anchor.y));
    if (x + w > W - 12) x = W - w - 12;
  } else {
    x = (W - w) / 2;
    y = Math.max(40, (H - h) / 2 - 40);
  }
  el.style.left = `${Math.max(12, Math.round(x))}px`;
  el.style.top = `${Math.max(12, Math.round(y))}px`;
}

export function closeAiSheet() {
  if (!current) return;
  const c = current;
  current = null;
  c.el.classList.add("out");
  c.dispose();
  setTimeout(() => c.el.remove(), 180);
}

export function activeAiSheet() { return current; }

/**
 * Ouvre la feuille et, si `question` est donnée, envoie tout de suite.
 * Renvoie un contrôleur { el, ask(text), close(), messages }.
 */
export function openAiSheet(opts = {}) {
  const win = opts.win || window;
  const doc = win.document;
  ensureStyle(doc);
  closeAiSheet();
  const lang = opts.lang || sheetLang();
  const T = L[lang] || L.fr;
  const send = opts.send || (async (messages, o) => {
    // `display` n'est que pour l'affichage : on ne l'envoie pas au backend.
    const out = await llmChat(messages.map(({ display: _d, ...m }) => m), o || {});
    return typeof out === "string" ? out : out?.content ?? String(out ?? "");
  });

  const messages = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });

  const el = doc.createElement("section");
  el.className = "lumen-sheet";
  el.setAttribute("role", "dialog");
  const cols = orbColors();
  cols.slice(0, 4).forEach((c, i) => el.style.setProperty(`--sheet-c${i + 1}`, c));
  el.innerHTML = `
    <header class="lumen-sheet-head">
      <span class="lumen-sheet-orb"></span>
      <div class="lumen-sheet-title">${escapeHtml(opts.title || "Lumen")}${opts.subtitle ? `<small>${escapeHtml(opts.subtitle)}</small>` : ""}</div>
      ${opts.onExpand ? `<button class="lumen-sheet-ib" data-act="expand" title="${T.expand}">${icon("maximize")}</button>` : ""}
      <button class="lumen-sheet-ib" data-act="close" title="${T.close}">${icon("x")}</button>
    </header>
    <div class="lumen-sheet-body"></div>
    <div class="lumen-sheet-chips" hidden></div>
    <footer class="lumen-sheet-foot">
      <input class="lumen-sheet-input" type="text" placeholder="${escapeHtml(opts.placeholder || T.ask)}" />
      <button class="lumen-sheet-send" title="${lang === "en" ? "Send" : "Envoyer"}">${icon("send-horizontal")}</button>
    </footer>`;
  doc.body.appendChild(el);

  const body = el.querySelector(".lumen-sheet-body");
  const chips = el.querySelector(".lumen-sheet-chips");
  const input = el.querySelector(".lumen-sheet-input");
  const sendBtn = el.querySelector(".lumen-sheet-send");
  mountMicButton(input, { before: sendBtn });
  let busy = false;
  let contextSent = false;

  const scroll = () => { body.scrollTop = body.scrollHeight; };

  function renderChips() {
    const list = (opts.actions || []).filter(Boolean);
    chips.hidden = !list.length;
    chips.innerHTML = "";
    for (const a of list) {
      const b = doc.createElement("button");
      b.className = "lumen-sheet-chip";
      b.innerHTML = `${a.icon ? icon(a.icon) : ""}<span>${escapeHtml(a.label)}</span>`;
      b.addEventListener("click", () => { try { a.run(ctrl); } catch (e) { fail(e); } });
      chips.appendChild(b);
    }
  }

  function fail(e) {
    const d = doc.createElement("div");
    d.className = "lumen-sheet-a err";
    d.textContent = String(e?.message || e || "Erreur");
    body.appendChild(d);
    scroll();
  }

  async function ask(text, images = []) {
    text = String(text || "").trim();
    if (!text || busy) return;
    busy = true;
    el.classList.add("busy");
    sendBtn.disabled = true;
    try { win.LumenOrb?.setState?.("thinking"); } catch {}

    // Le contexte (texte sélectionné, extrait de page…) accompagne la PREMIÈRE
    // question, cité pour l'utilisateur et intégré au message pour le modèle.
    let content = text;
    if (opts.context && !contextSent) {
      contextSent = true;
      const cite = doc.createElement("div");
      cite.className = "lumen-sheet-ctx";
      cite.title = T.ctx;
      cite.textContent = String(opts.context).slice(0, 600);
      body.appendChild(cite);
      content = `${lang === "en" ? "Context:" : "Contexte :"}\n"""\n${opts.context}\n"""\n\n${text}`;
    }
    const q = doc.createElement("div");
    q.className = "lumen-sheet-q";
    q.innerHTML = images.map((im) => `<img src="${im.dataUrl}" alt="" />`).join("") + escapeHtml(text);
    body.appendChild(q);
    const a = doc.createElement("div");
    a.className = "lumen-sheet-a";
    a.innerHTML = `<span class="lumen-sheet-typing" title="${T.thinking}"><i></i><i></i><i></i></span>`;
    body.appendChild(a);
    scroll();

    const userMsg = { role: "user", content, display: text };
    if (images.length) userMsg.images = images.map((im) => im.b64 || im.dataUrl?.split(",")[1]).filter(Boolean);
    messages.push(userMsg);
    try {
      // Réponse EN FLUX : le texte s'écrit au fil de l'eau, le raisonnement
      // reste replié. Un `send` personnalisé peut ignorer `onUpdate`.
      let view = null;
      const onUpdate = (st) => {
        if (!view) {
          a.innerHTML = "";
          const ans = doc.createElement("div");
          a.appendChild(ans);
          view = createStreamView({ answerEl: ans, render: renderMarkdown, onRender: scroll });
        }
        view.update(st);
      };
      const answer = await send(messages, { ...(opts.sendOptions || {}), onUpdate });
      view?.finish();
      const txt = String(answer || "").trim() || T.empty;
      messages.push({ role: "assistant", content: txt });
      const blocks = a.querySelector(":scope > .lm-blocks");
      a.innerHTML = renderMarkdown(txt);
      if (blocks) a.prepend(blocks);
      // Copier la réponse d'un clic : c'est le geste le plus fréquent après lecture.
      const cp = doc.createElement("button");
      cp.className = "lumen-sheet-chip";
      cp.style.marginTop = "6px";
      cp.innerHTML = `${icon("copy")}<span>${T.copy}</span>`;
      cp.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(txt); cp.querySelector("span").textContent = T.copied; } catch {}
      });
      a.appendChild(cp);
      opts.onAnswer?.(txt, ctrl);
    } catch (e) {
      messages.pop();
      a.className = "lumen-sheet-a err";
      a.textContent = String(e?.message || e || "Erreur");
    } finally {
      busy = false;
      el.classList.remove("busy");
      sendBtn.disabled = false;
      try { win.LumenOrb?.setState?.("idle"); } catch {}
      scroll();
    }
  }

  // Des images données sans question (menu image → « Poser une question… »)
  // partent avec la première question tapée.
  let pendingImages = opts.question ? [] : (opts.images || []);
  const submit = () => { const v = input.value; input.value = ""; const im = pendingImages; pendingImages = []; ask(v, im); };
  sendBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
    e.stopPropagation();
  });
  el.querySelector('[data-act="close"]').addEventListener("click", closeAiSheet);
  el.querySelector('[data-act="expand"]')?.addEventListener("click", () => {
    const snapshot = messages.slice();
    closeAiSheet();
    opts.onExpand?.(snapshot);
  });

  // Déplacement par la barre de titre.
  const head = el.querySelector(".lumen-sheet-head");
  head.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    const sx = e.clientX - el.offsetLeft, sy = e.clientY - el.offsetTop;
    const move = (ev) => { el.style.left = `${ev.clientX - sx}px`; el.style.top = `${ev.clientY - sy}px`; };
    const up = () => { doc.removeEventListener("pointermove", move); doc.removeEventListener("pointerup", up); };
    doc.addEventListener("pointermove", move);
    doc.addEventListener("pointerup", up);
  });

  // Échap ferme ; un clic ailleurs ne ferme PAS (on lit la réponse en
  // travaillant à côté), c'est le bouton ou Échap qui décident.
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); closeAiSheet(); } };
  doc.addEventListener("keydown", onKey, true);
  const onResize = () => place(el, opts.anchor, win);
  win.addEventListener("resize", onResize);

  const ctrl = {
    el, ask, messages,
    close: closeAiSheet,
    setActions(list) { opts.actions = list; renderChips(); },
    dispose() {
      doc.removeEventListener("keydown", onKey, true);
      win.removeEventListener("resize", onResize);
      opts.onClose?.();
    },
  };
  current = ctrl;

  renderChips();
  place(el, opts.anchor, win);
  requestAnimationFrame(() => el.classList.add("in"));
  if (opts.question) ask(opts.question, opts.images || []);
  else input.focus();
  return ctrl;
}
