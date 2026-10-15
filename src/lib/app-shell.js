// Petits compléments de la coquille Pro (lib/app-shell.css) : icônes de
// navigation, avatars d'initiales, états vides, tuiles KPI. Chaque app appelle
// `mountShell()` au chargement ; le reste est du HTML prêt à insérer.
import { icon } from "./icons.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/**
 * Remplace le contenu de tout élément `[data-icon]` (nav, en-têtes, boutons)
 * par l'icône Lucide nommée. Idempotent : peut être rappelé après un rendu.
 */
export function mountShell(root = document) {
  root.querySelectorAll("[data-icon]").forEach((el) => {
    if (el.dataset.iconDone === el.dataset.icon) return;
    const svg = icon(el.dataset.icon);
    if (svg) { el.innerHTML = svg; el.dataset.iconDone = el.dataset.icon; }
  });
}

/** Teinte (0-360) stable dérivée d'un nom, pour colorer un avatar. */
export function hueOf(name) {
  let h = 0;
  for (const ch of String(name || "")) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/** Initiales (2 lettres) d'un nom : « Atelier Nord » → « AN ». */
export function initials(name) {
  const parts = String(name || "").trim().split(/[\s\-_.]+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Avatar d'initiales. `size` : "sm" | "" | "lg". */
export function avatar(name, size = "", title = "") {
  return `<span class="avatar ${size}" style="--h:${hueOf(name)}" title="${esc(title || name)}">${esc(initials(name))}</span>`;
}

/**
 * État vide avec titre, indication et action facultative.
 * `action` : { label, act } → bouton `data-act`, à câbler par l'app.
 */
export function emptyState({ title, hint = "", action = null, compact = false } = {}) {
  return `<div class="empty ${compact ? "compact" : ""}">${title ? `<b>${esc(title)}</b>` : ""}${hint ? `<span>${esc(hint)}</span>` : ""}${action ? `<button class="btn tiny" data-act="${esc(action.act)}">${esc(action.label)}</button>` : ""}</div>`;
}

/**
 * Tuile KPI. `icon` : nom Lucide ; `tone` : "" | "alert" | "good" ;
 * `trend` : { dir: "up"|"down"|"", label }.
 */
export function kpi({ label, value, sub = "", icon: ic = "", tone = "", trend = null } = {}) {
  return `<div class="kpi ${tone}">
    ${ic ? `<span class="k-ic">${icon(ic)}</span>` : ""}
    <span class="k-label">${esc(label)}</span>
    <span class="k-value">${esc(value)}</span>
    ${trend ? `<span class="k-trend ${trend.dir || ""}">${trend.dir === "up" ? icon("chart-line") : trend.dir === "down" ? icon("triangle-alert") : ""}${esc(trend.label)}</span>` : ""}
    ${sub ? `<span class="k-sub">${esc(sub)}</span>` : ""}
  </div>`;
}

/** Barre de progression. `tone` : "" | "ok" | "warn" | "bad". */
export function progress(pct, tone = "") {
  const v = Math.max(0, Math.min(100, Number(pct) || 0));
  return `<span class="progress ${tone}" title="${v} %"><i style="width:${v}%"></i></span>`;
}

export { icon };
