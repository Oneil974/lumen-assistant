// Raccourcis clavier de Lumen Desktop — conventions macOS / Linux.
//
// Lumen Desktop est un bureau DANS une fenêtre. Ça impose une contrainte que rien ne
// contourne : les raccourcis que le système hôte s'est réservés n'arrivent
// jamais jusqu'à la page.
//
//  - **⌘Tab est confisqué par macOS**, **Alt+Tab par le gestionnaire de
//    fenêtres sous Linux et Windows.** On ne peut pas les capturer, même en
//    `preventDefault()` : l'évènement ne parvient pas au webview.
//  - En revanche **Ctrl+Tab est libre partout**, et **Alt+Tab est libre sur
//    macOS** (là c'est ⌘Tab qui bascule les apps du système).
//
// D'où le choix : le sélecteur de fenêtres répond à **Ctrl+Tab** partout, et
// **Alt+Tab en plus sur macOS** — le geste est alors le même que celui du
// système, à la touche de modification près. C'est la seule combinaison qui
// donne le réflexe « Alt+Tab » sans se battre contre l'OS.
//
// Le reste suit macOS quand la touche est libre (⌘W fermer, ⌘M réduire,
// ⌘` fenêtre suivante) et Linux/Windows sinon (F11 plein écran, Ctrl+Échap
// menu démarrer).
//
// ## Les évènements clavier et les iframes
//
// Chaque app du bureau vit dans une iframe même-origine. Un `keydown` qui s'y
// produit ne remonte PAS au document parent : sans traitement, les raccourcis
// cesseraient de marcher dès qu'on clique dans une app — c'est-à-dire tout le
// temps. On observe donc les iframes et on écoute aussi leur document.

import { tt } from "../apps-i18n.js";

const IS_MAC = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "");

/** Table des raccourcis, pour le panneau d'aide et la visite guidée. */
export function shortcutList() {
  const mod = IS_MAC ? "⌘" : "Ctrl";
  return [
    { group: "Fenêtres", keys: ["Ctrl+Tab", ...(IS_MAC ? ["⌥Tab"] : [])], label: "Sélecteur de fenêtres (maintenir, Tab pour avancer, ⇧Tab pour reculer)" },
    { group: "Fenêtres", keys: [`${mod}\``], label: "Passer à la fenêtre suivante" },
    { group: "Fenêtres", keys: [`${mod}W`], label: "Fermer la fenêtre active" },
    { group: "Fenêtres", keys: [`${mod}M`], label: "Réduire la fenêtre active" },
    { group: "Fenêtres", keys: [`${mod}D`], label: "Afficher le bureau (réduit / restaure tout)" },
    { group: "Bureau", keys: [`${mod}K`], label: "Recherche globale (apps, fenêtres, fichiers)" },
    { group: "Bureau", keys: ["Ctrl+Échap"], label: "Menu démarrer" },
    { group: "Bureau", keys: ["F11"], label: "Plein écran" },
    { group: "Bureau", keys: [`${mod}/`, "F1"], label: "Afficher cette aide" },
    { group: "Bureau", keys: ["Échap"], label: "Fermer le panneau ou le sélecteur ouvert" },
  ];
}

/**
 * Installe les raccourcis. `ctx` fournit les actions du bureau :
 *   listWindows() → [{ id, title, icon, minimized }] en ordre d'utilisation
 *                   (la plus récente d'abord) ;
 *   focus/close/minimize(id), toggleShowDesktop(), openStartMenu(),
 *   openSearch(), toggleFullscreen(), isDesktopActive().
 */
export function installOsShortcuts(ctx) {
  if (window.__dtOsKeys) return;
  window.__dtOsKeys = true;

  let switcher = null; // { el, items, index }

  const onKeyDown = (e) => {
    if (!ctx.isDesktopActive()) return;
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    const key = (e.key || "").toLowerCase();

    // ----- Sélecteur de fenêtres -----
    // Ctrl+Tab partout ; ⌥Tab en plus sur macOS, où la combinaison est libre.
    if (key === "tab" && (e.ctrlKey || (IS_MAC && e.altKey))) {
      e.preventDefault();
      cycle(e.shiftKey ? -1 : 1);
      return;
    }
    if (key === "escape" && document.querySelector(".dt-keyhelp")) {
      e.preventDefault();
      document.querySelector(".dt-keyhelp").remove();
      return;
    }
    if (switcher) {
      if (key === "escape") { e.preventDefault(); closeSwitcher(false); return; }
      if (key === "arrowright" || key === "arrowdown") { e.preventDefault(); cycle(1); return; }
      if (key === "arrowleft" || key === "arrowup") { e.preventDefault(); cycle(-1); return; }
      if (key === "enter") { e.preventDefault(); closeSwitcher(true); return; }
    }

    // ----- Fenêtre active -----
    if (mod && key === "`") { e.preventDefault(); nextWindow(e.shiftKey ? -1 : 1); return; }
    if (mod && key === "w") {
      const win = current();
      if (win) { e.preventDefault(); ctx.close(win.id); }
      return;
    }
    if (mod && key === "m") {
      const win = current();
      if (win) { e.preventDefault(); ctx.minimize(win.id); }
      return;
    }
    if (mod && key === "d") { e.preventDefault(); ctx.toggleShowDesktop(); return; }

    // ----- Bureau -----
    // ⌘K comme Ctrl+K : la recherche globale répondait déjà aux deux, et la
    // visite guidée l'annonce ainsi.
    if ((e.metaKey || e.ctrlKey) && key === "k") { e.preventDefault(); ctx.openSearch(); return; }
    if (e.ctrlKey && key === "escape") { e.preventDefault(); ctx.openStartMenu(); return; }
    if (key === "f11") { e.preventDefault(); ctx.toggleFullscreen(); return; }
    if ((mod && key === "/") || key === "f1") { e.preventDefault(); toggleHelp(); return; }
  };

  // La touche de modification relâchée valide la sélection — c'est ce qui donne
  // le geste « maintenir et lâcher » du sélecteur système.
  const onKeyUp = (e) => {
    if (!switcher) return;
    const k = e.key;
    if (k === "Control" || k === "Alt" || k === "Meta") closeSwitcher(true);
  };

  const current = () => ctx.listWindows()[0] || null;

  function nextWindow(dir) {
    const wins = ctx.listWindows();
    if (wins.length < 2) return;
    // La liste est en ordre d'utilisation : la « suivante » est la deuxième.
    ctx.focus(dir > 0 ? wins[1].id : wins[wins.length - 1].id);
  }

  // ----- Overlay du sélecteur -----

  function cycle(dir) {
    if (!switcher) {
      const wins = ctx.listWindows();
      if (wins.length < 2) return;
      openSwitcher(wins);
    }
    const n = switcher.items.length;
    switcher.index = (switcher.index + dir + n) % n;
    paintSwitcher();
  }

  function openSwitcher(wins) {
    const el = document.createElement("div");
    el.className = "dt-switcher";
    el.innerHTML = `<div class="dt-switcher-row"></div><div class="dt-switcher-name"></div>`;
    const row = el.querySelector(".dt-switcher-row");
    for (const w of wins) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "dt-switcher-item" + (w.minimized ? " minimized" : "");
      // Pastille dégradée + glyphe blanc : la même présentation que le menu
      // démarrer et le dock, seul rendu lisible pour ces icônes au trait.
      const [c1, c2] = w.grad || ["#8e8e93", "#3a3a3c"];
      card.innerHTML = `<span class="dt-switcher-ic" style="--c1:${c1};--c2:${c2 || c1}">${w.icon || ""}</span>`;
      card.title = w.title;
      // Clic direct : le sélecteur reste utilisable à la souris, comme le Dock.
      card.addEventListener("click", () => { switcher.index = wins.indexOf(w); closeSwitcher(true); });
      row.appendChild(card);
    }
    document.body.appendChild(el);
    // index 1 = la fenêtre précédente : un aller-retour Ctrl+Tab bascule entre
    // les deux dernières fenêtres, comme sur macOS et sous GNOME.
    switcher = { el, items: wins, index: 0 };
  }

  function paintSwitcher() {
    if (!switcher) return;
    const cards = switcher.el.querySelectorAll(".dt-switcher-item");
    cards.forEach((c, i) => c.classList.toggle("on", i === switcher.index));
    switcher.el.querySelector(".dt-switcher-name").textContent =
      switcher.items[switcher.index]?.title || "";
  }

  function closeSwitcher(commit) {
    if (!switcher) return;
    const target = switcher.items[switcher.index];
    switcher.el.remove();
    switcher = null;
    if (commit && target) ctx.focus(target.id);
  }

  // ----- Panneau d'aide -----

  function toggleHelp() {
    const open = document.querySelector(".dt-keyhelp");
    if (open) { open.remove(); return; }
    const lay = document.createElement("div");
    lay.className = "dt-keyhelp";
    const groups = [...new Set(shortcutList().map((s) => s.group))];
    lay.innerHTML = `<div class="dt-keyhelp-card">
      <div class="dt-keyhelp-head">${tt("Raccourcis clavier")}</div>
      ${groups.map((g) => `
        <div class="dt-keyhelp-group">${tt(g)}</div>
        ${shortcutList().filter((s) => s.group === g).map((s) => `
          <div class="dt-keyhelp-row">
            <span class="dt-keyhelp-keys">${s.keys.map((k) => `<kbd>${k}</kbd>`).join(" ")}</span>
            <span class="dt-keyhelp-label">${tt(s.label)}</span>
          </div>`).join("")}`).join("")}
      <p class="dt-keyhelp-note">${tt("⌘Tab (macOS) et Alt+Tab (Linux, Windows) appartiennent au système : ils basculent entre les applications de l'ordinateur, pas entre les fenêtres de Lumen Desktop.")}</p>
    </div>`;
    lay.addEventListener("click", (e) => { if (e.target === lay) lay.remove(); });
    document.body.appendChild(lay);
  }

  // ----- Branchement, y compris dans les apps embarquées -----

  function attach(doc) {
    if (!doc || doc.__dtOsKeys) return;
    doc.__dtOsKeys = true;
    doc.addEventListener("keydown", onKeyDown, true);
    doc.addEventListener("keyup", onKeyUp, true);
  }

  attach(document);
  // Le focus qui quitte la fenêtre pendant un maintien de Ctrl : sans ça, le
  // `keyup` n'arrive jamais et l'overlay reste collé à l'écran.
  window.addEventListener("blur", () => closeSwitcher(true));

  const wire = (frame) => {
    const tryAttach = () => { try { attach(frame.contentDocument); } catch { /* cross-origin */ } };
    tryAttach();
    frame.addEventListener("load", tryAttach);
  };
  document.querySelectorAll("iframe").forEach(wire);
  new MutationObserver((records) => {
    for (const rec of records) {
      for (const node of rec.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === "IFRAME") wire(node);
        else node.querySelectorAll?.("iframe").forEach(wire);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

  return { openHelp: toggleHelp };
}
