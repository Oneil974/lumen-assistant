// Ce que l'utilisateur peut réellement attendre du moteur qu'il vient de choisir.
//
// Un petit modèle local n'est pas un modèle cloud, et le dire franchement évite
// la déception des premières minutes : sans repère, l'utilisateur compare
// spontanément à ChatGPT, conclut que « ça ne marche pas », et s'arrête là.
// On annonce donc les forces ET les limites, avec la contrepartie (vie privée,
// coût, vitesse) qui justifie le choix.

import { t } from "../i18n.js";

/// Palier déduit du nombre de paramètres présent dans le nom du modèle
/// (350m, 1.7b, 8b…). Sert quand on n'a pas l'entrée de catalogue sous la main.
export function tierFromModelName(name) {
  const match = /(\d+(?:[.,]\d+)?)\s*([mb])\b/i.exec(String(name || ""));
  if (!match) return "balanced";
  let billions = parseFloat(match[1].replace(",", "."));
  if (match[2].toLowerCase() === "m") billions /= 1000;
  if (!(billions > 0)) return "balanced";
  if (billions < 2) return "fast";
  if (billions <= 8) return "balanced";
  return "powerful";
}

/**
 * Attentes réalistes pour une configuration.
 * @param {{source: string, model?: string, tier?: string}} config
 * @returns {{headline: string, good: string, weak: string, tradeoff: string}}
 */
export function modelExpectations({ source, model = "", tier = "" }) {
  if (source === "api") {
    return {
      headline: t("exp_api_head"),
      good: t("exp_api_good"),
      weak: t("exp_api_weak"),
      tradeoff: t("exp_api_tradeoff"),
    };
  }
  if (source === "shortcut") {
    return {
      headline: t("exp_apple_head"),
      good: t("exp_apple_good"),
      weak: t("exp_apple_weak"),
      tradeoff: t("exp_apple_tradeoff"),
    };
  }
  const level = tier || tierFromModelName(model);
  return {
    headline: t(`exp_${level}_head`),
    good: t(`exp_${level}_good`),
    weak: t(`exp_${level}_weak`),
    tradeoff: t("exp_local_tradeoff"),
  };
}

/// Rend l'explication dans un conteneur. Volontairement sobre : quatre lignes,
/// pas un pavé — sinon personne ne le lit.
export function renderExpectations(root, config) {
  if (!root) return;
  const exp = modelExpectations(config);
  root.classList.add("model-expectations");
  root.replaceChildren();
  const head = document.createElement("div");
  head.className = "exp-head";
  head.textContent = exp.headline;
  const good = document.createElement("div");
  good.className = "exp-line exp-good";
  good.textContent = exp.good;
  const weak = document.createElement("div");
  weak.className = "exp-line exp-weak";
  weak.textContent = exp.weak;
  const trade = document.createElement("div");
  trade.className = "exp-line exp-trade";
  trade.textContent = exp.tradeoff;
  root.append(head, good, weak, trade);
  ensureExpectationsCss();
}

const CSS_ID = "model-expectations-css";
function ensureExpectationsCss() {
  if (document.getElementById(CSS_ID)) return;
  const style = document.createElement("style");
  style.id = CSS_ID;
  style.textContent = `
.model-expectations {
  display: grid; gap: 4px; margin-top: 10px; padding: 10px 12px;
  border: 1px solid var(--line, var(--border)); border-radius: 10px;
  background: color-mix(in srgb, var(--surface, transparent) 70%, transparent);
}
.model-expectations .exp-head { font-size: 12.5px; font-weight: 600; }
.model-expectations .exp-line { font-size: 12px; line-height: 1.45; color: var(--text-muted); }
.model-expectations .exp-line::before { margin-right: 6px; }
.model-expectations .exp-good::before { content: "✓"; color: #34c759; }
.model-expectations .exp-weak::before { content: "—"; }
.model-expectations .exp-trade::before { content: "•"; }
`;
  document.head.appendChild(style);
}
