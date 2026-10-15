// Mini-visite guidée de la barre principale, sur le modèle de celle du bureau
// (cf. `startDesktopTour` dans sandbox/desktop.js) : une cible mise en évidence,
// une carte qui l'explique, « Passer » / « Suivant ».
//
// Deux différences imposées par la fenêtre de la barre, qui est **transparente
// et traversable par les clics** :
//   - pas de voile sombre plein écran (il peindrait un grand rectangle noir sur
//     le bureau de l'utilisateur) : seul un anneau entoure la cible ;
//   - l'habillage est en `pointer-events: none`, sauf la carte, pour ne pas
//     bloquer le passe-clic ni la barre elle-même pendant la visite.

import { t } from "../i18n.js";

const CSS_ID = "bar-tour-css";
const DONE_KEY = "barTourDone";

const CSS = `
.bar-tour-ov { position: fixed; inset: 0; z-index: 9000; pointer-events: none; }
.bar-tour-hl {
  position: absolute; border-radius: 12px;
  box-shadow: 0 0 0 2px var(--accent, #0a84ff), 0 0 22px 4px color-mix(in srgb, var(--accent, #0a84ff) 45%, transparent);
  transition: all .3s cubic-bezier(.3,.1,.3,1);
}
.bar-tour-card {
  /* Palette autonome, volontairement indépendante du thème de la barre : la
     carte est un calque au-dessus de l'interface, et emprunter --text au thème
     clair sur ce fond sombre donnait du texte gris sur gris. */
  position: absolute; width: 300px; pointer-events: auto;
  background: rgba(28,28,30,.97);
  border: 1px solid rgba(255,255,255,.16);
  border-radius: 14px; padding: 14px 16px; color: #fff;
  backdrop-filter: blur(28px) saturate(160%); -webkit-backdrop-filter: blur(28px) saturate(160%);
  box-shadow: 0 18px 50px rgba(0,0,0,.42);
  transition: left .3s cubic-bezier(.3,.1,.3,1), top .3s cubic-bezier(.3,.1,.3,1);
}
.bar-tour-step { font-size: 11px; font-weight: 600; color: rgba(235,235,245,.55); margin-bottom: 5px; }
.bar-tour-card h3 { margin: 0 0 5px; font-size: 14.5px; font-weight: 600; }
.bar-tour-card p { margin: 0 0 12px; font-size: 12.5px; line-height: 1.5; color: rgba(235,235,245,.82); }
.bar-tour-actions { display: flex; justify-content: space-between; gap: 10px; }
.bar-tour-skip {
  border: none; background: transparent; color: rgba(235,235,245,.7);
  font-size: 12.5px; cursor: pointer; padding: 6px 4px;
}
.bar-tour-skip:hover { color: #fff; }
.bar-tour-next {
  border: none; border-radius: 9px; background: var(--accent, #0a84ff); color: var(--on-accent, #fff);
  font-size: 12.5px; font-weight: 600; padding: 7px 16px; cursor: pointer;
}
.bar-tour-next:hover { filter: brightness(1.06); }
`;

function ensureCss() {
  if (document.getElementById(CSS_ID)) return;
  const style = document.createElement("style");
  style.id = CSS_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

/// Étapes de la visite. Une étape dont la cible est absente ou masquée (bouton
/// replié dans « Plus d'outils », mode non disponible) est simplement ignorée.
const STEPS = [
  { sel: "#chat-input", title: "bar_tour_input_t", body: "bar_tour_input_b" },
  { sel: "#model-toggle-pill", title: "bar_tour_model_t", body: "bar_tour_model_b" },
  { sel: "#btn-ollama-mode", title: "bar_tour_mode_t", body: "bar_tour_mode_b" },
  { sel: "#btn-settings", title: "bar_tour_settings_t", body: "bar_tour_settings_b" },
  { sel: "#btn-history", title: "bar_tour_history_t", body: "bar_tour_history_b" },
  {
    sel: "#btn-more",
    title: "bar_tour_more_t",
    body: "bar_tour_more_b",
    // On déplie le menu le temps de l'étape : décrire des outils que
    // l'utilisateur ne voit pas ne sert à rien. Le halo se cale alors sur le
    // panneau ouvert plutôt que sur le bouton.
    focusSel: "#toolbar-overflow",
    onEnter: () => setOverflowOpen(true),
    onLeave: () => setOverflowOpen(false),
  },
  { sel: "#orb-container", title: "bar_tour_orb_t", body: "bar_tour_orb_b" },
  { sel: "#btn-lumen-os", title: "bar_tour_os_t", body: "bar_tour_os_b" },
];

/// Ouvre ou referme le menu « Plus d'outils » (mêmes classes que la barre).
function setOverflowOpen(open) {
  document.querySelector("#toolbar-overflow")?.classList.toggle("open", open);
  document.querySelector("#btn-more")?.classList.toggle("active", open);
}

function visible(sel) {
  const el = document.querySelector(sel);
  return Boolean(el && el.getClientRects().length);
}

export function barTourDone() {
  return localStorage.getItem(DONE_KEY) === "1";
}

/// Lance la visite. `force` rejoue même si elle a déjà été vue.
export function startBarTour({ force = false } = {}) {
  if (!force && barTourDone()) return;
  ensureCss();
  document.querySelector(".bar-tour-ov")?.remove();

  const steps = STEPS.filter((step) => visible(step.sel));
  if (!steps.length) return;

  const overlay = document.createElement("div");
  overlay.className = "bar-tour-ov";
  overlay.innerHTML = `<div class="bar-tour-hl"></div>
    <div class="bar-tour-card">
      <div class="bar-tour-step"></div>
      <h3></h3><p></p>
      <div class="bar-tour-actions">
        <button type="button" class="bar-tour-skip"></button>
        <button type="button" class="bar-tour-next"></button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const highlight = overlay.querySelector(".bar-tour-hl");
  const card = overlay.querySelector(".bar-tour-card");
  let index = 0;
  // Étape dont le `onEnter` a été exécuté : sert à jouer `onLeave` en sortant,
  // y compris quand la visite est abandonnée en plein milieu.
  let entered = null;

  const finish = () => {
    entered?.onLeave?.();
    entered = null;
    localStorage.setItem(DONE_KEY, "1");
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", reposition);
    observer?.disconnect();
  };

  const show = () => {
    const step = steps[index];
    if (step !== entered) {
      entered?.onLeave?.();
      step.onEnter?.();
      entered = step;
    }
    // `focusSel` : élément révélé par `onEnter` (menu déplié). On ne l'utilise
    // que s'il est réellement affiché, sinon on garde la cible d'origine.
    const target = (step.focusSel && visible(step.focusSel)
      ? document.querySelector(step.focusSel)
      : document.querySelector(step.sel));
    if (!target) return next();
    observeTarget(target);
    const rect = target.getBoundingClientRect();
    // La barre vit dans un arbre transformé (animations de l'orbe et du panneau).
    // Un ancêtre transformé devient le bloc conteneur d'un élément `fixed` : les
    // coordonnées viewport ne s'appliquent alors plus. On se cale donc sur la
    // boîte de l'habillage lui-même, ce qui reste juste dans tous les cas.
    const frame = overlay.getBoundingClientRect();
    // Certaines fenêtres (et certains contextes d'inspection) rapportent une
    // taille nulle au premier rendu : sans ce repli, la carte se tasserait dans
    // le coin supérieur gauche au lieu de suivre sa cible.
    const frameW = frame.width || document.documentElement.clientWidth || window.innerWidth || 720;
    const frameH = frame.height || document.documentElement.clientHeight || window.innerHeight || 550;
    const pad = 6;
    highlight.style.left = `${rect.left - frame.left - pad}px`;
    highlight.style.top = `${rect.top - frame.top - pad}px`;
    highlight.style.width = `${rect.width + pad * 2}px`;
    highlight.style.height = `${rect.height + pad * 2}px`;

    overlay.querySelector(".bar-tour-step").textContent = `${index + 1} / ${steps.length}`;
    overlay.querySelector("h3").textContent = t(step.title);
    overlay.querySelector("p").textContent = t(step.body);
    overlay.querySelector(".bar-tour-skip").textContent = t("tour_skip");
    overlay.querySelector(".bar-tour-next").textContent =
      index === steps.length - 1 ? t("tour_done") : t("tour_next");

    // La carte se place sous la cible, ou au-dessus si l'on déborde du bas —
    // le tout dans le repère de l'habillage, comme le halo.
    const width = 300;
    const height = card.offsetHeight || 150;
    const localLeft = rect.left - frame.left;
    const localTop = rect.top - frame.top;
    const maxX = Math.max(10, frameW - width - 10);
    const x = Math.min(Math.max(10, localLeft - 20), maxX);
    let y = localTop + rect.height + 14;
    if (y + height > frameH - 10) y = Math.max(10, localTop - height - 14);
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
  };

  // La barre se replie, s'élargit et se déplace : on recalcule plutôt que de
  // laisser le halo pointer à côté.
  const reposition = () => { if (overlay.isConnected) show(); };
  window.addEventListener("resize", reposition);

  // La barre s'anime encore à l'ouverture (le champ s'élargit, des boutons se
  // replient) : un halo calé une seule fois pointerait à côté. On suit donc la
  // cible tant que la visite est à l'écran.
  const observer = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => reposition())
    : null;
  let observed = null;
  const observeTarget = (target) => {
    if (!observer || target === observed) return;
    if (observed) observer.unobserve(observed);
    observer.observe(target);
    observed = target;
  };

  const next = () => {
    index += 1;
    if (index >= steps.length) return finish();
    show();
    // Le panneau « Plus d'outils » s'ouvre avec une transition : on recale le
    // halo une fois qu'elle est terminée.
    setTimeout(reposition, 260);
  };

  const onKey = (event) => {
    if (event.key === "Escape") finish();
    else if (event.key === "Enter") next();
  };

  overlay.querySelector(".bar-tour-next").addEventListener("click", next);
  overlay.querySelector(".bar-tour-skip").addEventListener("click", finish);
  document.addEventListener("keydown", onKey);
  show();
  // Deuxième passe une fois la mise en page stabilisée (polices, transitions).
  requestAnimationFrame(() => setTimeout(reposition, 350));
}

/// Démarre la visite au premier lancement, une fois l'assistant terminé.
export function maybeStartBarTour() {
  if (barTourDone()) return;
  if (localStorage.getItem("onboardingDone") !== "true") return;
  // Laisse la barre finir de se peindre (icônes, largeur, boutons repliés).
  setTimeout(() => startBarTour(), 900);
}
