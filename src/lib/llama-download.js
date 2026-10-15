// Téléchargement d'un modèle GGUF : logique partagée par l'assistant de
// configuration et les Paramètres.
//
// Elle couvre ce qu'un utilisateur non technique attend d'un transfert de
// plusieurs gigaoctets : vérification de la place disque et de la mémoire vive
// avant de commencer, bouton d'annulation, et reprise là où l'on s'était
// arrêté (le backend conserve le `.part` et redemande la suite via `Range`).

import { t } from "../i18n.js";
import { llamaModelAbout, llamaModelCardUrl, llamaModelDescription } from "../llama-models.js";

const { invoke } = window.__TAURI__?.core || { invoke: async () => { throw new Error("Tauri indisponible"); } };

/// Marqueur renvoyé par le backend quand l'utilisateur annule (cf. llama.rs).
export const CANCELLED = "download-cancelled";

export function formatBytes(bytes) {
  const units = ["o", "Ko", "Mo", "Go", "To"];
  let value = Number(bytes) || 0, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

// ===== Ressources de la machine =====
let hardwareInfo = null;

export async function loadHardware() {
  try { hardwareInfo = await invoke("system_resources"); } catch { hardwareInfo = null; }
  return hardwareInfo;
}

export function hardware() { return hardwareInfo; }

export function hardwareBannerText() {
  if (!hardwareInfo?.total_memory) return "";
  return t("hw_banner", {
    ram: formatBytes(hardwareInfo.total_memory),
    disk: formatBytes(hardwareInfo.free_disk),
    tier: t(`model_tier_${hardwareInfo.tier}`),
  });
}

const TIER_RANK = { fast: 0, balanced: 1, powerful: 2 };

/// Le modèle demande plus que ce que la machine peut offrir confortablement.
export function tierTooHeavy(tier) {
  if (!hardwareInfo?.total_memory) return false;
  return (TIER_RANK[tier] ?? 1) > (TIER_RANK[hardwareInfo.tier] ?? 1);
}

/// Pas la place sur le disque (on garde 500 Mo de marge).
export function diskTooSmall(sizeBytes) {
  if (!hardwareInfo?.free_disk || !sizeBytes) return false;
  return hardwareInfo.free_disk < Number(sizeBytes) + 500 * 1024 * 1024;
}

/// Octets déjà téléchargés par modèle (`.part` laissés par une interruption).
export async function loadPartials() {
  try {
    const entries = await invoke("llama_partial_downloads");
    return new Map((Array.isArray(entries) ? entries : []).map(([name, size]) => [name, size]));
  } catch { return new Map(); }
}

// ===== Construction d'une ligne de catalogue =====

/// Actions d'une entrée non installée : télécharger / reprendre, puis annuler
/// pendant le transfert (le même bouton change de rôle, sans re-rendu).
function downloadAction(model, { picker, partialBytes = 0, onInstalled }) {
  const resumable = partialBytes > 0 && model.sizeBytes
    ? Math.min(99, Math.floor((partialBytes / model.sizeBytes) * 100))
    : 0;
  return {
    label: resumable ? t("llama_resume", { pct: resumable }) : t("llama_download"),
    onClick: async (ctx) => {
      // Deuxième clic pendant le transfert : c'est le bouton « Annuler ».
      if (ctx.button.dataset.downloading === "1") {
        ctx.button.disabled = true;
        await invoke("llama_cancel_download", { id: model.id }).catch(() => {});
        return;
      }
      if (diskTooSmall(model.sizeBytes)) {
        ctx.setStatus(t("llama_disk_full", {
          need: formatBytes(model.sizeBytes),
          free: formatBytes(hardwareInfo?.free_disk || 0),
        }), true);
        return;
      }
      // Modèle plus lourd que la machine : on prévient une fois, un second clic
      // lance quand même (l'utilisateur reste maître de son matériel).
      if (tierTooHeavy(model.tier) && ctx.button.dataset.warned !== "1") {
        ctx.button.dataset.warned = "1";
        ctx.setStatus(t("llama_ram_warn", { ram: model.ramHint, have: formatBytes(hardwareInfo?.total_memory || 0) }), true);
        ctx.button.textContent = t("llama_download_anyway");
        return;
      }

      ctx.button.dataset.downloading = "1";
      ctx.button.textContent = t("llama_cancel");
      ctx.setProgress(resumable);
      ctx.setStatus(t("llama_downloading"));
      try {
        await invoke("llama_download_model", {
          request: {
            id: model.id,
            url: model.url,
            filename: model.filename,
            mmprojFilename: model.mmprojFilename,
            mmprojUrl: model.mmprojUrl,
          },
        });
        ctx.setStatus("");
        await onInstalled?.(model);
      } catch (e) {
        const message = String(e?.message || e);
        picker?.clearProgress(model.id);
        delete ctx.button.dataset.downloading;
        ctx.button.disabled = false;
        if (message.includes(CANCELLED)) {
          ctx.setStatus(t("llama_cancelled"));
          ctx.button.textContent = t("llama_resume_short");
        } else {
          ctx.setStatus(t("llama_download_error", { error: message }), true);
          ctx.button.textContent = t("llama_retry");
        }
      }
    },
  };
}

/**
 * Transforme une entrée du catalogue en ligne pour `catalog-picker`.
 * `extraActions` reçoit les boutons propres à l'écran appelant (ex. « Utiliser »).
 */
export function llamaCatalogItem(model, {
  installed,
  partials,
  picker,
  lang,
  onInstalled,
  installedActions = () => [],
}) {
  const partialBytes = partials?.get(model.filename) || 0;
  const heavy = !installed && tierTooHeavy(model.tier);
  return {
    id: model.id,
    title: model.label,
    meta: [
      t(`model_tier_${model.tier}`),
      model.quantization,
      model.sizeLabel,
      t("cat_ram", { ram: model.ramHint }),
    ].join(" · "),
    description: llamaModelDescription(model, lang),
    // Bouton « i » de la ligne : la présentation longue et le lien vers la
    // fiche d'origine, pour qui veut vérifier ou en savoir plus.
    info: {
      text: llamaModelAbout(model, lang),
      href: llamaModelCardUrl(model),
      linkLabel: t("cat_model_card"),
    },
    tags: [...(model.tags || []), model.family],
    tier: model.tier,
    installed,
    badge: installed ? t("cat_badge_installed") : heavy ? t("cat_badge_heavy") : "",
    actions: installed
      ? installedActions(model)
      : [downloadAction(model, { picker, partialBytes, onInstalled })],
  };
}
