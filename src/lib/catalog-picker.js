// Liste compacte, filtrable et à hauteur bornée, partagée par tous les
// catalogues téléchargeables de Lumen (modèles GGUF llama.cpp, modèles Ollama,
// voix Piper/Kokoro). Le but est d'éviter les longues pages qui défilent à
// l'infini : la liste garde sa propre zone de défilement (`--catalog-max-h`),
// et les puces de filtre + la recherche ramènent le choix à quelques lignes.
//
// Usage :
//   const picker = createCatalogPicker(root, { chips, searchPlaceholder, ... });
//   picker.setItems(items);            // re-rend la liste
//   picker.setProgress(id, 42);        // barre de progression d'une ligne
//   picker.setStatus(id, "…", true);   // message sous une ligne
//
// item = { id, title, meta, description, tags: [], installed: bool,
//          actions: [{ label, kind: "default"|"danger", onClick(ctx) }] }
// ctx = { item, button, setProgress(pct), setStatus(text, isError), refresh() }

import { openExternal } from "./open-external.js";

const CSS_ID = "catalog-picker-css";
const PICKER_CSS = `
.catalog-picker { display: grid; gap: 8px; }
.catalog-picker-tools { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.catalog-picker-search {
  flex: 1 1 150px; min-width: 120px; height: 30px; padding: 0 10px;
  border: 1px solid var(--line, var(--border)); border-radius: 999px;
  background: var(--surface-3, transparent); color: var(--text); font-size: 12.5px;
}
.catalog-chip {
  border: 1px solid var(--line, var(--border)); border-radius: 999px;
  padding: 4px 10px; font-size: 11.5px; line-height: 1.3; cursor: pointer;
  background: transparent; color: var(--text-muted); white-space: nowrap;
}
.catalog-chip:hover { color: var(--text); }
.catalog-chip.active { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.catalog-list {
  display: grid; gap: 6px;
  max-height: var(--catalog-max-h, 268px); overflow-y: auto; overscroll-behavior: contain;
  padding-right: 2px;
}
.catalog-row {
  display: grid; grid-template-columns: 1fr auto; gap: 4px 10px; align-items: center;
  padding: 8px 10px; border: 1px solid var(--line, var(--border)); border-radius: 10px;
  background: color-mix(in srgb, var(--surface, transparent) 78%, transparent);
}
.catalog-row.installed { border-color: color-mix(in srgb, var(--accent) 55%, var(--line, var(--border))); }
.catalog-row-title { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.catalog-row-badge {
  font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .02em;
  padding: 1px 6px; border-radius: 999px; background: var(--accent); color: var(--on-accent);
}
.catalog-row-meta { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
.catalog-row-desc { font-size: 11.5px; color: var(--text-muted); margin-top: 3px; display: none; }
.catalog-row.expanded .catalog-row-desc { display: block; }
.catalog-row-actions { display: flex; gap: 6px; align-items: center; }
.catalog-row-btn {
  border: 1px solid var(--line, var(--border)); border-radius: 8px; background: var(--surface-3, transparent);
  color: var(--text); font-size: 11.5px; padding: 4px 10px; cursor: pointer; white-space: nowrap;
}
.catalog-row-btn:hover:not(:disabled) { filter: brightness(1.08); }
.catalog-row-btn:disabled { opacity: .55; cursor: default; }
.catalog-row-btn.danger { color: var(--danger, #ff3b30); }
.catalog-row-progress { grid-column: 1 / -1; height: 4px; border-radius: 4px; overflow: hidden; background: var(--line, var(--border)); }
.catalog-row-progress > span { display: block; height: 100%; width: 0; background: var(--accent); transition: width .2s ease; }
.catalog-row-status { grid-column: 1 / -1; font-size: 11px; color: var(--text-muted); }
.catalog-row-status.error { color: var(--danger, #ff3b30); }
/* Bouton info : discret par construction — pas de fond, pas de bordure, la
   couleur d'un texte secondaire. Il ne doit pas concurrencer le bouton
   « Télécharger », qui reste l'action de la ligne. */
.catalog-row-info {
  border: 0; background: transparent; padding: 0; cursor: help;
  width: 15px; height: 15px; flex: 0 0 auto; border-radius: 999px;
  color: var(--text-muted); opacity: .6; display: inline-flex;
  align-items: center; justify-content: center;
}
.catalog-row-info:hover, .catalog-row-info:focus-visible { opacity: 1; color: var(--accent-ink); }
.catalog-row-info svg { width: 100%; height: 100%; }
/* L'ancrage porte le positionnement pour que l'infobulle suive le bouton. */
.catalog-info-anchor { position: relative; display: inline-flex; }
.catalog-info-tip {
  position: absolute; z-index: 40; left: 0; top: calc(100% + 6px);
  width: max-content; max-width: 270px;
  padding: 9px 11px; border-radius: 9px;
  border: 1px solid var(--line, var(--border));
  background: var(--surface-2, var(--card, #1b1d24));
  box-shadow: 0 10px 28px rgb(0 0 0 / .28);
  font-size: 11.5px; font-weight: 400; line-height: 1.5; color: var(--text);
  white-space: normal; text-align: left;
}
/* Près du bord droit, l'infobulle déborderait du panneau : on l'aligne à droite. */
.catalog-info-tip.flip { left: auto; right: 0; }
.catalog-info-tip a { color: var(--accent-ink); }
.catalog-info-src { display: block; margin-top: 6px; font-size: 10.5px; color: var(--text-muted); }
.catalog-group-title {
  position: sticky; top: 0; z-index: 1; margin-top: 4px; padding: 4px 2px;
  font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em;
  color: var(--text-muted); background: var(--surface, var(--bg, transparent));
  display: flex; justify-content: space-between;
}
.catalog-group-title:first-child { margin-top: 0; }
.catalog-picker-count { font-size: 11px; color: var(--text-muted); }
.catalog-picker-empty {
  padding: 10px; border: 1px dashed var(--line, var(--border)); border-radius: 10px;
  font-size: 12px; color: var(--text-muted); text-align: center;
}
`;

function ensureCss() {
  if (document.getElementById(CSS_ID)) return;
  const style = document.createElement("style");
  style.id = CSS_ID;
  style.textContent = PICKER_CSS;
  document.head.appendChild(style);
}

function matchesSearch(item, query) {
  if (!query) return true;
  const haystack = `${item.title || ""} ${item.meta || ""} ${item.description || ""} ${(item.tags || []).join(" ")}`;
  return haystack.toLowerCase().includes(query);
}

/**
 * @param {HTMLElement} root conteneur (vidé à chaque rendu)
 * @param {{chips?: {id: string, label: string, test?: (item: any) => boolean}[],
 *          searchPlaceholder?: string, emptyLabel?: string,
 *          countLabel?: (shown: number, total: number) => string,
 *          maxHeight?: string}} options
 */
export function createCatalogPicker(root, options = {}) {
  ensureCss();
  const chips = options.chips || [];
  // `search: false`, ou aucun placeholder fourni : la recherche disparaît.
  const showSearch = options.search !== false && Boolean(options.searchPlaceholder);
  let items = [];
  let activeChip = chips[0]?.id || "";
  // Vrai dès que l'utilisateur a choisi un filtre : l'appelant peut alors
  // cesser de proposer un filtre par défaut (ex. le palier de la machine).
  let chipTouched = false;
  let query = "";
  const progress = new Map();
  const statuses = new Map();

  root.classList.add("catalog-picker");
  if (options.maxHeight) root.style.setProperty("--catalog-max-h", options.maxHeight);

  const tools = document.createElement("div");
  tools.className = "catalog-picker-tools";
  const list = document.createElement("div");
  list.className = "catalog-list";
  const count = document.createElement("div");
  count.className = "catalog-picker-count";
  root.replaceChildren(tools, list, count);

  const search = document.createElement("input");
  search.type = "search";
  search.className = "catalog-picker-search";
  search.placeholder = options.searchPlaceholder || "";
  search.addEventListener("input", () => {
    query = search.value.trim().toLowerCase();
    render();
  });

  // La barre d'outils est construite UNE FOIS. La reconstruire à chaque rendu
  // retirait l'input de recherche du DOM à chaque frappe : le retrait provoque
  // un blur, et le champ perdait le focus dès la première lettre. Les rendus
  // suivants se contentent donc de mettre à jour l'état actif des puces.
  const chipButtons = new Map();
  let toolsBuilt = false;

  function buildTools() {
    tools.replaceChildren(...(showSearch ? [search] : []));
    chipButtons.clear();
    for (const chip of chips) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "catalog-chip";
      btn.textContent = chip.label;
      btn.addEventListener("click", () => {
        activeChip = chip.id;
        chipTouched = true;
        render();
      });
      chipButtons.set(chip.id, btn);
      tools.appendChild(btn);
    }
    toolsBuilt = true;
  }

  function renderTools() {
    // Barre d'outils inutile quand il n'y a ni filtre ni recherche (petite liste).
    if (!showSearch && !chips.length) { tools.hidden = true; return; }
    tools.hidden = false;
    if (!toolsBuilt) buildTools();
    for (const [id, btn] of chipButtons) btn.classList.toggle("active", id === activeChip);
  }

  function visibleItems() {
    const chip = chips.find((c) => c.id === activeChip);
    return items.filter((item) =>
      (!chip?.test || chip.test(item)) && matchesSearch(item, query)
    );
  }

  function makeCtx(item, button, row) {
    return {
      item,
      button,
      setProgress: (pct) => setProgress(item.id, pct),
      setStatus: (text, isError) => setStatus(item.id, text, isError),
      row,
      refresh: render,
    };
  }

  /// Bouton « i » et son infobulle, montrés au survol comme au clavier.
  ///
  /// L'infobulle n'est PAS un attribut `title=` : celui du navigateur arrive
  /// après une seconde, ne se met pas en forme et ne peut pas porter le lien
  /// vers la fiche d'origine — or c'est justement ce lien qui permet à un
  /// débutant d'aller vérifier ce qu'on lui résume.
  function infoButton(item) {
    const anchor = document.createElement("span");
    anchor.className = "catalog-info-anchor";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "catalog-row-info";
    btn.setAttribute("aria-label", options.infoLabel || "Informations");
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M12 11v5.5"/><path d="M12 7.6v.6"/></svg>`;

    const tip = document.createElement("span");
    tip.className = "catalog-info-tip";
    tip.hidden = true;
    tip.setAttribute("role", "tooltip");
    tip.append(item.info.text);
    if (item.info.href) {
      const link = document.createElement("a");
      link.className = "catalog-info-src";
      link.href = item.info.href;
      link.target = "_blank";
      link.rel = "noreferrer noopener";
      link.textContent = item.info.linkLabel || item.info.href;
      // Le lien doit rester cliquable : sans ça, quitter le bouton pour aller
      // vers lui referme l'infobulle avant qu'on l'atteigne. Et `target=_blank`
      // ne fait rien dans la WebView : on passe par le navigateur système.
      link.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        openExternal(link.href);
      });
      tip.appendChild(link);
    }

    let hideTimer = null;
    const show = () => {
      clearTimeout(hideTimer);
      tip.hidden = false;
      // Débordement à droite : mesuré une fois affichée, la largeur dépendant
      // du texte.
      const box = tip.getBoundingClientRect();
      const limit = list.getBoundingClientRect().right;
      tip.classList.toggle("flip", box.right > limit);
    };
    const hide = () => { hideTimer = setTimeout(() => { tip.hidden = true; }, 120); };

    anchor.addEventListener("mouseenter", show);
    anchor.addEventListener("mouseleave", hide);
    btn.addEventListener("focus", show);
    btn.addEventListener("blur", hide);
    // Au doigt, il n'y a pas de survol : le clic bascule.
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (tip.hidden) show(); else tip.hidden = true;
    });

    anchor.append(btn, tip);
    return anchor;
  }

  function renderRow(item) {
    const row = document.createElement("div");
    row.className = "catalog-row" + (item.installed ? " installed" : "");
    row.dataset.itemId = item.id;

    const main = document.createElement("div");
    const title = document.createElement("div");
    title.className = "catalog-row-title";
    title.append(item.title || item.id);
    if (item.badge) {
      const badge = document.createElement("span");
      badge.className = "catalog-row-badge";
      badge.textContent = item.badge;
      title.appendChild(badge);
    }
    // Bouton info : le détail « d'où vient ce modèle et à quoi il sert » sans
    // allonger la ligne. Une liste de 24 modèles où chacun expose trois phrases
    // ne se lit plus ; repliée derrière un « i », l'information reste à un
    // survol de distance pour qui en a besoin, invisible pour les autres.
    if (item.info?.text) title.appendChild(infoButton(item));
    main.appendChild(title);
    if (item.meta) {
      const meta = document.createElement("div");
      meta.className = "catalog-row-meta";
      meta.textContent = item.meta;
      main.appendChild(meta);
    }
    if (item.description) {
      const desc = document.createElement("div");
      desc.className = "catalog-row-desc";
      desc.textContent = item.description;
      main.appendChild(desc);
      // La description reste repliée : c'est ce qui garde la liste compacte.
      main.style.cursor = "pointer";
      main.addEventListener("click", () => row.classList.toggle("expanded"));
    }
    row.appendChild(main);

    const actions = document.createElement("div");
    actions.className = "catalog-row-actions";
    for (const action of item.actions || []) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "catalog-row-btn" + (action.kind === "danger" ? " danger" : "");
      btn.textContent = action.label;
      btn.addEventListener("click", () => action.onClick?.(makeCtx(item, btn, row)));
      actions.appendChild(btn);
    }
    row.appendChild(actions);

    const bar = document.createElement("div");
    bar.className = "catalog-row-progress";
    bar.hidden = !progress.has(item.id);
    const fill = document.createElement("span");
    if (progress.has(item.id)) fill.style.width = `${progress.get(item.id)}%`;
    bar.appendChild(fill);
    row.appendChild(bar);

    const status = statuses.get(item.id);
    const statusEl = document.createElement("div");
    statusEl.className = "catalog-row-status" + (status?.isError ? " error" : "");
    statusEl.textContent = status?.text || "";
    statusEl.hidden = !status?.text;
    row.appendChild(statusEl);

    return row;
  }

  function render() {
    renderTools();
    const shown = visibleItems();
    list.replaceChildren();
    if (!shown.length) {
      const empty = document.createElement("div");
      empty.className = "catalog-picker-empty";
      empty.textContent = options.emptyLabel || "—";
      list.appendChild(empty);
    } else if (options.groupBy) {
      // Sections façon bibliothèque Ollama : un titre par famille, dans
      // l'ordre fourni par `groupOrder`, les lignes gardant leur ordre propre.
      const groups = new Map();
      for (const item of shown) {
        const g = options.groupBy(item) || "";
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(item);
      }
      const order = options.groupOrder || (() => 0);
      for (const [g, rows] of [...groups].sort((a, b) => order(a[0]) - order(b[0]))) {
        const head = document.createElement("div");
        head.className = "catalog-group-title";
        const name = document.createElement("span");
        name.textContent = options.groupLabel ? options.groupLabel(g) : g;
        const n = document.createElement("span");
        n.textContent = String(rows.length);
        head.append(name, n);
        list.appendChild(head);
        for (const item of rows) list.appendChild(renderRow(item));
      }
    } else {
      for (const item of shown) list.appendChild(renderRow(item));
    }
    count.textContent = options.countLabel ? options.countLabel(shown.length, items.length) : "";
  }

  function rowFor(id) {
    return [...list.children].find((el) => el.dataset?.itemId === String(id)) || null;
  }

  function setProgress(id, pct) {
    const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
    progress.set(id, clamped);
    const bar = rowFor(id)?.querySelector(".catalog-row-progress");
    if (bar) {
      bar.hidden = false;
      bar.firstElementChild.style.width = `${clamped}%`;
    }
  }

  function clearProgress(id) {
    progress.delete(id);
    const bar = rowFor(id)?.querySelector(".catalog-row-progress");
    if (bar) bar.hidden = true;
  }

  function setStatus(id, text, isError = false) {
    if (!text) statuses.delete(id);
    else statuses.set(id, { text, isError });
    const el = rowFor(id)?.querySelector(".catalog-row-status");
    if (el) {
      el.textContent = text || "";
      el.hidden = !text;
      el.classList.toggle("error", Boolean(isError));
    }
  }

  render();

  return {
    setItems(next) { items = Array.isArray(next) ? next : []; render(); },
    /// Présélectionne un filtre tant que l'utilisateur n'en a pas choisi un.
    selectChip(id) {
      if (chipTouched || !chips.some((c) => c.id === id)) return;
      activeChip = id;
      render();
    },
    get chipTouched() { return chipTouched; },
    setProgress,
    clearProgress,
    setStatus,
    refresh: render,
    get element() { return root; },
  };
}
