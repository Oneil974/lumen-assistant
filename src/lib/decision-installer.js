// Carte d'installation du moteur de décision (Tev1-0.8B), partagée par
// l'assistant de premier démarrage et les Réglages.
//
// llama.cpp : le GGUF passe par `llama_download_model` (reprise, annulation,
// événements `llama-download-progress` filtrés par id) ;
// Ollama    : `ollama_pull` du dépôt Hugging Face (`hf.co/…`), événements
//             `ollama-pull-*` filtrés par nom de modèle.
import {
  DECISION_MODELS, decisionModel, setDecisionModel, decisionEngineFor, decisionEnabled, setDecisionEnabled,
  decisionStatus, ollamaHasDecisionModel, resetDecisionCache,
} from "./decision.js";

const invoke = (...a) => window.__TAURI__.core.invoke(...a);
const listen = (...a) => window.__TAURI__?.event?.listen?.(...a);
const sizeLabel = (bytes) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1).replace(".", ",")} Go` : `${Math.round(bytes / 1e6)} Mo`;
// Moteur effectif pour le modèle choisi : un modèle « GGUF seulement » passe
// par le llama.cpp intégré même quand la discussion utilise Ollama, et l'inverse.
const engineOf = (engine) => decisionEngineFor(engine === "ollama" ? "ollama" : "llama");

/**
 * Installe le moteur (sans interface, utilisé aussi en fin d'assistant).
 * Ollama : tirage `hf.co/…` ; s'il échoue (Ollama récents : redirection de
 * Hugging Face vers son CDN refusée), téléchargement du GGUF par Lumen puis
 * import dans Ollama. Ne rejette jamais : renvoie true/false.
 */
export async function installDecisionInBackground({ engine, ollamaUrl }) {
  const model = decisionModel();
  engine = engineOf(engine);
  const downloadGguf = async () => {
    if ((await decisionStatus(undefined, { fresh: true })).installed) return;
    await invoke("llama_download_model", { request: { id: `decision-${model.id}`, url: model.url, filename: model.filename } });
  };
  try {
    if (engine === "ollama") {
      try {
        await invoke("ollama_pull", { url: ollamaUrl, model: model.ollama[0] });
      } catch (e) {
        // Repli historique de Tev1 0.8B : GGUF téléchargé puis importé.
        if (model.id !== "tev1") throw e;
        console.info("[decision] tirage refusé, import du GGUF :", e);
        await downloadGguf();
        await invoke("decision_ollama_import", { ollamaUrl });
      }
    } else {
      await downloadGguf();
    }
    resetDecisionCache();
    return true;
  } catch (e) {
    console.warn("[decision] install", e);
    resetDecisionCache();
    return false;
  }
}

// Styles minimaux : la carte vit aussi dans les Réglages, qui n'ont pas la
// feuille de l'assistant (.ob-progress, .onboarding-step-card-row…).
function injectStyle() {
  if (document.getElementById("decision-box-style")) return;
  const st = document.createElement("style");
  st.id = "decision-box-style";
  st.textContent = `
    .decision-box .decision-card { display:flex; align-items:center; justify-content:space-between; gap:12px; }
    .decision-box .decision-card code { font-size:11px; word-break:break-all; }
    .decision-box .ob-progress { height:4px; border-radius:2px; background:color-mix(in oklch, currentColor 12%, transparent); overflow:hidden; margin-top:8px; }
    .decision-box .ob-progress-bar { height:100%; width:0; background:var(--primary, #6366f1); transition:width .2s; }
    .decision-box label { display:flex; align-items:center; gap:6px; margin-top:6px; cursor:pointer; }
    .decision-box .decision-pick { display:flex; align-items:center; gap:8px; margin:8px 0 2px; cursor:default; }
    .decision-box .decision-pick select { flex:1; min-width:0; }`;
  document.head.appendChild(st);
}

/** Le moteur est-il déjà installé pour ce moteur d'inférence ? */
export async function decisionInstalled({ engine, ollamaUrl }) {
  if (engineOf(engine) === "ollama") return ollamaHasDecisionModel(ollamaUrl);
  return Boolean((await decisionStatus(undefined, { fresh: true })).installed);
}

/**
 * Monte la carte dans `root`. `opts.t` = fonction de traduction,
 * `opts.engine` = "llama" | "ollama", `opts.ollamaUrl` pour Ollama.
 * Renvoie { refresh(), wantsAutoInstall() }.
 */
export function mountDecisionCard(root, { t, engine, ollamaUrl = "http://127.0.0.1:11434", autoOption = false }) {
  injectStyle();
  root.classList.add("decision-box");
  const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const en = document.documentElement.lang === "en" || localStorage.getItem("lang") === "en";
  root.innerHTML = `
    <div class="onboarding-step-card-row decision-card">
      <div class="shortcut-card-info">
        <div class="shortcut-card-name">${esc(t("decision_title"))}</div>
        <div class="shortcut-card-desc">${esc(t("decision_desc"))}</div>
        <div class="shortcut-card-desc" data-role="model-line"></div>
      </div>
      <button class="onboarding-secondary-btn compact" data-role="install">${esc(t("decision_install"))}</button>
    </div>
    <label class="onboarding-note decision-pick">${esc(t("decision_model"))}
      <select class="select" data-role="model">${DECISION_MODELS.map((m) => `<option value="${m.id}">${esc(m.label)}${m.recommended ? ` — ${esc(t("decision_recommended"))}` : ""}</option>`).join("")}</select>
    </label>
    <div class="ob-progress" data-role="progress" hidden><div class="ob-progress-bar" data-role="bar"></div></div>
    ${autoOption ? `<label class="onboarding-note decision-auto"><input type="checkbox" data-role="auto" checked> ${esc(t("decision_auto"))}</label>` : ""}
    <label class="onboarding-note decision-enabled"><input type="checkbox" data-role="enabled" ${decisionEnabled() ? "checked" : ""}> ${esc(t("decision_enabled"))}</label>
    <p class="onboarding-note" data-role="status"></p>`;
  const $ = (r) => root.querySelector(`[data-role="${r}"]`);
  const btn = $("install"), status = $("status"), wrap = $("progress"), bar = $("bar");
  let installed = false, busy = false;

  const setProgress = (pct) => {
    wrap.hidden = false;
    bar.style.width = `${pct}%`;
    status.textContent = t("decision_progress", { pct });
  };
  const showModel = () => {
    const m = decisionModel();
    const eng = engineOf(engine);
    $("model").value = m.id;
    $("model-line").innerHTML = `${esc(en ? m.descEn : m.desc)}<br><code>${esc(eng === "ollama" ? m.ollama[0] : m.filename)}</code> · ${sizeLabel(m.size)} · ${eng === "ollama" ? "Ollama" : "llama.cpp"}`;
  };
  const refresh = async () => {
    showModel();
    installed = await decisionInstalled({ engine, ollamaUrl });
    btn.hidden = installed;
    if (installed) { wrap.hidden = true; status.textContent = t("decision_installed"); }
    else if (!busy) status.textContent = "";
    const auto = $("auto");
    if (auto) auto.closest("label").hidden = installed;
  };

  btn.addEventListener("click", async () => {
    busy = true; btn.disabled = true; setProgress(0);
    const ok = await installDecisionInBackground({ engine, ollamaUrl });
    busy = false; btn.disabled = false;
    if (!ok) { wrap.hidden = true; status.textContent = t("decision_failed"); }
    await refresh();
  });
  $("enabled").addEventListener("change", (e) => setDecisionEnabled(e.target.checked));
  $("model").addEventListener("change", async (e) => {
    await setDecisionModel(e.target.value);
    wrap.hidden = true;
    await refresh();
  });

  listen?.("llama-download-progress", (evt) => {
    const p = evt?.payload || {};
    if (p.id === `decision-${decisionModel().id}`) setProgress(p.percent ?? 0);   // aussi pour le repli Ollama
  });
  listen?.("ollama-pull-progress", (evt) => {
    const p = evt?.payload || {};
    if (engineOf(engine) === "ollama" && p.model === decisionModel().ollama[0]) setProgress(p.percent ?? 0);
  });
  refresh();
  return {
    refresh,
    wantsAutoInstall: () => !installed && !busy && decisionEnabled() && Boolean($("auto")?.checked),
  };
}
