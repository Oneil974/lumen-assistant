// Cartes d'exécution des outils (agent délégué, document rédigé, PDF exporté,
// image générée) : persistées avec la réponse pour qu'une discussion rouverte
// montre encore CE QUI A ÉTÉ FAIT — étapes, fichiers, sources, compte rendu.
//
// On enregistre le rendu final (HTML de la carte, déjà échappé à sa création)
// et on rebranche au rechargement les gestes qui ont encore un sens : déplier,
// copier, ouvrir/révéler un fichier, enregistrer une image. Les gestes liés à
// l'exécution (export PDF différé…) disparaissent.

import { ensureRunStyles } from "./agent-delegation.js";

const CARD_SELECTOR = ".agent-run, .file-card, .image-card";
// Une image générée en data URL pèse vite plusieurs Mo : au-delà, on garde la
// carte (moteur, chemin dans la sandbox) sans l'image, pour ménager le stockage.
const MAX_IMAGE_CHARS = 400_000;
const MAX_TOTAL_CHARS = 600_000;

/** HTML des cartes d'outils présentes dans `bubble` (tableau, éventuellement vide). */
export function snapshotToolCards(bubble) {
  if (!bubble) return [];
  const out = [];
  let total = 0;
  for (const el of bubble.querySelectorAll(CARD_SELECTOR)) {
    if (el.parentElement?.closest(CARD_SELECTOR)) continue;
    const clone = el.cloneNode(true);
    clone.querySelectorAll(".sb-prompt, .agent-run-burst").forEach((n) => n.remove());
    clone.querySelectorAll(".is-live").forEach((n) => n.classList.remove("is-live"));
    clone.querySelectorAll("img").forEach((img) => {
      if ((img.getAttribute("src") || "").length > MAX_IMAGE_CHARS) img.remove();
    });
    // Toujours en cours au moment de l'enregistrement : figé tel quel.
    if (clone.dataset.state === "run") clone.dataset.state = "fail";
    const html = clone.outerHTML;
    if (total + html.length > MAX_TOTAL_CHARS) break;
    total += html.length;
    out.push(html);
  }
  return out;
}

/**
 * Remonte des cartes enregistrées dans `bubble`, avant `before` s'il est donné.
 * @param {{invoke?:Function}} opts
 */
export function restoreToolCards(bubble, cards, { invoke, before = null } = {}) {
  if (!bubble || !Array.isArray(cards) || !cards.length) return;
  ensureRunStyles();
  for (const html of cards) {
    const tpl = document.createElement("template");
    tpl.innerHTML = String(html || "");
    const card = tpl.content.firstElementChild;
    if (!card || !card.matches(CARD_SELECTOR)) continue;
    // Seul du balisage : aucun script ni gestionnaire inline ne doit revivre.
    card.querySelectorAll("script, iframe, object, embed").forEach((n) => n.remove());
    card.querySelectorAll("*").forEach((n) => {
      for (const a of [...n.attributes]) if (/^on/i.test(a.name)) n.removeAttribute(a.name);
    });
    card.classList.add("is-restored");
    wire(card, invoke);
    bubble.insertBefore(card, before && before.parentNode === bubble ? before : null);
  }
}

function wire(card, invoke) {
  card.querySelectorAll("[data-act]").forEach((btn) => {
    const act = btn.dataset.act;
    if (act === "more") {
      btn.addEventListener("click", () => {
        card.querySelector(".doc-run-preview")?.classList.remove("is-clamped");
        btn.remove();
      });
    } else if (act === "copy") {
      btn.addEventListener("click", () => {
        const text = card.querySelector(".doc-run-preview")?.innerText || "";
        navigator.clipboard?.writeText(text).catch(() => {});
      });
    } else if ((act === "open" || act === "reveal") && card.dataset.path && invoke) {
      btn.addEventListener("click", () => {
        invoke(act === "open" ? "open_exported_file" : "backup_reveal", { path: card.dataset.path }).catch(() => {});
      });
    } else if (act === "save" && invoke && card.querySelector("img")) {
      btn.addEventListener("click", () => {
        invoke("bonsai_save_png", { dataUrl: card.querySelector("img").src, name: card.dataset.name || "image" }).catch(() => {});
      });
    } else {
      btn.remove();
    }
  });
}
