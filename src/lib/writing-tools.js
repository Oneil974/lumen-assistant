// Outils d'écriture universels — l'IA sur n'importe quel texte sélectionné.
//
// Le geste est le même partout dans Lumen : on sélectionne un texte, un petit
// bouton étincelle apparaît (ou clic droit, ou ⌘⇧E), et un menu en pilules
// propose Relire, Réécrire (ton), Résumer, Points clés, Liste, Tableau,
// Traduire, Demander à Lumen… Le résultat s'affiche dans un popover ancré à la
// sélection, avec Remplacer / Insérer dessous / Copier — et, pour Relire, les
// corrections surlignées.
//
// Trois sources de sélection, un seul menu :
//   1. le document du bureau lui-même (`attach(document)`) ;
//   2. les apps en iframe MÊME origine (hubs, apps du bureau) : `attach(doc)`
//      est appelé sur chaque document au chargement, et les coordonnées sont
//      remontées jusqu'à la fenêtre du haut, où tout est dessiné ;
//   3. les apps paquets (`lumenapp://`, autre origine) : le SDK (guest.js)
//      envoie la sélection par postMessage, l'hôte (host.js) la relaie ici via
//      `remote()`, et le remplacement repart par le même pont.
//
// Le module ne dépend pas du bureau : `install()` reçoit ce qu'il faut pour
// ouvrir la feuille IA, partager, ou déposer un objet dans une app.

import { llmChat } from "../llm.js";
import { buildPrompt, textLang } from "./prompt-kit.js";
import { renderMarkdown, escapeHtml } from "../sandbox/render.js";
import { icon } from "./icons.js?v=2";
import { makeObject, handoff } from "./interop.js?v=2";
import { defaultOrbColors } from "./orb-palette.js";
import { mountMicButton } from "./mic-button.js";

// ===== Libellés ==============================================================

const LABELS = {
  fr: {
    proofread: "Relire", rewrite: "Réécrire", friendly: "Amical", professional: "Professionnel", concise: "Concis",
    describe: "Décrire la modification…", summarize: "Résumer", keypoints: "Points clés", transform: "Transformer",
    list: "Liste", table: "Tableau", translate: "Traduire", to_en: "en anglais", to_fr: "en français",
    ask: "Demander à Lumen…", share: "Envoyer vers…", explain_code: "Expliquer ce code", more: "Plus…",
    cut: "Couper", paste: "Coller", speak: "Énoncer (voix de Lumen)",
    tasks: "Envoyer dans Tempo", event: "Créer une tâche datée", remember: "Mémoriser", automation: "Créer une automatisation",
    open_link: "Ouvrir le lien",
    replace: "Remplacer", insert: "Insérer dessous", copy: "Copier", copied: "Copié", retry: "Réessayer",
    describe_ph: "Décrivez la modification souhaitée…", working: "Lumen travaille…", empty: "(réponse vide)",
    ask_context: "Que veux-tu savoir sur ce texte ?", ask_title: "À propos de la sélection",
    img_describe: "Décrire l'image", img_ocr: "Extraire le texte", img_copy: "Copier l'image", img_ask: "Poser une question…",
    img_title: "À propos de l'image", img_q: "Décris précisément cette image.", ocr_q: "Transcris fidèlement tout le texte visible dans cette image, sans commentaire.",
    code_q: "Explique ce que fait ce code, simplement.",
  },
  en: {
    proofread: "Proofread", rewrite: "Rewrite", friendly: "Friendly", professional: "Professional", concise: "Concise",
    describe: "Describe your change…", summarize: "Summarize", keypoints: "Key points", transform: "Transform",
    list: "List", table: "Table", translate: "Translate", to_en: "to English", to_fr: "to French",
    ask: "Ask Lumen…", share: "Send to…", explain_code: "Explain this code", more: "More…",
    cut: "Cut", paste: "Paste", speak: "Speak aloud (Lumen's voice)",
    tasks: "Send to Tempo", event: "Create a dated task", remember: "Remember", automation: "Create an automation",
    open_link: "Open link",
    replace: "Replace", insert: "Insert below", copy: "Copy", copied: "Copied", retry: "Retry",
    describe_ph: "Describe the change you want…", working: "Lumen is working…", empty: "(empty answer)",
    ask_context: "What do you want to know about this text?", ask_title: "About the selection",
    img_describe: "Describe image", img_ocr: "Extract text", img_copy: "Copy image", img_ask: "Ask a question…",
    img_title: "About the image", img_q: "Describe this image precisely.", ocr_q: "Transcribe all visible text in this image faithfully, without commentary.",
    code_q: "Explain what this code does, simply.",
  },
};

export function wtLang() {
  return (localStorage.getItem("lang") || "fr").toLowerCase().startsWith("en") ? "en" : "fr";
}
const T = () => LABELS[wtLang()] || LABELS.fr;

// ===== Opérations ============================================================
// Chaque opération a un prompt système FR et EN (selon la langue de l'UI ;
// la langue du TEXTE est respectée par consigne), personnalisable via le
// catalogue de prompts (`writing.<op>`).

export const WRITING_OPS = {
  proofread: {
    fr: "Tu es un correcteur. Corrige l'orthographe, la grammaire, la ponctuation et les accords du texte fourni, sans changer son sens, son style ni sa langue. Réponds UNIQUEMENT avec le texte corrigé, sans commentaire ni guillemets.",
    en: "You are a proofreader. Fix spelling, grammar, punctuation and agreement in the given text without changing its meaning, style or language. Reply ONLY with the corrected text, no commentary, no quotes.",
    replaces: true, diff: true,
  },
  rewrite: {
    fr: "Réécris le texte fourni pour le rendre plus clair et plus fluide, en gardant son sens, sa longueur approximative et sa langue. Réponds UNIQUEMENT avec le texte réécrit.",
    en: "Rewrite the given text to make it clearer and smoother, keeping its meaning, approximate length and language. Reply ONLY with the rewritten text.",
    replaces: true,
  },
  friendly: {
    fr: "Réécris le texte fourni sur un ton chaleureux et amical, en gardant son sens et sa langue. Réponds UNIQUEMENT avec le texte réécrit.",
    en: "Rewrite the given text in a warm, friendly tone, keeping its meaning and language. Reply ONLY with the rewritten text.",
    replaces: true,
  },
  professional: {
    fr: "Réécris le texte fourni sur un ton professionnel et soigné, en gardant son sens et sa langue. Réponds UNIQUEMENT avec le texte réécrit.",
    en: "Rewrite the given text in a polished, professional tone, keeping its meaning and language. Reply ONLY with the rewritten text.",
    replaces: true,
  },
  concise: {
    fr: "Réécris le texte fourni de façon plus concise, sans perdre d'information importante, dans la même langue. Réponds UNIQUEMENT avec le texte réécrit.",
    en: "Rewrite the given text more concisely without losing important information, in the same language. Reply ONLY with the rewritten text.",
    replaces: true,
  },
  describe: {
    fr: "Modifie le texte fourni en suivant exactement l'instruction donnée, dans la même langue que le texte. Réponds UNIQUEMENT avec le texte modifié.",
    en: "Modify the given text following exactly the given instruction, in the text's language. Reply ONLY with the modified text.",
    replaces: true,
  },
  summarize: {
    fr: "Résume le texte fourni en quelques phrases claires, dans sa langue. Réponds UNIQUEMENT avec le résumé.",
    en: "Summarize the given text in a few clear sentences, in its language. Reply ONLY with the summary.",
    markdown: true,
  },
  keypoints: {
    fr: "Extrais les points clés du texte fourni sous forme de liste à puces courtes (Markdown), dans sa langue. Réponds UNIQUEMENT avec la liste.",
    en: "Extract the key points of the given text as a short Markdown bullet list, in its language. Reply ONLY with the list.",
    markdown: true, replaces: true,
  },
  list: {
    fr: "Transforme le texte fourni en liste à puces (Markdown), un élément par idée, dans sa langue. Réponds UNIQUEMENT avec la liste.",
    en: "Turn the given text into a Markdown bullet list, one item per idea, in its language. Reply ONLY with the list.",
    markdown: true, replaces: true,
  },
  table: {
    fr: "Organise les informations du texte fourni dans un tableau Markdown pertinent (colonnes claires), dans sa langue. Réponds UNIQUEMENT avec le tableau.",
    en: "Organize the information of the given text into a relevant Markdown table (clear columns), in its language. Reply ONLY with the table.",
    markdown: true, replaces: true,
  },
  to_en: {
    fr: "Traduis le texte fourni en anglais, fidèlement et naturellement. Réponds UNIQUEMENT avec la traduction.",
    en: "Translate the given text into English, faithfully and naturally. Reply ONLY with the translation.",
    replaces: true,
  },
  to_fr: {
    fr: "Traduis le texte fourni en français, fidèlement et naturellement. Réponds UNIQUEMENT avec la traduction.",
    en: "Translate the given text into French, faithfully and naturally. Reply ONLY with the translation.",
    replaces: true,
  },
};


/** Nettoie une réponse « texte seul » : guillemets ou fence que le modèle ajoute parfois. */
function cleanOutput(s) {
  let t = String(s || "").trim();
  t = t.replace(/^```[a-z]*\n([\s\S]*?)\n```$/i, "$1").trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("«") && t.endsWith("»"))) t = t.slice(1, -1).trim();
  return t;
}

// `onDelta(texte)` : résultat en flux (le texte s'écrit dans la bulle).
async function runOp(op, text, instruction = "", onDelta) {
  const chat = ctx?.chat || llmChat;
  const out = await chat(writingMessages(op, text, instruction), { rawSystem: true, think: false, ...(onDelta ? { onDelta } : {}) });
  return cleanOutput(typeof out === "string" ? out : out?.content ?? "");
}

/**
 * Messages d'une opération d'écriture. La langue de réponse est celle du TEXTE
 * (un mail anglais relu reste en anglais), ou la cible d'une traduction.
 */
export function writingMessages(op, text, instruction = "") {
  const spec = WRITING_OPS[op];
  // Langue de réponse : la cible d'une traduction, sinon celle du TEXTE.
  const lang = op === "to_en" ? "en" : op === "to_fr" ? "fr" : textLang(text);
  return buildPrompt({
    id: `writing.${op}`, kind: spec.markdown && !spec.replaces ? "summary" : "transform", lang,
    role: spec[wtLang()] || spec.fr,
    data: { TEXTE: text },
    request: instruction ? `Instruction : ${instruction}` : "",
    format: spec.markdown ? "Markdown, sans introduction." : "le texte seul.",
  });
}

// ===== Diff mot à mot (pour Relire) ==========================================

function wordDiff(a, b) {
  const A = a.split(/(\s+)/), B = b.split(/(\s+)/);
  const n = A.length, m = B.length;
  if (n * m > 250000) return escapeHtml(b); // trop long : pas de surlignage
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0, j = 0, out = "";
  while (i < n && j < m) {
    if (A[i] === B[j]) { out += escapeHtml(A[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { if (A[i].trim()) out += `<del>${escapeHtml(A[i])}</del>`; i++; }
    else { out += B[j].trim() ? `<ins>${escapeHtml(B[j])}</ins>` : escapeHtml(B[j]); j++; }
  }
  while (i < n) { if (A[i].trim()) out += `<del>${escapeHtml(A[i])}</del>`; i++; }
  while (j < m) { out += B[j].trim() ? `<ins>${escapeHtml(B[j])}</ins>` : escapeHtml(B[j]); j++; }
  return out;
}

// ===== Détection d'actions suggérées =========================================

const RE_URL = /https?:\/\/[^\s<>"']+/i;
const RE_DATE = /\b(\d{1,2}[\/.-]\d{1,2}([\/.-]\d{2,4})?|\d{1,2}\s?h\s?\d{0,2}\b|\d{1,2}:\d{2}|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|demain|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|janvier|février|mars|avril|juin|juillet|août|septembre|octobre|novembre|décembre|january|february|march|april|june|july|august|september|october|november|december)\b/i;
const RE_TASKLINE = /^\s*([-*•]|\d+[.)]|\[[ x]\])\s+\S/;
const RE_CODE = /[{};]\s*$|^\s*(function|const|let|var|def|class|import|#include|SELECT|fn |pub |=>)/m;

function suggestions(sel, ctx) {
  const t = sel.text, L = T();
  const out = [];
  const lines = t.split(/\n/).filter((l) => l.trim());
  const taskLines = lines.filter((l) => RE_TASKLINE.test(l));
  if (lines.length >= 2 && taskLines.length >= Math.max(2, lines.length * 0.6)) {
    out.push({ id: "tasks", label: L.tasks, icon: "list-checks", run: () => {
      for (const l of taskLines) {
        const text = l.replace(/^\s*([-*•]|\d+[.)]|\[[ x]\])\s+/, "").trim();
        if (text) handoff("kanban", makeObject("task", { text }, { sourceApp: "writing-tools" }));
      }
    } });
  } else if (RE_DATE.test(t) && t.length < 400) {
    out.push({ id: "event", label: L.event, icon: "calendar", run: () => {
      handoff("kanban", makeObject("task", { text: t.trim(), due: (RE_DATE.exec(t) || [""])[0] }, { sourceApp: "writing-tools" }));
    } });
  }
  const url = RE_URL.exec(t);
  if (url && ctx.openUrl) out.push({ id: "link", label: L.open_link, icon: "external-link", run: () => ctx.openUrl(url[0]) });
  if (RE_CODE.test(t) && lines.length >= 2) {
    out.push({ id: "code", label: L.explain_code, icon: "code", run: () => askSheetFor(sel, ctx, L.code_q) });
  }
  return out.slice(0, 2);
}

// ===== État global (fenêtre du haut) =========================================

let ctx = null;         // ce que le bureau nous prête
let menuEl = null;      // menu en pilules ouvert
let sparkEl = null;     // bouton étincelle
let popEl = null;       // popover de résultat
let popDispose = null;
let activeSel = null;   // sélection sur laquelle porte le menu/popover
const attachedDocs = new WeakSet();
const remoteFrames = new Map(); // frame → { host, sel }

function topDoc() { return window.document; }

function ensureStyle() {
  const doc = topDoc();
  if (doc.getElementById("lumen-wt-css")) return;
  const link = doc.createElement("link");
  link.id = "lumen-wt-css";
  link.rel = "stylesheet";
  link.href = new URL("./writing-tools.css?v=7", import.meta.url).href;
  doc.head.appendChild(link);
  try {
    const cols = JSON.parse(localStorage.getItem("orbColors") || "null") || defaultOrbColors();
    cols.slice(0, 4).forEach((c, i) => doc.documentElement.style.setProperty(`--sheet-c${i + 1}`, c));
  } catch {}
}

/** Convertit un rect d'une fenêtre (même origine) en coordonnées de la fenêtre du haut. */
function toTop(rect, win) {
  let x = rect.x ?? rect.left, y = rect.y ?? rect.top;
  let w = win;
  for (let guard = 0; guard < 8 && w && w !== window; guard++) {
    let fe = null;
    try { fe = w.frameElement; } catch { break; }
    if (!fe) break;
    const r = fe.getBoundingClientRect();
    x += r.left; y += r.top;
    w = fe.ownerDocument.defaultView;
  }
  return { x, y, w: rect.width ?? rect.w ?? 0, h: rect.height ?? rect.h ?? 0 };
}

// ===== Lecture de la sélection dans un document ==============================

function isEditable(el) {
  if (!el) return false;
  if (el.tagName === "TEXTAREA") return !el.readOnly && !el.disabled;
  if (el.tagName === "INPUT") return /^(text|search|url|email|tel)$/i.test(el.type || "text") && !el.readOnly && !el.disabled;
  return !!el.isContentEditable;
}


/* Rect du TEXTE sélectionné dans un champ (textarea/input), et non du champ
   entier : on reproduit le champ dans un div miroir (mêmes styles, même
   largeur, même défilement) et on mesure la portée du texte sélectionné.
   Sans cela, l'étincelle atterrissait au bas d'un long éditeur. */
const MIRROR_PROPS = ["boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontVariant", "letterSpacing", "lineHeight",
  "textTransform", "textIndent", "wordSpacing", "whiteSpace", "wordBreak", "overflowWrap", "tabSize", "direction"];
function fieldSelectionRect(el, start, end) {
  const doc = el.ownerDocument, win = doc.defaultView;
  const box = el.getBoundingClientRect();
  try {
    const cs = win.getComputedStyle(el);
    const mirror = doc.createElement("div");
    for (let i = 0; i < MIRROR_PROPS.length; i++) mirror.style[MIRROR_PROPS[i]] = cs[MIRROR_PROPS[i]];
    mirror.style.position = "fixed"; mirror.style.left = box.left + "px"; mirror.style.top = box.top + "px";
    mirror.style.height = box.height + "px"; mirror.style.overflow = "hidden";
    mirror.style.visibility = "hidden"; mirror.style.pointerEvents = "none"; mirror.style.zIndex = "-1";
    if (el.tagName === "TEXTAREA") { mirror.style.whiteSpace = "pre-wrap"; mirror.style.overflowWrap = "break-word"; }
    else { mirror.style.whiteSpace = "pre"; }
    const v = el.value;
    mirror.appendChild(doc.createTextNode(v.slice(0, start)));
    const span = doc.createElement("span");
    span.appendChild(doc.createTextNode(v.slice(start, end) || "\u200b"));
    mirror.appendChild(span);
    mirror.appendChild(doc.createTextNode(v.slice(end) + "\u200b"));
    doc.body.appendChild(mirror);
    mirror.scrollTop = el.scrollTop; mirror.scrollLeft = el.scrollLeft;
    const rects = span.getClientRects();
    const r = rects.length ? rects[rects.length - 1] : span.getBoundingClientRect();
    const first = rects.length ? rects[0] : r;
    mirror.parentNode.removeChild(mirror);
    // Portée visible du champ : une sélection qui a défilé hors de vue est
    // ramenée au bord, plutôt que projetée hors de la fenêtre.
    const top = Math.max(box.top, Math.min(first.top, box.bottom));
    const bottom = Math.max(box.top, Math.min(r.bottom, box.bottom));
    const left = Math.max(box.left, Math.min(rects.length > 1 ? box.left : first.left, box.right));
    const right = Math.max(box.left, Math.min(rects.length > 1 ? box.right : r.right, box.right));
    return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
  } catch (e) {
    return { x: box.left, y: box.top, w: box.width, h: box.height };
  }
}

function readSelection(doc) {
  const win = doc.defaultView;
  const active = doc.activeElement;
  // Un champ peut garder le focus alors que la sélection est ailleurs dans la
  // page : on ne prend le champ que s'il a LUI-MÊME une sélection.
  const fieldSel = active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT")
    && (active.selectionEnd ?? 0) - (active.selectionStart ?? 0) >= 1
    && active.value.slice(active.selectionStart, active.selectionEnd).trim();
  if (fieldSel) {
    const start = active.selectionStart ?? 0, end = active.selectionEnd ?? 0;
    const text = active.value.slice(start, end);
    const r = fieldSelectionRect(active, start, end);
    return {
      text, editable: isEditable(active), doc, win,
      rect: toTop({ x: r.x, y: r.y, width: r.w, height: r.h }, win),
      replace(t) {
        active.focus();
        active.setRangeText(t, start, end, "end");
        active.dispatchEvent(new Event("input", { bubbles: true }));
        active.dispatchEvent(new Event("change", { bubbles: true }));
      },
      insertAfter(t) {
        active.focus();
        const sep = active.tagName === "TEXTAREA" ? "\n\n" : " ";
        active.setRangeText(sep + t, end, end, "end");
        active.dispatchEvent(new Event("input", { bubbles: true }));
      },
    };
  }
  const sel = win.getSelection?.();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const text = sel.toString();
  if (!text.trim()) return null;
  const range = sel.getRangeAt(0).cloneRange();
  let node = range.commonAncestorContainer;
  if (node.nodeType !== 1) node = node.parentElement;
  const editable = isEditable(node?.closest?.("[contenteditable]") || node);
  const r = range.getBoundingClientRect();
  const restore = () => { const s = win.getSelection(); s.removeAllRanges(); s.addRange(range); };
  return {
    text, editable, doc, win,
    rect: toTop({ x: r.left, y: r.top, width: r.width, height: r.height }, win),
    replace(t) {
      restore();
      (node.closest?.("[contenteditable]") || node).focus?.();
      let ok = false;
      try { ok = t === "" ? doc.execCommand("delete") : doc.execCommand("insertText", false, t); } catch {}
      if (!ok) { range.deleteContents(); if (t) range.insertNode(doc.createTextNode(t)); }
    },
    insertAfter(t) {
      restore();
      const s = win.getSelection();
      s.collapseToEnd();
      (node.closest?.("[contenteditable]") || node).focus?.();
      let ok = false;
      try { ok = doc.execCommand("insertText", false, "\n" + t); } catch {}
      if (!ok) { const rg = s.getRangeAt(0); rg.insertNode(doc.createTextNode("\n" + t)); }
    },
  };
}

/** La sélection courante du document touche-t-elle l'élément cliqué ? */
function selectionHits(doc, target) {
  if (!target) return false;
  const active = doc.activeElement;
  if (active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT")) return target === active || active.contains(target);
  try {
    const sel = doc.defaultView.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    if (sel.containsNode(target, true)) return true;
    const node = sel.getRangeAt(0).commonAncestorContainer;
    const el = node.nodeType === 1 ? node : node.parentElement;
    return !!el && (el === target || el.contains(target));
  } catch { return false; }
}

// ===== UI : étincelle, menu, popover ========================================

function clamp(x, y, w, h) {
  const W = window.innerWidth, H = window.innerHeight;
  // Le bureau réserve le bas de l'écran (barre des tâches, dock, chat) : on
  // s'arrête au-dessus, sinon l'élément passait sous ces barres.
  let safe = 8;
  try { safe = Math.max(8, Number(window.__lumenSafeBottom?.()) || 8); } catch { safe = 8; }
  return { x: Math.max(8, Math.min(x, W - w - 8)), y: Math.max(8, Math.min(y, H - h - safe)) };
}

function hideSpark() { sparkEl?.remove(); sparkEl = null; }
function closeMenu() { menuEl?.remove(); menuEl = null; }
function closePop() { popDispose?.(); popDispose = null; popEl?.remove(); popEl = null; }
export function closeWritingTools() { hideSpark(); closeMenu(); closePop(); }

function showSpark(sel) {
  ensureStyle();
  hideSpark();
  const doc = topDoc();
  const b = doc.createElement("button");
  b.className = "lumen-wt-spark";
  b.title = wtLang() === "en" ? "Writing tools (⌘⇧E)" : "Outils d'écriture (⌘⇧E)";
  b.innerHTML = icon("sparkles");
  const p = clamp(sel.rect.x + sel.rect.w + 6, sel.rect.y + sel.rect.h - 8, 26, 26);
  b.style.left = `${p.x}px`; b.style.top = `${p.y}px`;
  b.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); });
  b.addEventListener("click", (e) => { e.stopPropagation(); openMenu(sel, { x: p.x, y: p.y + 30 }); });
  doc.body.appendChild(b);
  sparkEl = b;
  requestAnimationFrame(() => b.classList.add("in"));
}

function pill(label, ico, opts = {}) {
  const el = topDoc().createElement("div");
  el.className = "lumen-wt-pill" + (opts.cls ? " " + opts.cls : "");
  el.innerHTML = `${icon(ico)}<span>${escapeHtml(label)}</span>${opts.sub ? icon("chevron-down", { cls: "chev" }) : ""}`;
  if (opts.sub) {
    const sub = topDoc().createElement("div");
    sub.className = "lumen-wt-sub";
    for (const [l, fn] of opts.sub) {
      const it = topDoc().createElement("div");
      it.textContent = l;
      it.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
      sub.appendChild(it);
    }
    el.appendChild(sub);
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const was = el.classList.contains("open");
      menuEl?.querySelectorAll(".lumen-wt-pill.open").forEach((p) => p.classList.remove("open"));
      if (!was) {
        el.classList.add("open");
        const r = sub.getBoundingClientRect();
        if (r.right > window.innerWidth - 8) sub.classList.add("left");
        // En bas d'écran, le sous-menu remonte au lieu de passer sous la
        // barre des tâches.
        let safe = 8;
        try { safe = Math.max(8, Number(window.__lumenSafeBottom?.()) || 8); } catch { safe = 8; }
        if (r.bottom > window.innerHeight - safe) sub.classList.add("up");
      }
    });
  } else if (opts.run) {
    el.addEventListener("click", (e) => { e.stopPropagation(); opts.run(); });
  }
  return el;
}

export function openMenu(sel, at) {
  ensureStyle();
  closeMenu(); closePop(); hideSpark();
  activeSel = sel;
  const L = T();
  const doc = topDoc();
  const m = doc.createElement("div");
  m.className = "lumen-wt-menu";
  const go = (op, instruction) => { closeMenu(); runAndShow(op, sel, instruction); };

  // Deux niveaux : les gestes fréquents en pilules, les variantes dans des
  // sous-menus, et les actions rares derrière « Plus… » — un menu court se
  // lit d'un coup d'œil, un menu long se fait ignorer.
  if (sel.editable) {
    m.appendChild(pill(L.proofread, "search-check", { cls: "primary", run: () => go("proofread") }));
    m.appendChild(pill(L.rewrite, "pencil", { sub: [
      [L.rewrite, () => go("rewrite")],
      [L.friendly, () => go("friendly")],
      [L.professional, () => go("professional")],
      [L.concise, () => go("concise")],
      [L.describe, () => { closeMenu(); showPop(sel, "describe", null); }],
    ] }));
  }
  m.appendChild(pill(L.summarize, "scroll-text", { sub: [[L.summarize, () => go("summarize")], [L.keypoints, () => go("keypoints")]] }));
  if (sel.editable) {
    m.appendChild(pill(L.transform, "table", { sub: [[L.list, () => go("list")], [L.table, () => go("table")]] }));
  }
  m.appendChild(pill(L.translate, "globe", { sub: [[L.to_en, () => go("to_en")], [L.to_fr, () => go("to_fr")]] }));

  // Presse-papiers : le menu natif n'apparaît plus quand celui-ci prend la
  // main, les gestes de base doivent donc y être.
  const copyText = async () => { try { await navigator.clipboard.writeText(sel.text); ctx?.toast?.(L.copied, false); } catch (e) { ctx?.toast?.(String(e?.message || e)); } };
  const clip = doc.createElement("div"); clip.className = "lumen-wt-row";
  const iconBtn = (label, ico, run) => {
    const b = doc.createElement("button");
    b.type = "button";
    b.className = "lumen-wt-pill icon";
    b.title = label; b.setAttribute("aria-label", label);
    b.innerHTML = icon(ico);
    b.addEventListener("click", (e) => { e.stopPropagation(); run(); });
    return b;
  };
  clip.appendChild(iconBtn(L.copy, "copy", () => { closeMenu(); copyText(); }));
  if (sel.editable) {
    clip.appendChild(iconBtn(L.cut, "scissors", async () => { closeMenu(); await copyText(); try { sel.replace(""); } catch {} }));
    clip.appendChild(iconBtn(L.paste, "clipboard-paste", async () => {
      closeMenu();
      try { const t = await navigator.clipboard.readText(); if (t) sel.replace(t); } catch (e) { ctx?.toast?.(String(e?.message || e)); }
    }));
  }
  // Énoncer : la sélection est lue par la voix locale, l'orbe s'anime.
  if (ctx?.speak) clip.appendChild(iconBtn(L.speak, "volume-2", () => { closeMenu(); try { ctx.speak(sel.text); } catch (e) { ctx?.toast?.(String(e?.message || e)); } }));
  m.appendChild(clip);
  const gap = doc.createElement("div"); gap.className = "lumen-wt-gap"; m.appendChild(gap);
  // Suggestions contextuelles (tâches, date, lien, code) : rares et précieuses,
  // elles restent visibles.
  for (const sg of suggestions(sel, ctx || {})) {
    m.appendChild(pill(sg.label, sg.icon, { cls: "suggest", run: () => { closeMenu(); sg.run(); } }));
  }
  m.appendChild(pill(L.more, "ellipsis", { sub: [
    [L.share, () => { closeMenu(); (ctx?.share || window.LumenShare)?.(makeObject("text", { text: sel.text }, { app: "writing-tools" })); }],
    [L.remember, () => { closeMenu(); handoff("memory", makeObject("text", { text: sel.text }, { app: "writing-tools" })); }],
    [L.automation, () => { closeMenu(); handoff("fluxo", makeObject("text", { text: sel.text }, { app: "writing-tools" })); }],
  ] }));
  m.appendChild(pill(L.ask, "sparkles", { cls: "primary", run: () => { closeMenu(); askSheetFor(sel, ctx || {}); } }));

  doc.body.appendChild(m);
  const h = m.offsetHeight, w = m.offsetWidth;
  // Sous le point d'appel ; s'il manque de la place, on remonte juste ce qu'il
  // faut (plutôt que de sauter au-dessus, loin de la sélection).
  let x = at?.x ?? sel.rect.x, y = at?.y ?? (sel.rect.y + sel.rect.h + 8);
  const p = clamp(x, y, w, h);
  m.style.left = `${p.x}px`; m.style.top = `${p.y}px`;
  requestAnimationFrame(() => m.classList.add("in"));
  menuEl = m;
}

/** Ouvre la feuille IA sur la sélection (question libre ou fournie). */
function askSheetFor(sel, c, question = "") {
  const L = T();
  const open = c.openSheet || window.LumenAskSheet;
  if (!open) return;
  open({
    title: L.ask_title,
    anchor: { x: sel.rect.x, y: sel.rect.y, w: sel.rect.w, h: sel.rect.h },
    context: sel.text,
    question: question || "",
    placeholder: L.ask_context,
  });
}

async function runAndShow(op, sel, instruction) {
  showPop(sel, op, instruction);
}

function showPop(sel, op, instruction) {
  ensureStyle();
  closePop();
  const L = T();
  const doc = topDoc();
  const spec = WRITING_OPS[op];
  const el = doc.createElement("section");
  el.className = "lumen-wt-pop";
  el.setAttribute("role", "dialog");
  el.innerHTML = `
    <header class="lumen-wt-pop-head">${icon("sparkles")}<div class="lumen-wt-pop-title">${escapeHtml(L[op] || L.rewrite)}</div>
      <button class="lumen-sheet-ib" data-act="close" title="Fermer">${icon("x")}</button></header>
    <div class="lumen-wt-pop-body"></div>
    <footer class="lumen-wt-pop-foot"></footer>`;
  doc.body.appendChild(el);
  popEl = el;
  const body = el.querySelector(".lumen-wt-pop-body");
  const foot = el.querySelector(".lumen-wt-pop-foot");
  el.querySelector('[data-act="close"]').addEventListener("click", closePop);
  el.addEventListener("pointerdown", (e) => e.stopPropagation());

  // Position : sous la sélection, sinon au-dessus.
  const placeIt = () => {
    const h = el.offsetHeight, w = el.offsetWidth;
    let x = sel.rect.x, y = sel.rect.y + sel.rect.h + 10;
    let safe = 8;
    try { safe = Math.max(8, Number(window.__lumenSafeBottom?.()) || 8); } catch { safe = 8; }
    if (y + h > window.innerHeight - safe && sel.rect.y - h - 10 >= 8) y = sel.rect.y - h - 10;
    const p = clamp(x, y, w, h);
    el.style.left = `${p.x}px`; el.style.top = `${p.y}px`;
  };
  requestAnimationFrame(() => { placeIt(); el.classList.add("in"); });

  const head = el.querySelector(".lumen-wt-pop-head");
  head.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    const sx = e.clientX - el.offsetLeft, sy = e.clientY - el.offsetTop;
    const move = (ev) => { el.style.left = `${ev.clientX - sx}px`; el.style.top = `${ev.clientY - sy}px`; };
    const up = () => { doc.removeEventListener("pointermove", move); doc.removeEventListener("pointerup", up); };
    doc.addEventListener("pointermove", move); doc.addEventListener("pointerup", up);
  });
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); closePop(); } };
  doc.addEventListener("keydown", onKey, true);
  popDispose = () => doc.removeEventListener("keydown", onKey, true);

  let result = "";
  const btn = (label, ico, fn, cls = "") => {
    const b = doc.createElement("button");
    b.className = "lumen-wt-btn" + (cls ? " " + cls : "");
    b.innerHTML = `${ico ? icon(ico) : ""}<span>${escapeHtml(label)}</span>`;
    b.addEventListener("click", fn);
    foot.appendChild(b);
    return b;
  };

  const describeRow = () => {
    const row = doc.createElement("div");
    row.className = "lumen-wt-describe";
    row.innerHTML = `<input type="text" placeholder="${escapeHtml(L.describe_ph)}" /><button class="lumen-wt-btn primary">${icon("send-horizontal")}</button>`;
    const inp = row.querySelector("input");
    const send = () => { const v = inp.value.trim(); if (v) { closePop(); showPop(sel, "describe", v); } };
    row.querySelector("button").addEventListener("click", send);
    inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") send(); if (e.key === "Escape") closePop(); });
    foot.appendChild(row);
    mountMicButton(inp, { before: row.querySelector("button") });
    return inp;
  };

  const renderFoot = () => {
    foot.innerHTML = "";
    if (result) {
      if (sel.editable && spec.replaces) btn(L.replace, "check", () => { try { sel.replace(result); } catch (e) { ctx?.toast?.(String(e?.message || e)); } closePop(); }, "primary");
      if (sel.editable) btn(L.insert, "plus", () => { try { sel.insertAfter(result); } catch (e) { ctx?.toast?.(String(e?.message || e)); } closePop(); });
      const cp = btn(L.copy, "copy", async () => { try { await navigator.clipboard.writeText(result); cp.querySelector("span").textContent = L.copied; } catch {} });
      btn(L.retry, "refresh-cw", () => { closePop(); showPop(sel, op, instruction); });
      btn(L.share, "send", () => { (ctx?.share || window.LumenShare)?.(makeObject("text", { text: result, markdown: !!spec.markdown }, { app: "writing-tools" })); });
    }
    if (sel.editable) describeRow();
  };

  if (op === "describe" && !instruction) {
    body.textContent = "";
    body.hidden = true;
    renderFoot();
    setTimeout(() => foot.querySelector("input")?.focus(), 30);
    return;
  }

  body.innerHTML = `<span class="lumen-wt-typing" title="${escapeHtml(L.working)}"><i></i><i></i><i></i></span>`;
  el.classList.add("busy");
  renderFoot();
  const myEl = el;
  // Pendant le flux, texte brut (le surlignage des différences et le Markdown
  // n'ont de sens que sur le résultat complet, posé à la fin).
  runOp(op, sel.text, instruction, (txt) => {
    if (popEl !== myEl || !txt) return;
    if (spec.markdown) { body.classList.add("md"); body.innerHTML = renderMarkdown(txt); }
    else body.textContent = txt;
  }).then((out) => {
    if (popEl !== myEl) return;
    result = out || "";
    if (!result) { body.textContent = L.empty; }
    else if (spec.diff) { body.innerHTML = wordDiff(sel.text, result); }
    else if (spec.markdown) { body.classList.add("md"); body.innerHTML = renderMarkdown(result); }
    else { body.textContent = result; }
    renderFoot();
    placeIt();
  }).catch((e) => {
    if (popEl !== myEl) return;
    body.classList.add("err");
    body.textContent = String(e?.message || e || "Erreur");
  }).finally(() => myEl.classList.remove("busy"));
}

// ===== Menu image ============================================================

async function imageToDataUrl(img) {
  try {
    if (img.src.startsWith("data:")) return img.src;
    const c = document.createElement("canvas");
    c.width = img.naturalWidth || img.width; c.height = img.naturalHeight || img.height;
    c.getContext("2d").drawImage(img, 0, 0);
    return c.toDataURL("image/png");
  } catch {
    // Image d'une autre origine : le canvas est souillé. On repasse par fetch
    // (même origine ou CORS ouvert), sinon on abandonne proprement.
    try {
      const blob = await (await fetch(img.src)).blob();
      return await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
    } catch { return ""; }
  }
}

function openImageMenu(imgInfo, at) {
  ensureStyle();
  closeMenu(); closePop(); hideSpark();
  const L = T();
  const doc = topDoc();
  const m = doc.createElement("div");
  m.className = "lumen-wt-menu";
  const sheet = async (question) => {
    closeMenu();
    const dataUrl = await imgInfo.dataUrl();
    if (!dataUrl) { ctx?.toast?.(wtLang() === "en" ? "This image cannot be read." : "Cette image ne peut pas être lue."); return; }
    const open = ctx?.openSheet || window.LumenAskSheet;
    open?.({
      title: L.img_title,
      anchor: imgInfo.rect,
      question,
      images: [{ dataUrl, b64: dataUrl.split(",")[1] }],
      placeholder: L.img_ask,
    });
  };
  m.appendChild(pill(L.img_describe, "eye", { cls: "primary", run: () => sheet(L.img_q) }));
  m.appendChild(pill(L.img_ocr, "type", { run: () => sheet(L.ocr_q) }));
  m.appendChild(pill(L.img_ask, "sparkles", { run: async () => {
    closeMenu();
    const dataUrl = await imgInfo.dataUrl();
    if (!dataUrl) return;
    (ctx?.openSheet || window.LumenAskSheet)?.({ title: L.img_title, anchor: imgInfo.rect, images: [{ dataUrl, b64: dataUrl.split(",")[1] }], pendingImages: true, placeholder: L.img_ask });
  } }));
  const gap = doc.createElement("div"); gap.className = "lumen-wt-gap"; m.appendChild(gap);
  m.appendChild(pill(L.more, "ellipsis", { sub: [
    [L.img_copy, async () => {
      closeMenu();
      try {
        const dataUrl = await imgInfo.dataUrl();
        const blob = await (await fetch(dataUrl)).blob();
        await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
        ctx?.toast?.(L.copied, false);
      } catch (e) { ctx?.toast?.(String(e?.message || e)); }
    }],
    [L.share, async () => {
      closeMenu();
      const dataUrl = await imgInfo.dataUrl();
      if (dataUrl) (ctx?.share || window.LumenShare)?.(makeObject("image", { dataUrl }, { app: "writing-tools" }));
    }],
  ] }));
  doc.body.appendChild(m);
  const p = clamp(at.x, at.y, m.offsetWidth, m.offsetHeight);
  m.style.left = `${p.x}px`; m.style.top = `${p.y}px`;
  requestAnimationFrame(() => m.classList.add("in"));
  menuEl = m;
}

// ===== Branchement sur un document ==========================================

// `.files` : la grille de l'explorateur de sandboxes — ses noms de fichiers ne
// sont pas du texte à relire ou traduire.
const IGNORE_SEL = ".lumen-wt-menu, .lumen-wt-pop, .lumen-wt-spark, .lumen-sheet, .files";

/**
 * Branche les gestes sur un document même origine (fenêtre du haut ou iframe).
 * Idempotent.
 */
export function attachWritingTools(doc) {
  if (!doc || attachedDocs.has(doc)) return;
  attachedDocs.add(doc);
  const win = doc.defaultView;
  if (!win) return;

  // Clic droit : sur une image → menu image ; sur une sélection → menu texte.
  // Sinon on laisse faire (menu natif ou menu de l'app).
  doc.addEventListener("contextmenu", (e) => {
    if (e.target?.closest?.(IGNORE_SEL)) return;
    const img = e.target?.closest?.("img");
    const pt = toTop({ x: e.clientX, y: e.clientY, width: 0, height: 0 }, win);
    // Une image sous le curseur prime sur une sélection de texte restée ailleurs.
    if (img && img.naturalWidth > 32 && img.naturalHeight > 32) {
      e.preventDefault(); e.stopImmediatePropagation();
      const r = toTop(img.getBoundingClientRect(), win);
      openImageMenu({ rect: r, dataUrl: () => imageToDataUrl(img) }, { x: pt.x + 2, y: pt.y + 2 });
      return;
    }
    const sel = readSelection(doc);
    if (!sel || sel.text.trim().length < 2) return;
    // Le clic droit doit porter SUR la sélection : une sélection oubliée
    // ailleurs dans la page ne doit pas confisquer le menu contextuel de
    // l'endroit cliqué (bureau, fenêtre, dock…).
    if (!selectionHits(doc, e.target)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    openMenu(sel, { x: pt.x + 2, y: pt.y + 2 });
  }, true);

  // Fin de sélection à la souris : l'étincelle.
  let t = 0;
  doc.addEventListener("mouseup", (e) => {
    if (e.button !== 0 || e.target?.closest?.(IGNORE_SEL)) return;
    clearTimeout(t);
    t = setTimeout(() => {
      const sel = readSelection(doc);
      if (sel && sel.text.trim().length >= 3 && !menuEl && !popEl) showSpark(sel);
      else if (!sel) hideSpark();
    }, 120);
  });
  // Minuteur distinct : `selectionchange` arrive de façon asynchrone APRÈS le
  // mouseup et annulerait sinon l'étincelle avant qu'elle n'apparaisse.
  let t2 = 0;
  doc.addEventListener("selectionchange", () => {
    clearTimeout(t2);
    t2 = setTimeout(() => { if (!readSelection(doc)) hideSpark(); }, 150);
  });

  // ⌘⇧E / Ctrl+Shift+E : menu à la sélection.
  doc.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "e" || e.key === "E")) {
      const sel = readSelection(doc);
      if (!sel) return;
      e.preventDefault(); e.stopPropagation();
      openMenu(sel);
    }
  }, true);

  // Un clic n'importe où ferme le menu (pas le popover : on le ferme par son bouton, Échap ou Remplacer).
  doc.addEventListener("pointerdown", (e) => {
    if (e.target?.closest?.(IGNORE_SEL)) return;
    closeMenu();
    hideSpark();
  }, true);
  win.addEventListener("scroll", () => { closeMenu(); hideSpark(); }, true);
  win.addEventListener("blur", () => hideSpark());

  // Les iframes MÊME origine de ce document (hubs, apps du bureau) sont
  // branchées à leur tour, y compris celles qui apparaîtront plus tard.
  const hook = (frame) => {
    const tryAttach = () => { try { const d = frame.contentDocument; if (d && d.body) attachWritingTools(d); } catch { /* autre origine : passe par guest.js */ } };
    frame.addEventListener("load", tryAttach);
    tryAttach();
  };
  doc.querySelectorAll("iframe").forEach(hook);
  try {
    new win.MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === "IFRAME") hook(n);
        else n.querySelectorAll?.("iframe").forEach(hook);
      }
    }).observe(doc.documentElement, { childList: true, subtree: true });
  } catch {}
}

/**
 * Sélection venue d'une app d'une AUTRE origine (via host.js). `frame` sert à
 * convertir les coordonnées, `host.emit` à renvoyer le remplacement.
 */
export function remoteSelection(frame, host, p) {
  if (!p) return;
  // `frame` vit dans le document de l'HÔTE (hub-shell), lui-même embarqué dans
  // une fenêtre du bureau : son rect est relatif à l'hôte, pas à la fenêtre du
  // haut qui dessine l'étincelle. Sans la remontée, l'icône atterrissait loin
  // de la sélection (typiquement au bas de la fenêtre de l'app).
  let hostWin = null;
  try { hostWin = frame.ownerDocument?.defaultView || null; } catch { hostWin = null; }
  const r = toTop(frame.getBoundingClientRect(), hostWin || window);
  const fr = { x: (p.rect?.x || 0) + r.x, y: (p.rect?.y || 0) + r.y, w: p.rect?.w || 0, h: p.rect?.h || 0 };
  const at = p.point ? { x: p.point.x + r.x + 2, y: p.point.y + r.y + 2 } : null;
  if (p.kind === "clear") { hideSpark(); return; }
  // Clic dans l'app (hors sélection) : le menu de l'hôte se ferme, comme un
  // clic sur le bureau.
  if (p.kind === "pointerdown") { closeMenu(); hideSpark(); return; }
  if (p.kind === "image" && p.dataUrl) {
    openImageMenu({ rect: fr, dataUrl: async () => p.dataUrl }, at || { x: fr.x, y: fr.y + fr.h });
    return;
  }
  if (!p.text || p.text.trim().length < 2) return;
  const sel = {
    text: p.text, editable: !!p.editable, rect: fr, remote: true,
    replace: (t) => host.emit("selection.replace", { text: t, mode: "replace" }),
    insertAfter: (t) => host.emit("selection.replace", { text: t, mode: "after" }),
  };
  if (p.kind === "spark") { if (!menuEl && !popEl) showSpark(sel); return; }
  openMenu(sel, at);
}

/**
 * À appeler UNE fois dans la fenêtre du haut.
 * @param {object} c  { openSheet(spec), share(obj), toast(msg, isError), openUrl(url), chat(messages, opts)? }
 */
export function installWritingTools(c = {}) {
  ctx = c;
  ensureStyle();
  attachWritingTools(document);
  window.LumenWritingTools = { attach: attachWritingTools, remote: remoteSelection, open: openMenu, close: closeWritingTools };
}
