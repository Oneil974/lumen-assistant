// Panneau « Bonsai local » partagé par la barre (index.html) et la fenêtre des
// Réglages : état du moteur embarqué, modèles du catalogue PrismML
// (téléchargement depuis Hugging Face avec progression, suppression), démarrage
// et arrêt du serveur. Les deux surfaces avaient chacune leur copie d'un
// panneau à deux boutons ; celui-ci lit les commandes Rust `bonsai_status`,
// `bonsai_download_model`, `bonsai_cancel_download`, `bonsai_delete_model`,
// `bonsai_start`, `bonsai_stop`.
//
// Attendus dans le DOM (ids historiques conservés) :
//   #bonsai-status     ligne d'état (moteur, serveur)
//   #bonsai-models     conteneur de la liste des modèles
//   #btn-bonsai-start  démarrer / arrêter le serveur
//   #input-bonsai-url, #btn-bonsai-url-save   URL personnalisée (optionnels)

import { formatBytes } from "./llama-download.js";
import { bonsaiModel, pushImageConfig } from "./image-provider.js";

const KIND_LABEL = { mlx: "Apple Silicon · MLX", gemlite: "GPU NVIDIA · CUDA" };

export function mountBonsaiPanel({ invoke, listen, t = (k, v) => k, root = document, onChange } = {}) {
  const $ = (id) => root.querySelector(`#${id}`);
  const status = $("bonsai-status");
  const models = $("bonsai-models");
  const btnStart = $("btn-bonsai-start");
  const urlInput = $("input-bonsai-url");
  const btnUrlSave = $("btn-bonsai-url-save");
  if (!status || !btnStart) return null;

  const tr = (key, fallback, vars) => {
    const s = t(key, vars);
    return s === key ? fallback.replace(/\{(\w+)\}/g, (_, k) => (vars && k in vars ? vars[k] : `{${k}}`)) : s;
  };
  const progress = new Map();   // id → % en cours (« engine » pour le moteur)
  const busy = new Set();
  let last = null;
  let remote = null;            // bonsai_engine_remote : archive publiée pour cette machine
  let remoteAt = 0;

  const setStatus = (text, kind = "") => {
    status.textContent = text;
    status.dataset.kind = kind;
  };

  function engineLine(s) {
    if (!s.kind) return tr("bonsai_unsupported", "Bonsai n'est pas disponible sur cette plateforme (Apple Silicon ou GPU NVIDIA requis).");
    if (!s.engine_bundled) return tr("bonsai_engine_missing", "Moteur Bonsai non installé ({kind}) : télécharge-le ci-dessous.", { kind: KIND_LABEL[s.kind] || s.kind });
    const engine = tr("bonsai_engine_ready", "Moteur embarqué ({kind}{version})", {
      kind: KIND_LABEL[s.kind] || s.kind, version: s.engine_version ? ` · ${s.engine_version}` : "",
    });
    const server = s.running
      ? tr("bonsai_server_running", "serveur actif{variant} · {url}", {
        variant: s.active_variant ? ` (${s.active_variant})` : "", url: s.url,
      })
      : tr("bonsai_server_stopped", "serveur arrêté");
    return `${engine} · ${server}`;
  }

  // Ligne du moteur : le runtime lui-même se télécharge comme un modèle
  // (Release GitHub décrite par bonsai-engine.json), et se supprime de même.
  function renderEngineRow(s) {
    if (!s.kind) return null;
    const row = document.createElement("div");
    row.className = "bonsai-model bonsai-engine";
    const info = document.createElement("div");
    info.className = "bonsai-model-info";
    const name = document.createElement("div");
    name.className = "bonsai-model-name";
    name.textContent = tr("bonsai_engine_name", "Moteur Bonsai Image ({kind})", { kind: KIND_LABEL[s.kind] || s.kind });
    const meta = document.createElement("div");
    meta.className = "bonsai-model-meta";
    const pct = progress.get("engine");
    const downloading = s.engine_downloading || busy.has("engine");
    const size = remote?.size ? formatBytes(remote.size) : "";
    let state;
    if (downloading) state = tr("bonsai_model_downloading", "téléchargement {pct} %", { pct: pct ?? 0 });
    else if (s.engine_bundled) state = tr("bonsai_engine_installed", "installé{version}", { version: s.engine_version ? ` · ${s.engine_version}` : "" });
    else if (remote?.available) state = tr("bonsai_model_available", "à télécharger");
    else if (remote?.error) state = tr("bonsai_engine_offline", "dépôt injoignable");
    else state = tr("bonsai_engine_unpublished", "aucune archive publiée pour cette plateforme");
    meta.textContent = [size, state, remote?.update_available && !downloading ? tr("bonsai_engine_update", "mise à jour {version} disponible", { version: remote.version }) : ""].filter(Boolean).join(" · ");
    info.append(name, meta);
    if (pct !== undefined) {
      const bar = document.createElement("div");
      bar.className = "bonsai-model-bar";
      const fill = document.createElement("i");
      fill.style.width = `${pct}%`;
      bar.appendChild(fill);
      info.appendChild(bar);
    }
    const actions = document.createElement("div");
    actions.className = "bonsai-model-actions";
    const button = (label, cls, onClick) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `settings-save-btn secondary-action compact ${cls}`.trim();
      b.textContent = label;
      b.addEventListener("click", () => onClick(b));
      actions.appendChild(b);
      return b;
    };
    if (downloading) {
      button(tr("bonsai_cancel", "Annuler"), "", async (b) => {
        b.disabled = true;
        await invoke("bonsai_cancel_download", { id: "engine" }).catch(() => {});
      });
    } else {
      if (remote?.available && (!s.engine_bundled || remote.update_available)) {
        button(s.engine_bundled ? tr("bonsai_engine_do_update", "Mettre à jour") : tr("bonsai_download", "Télécharger"), "primary", () => downloadEngine());
      }
      if (s.engine_downloaded) {
        button(tr("bonsai_delete", "Supprimer"), "danger", async (b) => {
          b.disabled = true;
          try { await invoke("bonsai_delete_engine"); }
          catch (e) { setStatus(tr("bonsai_status_error", "Bonsai : {err}", { err: e?.message || e }), "error"); }
          await refresh();
        });
      }
    }
    row.append(info, actions);
    return row;
  }

  async function downloadEngine() {
    busy.add("engine");
    progress.set("engine", 0);
    if (last) renderModels(last);
    setStatus(tr("bonsai_engine_downloading", "Téléchargement du moteur Bonsai ({size})…", { size: remote?.size ? formatBytes(remote.size) : "" }));
    try {
      await invoke("bonsai_download_engine");
      setStatus(tr("bonsai_engine_ready_msg", "Moteur Bonsai installé ✓"));
      onChange?.();
    } catch (e) {
      const msg = String(e?.message || e);
      setStatus(/download-cancelled/.test(msg)
        ? tr("bonsai_download_cancelled", "Téléchargement interrompu — il reprendra là où il s'est arrêté.")
        : tr("bonsai_status_error", "Bonsai : {err}", { err: msg }), "error");
    } finally {
      busy.delete("engine");
      progress.delete("engine");
      remoteAt = 0;
      await refresh({ keepStatus: true });
    }
  }

  function renderModels(s) {
    if (!models) return;
    models.innerHTML = "";
    const engineRow = renderEngineRow(s);
    if (engineRow) models.appendChild(engineRow);
    const list = Array.isArray(s.models) ? s.models : [];
    if (!list.length) {
      const p = document.createElement("p");
      p.className = "setting-hint";
      p.textContent = tr("bonsai_no_catalog", "Aucun modèle Bonsai n'est proposé pour cette plateforme.");
      models.appendChild(p);
      return;
    }
    for (const m of list) {
      const row = document.createElement("div");
      row.className = "bonsai-model";
      row.dataset.id = m.id;
      const pct = progress.get(m.id);
      const info = document.createElement("div");
      info.className = "bonsai-model-info";
      const name = document.createElement("div");
      name.className = "bonsai-model-name";
      name.textContent = m.label;
      const meta = document.createElement("div");
      meta.className = "bonsai-model-meta";
      const state = m.downloading || busy.has(m.id)
        ? tr("bonsai_model_downloading", "téléchargement {pct} %", { pct: pct ?? 0 })
        : m.installed ? tr("bonsai_model_installed", "installé") : tr("bonsai_model_available", "à télécharger");
      meta.textContent = `${formatBytes(m.size_bytes)} · ${state} · ${m.repo}`;
      info.append(name, meta);
      if (pct !== undefined) {
        const bar = document.createElement("div");
        bar.className = "bonsai-model-bar";
        const fill = document.createElement("i");
        fill.style.width = `${pct}%`;
        bar.appendChild(fill);
        info.appendChild(bar);
      }
      const actions = document.createElement("div");
      actions.className = "bonsai-model-actions";
      const button = (label, cls, onClick) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = `settings-save-btn secondary-action compact ${cls}`.trim();
        b.textContent = label;
        b.addEventListener("click", () => onClick(b));
        actions.appendChild(b);
        return b;
      };
      if (m.downloading || busy.has(m.id)) {
        button(tr("bonsai_cancel", "Annuler"), "", async (b) => {
          b.disabled = true;
          await invoke("bonsai_cancel_download", { id: m.id }).catch(() => {});
        });
      } else if (m.installed) {
        const active = s.running && s.active_variant === m.variant;
        button(active ? tr("bonsai_model_active", "Actif") : tr("bonsai_use", "Utiliser"), active ? "primary" : "", async (b) => {
          if (active) return;
          b.disabled = true;
          try {
            localStorage.setItem("imageBonsaiModel", m.variant);
            pushImageConfig(invoke);
            setStatus(tr("bonsai_starting", "Démarrage de l'API Bonsai…"));
            await invoke("bonsai_start", { variant: m.variant });
            onChange?.();
          } catch (e) {
            setStatus(tr("bonsai_status_error", "Bonsai : {err}", { err: e?.message || e }), "error");
            return;
          } finally { b.disabled = false; }
          await refresh();
        });
        button(tr("bonsai_delete", "Supprimer"), "danger", async (b) => {
          b.disabled = true;
          try {
            await invoke("bonsai_delete_model", { id: m.id });
          } catch (e) {
            setStatus(tr("bonsai_status_error", "Bonsai : {err}", { err: e?.message || e }), "error");
          }
          await refresh();
        });
      } else {
        button(tr("bonsai_download", "Télécharger"), "primary", () => download(m));
      }
      row.append(info, actions);
      models.appendChild(row);
    }
  }

  async function download(m) {
    busy.add(m.id);
    progress.set(m.id, 0);
    if (last) renderModels(last);
    setStatus(tr("bonsai_downloading_model", "Téléchargement de {name} ({size})…", { name: m.label, size: formatBytes(m.size_bytes) }));
    try {
      await invoke("bonsai_download_model", { id: m.id });
      setStatus(tr("bonsai_downloaded", "Modèle Bonsai installé ✓"));
      if (!localStorage.getItem("imageBonsaiModel")) localStorage.setItem("imageBonsaiModel", m.variant);
      onChange?.();
    } catch (e) {
      const msg = String(e?.message || e);
      setStatus(/download-cancelled/.test(msg)
        ? tr("bonsai_download_cancelled", "Téléchargement interrompu — il reprendra là où il s'est arrêté.")
        : tr("bonsai_status_error", "Bonsai : {err}", { err: msg }), "error");
    } finally {
      busy.delete(m.id);
      progress.delete(m.id);
      await refresh({ keepStatus: true });
    }
  }

  async function refresh({ keepStatus = false } = {}) {
    try {
      const s = await invoke("bonsai_status");
      last = s;
      // Le manifeste distant ne change pas toutes les secondes : 10 min de mémoire.
      if (s.kind && Date.now() - remoteAt > 600_000) {
        remoteAt = Date.now();
        remote = await invoke("bonsai_engine_remote").catch(() => null);
      }
      if (!keepStatus || status.dataset.kind !== "error") setStatus(engineLine(s));
      renderModels(s);
      const canStart = s.engine_bundled && s.model_present;
      btnStart.disabled = !canStart && !s.running;
      btnStart.textContent = s.running ? tr("btn_bonsai_stop", "Arrêter l'API Bonsai") : tr("btn_bonsai_start", "Lancer l'API Bonsai");
      btnStart.dataset.running = s.running ? "1" : "0";
      return s;
    } catch (e) {
      setStatus(tr("bonsai_status_error", "Bonsai : {err}", { err: e?.message || e }), "error");
      return null;
    }
  }

  btnStart.addEventListener("click", async () => {
    btnStart.disabled = true;
    try {
      if (btnStart.dataset.running === "1") {
        await invoke("bonsai_stop");
      } else {
        setStatus(tr("bonsai_starting", "Démarrage de l'API Bonsai…"));
        await invoke("bonsai_start", { variant: bonsaiModel() });
        onChange?.();
      }
    } catch (e) {
      setStatus(tr("bonsai_status_error", "Bonsai : {err}", { err: e?.message || e }), "error");
      btnStart.disabled = false;
      return;
    }
    await refresh();
  });

  if (urlInput && btnUrlSave) {
    const applyUrl = async (url) => { await invoke("bonsai_set_url", { url: url || null }); };
    const saved = localStorage.getItem("bonsaiUrl") || "";
    urlInput.value = saved;
    if (saved) applyUrl(saved).catch(() => {});
    btnUrlSave.addEventListener("click", async () => {
      const url = urlInput.value.trim();
      btnUrlSave.disabled = true;
      try {
        await applyUrl(url);
        if (url) localStorage.setItem("bonsaiUrl", url);
        else localStorage.removeItem("bonsaiUrl");
        // Le noyau mémorisé ne vaut que pour le moteur local.
        localStorage.removeItem("canvasBonsaiKind");
        await refresh();
      } catch (e) {
        setStatus(tr("bonsai_status_error", "Bonsai : {err}", { err: e?.message || e }), "error");
      } finally {
        btnUrlSave.disabled = false;
      }
    });
  }

  // Progression : un évènement toutes les 200 ms, on ne repeint que la ligne.
  listen?.("bonsai-download-progress", ({ payload }) => {
    if (!payload?.id) return;
    progress.set(payload.id, Number(payload.percent) || 0);
    if (payload.id === "engine" && payload.phase === "extract") {
      setStatus(tr("bonsai_engine_extracting", "Installation du moteur Bonsai…"));
    }
    if (last) renderModels(last);
  });
  listen?.("bonsai-download-done", () => { refresh(); });

  refresh();
  return { refresh };
}
