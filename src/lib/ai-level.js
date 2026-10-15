// Niveau d'IA en un réglage : Léger / Équilibré / Puissant. Chaque niveau
// fixe le modèle llama.cpp (le plus fiable en appel d'outils qui tient en
// mémoire) et la taille de contexte. Partagé par le Démarrage express et les
// Réglages ; le détail (modèle, contexte) reste modifiable en avancé.
import { LLAMA_MODEL_CATALOG } from "../llama-models.js";

export const CHAT_BY_TIER = { fast: "lfm2.5-2.6b-q4km", balanced: "qwen3-4b-q4km", powerful: "qwen3-8b-q4km" };
export const CTX_BY_TIER = { fast: 8192, balanced: 16384, powerful: 32768 };
export const TIERS = ["fast", "balanced", "powerful"];

export const levelModel = (tier) =>
  LLAMA_MODEL_CATALOG.find((m) => m.id === CHAT_BY_TIER[tier]) || LLAMA_MODEL_CATALOG.find((m) => m.tier === "fast");

/** Niveau correspondant au modèle actif, sinon null (réglage « sur mesure »). */
export function levelOf(filename) {
  return TIERS.find((tier) => levelModel(tier)?.filename === filename) || null;
}

/**
 * Carte de choix du niveau. `onApply(tier, model, ctx)` est appelé une fois le
 * modèle présent (téléchargé au besoin). `hwTier` = palier de la machine.
 */
export function mountAiLevel(root, { t, invoke, listen, hwTier, current, onApply }) {
  const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const rank = { fast: 0, balanced: 1, powerful: 2 };
  let active = levelOf(current), busy = false;
  const render = () => {
    root.innerHTML = `
      <div class="ai-level">
        <div class="ai-level-head"><b>${esc(t("lvl_title"))}</b><span>${esc(t("lvl_hint"))}</span></div>
        <div class="ai-level-seg" role="radiogroup">
          ${TIERS.map((tier) => {
            const m = levelModel(tier);
            const heavy = hwTier && rank[tier] > rank[hwTier];
            return `<button type="button" role="radio" data-tier="${tier}" aria-checked="${active === tier}" ${busy ? "disabled" : ""} class="${heavy ? "heavy" : ""}">
              <b>${esc(t(`lvl_${tier}`))}</b><small>${esc(m.label)} · ${CTX_BY_TIER[tier] / 1024}K</small>${heavy ? `<em>${esc(t("lvl_heavy"))}</em>` : ""}</button>`;
          }).join("")}
        </div>
        <p class="setting-hint" data-role="status">${active ? "" : esc(t("lvl_custom"))}</p>
      </div>`;
    root.querySelectorAll("[data-tier]").forEach((b) => b.addEventListener("click", () => apply(b.dataset.tier)));
  };
  const status = (s) => { const el = root.querySelector('[data-role="status"]'); if (el) el.textContent = s; };
  let dlId = null;
  listen?.("llama-download-progress", (e) => { const p = e?.payload || {}; if (busy && p.id === dlId) status(t("lvl_downloading", { pct: Math.round(p.percent ?? 0) })); });
  async function apply(tier) {
    if (busy) return;
    const m = levelModel(tier);
    busy = true; render();
    try {
      const have = ((await invoke("llama_list_models").catch(() => [])) || []).some((x) => x.filename === m.filename);
      if (!have) {
        dlId = m.id;
        status(t("lvl_downloading", { pct: 0 }));
        await invoke("llama_download_model", { request: { id: m.id, url: m.url, filename: m.filename, mmprojFilename: m.mmprojFilename || null, mmprojUrl: m.mmprojUrl || null } });
      }
      status(t("lvl_applying"));
      await onApply?.(tier, m, CTX_BY_TIER[tier]);
      active = tier;
      busy = false; render(); status(t("lvl_done", { name: m.label }));
    } catch (e) {
      busy = false; render(); status(String(e?.message || e));
    }
  }
  render();
  return { setCurrent(f) { active = levelOf(f); if (!busy) render(); } };
}
