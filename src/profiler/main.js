// Profiler — mesure en direct le coût réel des modèles locaux.
//
// Deux sources, volontairement distinctes :
//  - l'HISTORIQUE des appels, collecté par `lib/profiler.js` depuis toutes les
//    surfaces de Lumen (barre, bureau, mini-apps) ;
//  - l'ÉTAT du runtime, relevé ici en boucle auprès d'Ollama (`/api/ps`,
//    `/api/show`), de llama-server (`/props`, `/slots`) et de la machine
//    (`profiler_system_stats`).
//
// L'app ne se contente pas d'afficher : elle en tire un diagnostic, parce que
// « 7 812 tokens de prompt » ne dit rien tant qu'on ne le rapporte pas à la
// fenêtre configurée, aux outils qui l'occupent et à la mémoire disponible.

import { getSamples, clearSamples, onSample } from "../lib/profiler.js";
import { llmBackend, ollamaGetJson, ollamaPostJson } from "../llm.js";
import { autoTranslate, tt } from "../apps-i18n.js";

autoTranslate({ observe: true });

const __TAURI = window.__TAURI__ || (window.parent && window.parent.__TAURI__) || {};
const { invoke } = __TAURI.core || {};

const $ = (s) => document.querySelector(s);
const POLL_MS = 3000;

let samples = [];
let runtime = { backend: "", model: "", ctxWindow: 0, temperature: null, loaded: [], sys: null, error: "" };
// Piste du runtime : la mémoire vive et la fenêtre de contexte ne sont pas
// attachées à un appel de modèle, elles évoluent en continu. Sans cette piste,
// impossible de les tracer dans le temps à côté des appels.
let runtimeTrack = [];
const RUNTIME_KEY = "lumenProfilerRuntimeTrack";
const RUNTIME_MAX = 720;

window.addEventListener("DOMContentLoaded", () => {
  samples = getSamples();
  $("#btn-clear").addEventListener("click", () => {
    clearSamples(); samples = []; runtimeTrack = []; writeRuntimeTrack();
    renderAll();
  });
  $("#btn-refresh").addEventListener("click", () => pollRuntime().then(renderAll));

  onSample((message) => {
    if (message?.type === "cleared") samples = [];
    else if (message?.type === "sample" && message.sample) {
      // Le même échantillon peut arriver deux fois (BroadcastChannel + event
      // local quand le Profiler est ouvert dans la surface émettrice).
      if (!samples.some((s) => s.ts === message.sample.ts && s.app === message.sample.app)) {
        samples.push(message.sample);
      }
    }
    renderAll();
  });

  runtimeTrack = readRuntimeTrack();
  wireChartControls();
  // Le graphe est dimensionné en pixels réels (sinon les pastilles seraient
  // déformées par une mise à l'échelle non uniforme) : il faut le retracer
  // quand la fenêtre change de largeur.
  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderChart, 150);
  });

  // Les WebViews Tauri distinctes ne partagent pas forcément BroadcastChannel :
  // la relecture périodique du stockage garantit qu'un appel émis depuis la
  // barre principale finit toujours par apparaître ici.
  // Resynchronisation NON destructive : on fusionne, on ne remplace pas.
  // Remplacer faisait disparaître l'échantillon reçu en direct dès que le
  // stockage relu n'était pas exactement de la même longueur.
  setInterval(() => {
    const before = samples.length;
    samples = mergeSamples(samples, getSamples());
    if (samples.length !== before) renderAll();
  }, 2000);

  pollRuntime().then(renderAll);
  setInterval(() => pollRuntime().then(renderAll), POLL_MS);
  renderAll();
});

// ===== Relevé du runtime =================================================

async function pollRuntime() {
  const backend = llmBackend();
  const label = backend.llama ? "llama.cpp" : backend.api ? "api" : (localStorage.getItem("aiSource") === "shortcut" ? "apple" : "ollama");
  const next = { backend: label, model: backend.model || "", ctxWindow: 0, temperature: null, loaded: [], sys: runtime.sys, error: "" };

  if (invoke) {
    try { next.sys = await invoke("profiler_system_stats"); }
    catch { /* relevé système indisponible : les autres mesures restent valables */ }
  }

  try {
    if (label === "llama.cpp") await pollLlama(next);
    else if (label === "ollama") await pollOllama(next, backend);
    else next.error = tt("Ce backend n'expose pas de télémétrie locale : seuls les appels mesurés côté Lumen sont affichés.");
  } catch (error) {
    next.error = String(error?.message || error);
  }
  runtime = next;
  trackRuntime(next);
  return next;
}

/** Ajoute un point à la piste du runtime (mémoire, fenêtre, modèles chargés). */
function trackRuntime(next) {
  const sys = next.sys;
  const point = {
    ts: Date.now(),
    ram: sys?.total_memory ? sys.used_memory / sys.total_memory : null,
    servers: (sys?.processes || []).reduce((sum, p) => sum + (p.rss || 0), 0),
    ctxWindow: Number(next.ctxWindow || 0),
    loaded: (next.loaded || []).length,
    backend: next.backend,
    model: next.model,
    slotUsed: (next.slots || []).reduce((max, sl) => Math.max(max, sl.used || 0), 0),
  };
  const last = runtimeTrack[runtimeTrack.length - 1];
  // Le relevé tourne toutes les 3 s : on ne garde un point que si quelque chose
  // a bougé, ou toutes les 30 s, sinon la piste ne serait que du bruit.
  const changed = !last || last.ram == null || point.ram == null
    || Math.abs((point.ram || 0) - (last.ram || 0)) > 0.01
    || point.ctxWindow !== last.ctxWindow || point.loaded !== last.loaded
    || point.slotUsed !== last.slotUsed || point.ts - last.ts > 30000;
  if (!changed) return;
  runtimeTrack.push(point);
  if (runtimeTrack.length > RUNTIME_MAX) runtimeTrack = runtimeTrack.slice(-RUNTIME_MAX);
  writeRuntimeTrack();
}

function readRuntimeTrack() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RUNTIME_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
function writeRuntimeTrack() {
  try { localStorage.setItem(RUNTIME_KEY, JSON.stringify(runtimeTrack)); }
  catch { /* quota : la piste n'est pas critique */ }
}

/** Fusionne deux listes d'échantillons sans doublon, dans l'ordre du temps. */
function mergeSamples(a, b) {
  const out = new Map();
  for (const s of [...a, ...b]) {
    if (!s) continue;
    out.set(`${s.ts}|${s.app}`, s);
  }
  return [...out.values()].sort((x, y) => (x.ts || 0) - (y.ts || 0));
}

async function pollLlama(next) {
  const status = invoke ? await invoke("llama_status") : null;
  if (!status?.running) { next.error = tt("llama-server n'est pas démarré."); return; }
  next.model = status.model || next.model;
  next.ctxWindow = Number(status.ctx_size || 0);
  const props = await invoke("llama_get_json", { path: "props" }).catch(() => null);
  const settings = props?.default_generation_settings || {};
  // `n_ctx` de /props est la fenêtre réellement servie par le slot : elle prime
  // sur la valeur demandée au démarrage, qui a pu être rabotée par le serveur.
  if (Number(settings.n_ctx)) next.ctxWindow = Number(settings.n_ctx);
  const params = settings.params || settings;
  if (params && params.temperature != null) next.temperature = Number(params.temperature);
  next.chatTemplate = props?.chat_template ? String(props.chat_template).slice(0, 60) : "";
  next.loaded = [{
    name: next.model,
    kind: "llama.cpp",
    ctx: next.ctxWindow,
    detail: [props?.model_path ? String(props.model_path).split(/[\\/]/).pop() : "", props?.total_slots ? `${props.total_slots} slot(s)` : ""].filter(Boolean).join(" · "),
  }];
  // Les slots exposent l'occupation VIVANTE du contexte, indépendamment de nos
  // propres mesures : c'est la seule source qui voie aussi les appels faits
  // hors de Lumen. Endpoint souvent désactivé — l'absence n'est pas une erreur.
  const slots = await invoke("llama_get_json", { path: "slots" }).catch(() => null);
  if (Array.isArray(slots) && slots.length) {
    next.slots = slots.map((slot) => ({
      id: slot.id,
      used: Number(slot.n_ctx ? (slot.prompt_n ?? slot.n_past ?? 0) : 0),
      ctx: Number(slot.n_ctx || next.ctxWindow),
      state: slot.is_processing ? tt("occupé") : tt("libre"),
    }));
  }
}

async function pollOllama(next, backend) {
  const ps = await ollamaGetJson("api/ps", backend.base).catch(() => null);
  const running = Array.isArray(ps?.models) ? ps.models : [];
  next.loaded = running.map((model) => ({
    name: model.name || model.model || "",
    kind: "ollama",
    size: Number(model.size || 0),
    vram: Number(model.size_vram || 0),
    ctx: Number(model.context_length || 0),
    expires: model.expires_at || "",
    detail: [model.details?.parameter_size, model.details?.quantization_level, model.details?.family].filter(Boolean).join(" · "),
  }));
  const active = next.loaded.find((m) => m.name === next.model) || next.loaded[0];
  // Fenêtre effective : le réglage global de Lumen s'il est posé, sinon celle
  // qu'Ollama a réellement allouée au modèle chargé.
  const configured = parseInt(localStorage.getItem("ollamaNumCtx") || "0", 10) || 0;
  next.ctxWindow = configured || Number(active?.ctx || 0);
  if (!next.model) return;
  const show = await ollamaPostJson("api/show", { model: next.model }, backend.base).catch(() => null);
  if (show) {
    // `parameters` est un bloc texte « clé valeur » par ligne (Modelfile).
    const line = String(show.parameters || "").split("\n").find((l) => l.trim().startsWith("temperature"));
    if (line) next.temperature = Number(line.trim().split(/\s+/)[1]);
    if (!next.ctxWindow) {
      const entry = Object.entries(show.model_info || {}).find(([k]) => k.endsWith(".context_length"));
      if (entry) next.ctxWindow = Number(entry[1]) || 0;
    }
    next.capabilities = Array.isArray(show.capabilities) ? show.capabilities : [];
  }
}

// ===== Rendu ==============================================================

function renderAll() {
  renderCards();
  renderChart();
  renderTools();
  renderApps();
  renderAdvice();
  renderRuntime();
  renderCalls();
  const fresh = samples.length && Date.now() - samples[samples.length - 1].ts < 120000;
  $("#live").classList.toggle("stale", !fresh);
}

/** Occupation la plus récente du contexte, et son pic sur l'historique. */
function contextUsage() {
  const window_ = runtime.ctxWindow || 0;
  const last = samples.length ? samples[samples.length - 1] : null;
  const lastUsed = last ? last.promptTokens + last.genTokens : 0;
  const peak = samples.reduce((max, s) => Math.max(max, s.promptTokens + s.genTokens), 0);
  return { window: window_, last: lastUsed, peak, ratio: window_ ? lastUsed / window_ : 0, peakRatio: window_ ? peak / window_ : 0 };
}

function renderCards() {
  const ctx = contextUsage();
  const sys = runtime.sys;
  const servers = (sys?.processes || []).reduce((sum, p) => sum + (p.rss || 0), 0);
  const recent = samples.slice(-20);
  const tps = recent.filter((s) => s.tps > 0);
  const avgTps = tps.length ? tps.reduce((sum, s) => sum + s.tps, 0) / tps.length : 0;
  const resets = samples.filter((s) => s.reset).length;
  const memRatio = sys?.total_memory ? sys.used_memory / sys.total_memory : 0;

  const cards = [
    card({
      k: tt("Contexte occupé"),
      v: ctx.window ? `${pct(ctx.ratio)}` : fmtNum(ctx.last),
      s: ctx.window ? `${fmtNum(ctx.last)} / ${fmtNum(ctx.window)} tok · ${tt("pic")} ${pct(ctx.peakRatio)}` : tt("fenêtre inconnue (défaut du modèle)"),
      bar: ctx.window ? ctx.ratio : null,
      level: ctx.ratio > 0.9 ? "crit" : ctx.ratio > 0.75 ? "alert" : "",
    }),
    card({
      k: tt("Mémoire vive"),
      v: sys?.total_memory ? pct(memRatio) : "—",
      s: sys?.total_memory ? `${fmtBytes(sys.used_memory)} / ${fmtBytes(sys.total_memory)} · ${tt("serveurs")} ${fmtBytes(servers)}` : tt("relevé indisponible"),
      bar: sys?.total_memory ? memRatio : null,
      level: memRatio > 0.92 ? "crit" : memRatio > 0.8 ? "alert" : "",
    }),
    card({
      k: tt("Débit"),
      v: avgTps ? `${avgTps.toFixed(1)} <small>tok/s</small>` : "—",
      s: tt("moyenne des 20 derniers appels"),
      level: avgTps && avgTps < 6 ? "alert" : "",
    }),
    card({
      k: tt("Modèle"),
      v: `<span style="font-size:14px">${escapeHtml(runtime.model || tt("aucun"))}</span>`,
      s: `${runtime.backend || "?"}${runtime.temperature != null ? ` · temp ${runtime.temperature}` : ""}`,
    }),
    card({
      k: tt("Appels mesurés"),
      v: String(samples.length),
      s: `${fmtNum(samples.reduce((sum, s) => sum + s.promptTokens, 0))} ${tt("prompt")} · ${fmtNum(samples.reduce((sum, s) => sum + s.genTokens, 0))} ${tt("générés")}`,
    }),
    card({
      k: tt("Ruptures de contexte"),
      v: String(resets),
      s: tt("historiques repartis de zéro"),
      level: resets > 3 ? "alert" : "",
    }),
  ];
  $("#cards").innerHTML = cards.join("");
}

function card({ k, v, s, bar = null, level = "" }) {
  return `<div class="card ${level}">
    <span class="k">${k}</span>
    <span class="v">${v}</span>
    ${bar != null ? `<span class="bar ${bar > 0.9 ? "crit" : bar > 0.75 ? "warn" : ""}"><i style="width:${Math.min(100, bar * 100).toFixed(1)}%"></i></span>` : ""}
    <span class="s" title="${escapeHtml(stripTags(s))}">${s}</span>
  </div>`;
}

/** Couleur stable par app, pour relier la courbe à la légende. */
const PALETTE = ["#0a84ff", "#30d158", "#bf5af2", "#ff9f0a", "#64d2ff", "#ff375f", "#5e5ce6", "#ffd60a"];
function appColor(app) {
  let hash = 0;
  for (const ch of String(app)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

// ===== Historique multi-séries ===========================================
// Le graphe ne traçait qu'une variable (le contexte occupé) et indexait les
// points par rang, pas par date : deux appels espacés d'une heure étaient
// côte à côte. Il trace désormais TOUTES les variables suivies sur un axe
// temporel, chacune activable, chaque point ouvrant son détail complet.
//
// Deux échelles : les tokens à gauche (grandeurs homogènes), le reste à droite
// (débit, compteurs d'outils, pourcentages) — chaque série annonce son unité et
// son maximum dans la légende, pour qu'aucune courbe ne soit lue de travers.
const SERIES = [
  { id: "total", label: "Contexte occupé", unit: "tok", axis: "tok", color: "#0a84ff", src: "call", value: (s) => s.promptTokens + s.genTokens },
  { id: "prompt", label: "Prompt", unit: "tok", axis: "tok", color: "#5e5ce6", src: "call", value: (s) => s.promptTokens },
  { id: "gen", label: "Générés", unit: "tok", axis: "tok", color: "#30d158", src: "call", value: (s) => s.genTokens },
  { id: "tps", label: "Débit", unit: "tok/s", axis: "aux", color: "#ffd60a", src: "call", value: (s) => s.tps || 0 },
  { id: "offered", label: "Outils présentés", unit: "", axis: "aux", color: "#ff9f0a", src: "call", value: (s) => (s.toolsOffered || []).length },
  { id: "called", label: "Outils appelés", unit: "", axis: "aux", color: "#ff375f", src: "call", value: (s) => (s.toolsCalled || []).length },
  { id: "messages", label: "Messages envoyés", unit: "", axis: "aux", color: "#64d2ff", src: "call", value: (s) => s.messages || 0 },
  { id: "ctxpct", label: "Fenêtre utilisée", unit: "%", axis: "aux", color: "#bf5af2", src: "call", value: (s) => (s.ctxSize ? ((s.promptTokens + s.genTokens) / s.ctxSize) * 100 : 0) },
  { id: "ram", label: "Mémoire vive", unit: "%", axis: "aux", color: "#98989d", src: "runtime", value: (p) => (p.ram == null ? null : p.ram * 100) },
  { id: "servers", label: "RAM des serveurs", unit: "Mo", axis: "aux", color: "#ac8e68", src: "runtime", value: (p) => Math.round((p.servers || 0) / 1048576) },
];
const SERIES_KEY = "lumenProfilerSeries";
const RANGE_KEY = "lumenProfilerRange";
let enabled = new Set(readEnabledSeries());
let rangeMs = Number(localStorage.getItem(RANGE_KEY) ?? 86400000);

function readEnabledSeries() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SERIES_KEY) || "null");
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch { /* réglage illisible : on repart du défaut */ }
  return ["total", "tps", "offered", "called"];
}

function wireChartControls() {
  const range = $("#ctx-range");
  range.value = String(rangeMs);
  range.addEventListener("change", () => {
    rangeMs = Number(range.value) || 0;
    localStorage.setItem(RANGE_KEY, String(rangeMs));
    renderChart();
  });
  $("#modal-close").addEventListener("click", closeModal);
  $("#sample-modal").addEventListener("click", (e) => { if (e.target.id === "sample-modal") closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
  renderSeriesToggles();
}

function renderSeriesToggles() {
  $("#ctx-series").innerHTML = SERIES.map((serie) =>
    `<button class="chip ${enabled.has(serie.id) ? "on" : ""}" data-serie="${serie.id}" style="--c:${serie.color}">
       <i></i>${escapeHtml(tt(serie.label))}${serie.unit ? ` <small>${serie.unit}</small>` : ""}
     </button>`).join("");
  $("#ctx-series").querySelectorAll("[data-serie]").forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.serie;
    if (enabled.has(id)) enabled.delete(id); else enabled.add(id);
    // Tout décocher viderait le graphe sans rien dire : on garde une série.
    if (!enabled.size) enabled.add("total");
    localStorage.setItem(SERIES_KEY, JSON.stringify([...enabled]));
    renderSeriesToggles();
    renderChart();
  }));
}

/** Points d'une série, filtrés sur la période affichée. */
function seriePoints(serie, since) {
  const source = serie.src === "runtime" ? runtimeTrack : samples;
  const out = [];
  for (const item of source) {
    if (!item || (since && item.ts < since)) continue;
    const v = serie.value(item);
    if (v == null || Number.isNaN(v)) continue;
    out.push({ ts: item.ts, v, item });
  }
  return out;
}

function renderChart() {
  const host = $("#ctx-chart");
  const now = Date.now();
  const since = rangeMs ? now - rangeMs : 0;
  const active = SERIES.filter((serie) => enabled.has(serie.id));
  const tracks = active.map((serie) => ({ serie, pts: seriePoints(serie, since) })).filter((t) => t.pts.length);
  const totalPoints = tracks.reduce((sum, t) => sum + t.pts.length, 0);

  if (!totalPoints) {
    host.innerHTML = `<div class="empty">${tt("Aucune mesure sur cette période. Utilisez Lumen, ou élargissez la période.")}</div>`;
    $("#ctx-legend").innerHTML = "";
    $("#ctx-hint").textContent = tt("Chaque appel de modèle et chaque relevé du runtime viennent enrichir ces courbes.");
    return;
  }

  const W = Math.max(420, host.clientWidth || 900);
  const H = 260;
  const pad = { l: 52, r: 54, t: 12, b: 22 };
  const allTs = tracks.flatMap((t) => t.pts.map((p) => p.ts));
  let t0 = Math.min(...allTs);
  let t1 = Math.max(...allTs, now);
  if (t1 - t0 < 60000) { t0 -= 30000; t1 += 30000; }   // un point isolé ne doit pas coller au bord

  const limit = runtime.ctxWindow || 0;
  const maxTok = Math.max(
    ...tracks.filter((t) => t.serie.axis === "tok").flatMap((t) => t.pts.map((p) => p.v)),
    limit && enabled.has("total") ? limit : 0, 1);
  const maxAux = Math.max(...tracks.filter((t) => t.serie.axis === "aux").flatMap((t) => t.pts.map((p) => p.v)), 1);

  const x = (ts) => pad.l + ((ts - t0) / (t1 - t0 || 1)) * (W - pad.l - pad.r);
  const yTok = (v) => pad.t + (1 - v / (maxTok * 1.1)) * (H - pad.t - pad.b);
  const yAux = (v) => pad.t + (1 - v / (maxAux * 1.1)) * (H - pad.t - pad.b);
  const yOf = (serie) => (serie.axis === "tok" ? yTok : yAux);

  const paths = tracks.map(({ serie, pts }) => {
    const y = yOf(serie);
    const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.ts).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
    return `<path d="${d}" fill="none" stroke="${serie.color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" opacity="0.95" />`;
  }).join("");

  // Pastilles : une par point, cliquable, avec son échantillon en référence.
  const dots = tracks.map(({ serie, pts }) => {
    const y = yOf(serie);
    return pts.map((p, i) => {
      const idx = serie.src === "runtime" ? runtimeTrack.indexOf(p.item) : samples.indexOf(p.item);
      return `<circle class="dot${p.item.reset ? " is-reset" : ""}" cx="${x(p.ts).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="4"
        fill="${serie.color}" data-src="${serie.src}" data-idx="${idx}" data-serie="${serie.id}" data-i="${i}" />`;
    }).join("");
  }).join("");

  const resets = samples
    .filter((s) => s.reset && (!since || s.ts >= since))
    .map((s) => `<line class="reset" x1="${x(s.ts).toFixed(1)}" y1="${pad.t}" x2="${x(s.ts).toFixed(1)}" y2="${H - pad.b}" />`).join("");

  const limitLine = limit && enabled.has("total") && limit <= maxTok * 1.1
    ? `<line class="ctx-limit" x1="${pad.l}" y1="${yTok(limit).toFixed(1)}" x2="${W - pad.r}" y2="${yTok(limit).toFixed(1)}" />
       <text class="axis-label" x="${pad.l + 4}" y="${(yTok(limit) - 4).toFixed(1)}">${tt("fenêtre")} ${fmtNum(limit)}</text>`
    : "";

  // Graduations horizontales : sans elles, une courbe temporelle ne se situe pas.
  const ticks = 4;
  const grid = Array.from({ length: ticks + 1 }, (_, i) => {
    const ts = t0 + ((t1 - t0) * i) / ticks;
    const px = x(ts);
    return `<line class="grid" x1="${px.toFixed(1)}" y1="${pad.t}" x2="${px.toFixed(1)}" y2="${H - pad.b}" />
      <text class="axis-label mid" x="${px.toFixed(1)}" y="${H - 6}">${new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</text>`;
  }).join("");

  const hasTok = tracks.some((t) => t.serie.axis === "tok");
  const hasAux = tracks.some((t) => t.serie.axis === "aux");

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">
    ${grid}
    <line class="axis" x1="${pad.l}" y1="${H - pad.b}" x2="${W - pad.r}" y2="${H - pad.b}" />
    <line class="axis" x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${H - pad.b}" />
    ${hasTok ? `<text class="axis-label" x="4" y="${pad.t + 8}">${fmtNum(Math.round(maxTok * 1.1))} tok</text>
                <text class="axis-label" x="4" y="${H - pad.b}">0</text>` : ""}
    ${hasAux ? `<text class="axis-label end" x="${W - 4}" y="${pad.t + 8}">${fmtNum(Math.round(maxAux * 1.1))}</text>
                <text class="axis-label end" x="${W - 4}" y="${H - pad.b}">0</text>` : ""}
    ${limitLine}${resets}${paths}${dots}
  </svg><div class="tip" hidden></div>`;

  wireChartPointers(host, tracks);

  $("#ctx-legend").innerHTML = tracks.map(({ serie, pts }) => {
    const max = Math.max(...pts.map((p) => p.v));
    const last = pts[pts.length - 1].v;
    return `<span title="${escapeHtml(`${tt("dernier")} ${fmtVal(last, serie)} · ${tt("max")} ${fmtVal(max, serie)}`)}">
      <i style="background:${serie.color}"></i>${escapeHtml(tt(serie.label))} <b>${fmtVal(last, serie)}</b></span>`;
  }).join("");

  const resetCount = samples.filter((s) => s.reset && (!since || s.ts >= since)).length;
  $("#ctx-hint").textContent = [
    `${samples.filter((s) => !since || s.ts >= since).length} ${tt("appel(s) mesuré(s)")} · ${runtimeTrack.filter((p) => !since || p.ts >= since).length} ${tt("relevé(s) du runtime")}`,
    resetCount ? `${resetCount} ${tt("rupture(s) de contexte, marquées par un trait vertical")}` : "",
    tt("Cliquez une pastille pour le détail complet de la mesure."),
  ].filter(Boolean).join(" — ");
}

function fmtVal(v, serie) {
  if (serie.unit === "%") return `${Math.round(v)} %`;
  if (serie.unit === "tok") return `${fmtNum(v)} tok`;
  if (serie.unit === "tok/s") return `${(+v).toFixed(1)} tok/s`;
  if (serie.unit === "Mo") return `${fmtNum(v)} Mo`;
  return String(Math.round(v));
}

function wireChartPointers(host, tracks) {
  const tip = host.querySelector(".tip");
  const pick = (target) => {
    const src = target.dataset.src;
    const idx = Number(target.dataset.idx);
    const serie = SERIES.find((s) => s.id === target.dataset.serie);
    const item = src === "runtime" ? runtimeTrack[idx] : samples[idx];
    return { src, item, serie };
  };
  host.querySelectorAll(".dot").forEach((dot) => {
    dot.addEventListener("mouseenter", () => {
      const { item, serie } = pick(dot);
      if (!item) return;
      const rect = dot.getBoundingClientRect();
      const box = host.getBoundingClientRect();
      tip.innerHTML = `<b>${escapeHtml(tt(serie.label))} ${fmtVal(serie.value(item), serie)}</b><br>` +
        `${new Date(item.ts).toLocaleTimeString()} · ${escapeHtml(item.app || item.model || runtime.backend || "")}`;
      tip.hidden = false;
      tip.style.left = `${Math.min(box.width - 190, Math.max(0, rect.left - box.left - 80))}px`;
      tip.style.top = `${Math.max(0, rect.top - box.top - 46)}px`;
    });
    dot.addEventListener("mouseleave", () => { tip.hidden = true; });
    dot.addEventListener("click", () => {
      const { src, item } = pick(dot);
      if (item) openModal(src, item);
    });
  });
}

// ===== Modal de détail ====================================================
function openModal(src, item) {
  const rows = src === "runtime" ? runtimeDetailRows(item) : sampleDetailRows(item);
  $("#modal-title").textContent = src === "runtime"
    ? `${tt("Relevé du runtime")} · ${new Date(item.ts).toLocaleTimeString()}`
    : `${item.app} · ${new Date(item.ts).toLocaleTimeString()}`;
  $("#modal-body").innerHTML = rows.map(([k, v, cls = ""]) =>
    `<div class="mrow ${cls}"><span class="mk">${escapeHtml(k)}</span><span class="mv">${v}</span></div>`).join("")
    + (src === "runtime" ? "" : transcriptHtml(item));
  $("#sample-modal").hidden = false;
  $("#modal-body").scrollTop = 0;
}

// ===== Conversation de l'appel ============================================
//
// Le chiffre « 7 812 tokens de prompt » ne se diagnostique pas sans lire ce qui
// a été envoyé : un prompt système qui a doublé, un historique jamais compacté,
// un résultat d'outil de 4 000 caractères réinjecté à chaque tour. On affiche
// donc, sous les mesures, la conversation exacte transmise au modèle et la
// réponse obtenue — dans l'ordre, l'utilisateur en dernier avant la réponse.
const ROLE_LABELS = {
  system: "Système",
  user: "Utilisateur",
  assistant: "Assistant",
  tool: "Résultat d'outil",
};

function msgHtml(entry, extraClass = "") {
  const role = String(entry.role || "?");
  const label = tt(ROLE_LABELS[role] || role);
  const meta = [
    entry.name ? escapeHtml(entry.name) : "",
    entry.images ? `${entry.images} ${tt("image(s)")}` : "",
    entry.clipped ? `${tt("tronqué de")} ${fmtNum(entry.clipped)} ${tt("car.")}` : "",
  ].filter(Boolean).join(" · ");
  const calls = (entry.calls || []).map((call) =>
    `<div class="msg-call"><code>${escapeHtml(call.name)}</code>(${escapeHtml(call.args || "")})</div>`).join("");
  const thinking = entry.thinking
    ? `<details class="msg-think"><summary>${tt("Réflexion du modèle")}</summary><pre>${escapeHtml(entry.thinking)}</pre></details>`
    : "";
  const text = entry.text
    ? `<pre>${escapeHtml(entry.text)}</pre>`
    : (calls ? "" : `<pre class="muted">${tt("(vide)")}</pre>`);
  return `<div class="msg role-${escapeHtml(role)} ${extraClass}">
    <div class="msg-head"><span class="msg-role">${escapeHtml(label)}</span>${meta ? `<span class="msg-meta">${meta}</span>` : ""}</div>
    ${thinking}${text}${calls}</div>`;
}

function transcriptHtml(s) {
  if (s.transcriptDropped) {
    return `<div class="msg-block"><div class="msg-block-head">${tt("Conversation")}</div>
      <p class="hint">${tt("Le contenu des messages n'est conservé que pour les mesures récentes ; celui-ci a été purgé pour économiser le stockage.")}</p></div>`;
  }
  const sent = (s.transcript || []).map((entry) => msgHtml(entry)).join("");
  const reply = s.reply ? msgHtml(s.reply, "reply") : "";
  if (!sent && !reply) {
    return `<div class="msg-block"><div class="msg-block-head">${tt("Conversation")}</div>
      <p class="hint">${tt("Aucun message enregistré pour cet appel (mesure antérieure à cette fonctionnalité, ou appel sans historique).")}</p></div>`;
  }
  return `<div class="msg-block">
    <div class="msg-block-head">${tt("Envoyé au modèle")}${s.messages ? ` <span class="muted">· ${s.messages} ${tt("message(s)")}</span>` : ""}</div>
    ${sent || `<p class="hint">${tt("Aucun message enregistré pour cet appel (mesure antérieure à cette fonctionnalité, ou appel sans historique).")}</p>`}
    ${reply ? `<div class="msg-block-head">${tt("Réponse du modèle")}</div>${reply}` : ""}
  </div>`;
}
function closeModal() { $("#sample-modal").hidden = true; }

function sampleDetailRows(s) {
  const tools = (names) => (names && names.length
    ? names.map((n) => `<code>${escapeHtml(n)}</code>`).join(" ")
    : `<span class="muted">${tt("aucun")}</span>`);
  const called = new Set(s.toolsCalled || []);
  const offered = (s.toolsOffered || []).map((n) =>
    `<code class="${called.has(n) ? "used" : "unused"}">${escapeHtml(n)}</code>`).join(" ");
  return [
    [tt("Horodatage"), escapeHtml(new Date(s.ts).toLocaleString())],
    [tt("Application"), `<span style="color:${appColor(s.app)}">●</span> ${escapeHtml(s.app)} <span class="muted">${escapeHtml(s.surface || "")}</span>`],
    [tt("Backend"), `${escapeHtml(s.backend || "—")} · ${escapeHtml(s.model || "—")}`],
    [tt("Tokens de prompt"), fmtNum(s.promptTokens)],
    [tt("Tokens générés"), fmtNum(s.genTokens)],
    [tt("Total"), `${fmtNum(s.totalTokens || s.promptTokens + s.genTokens)}${s.ctxSize ? ` / ${fmtNum(s.ctxSize)} tok (${pct((s.promptTokens + s.genTokens) / s.ctxSize)})` : ""}`],
    [tt("Préremplissage"), `${fmtNum(s.promptMs)} ms`],
    [tt("Génération"), `${fmtNum(s.genMs)} ms · ${s.tps || 0} tok/s`],
    [tt("Écart de prompt"), s.promptDelta ? `${s.promptDelta > 0 ? "+" : ""}${fmtNum(s.promptDelta)} tok` : "—"],
    [tt("Rupture de contexte"), s.reset ? `<b class="dead">${tt("oui")}</b>` : tt("non"), s.reset ? "warn" : ""],
    [tt("Messages envoyés"), String(s.messages || 0)],
    [tt("Température"), s.temperature != null ? String(s.temperature) : tt("défaut")],
    [tt("Réflexion"), s.thinking == null ? tt("défaut") : String(s.thinking)],
    [tt("Sortie structurée"), s.structured || tt("non")],
    [tt("Outils présentés"), offered || `<span class="muted">${tt("aucun")}</span>`],
    [tt("Outils appelés"), tools(s.toolsCalled)],
  ];
}

function runtimeDetailRows(p) {
  return [
    [tt("Horodatage"), escapeHtml(new Date(p.ts).toLocaleString())],
    [tt("Backend"), `${escapeHtml(p.backend || "—")} · ${escapeHtml(p.model || "—")}`],
    [tt("Mémoire vive"), p.ram == null ? "—" : pct(p.ram)],
    [tt("RAM des serveurs"), fmtBytes(p.servers || 0)],
    [tt("Fenêtre de contexte"), p.ctxWindow ? `${fmtNum(p.ctxWindow)} tok` : tt("défaut du modèle")],
    [tt("Contexte occupé (slot)"), p.slotUsed ? `${fmtNum(p.slotUsed)} tok` : "—"],
    [tt("Modèles chargés"), String(p.loaded || 0)],
  ];
}

function renderTools() {
  // Un outil présenté occupe le contexte à CHAQUE appel, qu'il serve ou non :
  // c'est le gisement d'optimisation le plus simple à exploiter.
  const stats = new Map();
  for (const sample of samples) {
    for (const name of sample.toolsOffered || []) {
      const entry = stats.get(name) || { offered: 0, called: 0 };
      entry.offered += 1;
      stats.set(name, entry);
    }
    for (const name of sample.toolsCalled || []) {
      const entry = stats.get(name) || { offered: 0, called: 0 };
      entry.called += 1;
      stats.set(name, entry);
    }
  }
  const rows = [...stats.entries()].sort((a, b) => b[1].offered - a[1].offered || b[1].called - a[1].called);
  const table = $("#tools-table");
  if (!rows.length) {
    table.innerHTML = `<tr><td class="muted">${tt("Aucun outil observé pour l'instant.")}</td></tr>`;
    return;
  }
  table.innerHTML =
    `<thead><tr><th>${tt("Outil")}</th><th class="num">${tt("Présenté")}</th><th class="num">${tt("Appelé")}</th><th class="num">${tt("Taux")}</th></tr></thead><tbody>` +
    rows.map(([name, s]) => {
      const rate = s.offered ? s.called / s.offered : 0;
      const dead = s.offered >= 5 && s.called === 0;
      return `<tr><td>${escapeHtml(name)}${dead ? ` <span class="dead">· ${tt("jamais appelé")}</span>` : ""}</td>` +
        `<td class="num">${s.offered}</td><td class="num">${s.called}</td>` +
        `<td class="num ${dead ? "dead" : "muted"}">${s.offered ? pct(rate) : "—"}</td></tr>`;
    }).join("") + "</tbody>";
}

function renderApps() {
  const stats = new Map();
  for (const sample of samples) {
    const entry = stats.get(sample.app) || { calls: 0, prompt: 0, gen: 0, tps: [], resets: 0, peak: 0 };
    entry.calls += 1;
    entry.prompt += sample.promptTokens;
    entry.gen += sample.genTokens;
    entry.peak = Math.max(entry.peak, sample.promptTokens + sample.genTokens);
    if (sample.tps > 0) entry.tps.push(sample.tps);
    if (sample.reset) entry.resets += 1;
    stats.set(sample.app, entry);
  }
  const rows = [...stats.entries()].sort((a, b) => (b[1].prompt + b[1].gen) - (a[1].prompt + a[1].gen));
  const table = $("#apps-table");
  if (!rows.length) {
    table.innerHTML = `<tr><td class="muted">${tt("Aucun appel mesuré pour l'instant.")}</td></tr>`;
    return;
  }
  table.innerHTML =
    `<thead><tr><th>${tt("App")}</th><th class="num">${tt("Appels")}</th><th class="num">${tt("Prompt moy.")}</th><th class="num">${tt("Pic")}</th><th class="num">${tt("tok/s")}</th><th class="num">${tt("Ruptures")}</th></tr></thead><tbody>` +
    rows.map(([app, s]) => {
      const avgTps = s.tps.length ? s.tps.reduce((sum, v) => sum + v, 0) / s.tps.length : 0;
      return `<tr><td><span style="color:${appColor(app)}">●</span> ${escapeHtml(app)}</td>` +
        `<td class="num">${s.calls}</td><td class="num">${fmtNum(Math.round(s.prompt / s.calls))}</td>` +
        `<td class="num">${fmtNum(s.peak)}</td><td class="num">${avgTps ? avgTps.toFixed(1) : "—"}</td>` +
        `<td class="num ${s.resets ? "dead" : "muted"}">${s.resets || "—"}</td></tr>`;
    }).join("") + "</tbody>";
}

function renderRuntime() {
  const table = $("#runtime-table");
  const sys = runtime.sys;
  const rows = [];
  rows.push([tt("Backend"), runtime.backend || "—"]);
  rows.push([tt("Modèle actif"), runtime.model || "—"]);
  rows.push([tt("Fenêtre de contexte"), runtime.ctxWindow ? `${fmtNum(runtime.ctxWindow)} tok` : tt("défaut du modèle")]);
  rows.push([tt("Température"), runtime.temperature != null ? String(runtime.temperature) : tt("défaut du modèle")]);
  if (runtime.capabilities?.length) rows.push([tt("Capacités"), runtime.capabilities.join(", ")]);
  if (runtime.chatTemplate) rows.push([tt("Gabarit de chat"), runtime.chatTemplate + "…"]);
  for (const model of runtime.loaded || []) {
    const bits = [model.detail, model.size ? fmtBytes(model.size) : "", model.vram ? `${fmtBytes(model.vram)} VRAM` : "",
      model.ctx ? `${fmtNum(model.ctx)} tok` : "", model.expires ? `${tt("expire")} ${new Date(model.expires).toLocaleTimeString()}` : ""];
    rows.push([tt("Chargé en mémoire"), `${escapeHtml(model.name)} <span class="muted">${escapeHtml(bits.filter(Boolean).join(" · "))}</span>`]);
  }
  for (const slot of runtime.slots || []) {
    rows.push([`${tt("Slot")} ${slot.id}`, `${fmtNum(slot.used)} / ${fmtNum(slot.ctx)} tok · ${slot.state}`]);
  }
  for (const proc of sys?.processes || []) {
    rows.push([tt("Processus"), `${escapeHtml(proc.name)} <span class="muted">pid ${proc.pid} · ${fmtBytes(proc.rss)}${proc.cpu ? ` · ${proc.cpu.toFixed(0)} % CPU` : ""}</span>`]);
  }
  if (sys?.cpu_count) rows.push([tt("Cœurs CPU"), String(sys.cpu_count)]);
  table.innerHTML = `<tbody>${rows.map(([k, v]) => `<tr><td class="muted">${k}</td><td>${v}</td></tr>`).join("")}</tbody>`;
  $("#runtime-sub").textContent = runtime.error || "";
}

function renderAdvice() {
  const host = $("#advice");
  const notes = [];
  const ctx = contextUsage();
  const sys = runtime.sys;

  if (ctx.window && ctx.peakRatio > 0.9) {
    notes.push(["crit", tt("Contexte saturé."), tt(`Le pic mesuré atteint ${pct(ctx.peakRatio)} de la fenêtre. Au-delà, le serveur tronque l'historique : les réponses perdent le début de la conversation. Augmentez la fenêtre, ou réduisez ce qui est envoyé (documents, outils, mémoire).`)]);
  } else if (ctx.window && ctx.peakRatio < 0.25 && samples.length > 15) {
    notes.push(["warn", tt("Fenêtre surdimensionnée."), tt(`Le pic mesuré ne dépasse pas ${pct(ctx.peakRatio)} de la fenêtre allouée. Une fenêtre plus petite libérerait de la mémoire et accélérerait le préremplissage, sans rien perdre.`)]);
  }

  const toolStats = new Map();
  const bump = (name, field) => {
    const entry = toolStats.get(name) || { offered: 0, called: 0 };
    entry[field] += 1;
    toolStats.set(name, entry);
  };
  for (const sample of samples) {
    for (const name of sample.toolsOffered || []) bump(name, "offered");
    for (const name of sample.toolsCalled || []) bump(name, "called");
  }
  const dead = [...toolStats.entries()].filter(([, s]) => s.offered >= 8 && s.called === 0).map(([name]) => name);
  if (dead.length) {
    notes.push(["warn", tt("Outils présentés pour rien."), tt(`${dead.join(", ")} n'ont jamais été appelés alors qu'ils sont décrits à chaque requête. Leur description occupe le contexte et brouille le choix du modèle : désactivez-les pour les surfaces qui n'en ont pas besoin.`)]);
  }

  const resets = samples.filter((s) => s.reset);
  if (resets.length >= 3) {
    const wasted = resets.reduce((sum, s) => sum + s.promptTokens, 0);
    notes.push(["warn", tt("Contexte repris de zéro trop souvent."), tt(`${resets.length} ruptures mesurées, soit ${fmtNum(wasted)} tokens de préremplissage rejoués. Si elles suivent une inactivité, allongez le keep-alive ; si elles suivent une compaction, relevez le budget de la boucle.`)]);
  }

  const tps = samples.slice(-20).filter((s) => s.tps > 0).map((s) => s.tps);
  const avgTps = tps.length ? tps.reduce((sum, v) => sum + v, 0) / tps.length : 0;
  if (avgTps && avgTps < 6) {
    notes.push(["warn", tt("Génération lente."), tt(`${avgTps.toFixed(1)} tok/s en moyenne. À ce rythme, l'usage conversationnel devient pénible : essayez une quantification plus légère, une fenêtre plus petite, ou un modèle plus petit.`)]);
  }

  if (sys?.total_memory) {
    const ratio = sys.used_memory / sys.total_memory;
    if (ratio > 0.92) {
      notes.push(["crit", tt("Mémoire vive saturée."), tt(`${pct(ratio)} de la RAM est utilisée. Le système va compresser ou paginer, et l'inférence s'effondrera bien avant de manquer de mémoire. Déchargez un modèle (keep-alive) ou réduisez la fenêtre de contexte.`)]);
    }
    const servers = (sys.processes || []).reduce((sum, p) => sum + (p.rss || 0), 0);
    if (servers && servers > sys.total_memory * 0.6) {
      notes.push(["warn", tt("Les serveurs d'inférence dominent la mémoire."), tt(`${fmtBytes(servers)} sont détenus par les serveurs de modèles, soit ${pct(servers / sys.total_memory)} de la machine.`)]);
    }
  }

  if ((runtime.loaded || []).length > 1) {
    notes.push(["warn", tt("Plusieurs modèles chargés simultanément."), tt("Chacun garde sa mémoire réservée. Réduisez le keep-alive si vous n'alternez pas réellement entre eux.")]);
  }

  const prompt = samples.reduce((sum, s) => sum + s.promptTokens, 0);
  const gen = samples.reduce((sum, s) => sum + s.genTokens, 0);
  if (gen > 0 && prompt / gen > 25 && samples.length > 15) {
    notes.push(["warn", tt("Beaucoup d'entrée pour peu de sortie."), tt(`${Math.round(prompt / gen)} tokens envoyés pour 1 token produit. L'essentiel du coût est du préremplissage : allégez le prompt système, la mémoire injectée ou les documents joints.`)]);
  }

  if (!notes.length) {
    notes.push(["ok", tt("Rien à signaler."), samples.length
      ? tt("Les mesures actuelles ne révèlent ni saturation, ni gaspillage manifeste.")
      : tt("Aucun appel mesuré pour l'instant : utilisez Lumen, puis revenez ici.")]);
  }

  host.innerHTML = notes.map(([level, title, body]) =>
    `<div class="advice ${level}"><span class="ic">${level === "ok" ? "✓" : level === "crit" ? "▲" : "!"}</span>` +
    `<span><b>${escapeHtml(title)}</b> ${escapeHtml(body)}</span></div>`
  ).join("");
}

function renderCalls() {
  const host = $("#calls");
  const shown = samples.slice(-60).reverse();
  if (!shown.length) {
    host.innerHTML = `<div class="empty">${tt("Aucun appel mesuré. Les appels de modèles apparaîtront ici, quelle que soit l'app d'origine.")}</div>`;
    return;
  }
  host.innerHTML = shown.map((s) => {
    const tools = (s.toolsCalled || []).length
      ? `<span class="muted">→ ${escapeHtml(s.toolsCalled.join(", "))}</span>`
      : (s.toolsOffered || []).length ? `<span class="muted">${s.toolsOffered.length} ${tt("outils offerts")}</span>` : "";
    // Cliquable comme les pastilles du graphe : c'est souvent par cette liste
    // qu'on repère l'appel dont on veut relire la conversation.
    return `<div class="row clickable ${s.reset ? "reset" : ""}" data-idx="${samples.indexOf(s)}" title="${escapeHtml(tt("Voir le détail et la conversation"))}">` +
      `<span class="pill ${String(s.backend).replace(/[^a-z]/g, "")}">${escapeHtml(s.backend)}</span>` +
      `<span class="src">${escapeHtml(s.app)}</span>` +
      `<span class="muted">${escapeHtml(s.model)}</span>` +
      `<span>${fmtNum(s.promptTokens)} → ${fmtNum(s.genTokens)} tok</span>` +
      (s.tps ? `<span class="muted">${s.tps} tok/s</span>` : "") +
      (s.promptDelta ? `<span class="muted">${s.promptDelta > 0 ? "+" : ""}${fmtNum(s.promptDelta)}</span>` : "") +
      (s.reset ? `<span class="dead">${tt("rupture")}</span>` : "") +
      tools +
      `<span class="when">${new Date(s.ts).toLocaleTimeString()}</span></div>`;
  }).join("");
  host.querySelectorAll(".row.clickable").forEach((row) => {
    row.addEventListener("click", () => {
      const sample = samples[Number(row.dataset.idx)];
      if (sample) openModal("sample", sample);
    });
  });
}

// ===== Formats ============================================================

function fmtNum(n) {
  n = Number(n) || 0;
  return n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} Go`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} Mo`;
  return `${Math.round(n / 1024)} ko`;
}

function pct(ratio) {
  return `${Math.round((Number(ratio) || 0) * 100)} %`;
}

function stripTags(s) {
  return String(s ?? "").replace(/<[^>]*>/g, "");
}

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
