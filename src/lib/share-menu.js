// Le sélecteur « Envoyer vers… » : la seule surface visible du bus d'interop.
//
// Il se monte TOUJOURS dans le document du haut (le bureau), jamais dans
// l'iframe appelante : sinon il serait rogné par la fenêtre de l'app et
// passerait sous les autres fenêtres. Les apps étant même-origine, on peut
// écrire dans le DOM du parent sans cérémonie.

import { icon as lucide } from "./icons.js?v=2";
import { describe, handoff, shelve, targetsFor } from "./interop.js?v=2";
import { tt } from "../apps-i18n.js";

const STYLE_ID = "lumen-share-style";

const CSS = `
.lumen-share-backdrop{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;
  justify-content:center;background:rgba(0,0,0,.42);backdrop-filter:blur(2px)}
.lumen-share{width:min(420px,92vw);max-height:76vh;overflow:auto;border-radius:14px;
  background:var(--dt-surface,#fff);color:var(--dt-text,#111);
  box-shadow:0 24px 64px rgba(0,0,0,.34);padding:16px;font:13px/1.45 system-ui,-apple-system,sans-serif}
.lumen-share h3{margin:0 0 2px;font-size:15px;font-weight:600}
.lumen-share .sub{margin:0 0 14px;opacity:.62;font-size:12px}
.lumen-share .row{display:flex;align-items:center;gap:10px;width:100%;padding:9px 10px;
  border:0;border-radius:9px;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit}
.lumen-share .row:hover,.lumen-share .row:focus-visible{background:var(--sel,rgba(10,132,255,.14));outline:none}
.lumen-share .row .ic{display:inline-flex;width:28px;height:28px;border-radius:8px;align-items:center;justify-content:center;background:var(--muted,rgba(0,0,0,.06));color:var(--foreground,inherit);flex:none}
.lumen-share .row .ic svg{width:15px;height:15px}
.lumen-share .row .name{font-weight:550}
.lumen-share .row .hint{opacity:.55;font-size:12px;margin-left:auto}
.lumen-share .sep{height:1px;margin:10px 0;background:currentColor;opacity:.10}
.lumen-share .empty{opacity:.6;padding:8px 10px}
.lumen-share-toast{position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:99999;
  padding:8px 14px;border-radius:999px;font:13px/1.3 system-ui,-apple-system,sans-serif;
  background:rgba(20,20,24,.9);color:#fff;box-shadow:0 10px 30px rgba(0,0,0,.3);pointer-events:none;
  animation:lumenShareToast 2.2s ease forwards}
@keyframes lumenShareToast{0%{opacity:0;transform:translate(-50%,6px)}12%{opacity:1;transform:translate(-50%,0)}80%{opacity:1}100%{opacity:0}}
@media (prefers-color-scheme:dark){
  .lumen-share{background:var(--dt-surface,#1f1f22);color:var(--dt-text,#f2f2f7)}
}
`;

function isolated() {
  try {
    if (!window.top || window.top === window) return false;
    void window.top.document;
    return false;
  } catch { return true; }
}

function topWindow() {
  try {
    if (window.top && window.top !== window) return window.top;
  } catch {}
  return window;
}

/** Confirmation fugace, dans le document du haut (celui du sélecteur). */
function shareToast(doc, text) {
  const el = doc.createElement("div");
  el.className = "lumen-share-toast";
  el.textContent = text;
  doc.body.appendChild(el);
  setTimeout(() => el.remove(), 2400);
}

function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}

/**
 * Ouvre le sélecteur pour `obj` et résout avec l'identifiant de l'app choisie,
 * "shelf" si l'objet a été posé sur l'étagère, ou null si l'utilisateur a
 * renoncé.
 *
 * @param {object} obj un objet Lumen (cf. interop.makeObject)
 * @returns {Promise<string|null>}
 */
export function share(obj) {
  // App paquet (autre origine) : le sélecteur est dessiné par l'hôte.
  if (isolated() && window.lumen?.__appkit) return window.lumen.interop.share(obj.kind, obj);
  const host = topWindow();
  const doc = host.document;
  ensureStyle(doc);

  return new Promise((resolve) => {
    const backdrop = doc.createElement("div");
    backdrop.className = "lumen-share-backdrop";
    const panel = doc.createElement("div");
    panel.className = "lumen-share";
    backdrop.appendChild(panel);

    const title = doc.createElement("h3");
    title.textContent = tt("Envoyer vers…");
    const sub = doc.createElement("p");
    sub.className = "sub";
    sub.textContent = describe(obj);
    panel.append(title, sub);

    function close(value) {
      backdrop.remove();
      doc.removeEventListener("keydown", onKey, true);
      resolve(value);
    }
    function onKey(event) {
      if (event.key === "Escape") { event.stopPropagation(); close(null); }
    }

    function addRow(name, hint, onPick, iconName = "") {
      const row = doc.createElement("button");
      row.type = "button";
      row.className = "row";
      if (iconName) {
        const ic = doc.createElement("span");
        ic.className = "ic";
        ic.innerHTML = lucide(iconName);
        row.appendChild(ic);
      }
      const label = doc.createElement("span");
      label.className = "name";
      label.textContent = name;
      const hintEl = doc.createElement("span");
      hintEl.className = "hint";
      hintEl.textContent = hint;
      row.append(label, hintEl);
      row.addEventListener("click", onPick);
      panel.appendChild(row);
      return row;
    }

    const targets = targetsFor(obj);
    if (!targets.length) {
      const empty = doc.createElement("div");
      empty.className = "empty";
      empty.textContent = tt("Aucune app ne sait recevoir ce type de contenu.");
      panel.appendChild(empty);
    }
    for (const target of targets) {
      addRow(tt(target.label), tt(target.hint), () => {
        handoff(target.appId, obj);
        // Sans retour, on ne sait pas si le geste a pris : l'app cible peut
        // mettre un instant à s'ouvrir, ou être déjà ouverte derrière.
        shareToast(doc, tt("Envoyé vers {app}", { app: tt(target.label) }));
        close(target.appId);
      }, target.icon || "");
    }

    const sep = doc.createElement("div");
    sep.className = "sep";
    panel.appendChild(sep);
    addRow(tt("Poser sur l'étagère"), tt("garder pour plus tard"), () => {
      shelve(obj);
      shareToast(doc, tt("Posé sur l'étagère."));
      close("shelf");
    }, "bookmark");

    doc.addEventListener("keydown", onKey, true);
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) close(null);
    });
    doc.body.appendChild(backdrop);
    panel.querySelector(".row")?.focus();
  });
}
