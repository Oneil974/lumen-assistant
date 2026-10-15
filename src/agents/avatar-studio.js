// Studio d'avatar : l'éditeur du personnage Kenney d'un agent. Monté dans la
// fenêtre « Avatar » de l'éditeur ET dans l'étape Identité de l'assistant —
// un seul composant, donc un seul geste d'une surface à l'autre.
//
// Chaque vignette est rendue avec l'avatar COURANT modifié d'un seul champ :
// on choisit une forme en la voyant déjà à sa couleur, un visage sur son corps.

import {
  agentAvatarHTML, normalizeAvatar, randomAvatar, setAvatarState, avatarColor,
  AVATAR_COLORS, AVATAR_SHAPES, AVATAR_FACES, AVATAR_HANDS, AVATAR_ANIMS,
} from "../lib/agent-avatar.js";
import { tt } from "../apps-i18n.js";
import { icon as lumenIcon } from "../lib/icons.js";

const STATES = [
  { key: "idle", label: "Repos" },
  { key: "work", label: "Au travail" },
  { key: "done", label: "Réussite" },
  { key: "fail", label: "Échec" },
];

const HAND_BASE = new URL("../lib/avatars/kenney/", import.meta.url).href;
const handThumb = (color, hand) => (color === "yellow" ? `${HAND_BASE}hand_yellow_${hand}.png` : `${HAND_BASE}${color}_hand_${hand}.png`);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/**
 * @param {HTMLElement} host
 * @param {{ value?: object, seed?: string, onChange?: (av:object)=>void, compact?: boolean }} opts
 */
export function mountAvatarStudio(host, opts = {}) {
  let av = normalizeAvatar(opts.value, opts.seed || "");
  let state = "idle";
  let stateTimer = null;

  function emit() { opts.onChange?.({ ...av }); }

  function set(field, value) {
    av = { ...av, [field]: value };
    render();
    emit();
  }

  function tile(field, value, inner, label, extraClass = "") {
    const on = av[field] === value;
    return `<button type="button" class="as-tile ${extraClass}${on ? " on" : ""}" data-f="${field}" data-v="${value}" title="${esc(tt(label))}" aria-pressed="${on}">${inner}</button>`;
  }

  function render() {
    const big = opts.compact ? 116 : 150;
    host.classList.add("as");
    host.classList.toggle("as-compact", !!opts.compact);
    host.style.setProperty("--as-c", avatarColor(av));
    host.innerHTML = `
      <div class="as-stage">
        <div class="as-halo">${agentAvatarHTML(av, { size: big, state, title: tt("Aperçu") })}</div>
        <div class="as-states" role="group" aria-label="${esc(tt("Tester une humeur"))}">
          ${STATES.map((s) => `<button type="button" class="as-state${s.key === state ? " on" : ""}" data-state="${s.key}">${esc(tt(s.label))}</button>`).join("")}
        </div>
        <button type="button" class="as-dice" title="${esc(tt("Un avatar au hasard"))}">${lumenIcon("sparkles")}<span>${esc(tt("Surprends-moi"))}</span></button>
      </div>
      <div class="as-panel">
        <div class="as-sec"><span class="as-lb">${esc(tt("Couleur"))}</span>
          <div class="as-row">${AVATAR_COLORS.map((c) => tile("color", c.key, `<span class="as-dot" style="background:${c.hex}"></span>`, c.label, "as-color")).join("")}</div></div>
        <div class="as-sec"><span class="as-lb">${esc(tt("Forme"))}</span>
          <div class="as-row">${AVATAR_SHAPES.map((s) => tile("shape", s.key, agentAvatarHTML({ ...av, shape: s.key }, { size: 40, hands: false, animate: false }), s.label)).join("")}</div></div>
        <div class="as-sec"><span class="as-lb">${esc(tt("Visage"))}</span>
          <div class="as-row as-faces">${AVATAR_FACES.map((f) => tile("face", f.key, agentAvatarHTML({ ...av, face: f.key }, { size: 40, hands: false, animate: false }), f.label)).join("")}</div></div>
        <div class="as-sec"><span class="as-lb">${esc(tt("Main gauche"))}</span>
          <div class="as-row">${AVATAR_HANDS.map((h) => tile("hand", h.key, `<img src="${handThumb(av.color, h.key)}" alt="" draggable="false">`, h.label, "as-hand")).join("")}</div></div>
        <div class="as-sec"><span class="as-lb">${esc(tt("Main droite"))}</span>
          <div class="as-row">${AVATAR_HANDS.map((h) => tile("hand2", h.key, `<img src="${handThumb(av.color, h.key)}" alt="" draggable="false" style="transform:scaleX(-1)">`, h.label, "as-hand")).join("")}</div></div>
        <div class="as-sec"><span class="as-lb">${esc(tt("Animation"))}</span>
          <div class="as-row">${AVATAR_ANIMS.map((a) => `<button type="button" class="as-chip${av.anim === a.key ? " on" : ""}" data-f="anim" data-v="${a.key}" aria-pressed="${av.anim === a.key}">${esc(tt(a.label))}</button>`).join("")}</div></div>
      </div>`;
    host.querySelectorAll("[data-f]").forEach((b) => b.addEventListener("click", () => set(b.dataset.f, b.dataset.v)));
    host.querySelectorAll(".as-state").forEach((b) => b.addEventListener("click", () => playState(b.dataset.state)));
    host.querySelector(".as-dice").addEventListener("click", () => {
      av = randomAvatar();
      render();
      emit();
      playState("done");
    });
  }

  // Aperçu d'une humeur : « réussite » et « échec » sont des réactions, elles
  // retombent d'elles-mêmes au repos ; « au travail » reste jusqu'au clic suivant.
  function playState(s) {
    clearTimeout(stateTimer);
    state = s;
    const el = host.querySelector(".as-halo .ka");
    setAvatarState(el, s);
    host.querySelectorAll(".as-state").forEach((b) => b.classList.toggle("on", b.dataset.state === s));
    if (s === "done" || s === "fail") {
      stateTimer = setTimeout(() => playState("idle"), 1900);
    }
  }

  render();
  return {
    get: () => ({ ...av }),
    set(value, seed) { av = normalizeAvatar(value, seed ?? opts.seed ?? ""); state = "idle"; render(); },
  };
}
