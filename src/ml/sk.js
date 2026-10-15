// Atelier ML — onglet scikit-learn (Python dans le navigateur).
//
// Ce que RpiML faisait avec Flask + une base : ici les datasets sont des CSV
// dans une sandbox (`ml/datasets/`), les modèles des dossiers
// (`ml/models/<nom>/` : model.joblib, model.json, predict.py, pi_server.py…),
// et l'entraînement tourne dans l'interpréteur Python de Lumen (Pyodide, Web
// Worker, cf. python/runtime.js) — scikit-learn est chargé du CDN au premier
// usage puis mis en cache. Aucun serveur, rien ne quitte la machine sauf le
// déploiement SSH vers un Raspberry Pi, explicitement demandé.

import { tt } from "../apps-i18n.js";
import { PythonRuntime } from "../python/runtime.js";
import { RESULT_MARK, trainingScript, predictScript, zipScript, kitFiles } from "./sk-scripts.js";
import { onnxFromModel, mlPickOverlay } from "./main.js";

// `confirm()`/`alert()` sont inopérants dans la WebView Tauri : boîte maison.
async function askConfirm(msg) { const r = await mlPickOverlay(msg, [{ label: tt("Confirmer"), ok: true }, { label: tt("Annuler"), ok: false }]); return !!r?.ok; }
function notify(msg) { $("sk-m-metrics").textContent = msg; }

const invoke = (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const DATA_DIR = "ml/datasets", MODEL_DIR = "ml/models";
const ALGO_LABEL = { logistic_regression: "Régression logistique", decision_tree: "Arbre de décision", random_forest: "Forêt aléatoire", gradient_boosting: "Gradient boosting", svm: "SVM", knn: "k-NN", naive_bayes: "Naive Bayes", linear_regression: "Régression linéaire", random_forest_regressor: "Forêt (régression)" };
const ALGO_PARAMS = { logistic_regression: ["C"], decision_tree: ["max_depth"], random_forest: ["n_estimators", "max_depth"], gradient_boosting: ["n_estimators", "max_depth", "lr"], svm: ["C", "kernel"], knn: ["k"], naive_bayes: [], linear_regression: [], random_forest_regressor: ["n_estimators", "max_depth"] };

const S = { sandbox: "", datasets: [], dataset: null, csv: null, models: [], model: null, editing: null };
let py = null;

function log(line, { reset = false } = {}) {
  const el = $("sk-log"); if (reset) el.textContent = "";
  el.textContent += line.endsWith("\n") ? line : line + "\n"; el.scrollTop = el.scrollHeight;
}
function piLog(line, reset = false) { const el = $("sk-pi-log"); if (reset) el.textContent = ""; el.textContent += line + "\n"; el.scrollTop = el.scrollHeight; }

// ===== Interpréteur Python =====
function runtime() {
  if (py) return py;
  py = new PythonRuntime({
    onStatus: ({ state, version, detail }) => {
      const box = $("sk-runtime"); box.className = "sk-runtime " + state;
      $("sk-runtime-txt").textContent = state === "ready" ? `Python ${version} prêt` : state === "loading" ? (detail || tt("Démarrage de Python…")) : state === "error" ? tt("Python en erreur : ") + (detail || "") : tt("Python : non démarré");
      $("sk-runtime-btn").textContent = state === "ready" ? tt("Redémarrer") : tt("Démarrer");
      $("sk-train").disabled = !(state === "ready" && S.dataset);
    },
    onOutput: ({ kind, text }) => { if (kind === "stderr" && /warning/i.test(text)) return; log(text); },
  });
  return py;
}
async function ensurePython() { const r = runtime(); await r.start(); return r; }

/** Exécute un script et renvoie le JSON derrière RESULT_MARK (ou lève). */
async function runPy(code, files = {}) {
  const r = await ensurePython();
  let captured = null;
  const prev = r.onOutput;
  r.onOutput = (o) => { if (o.kind === "stdout" && o.text.includes(RESULT_MARK)) { const i = o.text.indexOf(RESULT_MARK); try { captured = JSON.parse(o.text.slice(i + RESULT_MARK.length).trim().split("\n")[0]); } catch {} return; } prev(o); };
  try {
    const res = await r.run(code, { files, fresh: true });
    if (!res.ok) throw new Error(res.error || "Échec du script Python");
    return { result: captured, files: res.files || {} };
  } finally { r.onOutput = prev; }
}

// ===== Sandbox : datasets et modèles =====
async function readDir(path) { try { return await invoke("sandbox_read_dir", { id: S.sandbox, path }); } catch { return []; } }
async function readText(path) { const fc = await invoke("sandbox_read_file", { id: S.sandbox, path }); return fc?.content ?? ""; }
async function ensureDirs() { for (const d of ["ml", DATA_DIR, MODEL_DIR]) { try { await invoke("sandbox_create_dir", { id: S.sandbox, path: d }); } catch {} } }

async function refresh() {
  if (!invoke || !S.sandbox) { renderDatasets(); renderModels(); return; }
  S.datasets = (await readDir(DATA_DIR)).filter((e) => !e.is_dir && /\.(csv|tsv|txt)$/i.test(e.name));
  const dirs = (await readDir(MODEL_DIR)).filter((e) => e.is_dir);
  S.models = [];
  for (const d of dirs) {
    try { const meta = JSON.parse(await readText(`${d.path}/model.json`)); S.models.push({ ...meta, dir: d.path, folder: d.name }); } catch { /* dossier sans métadonnées */ }
  }
  S.models.sort((a, b) => (b.created || 0) - (a.created || 0));
  renderDatasets(); renderModels();
}

// ===== CSV =====
function parseCSV(text) {
  const sep = (text.split("\n")[0] || "").includes(";") && !(text.split("\n")[0] || "").includes(",") ? ";" : (text.split("\n")[0] || "").includes("\t") ? "\t" : ",";
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  const clean = rows.filter((r) => r.some((x) => x.trim() !== ""));
  return { header: clean[0] || [], rows: clean.slice(1) };
}
function toCSV(header, rows) {
  const q = (v) => { const s = String(v ?? ""); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [header.map(q).join(","), ...rows.map((r) => r.map(q).join(","))].join("\n") + "\n";
}

// ===== Datasets : liste, aperçu, éditeur =====
function renderDatasets() {
  const host = $("sk-datasets"); host.innerHTML = "";
  if (!S.datasets.length) { host.innerHTML = `<div class="muted">${esc(tt("Aucun dataset dans « ml/datasets » de cette sandbox. Importe un CSV (avec une colonne cible) ou crée un dataset texte."))}</div>`; return; }
  for (const d of S.datasets) {
    const it = document.createElement("div"); it.className = "sk-item" + (S.dataset?.path === d.path ? " on" : "");
    it.innerHTML = `<b></b><small>${esc((d.size / 1024).toFixed(1))} Ko</small><button class="btn tiny" data-act="edit" title="${esc(tt("Modifier"))}">✎</button><button class="btn tiny ghost" data-act="del" title="${esc(tt("Supprimer"))}">🗑</button>`;
    it.querySelector("b").textContent = d.name;
    it.addEventListener("click", () => selectDataset(d));
    it.querySelector('[data-act="edit"]').addEventListener("click", (e) => { e.stopPropagation(); editDataset(d); });
    it.querySelector('[data-act="del"]').addEventListener("click", async (e) => { e.stopPropagation(); if (!(await askConfirm(tt("Supprimer ce dataset ?")))) return; await invoke("sandbox_delete_path", { id: S.sandbox, path: d.path }); if (S.dataset?.path === d.path) { S.dataset = null; $("sk-preview").hidden = true; } refresh(); });
    host.appendChild(it);
  }
}

async function selectDataset(d) {
  S.dataset = d; S.csv = parseCSV(await readText(d.path));
  $("sk-editor").hidden = true;
  renderPreview(); renderDatasets();
  if (!$("sk-name").value.trim()) $("sk-name").value = d.name.replace(/\.(csv|tsv|txt)$/i, "").replace(/[^a-z0-9_-]+/gi, "_").toLowerCase();
  $("sk-train").disabled = !(py?.state === "ready");
}
function renderPreview() {
  const { header, rows } = S.csv; const pv = $("sk-preview"); pv.hidden = false;
  $("sk-pv-name").textContent = S.dataset.name; $("sk-pv-shape").textContent = tt("{r} lignes × {c} colonnes", { r: rows.length, c: header.length });
  const sel = $("sk-target"); sel.innerHTML = "";
  for (const h of header) sel.appendChild(new Option(h, h));
  sel.value = header.includes("target") ? "target" : header.includes("label") ? "label" : header[header.length - 1];
  const tbl = $("sk-pv-table"); tbl.innerHTML = "";
  const tr = document.createElement("tr"); for (const h of header) { const th = document.createElement("th"); th.textContent = h; tr.appendChild(th); } tbl.appendChild(tr);
  for (const r of rows.slice(0, 8)) { const trr = document.createElement("tr"); for (let i = 0; i < header.length; i++) { const td = document.createElement("td"); td.textContent = String(r[i] ?? "").slice(0, 40); trr.appendChild(td); } tbl.appendChild(trr); }
  updateClassInfo();
}
function updateClassInfo() {
  const { header, rows } = S.csv; const ti = header.indexOf($("sk-target").value);
  const counts = new Map(); for (const r of rows) counts.set(r[ti], (counts.get(r[ti]) || 0) + 1);
  const numeric = [...counts.keys()].every((k) => k !== "" && !Number.isNaN(Number(k)));
  const summary = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} (${n})`).join(" · ");
  $("sk-pv-classes").textContent = counts.size > 12 && numeric ? tt("Cible numérique continue ({n} valeurs) → régression", { n: counts.size }) : tt("Classes : ") + summary + (counts.size > 8 ? " …" : "");
}

function editDataset(d = null) {
  S.editing = d;
  const ed = $("sk-editor"); ed.hidden = false; $("sk-preview").hidden = true;
  $("sk-ed-name").value = d ? d.name.replace(/\.csv$/i, "") : "";
  (async () => {
    const data = d ? parseCSV(await readText(d.path)) : { header: ["text", "target"], rows: [["", ""]] };
    S.edit = data; renderEditor();
  })();
}
function renderEditor() {
  const { header, rows } = S.edit; const tbl = $("sk-ed-table"); tbl.innerHTML = "";
  const tr = document.createElement("tr"); for (const h of header) { const th = document.createElement("th"); th.textContent = h; tr.appendChild(th); } const thx = document.createElement("th"); tr.appendChild(thx); tbl.appendChild(tr);
  rows.forEach((r, ri) => {
    const trr = document.createElement("tr");
    header.forEach((_, ci) => { const td = document.createElement("td"); const inp = document.createElement("input"); inp.value = r[ci] ?? ""; inp.addEventListener("input", () => { r[ci] = inp.value; }); td.appendChild(inp); trr.appendChild(td); });
    const td = document.createElement("td"); const x = document.createElement("button"); x.className = "btn tiny ghost"; x.textContent = "✕"; x.addEventListener("click", () => { rows.splice(ri, 1); renderEditor(); }); td.appendChild(x); trr.appendChild(td);
    tbl.appendChild(trr);
  });
  $("sk-ed-info").textContent = tt("{n} ligne(s)", { n: rows.length });
}
async function saveEditor() {
  const name = ($("sk-ed-name").value.trim() || "dataset").replace(/[^a-z0-9_-]+/gi, "_") + ".csv";
  const rows = S.edit.rows.filter((r) => r.some((x) => String(x).trim()));
  if (!rows.length) return;
  await ensureDirs();
  await invoke("sandbox_write_file", { id: S.sandbox, path: `${DATA_DIR}/${name}`, content: toCSV(S.edit.header, rows) });
  $("sk-editor").hidden = true;
  await refresh();
  const d = S.datasets.find((x) => x.name === name); if (d) selectDataset(d);
}
async function importCSV(file) {
  await ensureDirs();
  const name = file.name.replace(/[^a-z0-9._-]+/gi, "_");
  await invoke("sandbox_write_file", { id: S.sandbox, path: `${DATA_DIR}/${name}`, content: await file.text() });
  await refresh(); const d = S.datasets.find((x) => x.name === name); if (d) selectDataset(d);
}
async function loadSample() {
  const text = await fetch(new URL("./samples/sample_commands.csv", import.meta.url)).then((r) => r.text());
  await ensureDirs();
  await invoke("sandbox_write_file", { id: S.sandbox, path: `${DATA_DIR}/sample_commands.csv`, content: text });
  await refresh(); const d = S.datasets.find((x) => x.name === "sample_commands.csv"); if (d) selectDataset(d);
}

// ===== Entraînement =====
function readParams() {
  return { n_estimators: Number($("sk-p-trees").value) || 100, max_depth: Number($("sk-p-depth").value) || 0, C: Number($("sk-p-c").value) || 1, kernel: $("sk-p-kernel").value, k: Number($("sk-p-k").value) || 5, lr: Number($("sk-p-lr").value) || 0.1 };
}
function showParams() { const on = ALGO_PARAMS[$("sk-algo").value] || []; document.querySelectorAll("#sk-params [data-p]").forEach((el) => { el.hidden = !on.includes(el.dataset.p); }); }

async function train() {
  if (!S.dataset) return;
  const name = ($("sk-name").value.trim() || "modele").replace(/[^a-z0-9_-]+/gi, "_").toLowerCase();
  const algo = $("sk-algo").value;
  $("sk-train").disabled = true; $("sk-metrics").innerHTML = ""; $("sk-confusion").innerHTML = ""; $("sk-log-box").open = true;
  log(tt("Chargement de scikit-learn (première fois : quelques dizaines de Mo depuis le CDN)…"), { reset: true });
  try {
    const csvText = toCSV(S.csv.header, S.csv.rows);
    const outDir = `/project/${MODEL_DIR}/${name}`;
    const cfg = { csv: `/project/${DATA_DIR}/${S.dataset.name}`, target: $("sk-target").value, algo, params: readParams(), testSize: Number($("sk-split").value) / 100, name, cv: $("sk-cv").checked, outDir, extraFiles: kitFiles(name) };
    const files = { [`${DATA_DIR}/${S.dataset.name}`]: { text: csvText } };
    const { result, files: produced } = await runPy(trainingScript(cfg), files);
    if (!result) throw new Error(tt("Aucun résultat renvoyé par le script."));
    // Retour des fichiers du modèle dans la sandbox.
    await ensureDirs();
    try { await invoke("sandbox_create_dir", { id: S.sandbox, path: `${MODEL_DIR}/${name}` }); } catch {}
    for (const [rel, f] of Object.entries(produced)) {
      if (!rel.startsWith(`${MODEL_DIR}/${name}/`)) continue;
      if (typeof f.text === "string") await invoke("sandbox_write_file", { id: S.sandbox, path: rel, content: f.text });
      else if (f.b64) await invoke("sandbox_import_file", { id: S.sandbox, path: rel, dataB64: f.b64 });
    }
    renderMetrics(result);
    await refresh();
    const m = S.models.find((x) => x.folder === name); if (m) selectModel(m);
  } catch (e) { log("✗ " + (e?.message || e)); $("sk-metrics").innerHTML = `<span style="color:var(--red)">${esc(e?.message || e)}</span>`; }
  finally { $("sk-train").disabled = false; }
}

function renderMetrics(r) {
  const m = r.metrics || {}; const box = $("sk-metrics");
  if (r.task === "regression") box.innerHTML = `${esc(tt("Test sur {n} ex.", { n: r.n_test }))}<br>R² : <b>${m.r2?.toFixed(3)}</b> · RMSE : <b>${m.rmse?.toFixed(3)}</b> · MAE : <b>${m.mae?.toFixed(3)}</b>`;
  else box.innerHTML = `${esc(tt("Test sur {n} ex.", { n: r.n_test }))}<br>${tt("Exactitude")} : <b>${(m.accuracy * 100).toFixed(1)}%</b> · F1 : <b>${m.f1?.toFixed(3)}</b> · ${tt("précision")} : <b>${m.precision?.toFixed(3)}</b> · ${tt("rappel")} : <b>${m.recall?.toFixed(3)}</b>`;
  if (r.cv) box.innerHTML += `<br>${tt("Validation croisée")} : <b>${r.cv.mean.toFixed(3)}</b> ± ${r.cv.std.toFixed(3)}`;
  box.innerHTML += `<br><span class="muted">${esc(r.seconds)} s · scikit-learn ${esc(r.sklearn)}</span>`;
  const cm = $("sk-confusion"); cm.innerHTML = "";
  if (r.confusion && r.classes?.length <= 12) {
    const n = r.classes.length; const max = Math.max(1, ...r.confusion.flat());
    const grid = document.createElement("div"); grid.className = "cm"; grid.style.gridTemplateColumns = `auto repeat(${n}, 1fr)`;
    grid.innerHTML = `<div class="h">${esc(tt("réel ↓ / prédit →"))}</div>` + r.classes.map((c) => `<div class="h" title="${esc(c)}">${esc(c)}</div>`).join("");
    r.confusion.forEach((row, i) => { grid.innerHTML += `<div class="h" title="${esc(r.classes[i])}">${esc(r.classes[i])}</div>` + row.map((v) => `<div class="c" style="--p:${(v / max).toFixed(2)}">${v}</div>`).join(""); });
    cm.appendChild(grid);
  }
}

// ===== Modèles =====
function renderModels() {
  const host = $("sk-models"); host.innerHTML = "";
  if (!S.models.length) { host.innerHTML = `<div class="muted">${esc(tt("Aucun modèle entraîné dans cette sandbox."))}</div>`; $("sk-model").hidden = true; return; }
  for (const m of S.models) {
    const it = document.createElement("div"); it.className = "sk-item" + (S.model?.dir === m.dir ? " on" : "");
    const score = m.task === "regression" ? `R² ${m.metrics?.r2?.toFixed(2)}` : `${((m.metrics?.accuracy || 0) * 100).toFixed(0)} %`;
    it.innerHTML = `<span class="tag">${esc(m.text_column ? "texte" : m.task === "regression" ? "régr." : "tab.")}</span><b></b><small>${esc(ALGO_LABEL[m.algo] || m.algo)} · ${esc(score)}</small>`;
    it.querySelector("b").textContent = m.name || m.folder;
    it.addEventListener("click", () => selectModel(m));
    host.appendChild(it);
  }
}
function selectModel(m) {
  S.model = m; renderModels();
  const box = $("sk-model"); box.hidden = false;
  $("sk-m-name").textContent = m.name || m.folder;
  $("sk-m-meta").textContent = `${ALGO_LABEL[m.algo] || m.algo} · ${new Date((m.created || 0) * 1000).toLocaleString()}`;
  const mt = m.metrics || {};
  $("sk-m-metrics").textContent = m.task === "regression" ? `R² ${mt.r2?.toFixed(3)} · RMSE ${mt.rmse?.toFixed(3)}` : `${tt("Exactitude")} ${((mt.accuracy || 0) * 100).toFixed(1)} % · F1 ${mt.f1?.toFixed(3)} · ${m.classes?.length || 0} ${tt("classes")}`;
  $("sk-m-onnx").hidden = !m.linear; $("sk-m-json").hidden = !m.linear;
  const inputs = $("sk-inputs"); inputs.innerHTML = "";
  $("sk-text-f").hidden = !m.text_column;
  if (!m.text_column) for (const f of m.features || []) { const l = document.createElement("label"); l.innerHTML = `<span></span><input type="text" data-f="" />`; l.querySelector("span").textContent = f; l.querySelector("input").dataset.f = f; inputs.appendChild(l); }
  $("sk-pred").textContent = "—";
  if ($("sk-pi-host").value && !$("sk-pi-url").value) $("sk-pi-url").value = `http://${$("sk-pi-host").value}:8010/`;
}
async function modelFiles(m) {
  // Le dossier complet du modèle, recopié dans /project pour le script.
  const files = {};
  for (const e of await readDir(m.dir)) {
    if (e.is_dir) continue;
    if (/\.(json|py|txt|md)$/i.test(e.name)) files[e.path] = { text: await readText(e.path) };
    else files[e.path] = { b64: await invoke("sandbox_read_b64", { id: S.sandbox, path: e.path }) };
  }
  return files;
}
function sampleFromInputs(m) {
  if (m.text_column) return $("sk-text").value;
  const s = {}; $("sk-inputs").querySelectorAll("input").forEach((i) => { s[i.dataset.f] = i.value; }); return s;
}
async function predictLocal() {
  const m = S.model; if (!m) return;
  $("sk-pred").textContent = "…";
  try {
    const { result } = await runPy(predictScript(`/project/${m.dir}`, sampleFromInputs(m)), await modelFiles(m));
    showPrediction(result);
  } catch (e) { $("sk-pred").textContent = "✗ " + (e?.message || e); }
}
function showPrediction(r) {
  if (!r) { $("sk-pred").textContent = "—"; return; }
  if (r.error) { $("sk-pred").textContent = "✗ " + r.error; return; }
  const probs = r.probs ? Object.entries(r.probs).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${(v * 100).toFixed(0)} %`).join(" · ") : "";
  $("sk-pred").innerHTML = `${esc(typeof r.prediction === "number" ? r.prediction.toFixed(3) : r.prediction)}${r.proba != null ? `<small>${esc(tt("confiance"))} ${(r.proba * 100).toFixed(0)} %${probs ? " — " + esc(probs) : ""}${r.time != null ? ` · ${(r.time * 1000).toFixed(0)} ms` : ""}</small>` : ""}`;
}
async function downloadKit() {
  const m = S.model; if (!m) return;
  try {
    const { result } = await runPy(zipScript(`/project/${m.dir}`), await modelFiles(m));
    const a = document.createElement("a"); a.href = "data:application/zip;base64," + result.b64; a.download = `${m.folder}.zip`; a.click();
  } catch (e) { notify("✗ " + (e?.message || e)); }
}
/** Modèle linéaire → format « couches » de l'Atelier (Fluxo « Prédire (ML) » et encodeur ONNX). */
function linearAsLayers(m) {
  const L = m.linear; const F = m.features.length;
  let w = L.coef.map((r) => r.slice()), b = L.intercept.slice();
  if (m.task !== "regression" && w.length === 1) { w = [w[0].map(() => 0), w[0]]; b = [0, b[0]]; } // binaire → 2 logits
  const act = m.task === "regression" ? "linear" : "softmax";
  return { task: m.task, input: "tabular", features: m.features, mean: L.mean, std: L.scale, classes: m.classes, ymean: 0, ystd: 1, layers: [{ w, b, act }] };
}
function downloadOnnx() { const m = S.model; if (!m?.linear) return; const data = onnxFromModel(linearAsLayers(m)); const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([data], { type: "application/octet-stream" })); a.download = `${m.folder}.onnx`; a.click(); }
async function saveFluxo() { const m = S.model; if (!m?.linear) return; await invoke("sandbox_write_file", { id: S.sandbox, path: `${m.folder}.mlmodel.json`, content: JSON.stringify(linearAsLayers(m)) }); notify(tt("Enregistré : ") + `${m.folder}.mlmodel.json`); }
async function deleteModel() { const m = S.model; if (!m || !(await askConfirm(tt("Supprimer ce modèle ?")))) return; await invoke("sandbox_delete_path", { id: S.sandbox, path: m.dir }); S.model = null; $("sk-model").hidden = true; refresh(); }

// ===== Raspberry Pi =====
const pi = () => ({ host: $("sk-pi-host").value.trim(), user: $("sk-pi-user").value.trim() || "pi", port: Number($("sk-pi-port").value) || 22, dir: $("sk-pi-dir").value.trim() || "~/models" });
async function piExec(command) { const p = pi(); if (!p.host) throw new Error(tt("Indique l'adresse du Raspberry Pi.")); const r = await invoke("pi_ssh_exec", { host: p.host, user: p.user, port: p.port, command }); if (r.stdout) piLog(r.stdout.trim()); if (r.stderr) piLog(r.stderr.trim()); if (!r.ok) throw new Error(tt("Commande SSH en échec")); return r; }
async function piCheck() { piLog(tt("Connexion…"), true); try { await piExec("uname -a && python3 --version && df -h ~ | tail -1"); piLog("✓ " + tt("Accès SSH OK")); } catch (e) { piLog("✗ " + (e?.message || e)); } }
async function piEnv() { piLog(tt("Création de l'environnement (~ml-env) et installation de scikit-learn : plusieurs minutes…"), true); try { await piExec("python3 -m venv ~/ml-env 2>&1 && ~/ml-env/bin/pip install --quiet --upgrade pip scikit-learn joblib pandas numpy 2>&1 | tail -3 && ~/ml-env/bin/python -c 'import sklearn; print(\"scikit-learn\", sklearn.__version__)'"); piLog("✓ " + tt("Environnement prêt")); } catch (e) { piLog("✗ " + (e?.message || e)); } }
async function piDeploy() {
  const m = S.model; if (!m) return; const p = pi(); if (!p.host) { piLog(tt("Indique l'adresse du Raspberry Pi.")); return; }
  piLog(tt("Déploiement de « {n} »…", { n: m.folder }), true);
  try {
    const paths = (await readDir(m.dir)).filter((e) => !e.is_dir).map((e) => e.path);
    const remote = `${p.dir.replace(/\/$/, "")}/${m.folder}`;
    const r = await invoke("pi_scp_push", { host: p.host, user: p.user, port: p.port, sandbox: S.sandbox, paths, remoteDir: remote });
    if (r.stderr) piLog(r.stderr.trim());
    if (!r.ok) throw new Error(tt("Copie SSH en échec"));
    piLog(`✓ ${paths.length} ${tt("fichier(s) copié(s) dans")} ${remote}`);
    $("sk-pi-url").value = `http://${p.host}:8010/`;
  } catch (e) { piLog("✗ " + (e?.message || e)); }
}
async function piStart() {
  const m = S.model; if (!m) return; const p = pi(); const remote = `${p.dir.replace(/\/$/, "")}/${m.folder}`;
  piLog(tt("Démarrage du serveur d'inférence…"), true);
  try { await piExec(`cd ${remote} && (pgrep -f 'pi_server.py' >/dev/null && pkill -f 'pi_server.py'; true) && nohup ~/ml-env/bin/python pi_server.py --port 8010 > server.log 2>&1 & sleep 2; cat ${remote}/server.log | tail -2`); $("sk-pi-url").value = `http://${p.host}:8010/`; } catch (e) { piLog("✗ " + (e?.message || e)); }
}
async function piPredict() {
  const m = S.model; const url = $("sk-pi-url").value.trim(); if (!m || !url) return;
  $("sk-pred").textContent = "…";
  try { const txt = await invoke("pi_http_json", { url, body: { sample: sampleFromInputs(m) }, timeoutS: 60 }); showPrediction(JSON.parse(txt)); }
  catch (e) { $("sk-pred").textContent = "✗ " + (e?.message || e); }
}

// ===== Câblage =====
async function fillSandboxes() {
  const sel = $("sk-sandbox"); sel.innerHTML = "";
  if (!invoke) { sel.appendChild(new Option(tt("(hors application)"), "")); return; }
  try { for (const sb of await invoke("sandbox_list")) sel.appendChild(new Option(sb.name || sb.id, sb.id)); } catch {}
  if (!sel.options.length) sel.appendChild(new Option("(aucune sandbox)", ""));
  S.sandbox = sel.value;
}
function init() {
  $("sk-sandbox").addEventListener("change", (e) => { S.sandbox = e.target.value; S.dataset = null; S.model = null; $("sk-preview").hidden = true; $("sk-model").hidden = true; refresh(); });
  $("sk-refresh").addEventListener("click", refresh);
  $("sk-import").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) importCSV(f); e.target.value = ""; });
  $("sk-new-text").addEventListener("click", () => editDataset(null));
  $("sk-sample").addEventListener("click", loadSample);
  $("sk-ed-close").addEventListener("click", () => { $("sk-editor").hidden = true; if (S.dataset) $("sk-preview").hidden = false; });
  $("sk-ed-add").addEventListener("click", () => { S.edit.rows.push(S.edit.header.map(() => "")); renderEditor(); });
  $("sk-ed-save").addEventListener("click", saveEditor);
  $("sk-target").addEventListener("change", updateClassInfo);
  $("sk-runtime-btn").addEventListener("click", () => { if (py?.state === "ready") py.restart(); else ensurePython().catch(() => {}); });
  $("sk-algo").addEventListener("change", showParams); showParams();
  $("sk-split").addEventListener("input", () => { $("sk-split-out").textContent = $("sk-split").value + "%"; });
  $("sk-train").addEventListener("click", train);
  $("sk-predict").addEventListener("click", predictLocal);
  $("sk-text").addEventListener("keydown", (e) => { if (e.key === "Enter") predictLocal(); });
  $("sk-m-download").addEventListener("click", downloadKit);
  $("sk-m-onnx").addEventListener("click", downloadOnnx);
  $("sk-m-json").addEventListener("click", saveFluxo);
  $("sk-m-delete").addEventListener("click", deleteModel);
  $("sk-pi-check").addEventListener("click", piCheck);
  $("sk-pi-env").addEventListener("click", piEnv);
  $("sk-pi-deploy").addEventListener("click", piDeploy);
  $("sk-pi-start").addEventListener("click", piStart);
  $("sk-pi-predict").addEventListener("click", piPredict);
  try { const saved = JSON.parse(localStorage.getItem("ml.pi") || "{}"); for (const k of ["host", "user", "port", "dir"]) if (saved[k]) $(`sk-pi-${k}`).value = saved[k]; } catch {}
  for (const k of ["host", "user", "port", "dir"]) $(`sk-pi-${k}`).addEventListener("change", () => { const p = pi(); try { localStorage.setItem("ml.pi", JSON.stringify(p)); } catch {} });
  fillSandboxes().then(refresh);
}
init();
