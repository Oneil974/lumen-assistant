// Documents vivants et @mentions d'agents — partagé par Notes, Opus et Calc.
//
//  • Un BLOC VIVANT est tenu à jour par un agent (ou Lumen), selon un rythme et
//    des sources ; le moteur est côté Rust (src-tauri/src/living.rs), il
//    réécrit le bloc même quand l'app est fermée. Ici : le dialogue de
//    réglage, la carte d'en-tête du bloc, l'actualisation manuelle.
//  • Une @MENTION d'agent (« @Plume rédige l'intro ») délègue la suite du
//    document à l'agent, à l'endroit précis (`living_delegate`).
//
// Configurer un bloc est une action sensible (un agent écrira seul dans vos
// fichiers) : bureau verrouillé, le mot de passe de session est demandé.

import { agentAvatarHTML, ensureAvatarStyles, setAvatarState } from "./agent-avatar.js";
import { localCronToUtc } from "./agent-templates.js";
import { icon } from "./icons.js";

const T = (window.__TAURI__ || window.parent?.__TAURI__) || null;
const invoke = T?.core?.invoke;
const listen = T?.event?.listen;
const en = () => String(localStorage.getItem("lang") || "fr").startsWith("en");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const L = (fr, eng) => (en() ? eng : fr);

// ---- Agents ------------------------------------------------------------------

let agentCache = null;
export async function listAgents(force = false) {
  if (!invoke) return [];
  if (!force && agentCache && Date.now() - agentCache.at < 20_000) return agentCache.list;
  const list = await invoke("agent_list").catch(() => []);
  agentCache = { at: Date.now(), list: Array.isArray(list) ? list : [] };
  return agentCache.list;
}

/** « @Nom demande » (nom le plus long qui correspond) → { agent, request }. */
export function matchAgentMention(text, agents) {
  const t = String(text || "").trim();
  if (!t.startsWith("@")) return null;
  const low = t.toLowerCase();
  let best = null;
  for (const a of agents || []) {
    const name = String(a.name || "").trim().toLowerCase();
    if (!name) continue;
    if (low.startsWith(`@${name}`) && (low.length === name.length + 1 || /[\s:,]/.test(low[name.length + 1]))) {
      if (!best || name.length > best.n) best = { agent: a, n: name.length };
    }
  }
  if (!best) return null;
  const request = t.slice(best.n + 1).replace(/^[\s:,]+/, "").trim();
  return request ? { agent: best.agent, request } : null;
}

/** Délègue à un agent la suite du document, à l'endroit marqué ⟦ICI⟧. */
/// `noteId` + `mark` (Notes) : Lumen remplace lui-même le marqueur dans la note,
/// même si la page est fermée ou a changé de note entre-temps.
export async function delegateToAgent({ agent, request, title = "", context = "", format = "text", noteId = null, mark = null }) {
  return withSessionPassword(() => invoke("living_delegate", {
    agent: agent.id, request, title, context, format, noteId, mark, agentName: agent.name || "",
  }), { lockOnly: false });
}

/**
 * Menu « @ » d'agents pour un champ texte (textarea / input) : s'ouvre quand
 * on tape @ en début de mot, filtre sur la suite, insère « @Nom ».
 */
export function attachAgentMenu(field, { onInsert } = {}) {
  ensureLivingStyles();
  const doc = field.ownerDocument;
  const menu = doc.createElement("div");
  menu.className = "lv-at-menu";
  menu.hidden = true;
  doc.body.appendChild(menu);
  let items = [];
  let active = 0;
  let token = null;

  const close = () => { menu.hidden = true; token = null; };
  const current = () => {
    const pos = field.selectionStart ?? 0;
    const before = field.value.slice(0, pos);
    const m = before.match(/(^|\s)@([^\s@]{0,30})$/);
    return m ? { start: pos - m[2].length - 1, end: pos, q: m[2].toLowerCase() } : null;
  };
  const place = () => {
    const r = field.getBoundingClientRect();
    menu.style.left = `${Math.max(8, r.left + 16)}px`;
    menu.style.top = `${Math.min(window.innerHeight - 260, r.top + 40)}px`;
  };
  const choose = (i) => {
    const a = items[i];
    if (!a || !token) return;
    const text = `@${a.name} `;
    field.value = field.value.slice(0, token.start) + text + field.value.slice(token.end);
    const caret = token.start + text.length;
    field.setSelectionRange(caret, caret);
    close();
    field.dispatchEvent(new Event("input", { bubbles: true }));
    onInsert?.(a);
  };
  const paint = () => {
    menu.innerHTML = `<div class="lv-at-head">${esc(L("Déléguer à un agent — Entrée pour lancer", "Hand off to an agent — Enter to run"))}</div>`;
    items.forEach((a, i) => {
      const row = doc.createElement("button");
      row.type = "button";
      row.className = "lv-at-row" + (i === active ? " on" : "");
      row.innerHTML = `${agentAvatarHTML(a, { size: 26, hands: false, animate: false })}<span><b>${esc(a.name)}</b><small>${esc(a.description || "")}</small></span>`;
      row.addEventListener("mousedown", (e) => { e.preventDefault(); choose(i); });
      menu.appendChild(row);
    });
    menu.hidden = !items.length;
    place();
  };
  field.addEventListener("input", async () => {
    token = current();
    if (!token) return close();
    const agents = await listAgents();
    items = agents.filter((a) => String(a.name || "").toLowerCase().includes(token.q)).slice(0, 8);
    active = 0;
    paint();
  });
  field.addEventListener("keydown", (e) => {
    if (menu.hidden) return;
    if (e.key === "ArrowDown") { e.preventDefault(); active = (active + 1) % items.length; paint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = (active - 1 + items.length) % items.length; paint(); }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); e.stopImmediatePropagation(); choose(active); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  }, true);
  field.addEventListener("blur", () => setTimeout(close, 150));
  return { close };
}

// ---- Mot de passe de session ---------------------------------------------------

/** Exécute `fn` ; sur SESSION_LOCKED, demande le mot de passe puis réessaie. */
export async function withSessionPassword(fn) {
  try {
    return await fn();
  } catch (e) {
    const msg = String(e?.message || e);
    if (!msg.startsWith("SESSION_LOCKED")) throw e;
    const ok = await askPassword();
    if (!ok) throw new Error(L("Configuration annulée.", "Configuration cancelled."));
    return fn();
  }
}

function askPassword() {
  ensureLivingStyles();
  return new Promise((resolve) => {
    const ov = document.createElement("div");
    ov.className = "lv-ov";
    ov.innerHTML = `<form class="lv-card lv-pw">
      <div class="lv-pw-ic">${icon("lock")}</div>
      <b>${esc(L("Mot de passe de session", "Session password"))}</b>
      <p>${esc(L("Le bureau Lumen OS est verrouillé. Confirmez votre mot de passe pour configurer ce document vivant — le bureau reste verrouillé.", "The Lumen OS desktop is locked. Confirm your password to configure this living document — the desktop stays locked."))}</p>
      <input type="password" autocomplete="current-password" placeholder="${esc(L("Mot de passe", "Password"))}">
      <small class="lv-err" hidden></small>
      <div class="lv-foot"><button type="button" data-a="no">${esc(L("Annuler", "Cancel"))}</button><button type="submit" class="pri">${esc(L("Autoriser", "Authorize"))}</button></div>
    </form>`;
    document.body.appendChild(ov);
    const form = ov.querySelector("form");
    const input = form.querySelector("input");
    const done = (v) => { ov.remove(); resolve(v); };
    form.querySelector("[data-a=no]").onclick = () => done(false);
    form.onsubmit = async (e) => {
      e.preventDefault();
      try { await invoke("session_authorize_config", { password: input.value }); done(true); }
      catch (err) { const box = form.querySelector(".lv-err"); box.hidden = false; box.textContent = String(err?.message || err); input.select(); }
    };
    input.focus();
  });
}

// ---- Registre ----------------------------------------------------------------

export async function listLiving() {
  if (!invoke) return [];
  const list = await invoke("living_list").catch(() => []);
  return Array.isArray(list) ? list : [];
}
export async function runLiving(id) { return invoke("living_run", { id }); }
export function onLivingUpdated(fn) {
  if (!listen) return () => {};
  let un = null;
  listen("living-updated", (e) => fn(e?.payload || {})).then((u) => { un = u; });
  return () => un?.();
}

export const RHYTHMS = [
  { id: "manual", cron: "", fr: "À la demande", en: "On demand" },
  { id: "hourly", cron: "0 0 * * * *", fr: "Toutes les heures", en: "Every hour" },
  { id: "morning", local: "0 7 * * *", fr: "Chaque matin (7 h)", en: "Every morning (7am)" },
  { id: "noon", local: "0 12 * * *", fr: "Chaque midi", en: "Every noon" },
  { id: "evening", local: "0 18 * * *", fr: "Chaque soir (18 h)", en: "Every evening (6pm)" },
  { id: "weekdays", local: "0 8 * * 1-5", fr: "Jours ouvrés (8 h)", en: "Weekdays (8am)" },
  { id: "weekly", local: "0 8 * * 1", fr: "Chaque lundi", en: "Every Monday" },
];
const rhythmCron = (r) => (r.local ? localCronToUtc(r.local) : r.cron);
export function rhythmLabel(cron) {
  const r = RHYTHMS.find((x) => rhythmCron(x) === (cron || ""));
  return r ? (en() ? r.en : r.fr) : (cron ? `CRON ${cron}` : L("À la demande", "On demand"));
}

export const SOURCE_KINDS = [
  { kind: "agenda", icon: "calendar", fr: "Agenda (7 jours)", en: "Calendar (7 days)", noValue: true },
  { kind: "tasks", icon: "list-checks", fr: "Tâches ouvertes", en: "Open tasks", noValue: true },
  { kind: "data", icon: "database", fr: "Données Lumen", en: "Lumen data", ph: ["mot-clé ou question", "keyword or question"] },
  { kind: "news", icon: "globe", fr: "Actualités", en: "News", ph: ["sujet (vide = à la une)", "topic (empty = top stories)"] },
  { kind: "web", icon: "search", fr: "Recherche web", en: "Web search", ph: ["requête", "query"] },
  { kind: "page", icon: "globe", fr: "Page web", en: "Web page", ph: ["https://…", "https://…"] },
  { kind: "weather", icon: "cloud-sun", fr: "Météo", en: "Weather", ph: ["ville", "city"] },
  { kind: "note", icon: "notes", fr: "Note", en: "Note", ph: ["titre de la note", "note title"] },
  { kind: "file", icon: "file", fr: "Fichier", en: "File", ph: ["Sandbox:chemin/fichier.md", "Sandbox:path/file.md"] },
];

const PRESETS = {
  note: [
    ["Ma semaine", "Résume mes rendez-vous et mes tâches des 7 prochains jours : un paragraphe d'introduction, puis une liste par jour, les points importants en gras.", [{ kind: "agenda" }, { kind: "tasks" }]],
    ["Revue de presse", "Fais une revue de presse courte sur le sujet des sources : 5 titres maximum, 2 lignes chacun, avec le lien, et une phrase « À retenir ».", [{ kind: "news", value: "" }]],
    ["Suivi de projet", "Tiens le point d'avancement du projet : objectifs, ce qui est fait, ce qui bloque, prochaines étapes avec responsables et échéances (tableau).", [{ kind: "tasks" }, { kind: "data", value: "" }]],
  ],
  sheet: [
    ["Tâches ouvertes", "Tableau des tâches ouvertes : colonnes Tâche, App, Échéance, Priorité, triées par échéance.", [{ kind: "tasks" }]],
    ["Agenda", "Tableau des évènements des 7 prochains jours : Date, Heure, Titre, Lieu.", [{ kind: "agenda" }]],
    ["Veille chiffrée", "Tableau de synthèse des chiffres clés trouvés dans les sources : Indicateur, Valeur, Variation, Source.", [{ kind: "web", value: "" }]],
  ],
  doc: [
    ["Point du jour", "Rédige un court point du jour (5 phrases maximum) à partir de mes rendez-vous et de mes tâches.", [{ kind: "agenda" }, { kind: "tasks" }]],
    ["Actualité du sujet", "Rédige un encadré « Dernières nouvelles » sur le sujet, 3 puces sourcées.", [{ kind: "news", value: "" }]],
  ],
};

// ---- Carte d'en-tête d'un bloc ---------------------------------------------------

function ago(secs) {
  if (!secs) return L("jamais mis à jour", "never updated");
  const d = Math.max(0, Math.round(Date.now() / 1000 - secs));
  const u = d < 60 ? L("à l'instant", "just now") : d < 3600 ? `${Math.round(d / 60)} min` : d < 86400 ? `${Math.round(d / 3600)} h` : `${Math.round(d / 86400)} ${L("j", "d")}`;
  return d < 60 ? u : L(`il y a ${u}`, `${u} ago`);
}

/** En-tête d'un bloc vivant : avatar de l'agent, rythme, fraîcheur, actions. */
export function livingCardHTML(block, agents) {
  ensureLivingStyles();
  const agent = (agents || []).find((a) => a.id === block?.agent_id);
  const running = block?.status === "running";
  const who = agent ? agent.name : "Lumen";
  const face = agent
    ? agentAvatarHTML(agent, { size: 30, hands: false, state: running ? "work" : block?.status === "error" ? "fail" : "idle" })
    : `<span class="lv-lumen">${icon("sparkles")}</span>`;
  const state = !block ? L("Bloc vivant introuvable — il a été supprimé.", "Living block not found — it was deleted.")
    : running ? L(`${who} met ce bloc à jour…`, `${who} is updating this block…`)
    : block.status === "error" ? `⚠️ ${block.last_error || L("échec", "failed")}`
    : `${rhythmLabel(block.cron)} · ${ago(block.last_run)}`;
  return `<div class="lv-head${running ? " is-running" : ""}" data-live-id="${esc(block?.id || "")}">
    ${face}
    <span class="lv-head-tx"><b>${esc(block?.title || L("Bloc vivant", "Living block"))}</b><i>${esc(L(`Tenu à jour par ${who}`, `Kept up to date by ${who}`))} · ${esc(state)}</i></span>
    ${block ? `<button type="button" class="lv-btn" data-live-run title="${esc(L("Mettre à jour maintenant", "Update now"))}">${icon("refresh-cw")}</button>
    <button type="button" class="lv-btn" data-live-edit title="${esc(L("Régler", "Settings"))}">${icon("settings")}</button>` : ""}
  </div>`;
}

/** Câble les boutons des cartes présentes dans `root`. */
export function wireLivingCards(root, { onEdit, onDone } = {}) {
  root.querySelectorAll(".lv-head[data-live-id]").forEach((head) => {
    if (head.dataset.wired) return;
    head.dataset.wired = "1";
    const id = head.dataset.liveId;
    head.querySelector("[data-live-run]")?.addEventListener("click", async (e) => {
      e.preventDefault();
      head.classList.add("is-running");
      setAvatarState(head.querySelector(".ka"), "work");
      try { await runLiving(id); setAvatarState(head.querySelector(".ka"), "done"); onDone?.(id, true); }
      catch (err) { setAvatarState(head.querySelector(".ka"), "fail"); onDone?.(id, false, err); }
      finally { head.classList.remove("is-running"); }
    });
    head.querySelector("[data-live-edit]")?.addEventListener("click", async (e) => {
      e.preventDefault();
      const block = (await listLiving()).find((b) => b.id === id);
      if (block) onEdit?.(block);
    });
  });
}

// ---- Dialogue de réglage ---------------------------------------------------------

/**
 * Crée ou règle un bloc vivant. `base` fixe l'emplacement (kind + note_id, ou
 * sandbox_id/path/target). Résout le bloc enregistré, `{ deleted: id }`, ou null.
 */
export async function openLivingDialog(base, existing = null) {
  ensureLivingStyles();
  ensureAvatarStyles();
  const agents = await listAgents(true);
  const draft = existing ? structuredClone(existing) : {
    id: "", title: "", agent_id: agents[0]?.id || "", instruction: "", sources: [], cron: "", enabled: true, ...base,
  };
  const kind = draft.kind || "note";
  return new Promise((resolve) => {
    const ov = document.createElement("div");
    ov.className = "lv-ov";
    ov.innerHTML = `<div class="lv-card lv-dlg" role="dialog" aria-modal="true">
      <header class="lv-dlg-head"><span class="lv-dlg-av"></span><span><b>${esc(existing ? L("Régler le bloc vivant", "Living block settings") : L("Nouveau bloc vivant", "New living block"))}</b>
        <i>${esc(L("Un agent tient ce bloc à jour tout seul, au rythme choisi, à partir des sources.", "An agent keeps this block up to date on its own, on schedule, from the sources."))}</i></span></header>
      <div class="lv-dlg-body">
        <label class="lv-lb">${esc(L("Titre du bloc", "Block title"))}</label>
        <input class="lv-in" data-f="title" maxlength="80" placeholder="${esc(L("Ex. : Ma semaine", "E.g. My week"))}">
        <label class="lv-lb">${esc(L("Qui le tient à jour ?", "Who keeps it up to date?"))}</label>
        <div class="lv-agents"></div>
        <label class="lv-lb">${esc(L("Consigne", "Instruction"))}</label>
        <div class="lv-presets"></div>
        <textarea class="lv-in" data-f="instruction" rows="4" placeholder="${esc(L("Ce que le bloc doit contenir, sa forme, son ton…", "What the block must contain, its shape, its tone…"))}"></textarea>
        <label class="lv-lb">${esc(L("Sources consultées à chaque mise à jour", "Sources checked at every update"))}</label>
        <div class="lv-sources"></div>
        <div class="lv-add"></div>
        <label class="lv-lb">${esc(L("Rythme", "Schedule"))}</label>
        <div class="lv-rhythms"></div>
        <small class="lv-err" hidden></small>
      </div>
      <footer class="lv-foot">
        ${existing ? `<button type="button" data-a="del" class="danger">${esc(L("Supprimer", "Delete"))}</button><span style="flex:1"></span>` : ""}
        <button type="button" data-a="no">${esc(L("Annuler", "Cancel"))}</button>
        <button type="button" data-a="save">${esc(L("Enregistrer", "Save"))}</button>
        <button type="button" data-a="run" class="pri">${esc(L("Enregistrer et mettre à jour", "Save and update"))}</button>
      </footer></div>`;
    document.body.appendChild(ov);
    const $ = (s) => ov.querySelector(s);
    const done = (v) => { ov.remove(); resolve(v); };
    $("[data-f=title]").value = draft.title || "";
    $("[data-f=instruction]").value = draft.instruction || "";
    $("[data-f=title]").oninput = (e) => { draft.title = e.target.value; };
    $("[data-f=instruction]").oninput = (e) => { draft.instruction = e.target.value; };

    const paintAgents = () => {
      const opts = [{ id: "", name: "Lumen", description: L("Modèle des Réglages, sans agent", "Settings model, no agent") }, ...agents];
      $(".lv-agents").innerHTML = opts.map((a) => `<button type="button" class="lv-agent${a.id === draft.agent_id ? " on" : ""}" data-id="${esc(a.id)}">
        ${a.id ? agentAvatarHTML(a, { size: 34, hands: false }) : `<span class="lv-lumen lg">${icon("sparkles")}</span>`}<span><b>${esc(a.name)}</b><small>${esc(a.description || "")}</small></span></button>`).join("");
      $(".lv-agents").querySelectorAll(".lv-agent").forEach((b) => { b.onclick = () => { draft.agent_id = b.dataset.id; paintAgents(); }; });
      const chosen = agents.find((a) => a.id === draft.agent_id);
      $(".lv-dlg-av").innerHTML = chosen ? agentAvatarHTML(chosen, { size: 56 }) : `<span class="lv-lumen xl">${icon("sparkles")}</span>`;
    };
    const paintPresets = () => {
      $(".lv-presets").innerHTML = (PRESETS[kind] || PRESETS.note).map(([t], i) => `<button type="button" class="lv-chip" data-i="${i}">${icon("wand-sparkles")}${esc(t)}</button>`).join("");
      $(".lv-presets").querySelectorAll("[data-i]").forEach((b) => {
        b.onclick = () => {
          const [t, ins, src] = (PRESETS[kind] || PRESETS.note)[Number(b.dataset.i)];
          if (!draft.title) { draft.title = t; $("[data-f=title]").value = t; }
          draft.instruction = ins; $("[data-f=instruction]").value = ins;
          draft.sources = structuredClone(src); paintSources();
        };
      });
    };
    const paintSources = () => {
      $(".lv-sources").innerHTML = (draft.sources || []).map((s, i) => {
        const k = SOURCE_KINDS.find((x) => x.kind === s.kind) || SOURCE_KINDS[0];
        return `<div class="lv-src"><span class="lv-src-ic">${icon(k.icon)}</span><b>${esc(en() ? k.en : k.fr)}</b>
          ${k.noValue ? `<span style="flex:1"></span>` : `<input class="lv-in" data-i="${i}" value="${esc(s.value || "")}" placeholder="${esc(k.ph?.[en() ? 1 : 0] || "")}">`}
          <button type="button" class="lv-btn" data-rm="${i}">${icon("x")}</button></div>`;
      }).join("") || `<div class="lv-empty">${esc(L("Aucune source : l'agent s'appuiera sur ses propres outils.", "No source: the agent will rely on its own tools."))}</div>`;
      $(".lv-sources").querySelectorAll("input[data-i]").forEach((inp) => { inp.oninput = () => { draft.sources[Number(inp.dataset.i)].value = inp.value; }; });
      $(".lv-sources").querySelectorAll("[data-rm]").forEach((b) => { b.onclick = () => { draft.sources.splice(Number(b.dataset.rm), 1); paintSources(); }; });
    };
    $(".lv-add").innerHTML = SOURCE_KINDS.map((k) => `<button type="button" class="lv-chip" data-k="${k.kind}">${icon("plus")}${esc(en() ? k.en : k.fr)}</button>`).join("");
    $(".lv-add").querySelectorAll("[data-k]").forEach((b) => {
      b.onclick = () => { draft.sources = draft.sources || []; draft.sources.push({ kind: b.dataset.k, value: "" }); paintSources(); ov.querySelector(`.lv-sources input[data-i="${draft.sources.length - 1}"]`)?.focus(); };
    });
    const paintRhythms = () => {
      $(".lv-rhythms").innerHTML = RHYTHMS.map((r) => `<button type="button" class="lv-chip${rhythmCron(r) === (draft.cron || "") ? " on" : ""}" data-r="${r.id}">${esc(en() ? r.en : r.fr)}</button>`).join("");
      $(".lv-rhythms").querySelectorAll("[data-r]").forEach((b) => { b.onclick = () => { draft.cron = rhythmCron(RHYTHMS.find((r) => r.id === b.dataset.r)); paintRhythms(); }; });
    };
    paintAgents(); paintPresets(); paintSources(); paintRhythms();

    const save = async (run) => {
      const err = $(".lv-err");
      err.hidden = true;
      if (!draft.instruction.trim()) { err.hidden = false; err.textContent = L("Une consigne est nécessaire.", "An instruction is required."); return; }
      if (!draft.title.trim()) draft.title = L("Bloc vivant", "Living block");
      draft.sources = (draft.sources || []).filter((s) => SOURCE_KINDS.find((k) => k.kind === s.kind)?.noValue || String(s.value || "").trim() || s.kind === "news");
      try {
        const saved = await withSessionPassword(() => invoke("living_save", { block: draft }));
        done({ ...saved, runNow: run });
      } catch (e) { err.hidden = false; err.textContent = String(e?.message || e).replace(/^SESSION_LOCKED:\s*/, ""); }
    };
    ov.addEventListener("click", async (e) => {
      if (e.target === ov) return done(null);
      const a = e.target.closest("[data-a]")?.dataset.a;
      if (a === "no") done(null);
      else if (a === "save") save(false);
      else if (a === "run") save(true);
      else if (a === "del" && existing) {
        const b = e.target.closest("[data-a]");
        if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = L("Confirmer la suppression", "Confirm deletion"); return; }
        await invoke("living_delete", { id: existing.id }).catch(() => {});
        done({ deleted: existing.id });
      }
    });
    ov.addEventListener("keydown", (e) => { if (e.key === "Escape") done(null); });
    $("[data-f=title]").focus();
  });
}

// ---- Styles ----------------------------------------------------------------------

export function ensureLivingStyles(doc = document) {
  if (!doc || doc.getElementById("lv-css")) return;
  const st = doc.createElement("style");
  st.id = "lv-css";
  st.textContent = `
.lv-head{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:12px 12px 0 0;
  background:linear-gradient(90deg,color-mix(in oklab,var(--primary,#7c6cf0) 10%,transparent),transparent);border-bottom:1px dashed color-mix(in oklab,var(--primary,#7c6cf0) 35%,transparent);font-size:12.5px}
.lv-head-tx{flex:1;min-width:0;display:grid;gap:1px}
.lv-head-tx b{font-size:13px;font-weight:650}
.lv-head-tx i{font-style:normal;color:var(--muted-foreground,#888);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lv-head.is-running [data-live-run] svg{animation:lv-spin 1s linear infinite}
@keyframes lv-spin{to{transform:rotate(360deg)}}
.lv-btn{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:8px;border:1px solid transparent;background:transparent;color:inherit;cursor:pointer}
.lv-btn:hover{background:color-mix(in oklab,var(--foreground,#000) 7%,transparent)}
.lv-btn svg{width:14px;height:14px}
.lv-lumen{display:inline-grid;place-items:center;width:30px;height:30px;border-radius:10px;flex:none;color:#fff;background:linear-gradient(135deg,#8b7bff,#5ac8fa)}
.lv-lumen svg{width:15px;height:15px}.lv-lumen.lg{width:34px;height:34px}.lv-lumen.xl{width:56px;height:56px;border-radius:18px}.lv-lumen.xl svg{width:26px;height:26px}
.lv-ov{position:fixed;inset:0;z-index:5000;display:grid;place-items:center;background:rgba(0,0,0,.34);font:13px system-ui,-apple-system,sans-serif}
.lv-card{background:var(--card,var(--background,#fff));color:var(--foreground,#111);border:1px solid var(--border,rgba(127,127,127,.25));border-radius:18px;box-shadow:0 24px 60px rgba(0,0,0,.25)}
.lv-dlg{width:min(680px,94vw);max-height:90vh;display:flex;flex-direction:column;overflow:hidden}
.lv-dlg-head{display:flex;align-items:center;gap:14px;padding:16px 18px;border-bottom:1px solid var(--border,rgba(127,127,127,.2))}
.lv-dlg-head b{font-size:16px}.lv-dlg-head i{display:block;font-style:normal;color:var(--muted-foreground,#888);font-size:12.5px;margin-top:2px}
.lv-dlg-body{overflow:auto;padding:4px 18px 16px;display:flex;flex-direction:column}
.lv-lb{font-size:11px;font-weight:650;letter-spacing:.05em;text-transform:uppercase;color:var(--muted-foreground,#888);margin:14px 0 6px}
.lv-in{font:inherit;width:100%;box-sizing:border-box;padding:8px 11px;border-radius:10px;border:1px solid var(--border,rgba(127,127,127,.3));background:var(--background,transparent);color:inherit}
textarea.lv-in{resize:vertical;line-height:1.45}
.lv-agents{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:6px;max-height:220px;overflow:auto}
.lv-agent{display:flex;align-items:center;gap:9px;text-align:left;font:inherit;color:inherit;padding:7px 9px;border-radius:12px;border:1.5px solid var(--border,rgba(127,127,127,.25));background:transparent;cursor:pointer}
.lv-agent span{display:grid;min-width:0}.lv-agent small{color:var(--muted-foreground,#888);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lv-agent.on{border-color:var(--primary,#7c6cf0);background:color-mix(in oklab,var(--primary,#7c6cf0) 9%,transparent)}
.lv-presets,.lv-add,.lv-rhythms{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:6px}
.lv-chip{display:inline-flex;align-items:center;gap:5px;font:inherit;font-size:12px;padding:4px 10px;border-radius:999px;border:1px solid var(--border,rgba(127,127,127,.3));background:transparent;color:inherit;cursor:pointer}
.lv-chip svg{width:12px;height:12px}.lv-chip:hover{background:color-mix(in oklab,var(--foreground,#000) 6%,transparent)}
.lv-chip.on{background:var(--foreground,#111);color:var(--background,#fff);border-color:transparent}
.lv-src{display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:10px;background:color-mix(in oklab,var(--foreground,#000) 3.5%,transparent);margin-bottom:5px}
.lv-src b{font-size:12.5px;font-weight:600;white-space:nowrap}.lv-src .lv-in{flex:1;padding:5px 9px}
.lv-src-ic{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:7px;background:color-mix(in oklab,var(--primary,#7c6cf0) 14%,transparent);color:var(--primary,#7c6cf0)}
.lv-src-ic svg{width:13px;height:13px}
.lv-empty{font-size:12px;color:var(--muted-foreground,#888);padding:6px 2px}
.lv-err{color:var(--destructive,#d33);font-size:12.5px;margin-top:10px}
.lv-foot{display:flex;gap:8px;justify-content:flex-end;padding:12px 16px;border-top:1px solid var(--border,rgba(127,127,127,.2))}
.lv-foot button{font:inherit;padding:7px 13px;border-radius:10px;border:1px solid var(--border,rgba(127,127,127,.3));background:transparent;color:inherit;cursor:pointer}
.lv-foot button.pri{background:var(--primary,#111);color:var(--primary-foreground,#fff);border-color:transparent}
.lv-foot button.danger{color:var(--destructive,#d33)}
.lv-pw{width:min(400px,92vw);padding:20px;display:grid;gap:10px}.lv-pw p{margin:0;color:var(--muted-foreground,#888);line-height:1.45}
.lv-pw .lv-foot{padding:6px 0 0;border:0}.lv-pw input{font:inherit;padding:9px 11px;border-radius:10px;border:1px solid var(--border,rgba(127,127,127,.3));background:var(--background,transparent);color:inherit}
.lv-pw-ic{width:38px;height:38px;border-radius:12px;display:grid;place-items:center;background:color-mix(in oklab,var(--primary,#7c6cf0) 12%,transparent);color:var(--primary,#7c6cf0)}
.lv-at-menu{position:fixed;z-index:5000;width:300px;max-height:260px;overflow:auto;padding:5px;border-radius:14px;background:var(--card,var(--background,#fff));
  color:var(--foreground,#111);border:1px solid var(--border,rgba(127,127,127,.25));box-shadow:0 16px 40px rgba(0,0,0,.2);font:13px system-ui,-apple-system,sans-serif}
.lv-at-head{font-size:11px;color:var(--muted-foreground,#888);padding:4px 8px 6px}
.lv-at-row{display:flex;align-items:center;gap:9px;width:100%;text-align:left;font:inherit;color:inherit;padding:6px 8px;border-radius:9px;border:0;background:transparent;cursor:pointer}
.lv-at-row span{display:grid;min-width:0}.lv-at-row small{color:var(--muted-foreground,#888);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lv-at-row.on,.lv-at-row:hover{background:color-mix(in oklab,var(--primary,#7c6cf0) 11%,transparent)}
.lv-working{display:flex;align-items:center;gap:10px;padding:10px 12px;margin:10px 0;border-radius:12px;border:1px dashed color-mix(in oklab,var(--primary,#7c6cf0) 45%,transparent);
  background:color-mix(in oklab,var(--primary,#7c6cf0) 6%,transparent);font-size:12.5px}
`;
  (doc.head || doc.documentElement).appendChild(st);
}
