// Démarrage express : tout ce qu'il faut pour utiliser Lumen avec llama.cpp,
// installé en un clic et choisi d'après la machine.
//
//   1. modèle de discussion (palier RAM → modèle qui sait appeler des outils)
//   2. moteur de décision Tev1-0.8B (aiguillage direct / outils / orchestration)
//   3. modèle d'embeddings (recherche dans les documents, mémoire)
//   4. dictée Whisper (facultatif)
//   5. voix Piper de la langue (facultatif, moteur installé si besoin)
//   6. démarrage de llama-server avec un contexte adapté + vrai message d'essai
//
// Chaque ligne reste décochable ; ce qui est déjà présent est sauté.
import { t, getLang } from "../i18n.js";
import { llmChat } from "../llm.js";
import { LLAMA_MODEL_CATALOG } from "../llama-models.js";
import { EMBED_CATALOG } from "../lib/embed-models.js";
import { whisperLoad } from "../lib/whisper-dictation.js";
import { DECISION_LLAMA, setDecisionEnabled, resetDecisionCache } from "../lib/decision.js";
import { loadHardware, formatBytes } from "../lib/llama-download.js";

const invoke = (...a) => window.__TAURI__.core.invoke(...a);
const listen = (...a) => window.__TAURI__?.event?.listen?.(...a);

import { CHAT_BY_TIER, CTX_BY_TIER } from "../lib/ai-level.js";
const EMBED_FILE = "LFM2.5-Embedding-350M-Q8_0.gguf";
const WHISPER_ID = "Xenova/whisper-base";

const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function mountExpress(root, { onState } = {}) {
  let hw = null, plan = [], running = false, done = false;

  async function buildPlan() {
    hw = await loadHardware();
    const tier = hw?.tier || "fast";
    const chat = LLAMA_MODEL_CATALOG.find((m) => m.id === CHAT_BY_TIER[tier]) || LLAMA_MODEL_CATALOG.find((m) => m.tier === "fast");
    const installed = new Set(((await invoke("llama_list_models").catch(() => [])) || []).map((m) => m.filename));
    const embed = EMBED_CATALOG[EMBED_FILE];
    let voice = null, tts = null;
    try {
      tts = await invoke("tts_engine_status");
      const cat = await invoke("tts_catalog");
      const lang = getLang() === "en" ? "en" : "fr";
      voice = cat.find((v) => v.lang?.startsWith(lang) && v.quality === "medium") || cat.find((v) => v.lang?.startsWith(lang));
    } catch {}
    plan = [
      { id: "chat", name: t("ex_chat", { name: chat.label }), size: chat.sizeBytes, have: installed.has(chat.filename), on: true, locked: true, model: chat },
      { id: "decision", name: t("ex_decision"), size: DECISION_LLAMA.size, have: installed.has(DECISION_LLAMA.filename), on: true },
      { id: "embed", name: t("ex_embed"), size: embed.sizeBytes, have: installed.has(EMBED_FILE), on: true },
      { id: "whisper", name: t("ex_whisper"), size: 84e6, have: false, on: true },
      ...(voice && (tts?.engine_ready || tts?.installable)
        ? [{ id: "voice", name: t("ex_voice", { name: voice.label }), size: (voice.size_mb || 60) * 1e6, have: voice.installed && tts?.engine_ready, on: true, voice, tts }]
        : []),
    ];
    render();
  }

  function total() { return plan.filter((s) => s.on && !s.have).reduce((a, s) => a + (s.size || 0), 0); }

  function render() {
    const tierLabel = t(`model_tier_${hw?.tier || "fast"}`);
    root.innerHTML = `
      <p class="onboarding-intro">${esc(t("ex_intro"))}</p>
      <p class="onboarding-note hw-banner visible">${esc(hw?.total_memory ? t("ex_hw", { ram: formatBytes(hw.total_memory), tier: tierLabel }) : "")}</p>
      <div class="onboarding-step-card ex-list">
        ${plan.map((s) => `
          <label class="ex-row" data-id="${s.id}">
            <input type="checkbox" ${s.on ? "checked" : ""} ${s.locked || running || done ? "disabled" : ""}>
            <span class="ex-name">${esc(s.name)}</span>
            <span class="ex-meta">${s.have ? esc(t("ex_have")) : `~${esc(formatBytes(s.size))}`}</span>
            <span class="ex-state" data-state></span>
            <span class="ex-bar"><i></i></span>
          </label>`).join("")}
      </div>
      <div class="ex-foot">
        <span class="onboarding-note" id="ex-total">${esc(t("ex_total", { size: formatBytes(total()) }))}</span>
        <button class="onboarding-nav-btn primary" id="ex-go" type="button" ${running || done ? "disabled" : ""}>${esc(done ? t("ex_ready_btn") : t("ex_go"))}</button>
      </div>
      <p class="onboarding-note" id="ex-status"></p>
      <blockquote class="ob-test-answer" id="ex-answer" hidden></blockquote>`;
    root.querySelectorAll(".ex-row input").forEach((cb) => cb.addEventListener("change", () => {
      const s = plan.find((x) => x.id === cb.closest(".ex-row").dataset.id);
      s.on = cb.checked;
      root.querySelector("#ex-total").textContent = t("ex_total", { size: formatBytes(total()) });
    }));
    root.querySelector("#ex-go").addEventListener("click", run);
  }

  const row = (id) => root.querySelector(`.ex-row[data-id="${id}"]`);
  const setRow = (id, state, pct) => {
    const r = row(id); if (!r) return;
    r.dataset.status = state;
    r.querySelector("[data-state]").textContent = { run: pct != null ? `${Math.round(pct)} %` : "…", ok: "✓", err: "!", skip: "—" }[state] || "";
    if (pct != null) r.querySelector(".ex-bar i").style.width = `${pct}%`;
  };
  const status = (txt) => { root.querySelector("#ex-status").textContent = txt; };

  const ggufIds = {};
  listen?.("llama-download-progress", (e) => {
    const p = e?.payload || {};
    const id = ggufIds[p.id];
    if (id && running) setRow(id, "run", p.percent ?? 0);
  });

  const dl = (id, request) => { ggufIds[request.id] = id; return invoke("llama_download_model", { request: { mmprojFilename: null, mmprojUrl: null, ...request } }); };

  const steps = {
    chat: (s) => dl("chat", { id: s.model.id, url: s.model.url, filename: s.model.filename, mmprojFilename: s.model.mmprojFilename || null, mmprojUrl: s.model.mmprojUrl || null }),
    decision: () => dl("decision", { id: DECISION_LLAMA.id, url: DECISION_LLAMA.url, filename: DECISION_LLAMA.filename }),
    embed: async () => {
      const e = EMBED_CATALOG[EMBED_FILE];
      await dl("embed", { id: e.id, url: e.url, filename: EMBED_FILE });
      await invoke("rag_set_embed_pref", { model: EMBED_FILE }).catch(() => {});
    },
    whisper: async () => {
      localStorage.setItem("whisperModel", WHISPER_ID);
      localStorage.setItem("whisperDictation", "1");
      await whisperLoad((_f, pct) => setRow("whisper", "run", pct));
    },
    voice: async (s) => {
      if (!s.tts?.engine_ready) await invoke("tts_install_runtime");
      if (!s.voice.installed) await invoke("tts_download_voice", { id: s.voice.id });
      await invoke("tts_set_voice", { voice: s.voice.id });
    },
  };

  async function run() {
    if (running) return;
    running = true; onState?.("busy"); render();
    let failed = false;
    for (const s of plan) {
      if (!s.on) { setRow(s.id, "skip"); continue; }
      if (s.have && s.id !== "voice" && s.id !== "embed") { setRow(s.id, "ok", 100); continue; }
      setRow(s.id, "run", 0);
      status(t("ex_installing", { name: s.name }));
      try { await steps[s.id](s); setRow(s.id, "ok", 100); }
      catch (e) {
        setRow(s.id, "err");
        status(t("ex_step_failed", { name: s.name, err: e?.message || e }));
        if (s.locked) { failed = true; break; }
      }
    }
    if (!failed) failed = !(await finishSetup());
    running = false;
    done = !failed;
    onState?.(done ? "done" : "error");
    const btn = root.querySelector("#ex-go");
    btn.disabled = done;
    btn.textContent = done ? t("ex_ready_btn") : t("ex_retry");
  }

  // Modèle actif, contexte, routeur, puis un vrai message pour prouver que ça répond.
  async function finishSetup() {
    const chat = plan.find((s) => s.id === "chat").model;
    const ctx = CTX_BY_TIER[hw?.tier || "fast"];
    localStorage.setItem("aiSource", "llama");
    localStorage.setItem("selectedModel", chat.filename);
    localStorage.setItem("selectedModel:llama", chat.filename);
    localStorage.setItem("llamaNumCtx", String(ctx));
    setDecisionEnabled(plan.find((s) => s.id === "decision")?.on !== false);
    resetDecisionCache();
    await invoke("set_ollama_config", {
      url: localStorage.getItem("ollamaUrl") || "http://localhost:11434", model: chat.filename, backend: "llama",
      apiBase: localStorage.getItem("apiBaseUrl") || "https://api.openai.com/v1", apiKey: "", apiModel: localStorage.getItem("apiModel") || "",
    }).catch(() => {});
    try { await window.__TAURI__?.event?.emit?.("settings-updated", { aiSource: "llama", selectedModel: chat.filename }); } catch {}
    status(t("ex_starting"));
    try {
      await invoke("llama_start", { filename: chat.filename, ctxSize: ctx });
      const res = await llmChat([{ role: "user", content: t("ex_test_prompt") }]);
      const reply = String(res?.content || "").trim();
      if (!reply) throw new Error(t("ob_test_empty"));
      const a = root.querySelector("#ex-answer");
      a.textContent = reply; a.hidden = false;
      status(t("ex_done"));
      return true;
    } catch (e) {
      status(t("ob_test_fail", { err: e?.message || e }));
      return false;
    }
  }

  buildPlan();
  return { isDone: () => done, isRunning: () => running };
}
