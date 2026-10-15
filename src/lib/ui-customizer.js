import { readAppearance, setAppearance, applyTheme } from "./theme.js";
// Personnalisateur d'habillage, façon shadcn/ui : trois axes qui n'échangent
// que des variables CSS. Rien n'est dupliqué par thème, aucune règle n'est
// réécrite — c'est ce qui rend le réglage instantané et global.
//
// Les choix sont persistés en localStorage et relayés aux autres fenêtres par
// l'événement `storage`, comme le fait déjà `dtTheme`.

export const UI_BASES = [
  { id: "neutral", label: "Neutre" }, { id: "stone", label: "Pierre" },
  { id: "zinc", label: "Zinc" }, { id: "gray", label: "Gris" }, { id: "slate", label: "Ardoise" },
  { id: "brume", label: "Brume" }, { id: "rosee", label: "Rosée" },
  { id: "jade", label: "Jade" }, { id: "argile", label: "Argile" }, { id: "iris", label: "Iris" },
];
export const UI_ACCENTS = [
  { id: "", label: "Palette" },
  { id: "blue", label: "Bleu" }, { id: "violet", label: "Violet" }, { id: "pink", label: "Rose" },
  { id: "rose", label: "Framboise" }, { id: "orange", label: "Orange" }, { id: "amber", label: "Ambre" },
  { id: "green", label: "Vert" }, { id: "teal", label: "Sarcelle" },
  { id: "chartreuse", label: "Vert vif" }, { id: "lime", label: "Vert lime" },
  { id: "citron", label: "Vert citron" },
  // Finitions : teintes profondes ou givrées des téléphones haut de gamme.
  { id: "bourgogne", label: "Bordeaux" }, { id: "glacier", label: "Glacier" },
  { id: "orange-cosmique", label: "Orange cosmique" }, { id: "bleu-profond", label: "Bleu profond" },
  // Demi-teintes : entre l'accent plein et son pastel, même teinte.
  { id: "mi-bleu", label: "Bleu doux" }, { id: "mi-violet", label: "Violet doux" },
  { id: "mi-rose", label: "Rose doux" }, { id: "mi-framboise", label: "Framboise douce" },
  { id: "mi-orange", label: "Orange doux" }, { id: "mi-ambre", label: "Ambre doux" },
  { id: "mi-vert", label: "Vert doux" }, { id: "mi-sarcelle", label: "Sarcelle douce" },
  { id: "orbe-rose", label: "Orbe rose" }, { id: "orbe-violet", label: "Orbe violet" },
  { id: "orbe-bleu", label: "Orbe bleu" }, { id: "orbe-menthe", label: "Orbe menthe" },
  { id: "orbe-peche", label: "Orbe pêche" },
  { id: "ciel", label: "Ciel" }, { id: "sauge", label: "Sauge" }, { id: "abricot", label: "Abricot" },
  { id: "glycine", label: "Glycine" }, { id: "sable", label: "Sable" },
];

// Habillage des pastilles d'icônes. « Natif » garde la couleur propre de chaque
// app (chaque icône a son dégradé) ; les deux autres alignent TOUTES les icônes
// sur la couleur d'action, dans un sens ou dans l'autre.
export const UI_ICON_STYLES = [
  { id: "", label: "Natif" },
  { id: "accent", label: "Sur l'accent" },
  { id: "accent-invert", label: "Accent inversé" },
];

// La lecture, l'écriture et la pose des attributs vivent dans lib/theme.js —
// le même module que le clair/sombre. Ce fichier ne garde que l'INTERFACE de
// réglage (les pastilles). Tant qu'il avait sa propre copie du stockage, un
// habillage changé ici et un thème changé ailleurs pouvaient se désynchroniser.
// Alias local, pas un ré-export : `export … from` ne crée aucune liaison dans
// ce module, et les appels internes ci-dessous échoueraient.
export const readUiTheme = () => readAppearance();

/**
 * Applique l'habillage à un document.
 *
 * Le paramètre `doc` sert aux fenêtres secondaires de même origine, qu'on
 * repeint depuis leur ouvrante. Pour le document courant, on passe par
 * `applyTheme()` afin que thème et habillage soient posés d'un seul geste.
 */
export function applyUiTheme(doc = document, theme = readUiTheme()) {
  if (doc === document) { applyTheme(); return; }
  const r = doc.documentElement;
  if (!r) return;
  r.setAttribute("data-ui-base", theme.base || "neutral");
  if (theme.accent) r.setAttribute("data-ui-accent", theme.accent);
  else r.removeAttribute("data-ui-accent");
  r.style.setProperty("--radius", `${Number(theme.radius) || 10}px`);
  if (theme.icons) r.setAttribute("data-ui-icons", theme.icons);
  else r.removeAttribute("data-ui-icons");
}

export const saveUiTheme = (patch) => setAppearance(patch);

/** Lit la couleur réelle d'un accent, pour peindre sa pastille. */
function accentColor(id) {
  if (!id) return "var(--base-primary)";
  const probe = document.createElement("div");
  probe.setAttribute("data-ui-accent", id);
  probe.style.display = "none";
  document.body.appendChild(probe);
  const c = getComputedStyle(probe).getPropertyValue("--accent-primary").trim();
  probe.remove();
  return c || "var(--base-primary)";
}

/** Monte les trois contrôles dans la page des Paramètres. */
export function mountUiCustomizer({ onChange } = {}) {
  const baseHost = document.getElementById("ui-base");
  const accentHost = document.getElementById("ui-accent");
  const iconsHost = document.getElementById("ui-icons");
  const range = document.getElementById("range-ui-radius");
  if (!baseHost || !accentHost || !range) return;
  let state = readUiTheme();

  const paint = () => {
    baseHost.querySelectorAll("[data-val]").forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.val === state.base)));
    accentHost.querySelectorAll("[data-val]").forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.val === state.accent)));
    iconsHost?.querySelectorAll("[data-val]").forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.val === state.icons)));
    range.value = state.radius;
    const lbl = document.getElementById("label-ui-radius");
    if (lbl) lbl.textContent = `${state.radius} px`;
  };
  const commit = (patch) => { state = saveUiTheme(patch); paint(); onChange?.(state); };

  const swatch = (host, list, key, colorFor) => {
    host.innerHTML = "";
    for (const item of list) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ui-swatch";
      b.dataset.val = item.id;
      b.title = item.label;
      b.setAttribute("aria-label", item.label);
      b.innerHTML = `<i style="background:${colorFor(item.id)}"></i><span>${item.label}</span>`;
      b.addEventListener("click", () => commit({ [key]: item.id }));
      host.appendChild(b);
    }
  };
  // La pastille d'une base montre son fond ET son texte : c'est le contraste
  // qui distingue « brume » de « rosée », pas la teinte seule.
  swatch(baseHost, UI_BASES, "base", (id) => {
    const p = document.createElement("div");
    p.setAttribute("data-ui-base", id); p.style.display = "none";
    document.body.appendChild(p);
    const bg = getComputedStyle(p).getPropertyValue("--muted").trim();
    const fg = getComputedStyle(p).getPropertyValue("--muted-foreground").trim();
    p.remove();
    return `linear-gradient(135deg, ${bg} 50%, ${fg} 50%)`;
  });
  swatch(accentHost, UI_ACCENTS, "accent", accentColor);
  // La pastille d'un style d'icône montre le rendu réel : dégradé d'app pour
  // « natif », aplat d'accent ou son inverse pour les deux autres.
  if (iconsHost) {
    swatch(iconsHost, UI_ICON_STYLES, "icons", (id) => {
      if (id === "accent") return "var(--accent)";
      if (id === "accent-invert") return "var(--on-accent)";
      return "linear-gradient(150deg, #6a5cff, #c75cff)";
    });
  }

  range.addEventListener("input", () => commit({ radius: range.value }));
  document.getElementById("btn-ui-shuffle")?.addEventListener("click", () => {
    const r = (a) => a[Math.floor(Math.random() * a.length)];
    commit({
      base: r(UI_BASES).id, accent: r(UI_ACCENTS).id,
      radius: String(2 * Math.floor(Math.random() * 8)), icons: r(UI_ICON_STYLES).id,
    });
  });
  document.getElementById("btn-ui-reset")?.addEventListener("click", () =>
    commit({ base: "neutral", accent: "", radius: "10", icons: "" }));

  paint();
}
