import { tt } from "/companion-i18n.js";
// Halo du compagnon mobile — la capsule du bureau, portée sur le téléphone.
//
// Même grammaire que `src/island.js` : une pastille qui apparaît quand un agent
// travaille et fait défiler ses étapes, une carte quand une notification
// arrive, un déroulé complet quand on touche la capsule. Le code, lui, est
// distinct : la capsule du bureau est une FENÊTRE native qu'il faut mesurer et
// repositionner, celle-ci est un simple élément flottant. Mutualiser les deux
// reviendrait à traîner `invoke`, `island_set_size` et le morphing de fenêtre
// dans une page qui n'en a aucun usage.
//
// Le téléphone ne calcule rien : il affiche ce que l'ordinateur pousse par le
// WebSocket (`agent-step`, `halo-notify`).

const TIMELINE_MAX = 60;
const STEP_TTL = 25000;
const HOLD_MS = 6000;
const IDLE_HOLD = 2600;

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const hhmm = (ts) =>
  new Date(ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

// Glyphes : la page du compagnon n'importe pas le jeu d'icônes du bureau (elle
// écrit ses SVG à la main, cf. companion.html). On garde le même principe.
const ICONS = {
  bolt: '<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  bell: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
  agents: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>',
  trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  warn: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
};
const svg = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${
    ICONS[name] || ICONS.bell
  }</svg>`;

const KIND_ICON = {
  info: "bell", success: "check", warn: "warn", error: "warn",
  progress: "bolt", thinking: "bolt",
};

export function mountHalo(root, { face = () => "", name = () => "" } = {}) {
  if (!root) return null;

  // --- État ---------------------------------------------------------------
  let timeline = [];        // déroulé du run, tous agents confondus
  let step = null;          // dernière étape reçue { label, agent, ts }
  let current = null;       // notification affichée
  const queue = [];
  let open = false;         // déroulé déplié
  let holdTimer = null;
  let idleTimer = null;

  root.className = "halo";
  root.hidden = true;
  root.innerHTML = `
    <button class="halo-shell" type="button" aria-live="polite">
      <span class="halo-lead"></span>
      <span class="halo-txt"><b></b><i></i></span>
      <span class="halo-more"></span>
    </button>
    <div class="halo-tl" hidden></div>`;

  const shell = root.querySelector(".halo-shell");
  const lead = root.querySelector(".halo-lead");
  const title = root.querySelector(".halo-txt b");
  const sub = root.querySelector(".halo-txt i");
  const more = root.querySelector(".halo-more");
  const tlEl = root.querySelector(".halo-tl");

  const fresh = () => step && Date.now() - step.ts < STEP_TTL;

  function render() {
    if (current) {
      root.dataset.kind = current.kind || "info";
      lead.innerHTML = svg(current.icon || KIND_ICON[current.kind] || "bell");
      title.textContent = current.title || "Lumen";
      sub.textContent = current.body || "";
    } else if (fresh()) {
      delete root.dataset.kind;
      // Le personnage de l'agent au travail, sinon l'éclair générique.
      lead.innerHTML = face(step.id) || face(step.agent) || svg("bolt");
      title.textContent = step.agent || "Agent";
      sub.textContent = step.label;
    } else {
      delete root.dataset.kind;
      lead.innerHTML = svg("agents");
      title.textContent = "Lumen";
      sub.textContent = "";
    }
    more.textContent = queue.length ? `+${queue.length}` : "";
    more.hidden = !queue.length;
    root.dataset.open = open ? "1" : "0";
    if (open) renderTimeline();
    tlEl.hidden = !open;
  }

  function renderTimeline() {
    if (!timeline.length) {
      tlEl.innerHTML = `<div class="halo-tl-empty">${tt("Aucune étape pour l'instant.")}</div>`;
      return;
    }
    tlEl.innerHTML = timeline
      .slice(-24)
      .reverse()
      .map((r) => {
        const detail = String(r.kind === "thought" ? r.result : r.result || r.input)
          .replace(/\s+/g, " ")
          .trim();
        return `
          <div class="halo-tl-row ${r.kind === "thought" ? "is-thought" : ""} ${r.ok ? "" : "is-error"}">
            <span class="halo-tl-avatar">${face(r.agentId, { size: 24, state: r.kind === "thought" ? "idle" : r.ok ? "done" : "fail" }) || svg("agents")}</span>
            <span class="halo-tl-time">${esc(hhmm(r.ts))}</span>
            <span class="halo-tl-body">
              <b>${esc(name(r.agentId) || r.agent || "Agent")} · ${esc(r.label)}</b>
              ${detail ? `<span>${esc(detail)}</span>` : ""}
            </span>
            <span class="halo-tl-dot">${r.kind === "thought" ? "" : svg(r.ok ? "check" : "x")}</span>
          </div>`;
      })
      .join("");
  }

  function show() {
    clearTimeout(idleTimer);
    idleTimer = null;
    root.hidden = false;
    // Une frame pour que la transition d'entrée parte de l'état replié.
    requestAnimationFrame(() => root.classList.add("is-in"));
  }

  // Rien à dire, personne au travail : la capsule s'efface. Le déroulé ouvert
  // la retient — on est en train de le lire.
  function settleLater() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (current || open || fresh()) return;
      root.classList.remove("is-in");
      setTimeout(() => {
        if (!current && !open && !fresh()) root.hidden = true;
      }, 260);
    }, IDLE_HOLD);
  }

  function present() {
    clearTimeout(holdTimer);
    current = queue.shift() || null;
    render();
    if (!current) return settleLater();
    show();
    holdTimer = setTimeout(() => {
      holdTimer = null;
      present();
    }, Number(current.timeout_ms) > 0 ? Number(current.timeout_ms) : HOLD_MS);
  }

  shell.addEventListener("click", () => {
    open = !open;
    // Toucher la capsule fige la notification affichée : on la lit, elle ne
    // doit pas filer sous le doigt.
    if (open) clearTimeout(holdTimer);
    else if (current) present();
    show();
    render();
  });

  return {
    /** Étape d'agent (appel d'outil ou raisonnement). */
    step(payload) {
      const p = payload?.step || payload || {};
      if (!p.agent_id) return;
      const row = {
        agentId: p.agent_id,
        agent: payload?.agent || name(p.agent_id) || "Agent",
        kind: p.kind === "thought" ? "thought" : "tool",
        label: String(p.skill || "…"),
        input: String(p.input || ""),
        result: String(p.result || ""),
        ok: p.success !== false,
        ts: Number(p.ts) ? Number(p.ts) * 1000 : Date.now(),
      };
      timeline.push(row);
      if (timeline.length > TIMELINE_MAX) timeline.splice(0, timeline.length - TIMELINE_MAX);
      step = { label: row.label, agent: payload?.agent || name(p.agent_id) || "Agent", id: p.agent_id, ts: Date.now() };
      show();
      render();
      settleLater();
    },
    /** Notification poussée par la capsule de l'ordinateur. */
    notify(payload) {
      const n = payload?.notification || payload || {};
      const item = {
        kind: String(n.kind || "info"),
        icon: n.icon && ICONS[n.icon] ? n.icon : null,
        title: String(n.title || "Lumen"),
        body: String(n.body || n.message || ""),
        timeout_ms: n.timeout_ms,
      };
      queue.push(item);
      if (current) {
        render();
        return;
      }
      present();
    },
    /** Vide le déroulé (changement de session, déconnexion). */
    reset() {
      timeline = [];
      step = null;
      current = null;
      queue.length = 0;
      open = false;
      render();
      settleLater();
    },
  };
}
