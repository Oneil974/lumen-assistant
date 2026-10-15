import { llmChat } from "../llm.js";
import { streamTarget } from "../lib/stream-view.js";
import { PROMPTS } from "./prompts.js";
import { inLang, replyLang } from "../lib/prompt-lang.js";
import * as tablesDb from "../tables/client.js";
import { autoTranslate, tt } from "../apps-i18n.js";
import { loadTransformers } from "../lib/transformers-loader.js";
autoTranslate({ observe: true });

// Atelier ML — entraînement 100 % local dans le navigateur. Implémente un petit
// réseau de neurones dense (perceptron multicouche) avec rétropropagation maison,
// qui couvre aussi la régression linéaire (1 couche linéaire) et la régression
// logistique (1 couche sigmoïde). Export d'un modèle JSON au format « couches »
// lisible par le bloc Fluxo « Prédire (ML) » (Rust).

const invoke = (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke;
const $ = (id) => document.getElementById(id);

/* ===================== Réseau de neurones ===================== */
const rng = () => (Math.random() * 2 - 1);
function dense(inDim, outDim) {
  const s = Math.sqrt(2 / inDim);
  return { w: Array.from({ length: outDim }, () => Array.from({ length: inDim }, () => rng() * s)), b: new Array(outDim).fill(0) };
}
function act(v, kind) {
  if (kind === "relu") return v.map((x) => Math.max(0, x));
  if (kind === "sigmoid") return v.map((x) => 1 / (1 + Math.exp(-x)));
  if (kind === "tanh") return v.map((x) => Math.tanh(x));
  if (kind === "softmax") { const m = Math.max(...v); const e = v.map((x) => Math.exp(x - m)); const s = e.reduce((a, b) => a + b, 0); return e.map((x) => x / s); }
  return v.slice(); // linear
}
function actDeriv(out, z, kind) {
  if (kind === "relu") return z.map((x) => (x > 0 ? 1 : 0));
  if (kind === "sigmoid") return out.map((o) => o * (1 - o));
  if (kind === "tanh") return out.map((o) => 1 - o * o);
  return z.map(() => 1); // linear (softmax/linear handled at output)
}
function matvec(w, x) { return w.map((row) => row.reduce((s, wij, i) => s + wij * x[i], 0)); }

// Cède la main au navigateur SANS setTimeout : les timers d'un onglet/fenêtre
// masqué sont throttlés (jusqu'à 1/min), ce qui suspendait l'entraînement dès
// que la fenêtre passait en arrière-plan. MessageChannel n'est pas throttlé.
function nextTick() {
  return new Promise((r) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => r();
    ch.port2.postMessage(0);
  });
}

function buildNet(inDim, hidden, outDim, outAct) {
  const layers = [];
  let prev = inDim;
  for (const h of hidden) { layers.push({ ...dense(prev, h), act: "relu" }); prev = h; }
  layers.push({ ...dense(prev, outDim), act: outAct });
  return layers;
}
function forward(layers, x) {
  const cache = [{ out: x }];
  let a = x;
  for (const L of layers) { const z = matvec(L.w, a).map((v, j) => v + L.b[j]); const out = act(z, L.act); cache.push({ z, out, inp: a }); a = out; }
  return cache;
}
// Entraînement par descente de gradient. Gère MSE (régression), BCE (sigmoïde
// binaire) et entropie croisée (softmax).
// Options : `batchSize` (0 = batch complet, sinon mini-batches mélangés à chaque
// époque) et `adam` (optimiseur Adam au lieu de la descente à taux fixe — bien
// plus efficace sur les gros datasets, ex. tête linéaire sur embeddings).
// ASYNC : rend la main au navigateur toutes les ~40 ms — l'UI reste réactive et
// la courbe de perte se dessine EN DIRECT (avant, tout tournait dans un seul
// setTimeout bloquant : aucun repaint avant la fin).
async function train(layers, X, Y, { lr, epochs, batchSize = 0, adam = false, onEpoch }) {
  const n = X.length, outAct = layers[layers.length - 1].act;
  const bs = batchSize > 0 ? Math.min(batchSize, n) : n;
  // État Adam (moments d'ordre 1 et 2 par paramètre).
  const B1 = 0.9, B2 = 0.999, EPS = 1e-8;
  let mW, vW, mB, vB, tStep = 0;
  if (adam) {
    mW = layers.map((L) => L.w.map((r) => r.map(() => 0)));
    vW = layers.map((L) => L.w.map((r) => r.map(() => 0)));
    mB = layers.map((L) => L.b.map(() => 0));
    vB = layers.map((L) => L.b.map(() => 0));
  }
  const order = X.map((_, i) => i);
  let lastYield = performance.now();
  for (let ep = 0; ep < epochs; ep++) {
    if (bs < n) for (let i = order.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [order[i], order[j]] = [order[j], order[i]]; }
    let epochLoss = 0;
    for (let start = 0; start < n; start += bs) {
      const m = Math.min(bs, n - start);
      const gW = layers.map((L) => L.w.map((r) => r.map(() => 0)));
      const gB = layers.map((L) => L.b.map(() => 0));
      for (let k = 0; k < m; k++) {
        const s = order[start + k];
        const cache = forward(layers, X[s]);
        const out = cache[cache.length - 1].out, y = Y[s];
        // gradient sur la pré-activation de sortie (identique pour MSE/BCE/CE)
        let dz = out.map((o, i) => o - y[i]);
        if (outAct === "softmax") epochLoss += -y.reduce((a, yi, i) => a + (yi ? Math.log(out[i] + 1e-9) : 0), 0);
        else if (outAct === "sigmoid") epochLoss += out.reduce((a, o, i) => a - (y[i] * Math.log(o + 1e-9) + (1 - y[i]) * Math.log(1 - o + 1e-9)), 0);
        else epochLoss += out.reduce((a, o, i) => a + 0.5 * (o - y[i]) ** 2, 0);
        // rétropropagation
        for (let l = layers.length - 1; l >= 0; l--) {
          const c = cache[l + 1];
          // Dérivée d'activation calculée UNE fois par couche (l'ancien code la
          // recalculait pour chaque neurone → O(n²) inutile).
          if (l < layers.length - 1) { const dv = actDeriv(c.out, c.z, layers[l].act); dz = dz.map((d, j) => d * dv[j]); }
          for (let j = 0; j < layers[l].w.length; j++) { gB[l][j] += dz[j]; for (let i = 0; i < c.inp.length; i++) gW[l][j][i] += dz[j] * c.inp[i]; }
          if (l > 0) { const wT = c.inp.map((_, i) => layers[l].w.reduce((s, row, j) => s + row[i] * dz[j], 0)); dz = wT; }
        }
      }
      if (adam) {
        tStep++;
        const c1 = 1 - Math.pow(B1, tStep), c2 = 1 - Math.pow(B2, tStep);
        for (let l = 0; l < layers.length; l++) {
          for (let j = 0; j < layers[l].w.length; j++) {
            const gb = gB[l][j] / m;
            mB[l][j] = B1 * mB[l][j] + (1 - B1) * gb; vB[l][j] = B2 * vB[l][j] + (1 - B2) * gb * gb;
            layers[l].b[j] -= lr * (mB[l][j] / c1) / (Math.sqrt(vB[l][j] / c2) + EPS);
            for (let i = 0; i < layers[l].w[j].length; i++) {
              const g = gW[l][j][i] / m;
              mW[l][j][i] = B1 * mW[l][j][i] + (1 - B1) * g; vW[l][j][i] = B2 * vW[l][j][i] + (1 - B2) * g * g;
              layers[l].w[j][i] -= lr * (mW[l][j][i] / c1) / (Math.sqrt(vW[l][j][i] / c2) + EPS);
            }
          }
        }
      } else {
        for (let l = 0; l < layers.length; l++) {
          for (let j = 0; j < layers[l].w.length; j++) { layers[l].b[j] -= lr * gB[l][j] / m; for (let i = 0; i < layers[l].w[j].length; i++) layers[l].w[j][i] -= lr * gW[l][j][i] / m; }
        }
      }
      if (performance.now() - lastYield > 40) {
        await nextTick();
        lastYield = performance.now();
      }
    }
    if (onEpoch && (ep % Math.ceil(epochs / 60) === 0 || ep === epochs - 1)) onEpoch(ep, epochLoss / n);
  }
}
function predictVec(layers, x) { const c = forward(layers, x); return c[c.length - 1].out; }

/* ===================== Stats / utilitaires ===================== */
function standardize(X) {
  const d = X[0].length, mean = new Array(d).fill(0), std = new Array(d).fill(0);
  for (const r of X) r.forEach((v, i) => (mean[i] += v));
  mean.forEach((_, i) => (mean[i] /= X.length));
  for (const r of X) r.forEach((v, i) => (std[i] += (v - mean[i]) ** 2));
  std.forEach((_, i) => (std[i] = Math.sqrt(std[i] / X.length) || 1));
  return { mean, std, Z: X.map((r) => r.map((v, i) => (v - mean[i]) / std[i])) };
}
function drawLoss(canvas, hist) {
  const ctx = canvas.getContext("2d"), W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (hist.length < 2) return;
  const max = Math.max(...hist), min = Math.min(...hist), pad = 6;
  ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue("--accent") || "#0a84ff";
  ctx.lineWidth = 2; ctx.beginPath();
  hist.forEach((v, i) => { const x = pad + (i / (hist.length - 1)) * (W - 2 * pad); const y = H - pad - ((v - min) / (max - min || 1)) * (H - 2 * pad); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();
}
// Graphe d'entraînement à 2 courbes : perte (échelle propre, couleur accent) et
// exactitude validation (0–100 %, vert). Dessiné en direct à chaque époque.
function drawTrainChart(canvas, lossHist, accHist) {
  const ctx = canvas.getContext("2d"), W = canvas.width, H = canvas.height, pad = 6;
  ctx.clearRect(0, 0, W, H);
  const path = (hist, min, max, color) => {
    if (hist.length < 2) return;
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
    hist.forEach((v, i) => {
      const x = pad + (i / (hist.length - 1)) * (W - 2 * pad);
      const y = H - pad - ((v - min) / (max - min || 1)) * (H - 2 * pad);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  };
  const accent = getComputedStyle(document.body).getPropertyValue("--accent").trim() || "#0a84ff";
  const ok = getComputedStyle(document.body).getPropertyValue("--ok").trim() || "#34c759";
  if (lossHist.length) path(lossHist, Math.min(...lossHist), Math.max(...lossHist), accent);
  if (accHist?.length) path(accHist, 0, 1, ok);
  // dernières valeurs en repère
  ctx.font = "10px -apple-system,sans-serif"; ctx.textAlign = "right";
  if (lossHist.length) { ctx.fillStyle = accent; ctx.fillText(`perte ${lossHist[lossHist.length - 1].toFixed(3)}`, W - 8, 12); }
  if (accHist?.length) { ctx.fillStyle = ok; ctx.fillText(`val ${(accHist[accHist.length - 1] * 100).toFixed(1)}%`, W - 8, 24); }
}
function setStatus(m) { $("status").textContent = m; }
async function fillSandboxes(sel) {
  if (!invoke) return;
  try { const list = await invoke("sandbox_list"); sel.innerHTML = ""; for (const sb of list || []) sel.appendChild(new Option(sb.name || sb.id, sb.id)); if (!sel.options.length) sel.appendChild(new Option("(aucune sandbox)", "")); }
  catch { sel.innerHTML = "<option value=''>(sandbox indisponible)</option>"; }
}
async function saveModel(sandboxSel, name, model, statusEl) {
  const json = JSON.stringify(model);
  if (invoke && sandboxSel.value) {
    try { await invoke("sandbox_write_file", { id: sandboxSel.value, path: `${name}.mlmodel.json`, content: json }); statusEl.textContent = `Enregistré : ${name}.mlmodel.json ✓ (utilisable dans Fluxo)`; return; }
    catch (e) { statusEl.textContent = "Échec sandbox : " + (e?.message || e); }
  }
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([json], { type: "application/json" })); a.download = `${name}.mlmodel.json`; a.click();
  statusEl.textContent = "Téléchargé.";
}
function bytes(...parts) {
  const n = parts.reduce((s, p) => s + p.length, 0), out = new Uint8Array(n);
  let o = 0; parts.forEach((p) => { out.set(p, o); o += p.length; });
  return out;
}
function encVarint(n) {
  const out = [];
  let v = BigInt(n);
  while (v >= 128n) { out.push(Number((v & 127n) | 128n)); v >>= 7n; }
  out.push(Number(v));
  return new Uint8Array(out);
}
function encKey(field, wire) { return encVarint((field << 3) | wire); }
function encField(field, wire, data) { return bytes(encKey(field, wire), data); }
function encString(field, s) {
  const d = new TextEncoder().encode(s);
  return encField(field, 2, bytes(encVarint(d.length), d));
}
function encBytes(field, d) { return encField(field, 2, bytes(encVarint(d.length), d)); }
function encInt(field, n) { return encField(field, 0, encVarint(n)); }
function encFloat32Array(arr) {
  const buf = new ArrayBuffer(arr.length * 4), dv = new DataView(buf);
  arr.forEach((v, i) => dv.setFloat32(i * 4, v, true));
  return new Uint8Array(buf);
}
function encInt8Array(arr) { return new Uint8Array(arr.map((v) => v & 255)); }
function tensorFloat(name, dims, values) {
  return bytes(encInt(1, 1), ...dims.map((d) => encInt(2, d)), encString(8, name), encBytes(9, encFloat32Array(values)));
}
function tensorInt8(name, dims, values) {
  return bytes(encInt(1, 3), ...dims.map((d) => encInt(2, d)), encString(8, name), encBytes(9, encInt8Array(values)));
}
function valueInfo(name, dims) {
  const shape = bytes(...dims.map((d) => encBytes(1, bytes(encInt(1, d)))));
  const tensorType = bytes(encInt(1, 1), encBytes(2, shape));
  const type = encBytes(1, tensorType);
  return bytes(encString(1, name), encBytes(2, type));
}
function attrInt(name, value) { return bytes(encString(1, name), encInt(2, value), encInt(20, 2)); }
function node(op, inputs, outputs, attrs = []) {
  return bytes(...inputs.map((i) => encString(1, i)), ...outputs.map((o) => encString(2, o)), encString(4, op), ...attrs.map((a) => encBytes(5, a)));
}
function quantizeSym(values) {
  const max = Math.max(1e-9, ...values.map((v) => Math.abs(v)));
  const scale = max / 127;
  return { q: values.map((v) => Math.max(-127, Math.min(127, Math.round(v / scale)))), scale };
}
function flattenWForGemm(layer) {
  const out = layer.w.length, input = layer.w[0].length, vals = [];
  for (let i = 0; i < input; i++) for (let j = 0; j < out; j++) vals.push(layer.w[j][i]);
  return vals;
}
function onnxFromModel(model, { int8 = false } = {}) {
  const inDim = model.input === "image" ? model.imageSize * model.imageSize : model.features.length;
  let current = "input", currentDim = inDim;
  const nodes = [], init = [];
  if (model.mean && model.std) {
    init.push(tensorFloat("pre_mean", [1, inDim], model.mean));
    init.push(tensorFloat("pre_std", [1, inDim], model.std));
    nodes.push(node("Sub", ["input", "pre_mean"], ["pre_centered"]));
    nodes.push(node("Div", ["pre_centered", "pre_std"], ["preprocessed"]));
    current = "preprocessed";
  }
  model.layers.forEach((layer, li) => {
    const outDim = layer.w.length, wName = `layer${li}_W`, bName = `layer${li}_B`, gemmOut = `layer${li}_gemm`;
    const wVals = flattenWForGemm(layer);
    if (int8) {
      const q = quantizeSym(wVals);
      init.push(tensorInt8(`${wName}_q`, [currentDim, outDim], q.q));
      init.push(tensorFloat(`${wName}_scale`, [], [q.scale]));
      init.push(tensorInt8(`${wName}_zero`, [], [0]));
      nodes.push(node("DequantizeLinear", [`${wName}_q`, `${wName}_scale`, `${wName}_zero`], [wName]));
    } else {
      init.push(tensorFloat(wName, [currentDim, outDim], wVals));
    }
    init.push(tensorFloat(bName, [outDim], layer.b));
    nodes.push(node("Gemm", [current, wName, bName], [gemmOut], [attrInt("transB", 0)]));
    let out = gemmOut;
    if (layer.act === "relu") { out = `layer${li}_relu`; nodes.push(node("Relu", [gemmOut], [out])); }
    else if (layer.act === "sigmoid") { out = `layer${li}_sigmoid`; nodes.push(node("Sigmoid", [gemmOut], [out])); }
    else if (layer.act === "tanh") { out = `layer${li}_tanh`; nodes.push(node("Tanh", [gemmOut], [out])); }
    else if (layer.act === "softmax") { out = `layer${li}_softmax`; nodes.push(node("Softmax", [gemmOut], [out], [attrInt("axis", 1)])); }
    current = out; currentDim = outDim;
  });
  let output = current;
  if (model.task === "regression") {
    init.push(tensorFloat("y_std", [1, 1], [model.ystd || 1]));
    init.push(tensorFloat("y_mean", [1, 1], [model.ymean || 0]));
    nodes.push(node("Mul", [current, "y_std"], ["y_scaled"]));
    nodes.push(node("Add", ["y_scaled", "y_mean"], ["output"]));
    output = "output";
  }
  const graph = bytes(
    ...nodes.map((n) => encBytes(1, n)),
    encString(2, "lumen_ml_graph"),
    ...init.map((t) => encBytes(5, t)),
    encBytes(11, valueInfo("input", [1, inDim])),
    encBytes(12, valueInfo(output, [1, currentDim])),
  );
  const opset = bytes(encString(1, ""), encInt(2, 13));
  return bytes(
    encInt(1, 8),
    encString(2, "Lumen Atelier ML"),
    encString(3, int8 ? "int8-compatible" : "fp32"),
    encBytes(7, graph),
    encBytes(8, opset),
    encInt(9, 7),
  );
}
function selectedOnnxKinds(sel) {
  const vals = [...sel.selectedOptions].map((o) => o.value);
  return vals.length ? vals : ["fp32"];
}
function downloadOnnxSet(model, baseName, sel, statusEl) {
  if (!model) return;
  selectedOnnxKinds(sel).forEach((kind) => {
    const int8 = kind === "8";
    const data = onnxFromModel(model, { int8 });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([data], { type: "application/octet-stream" }));
    a.download = `${baseName}.${int8 ? "int8" : "fp32"}.onnx`;
    a.click();
  });
  statusEl.textContent = "ONNX téléchargé (CPU portable, compatible ONNX Runtime).";
}

/* ===================== TABULAIRE ===================== */
const T = { cols: ["x1", "x2", "y"], rows: [], model: null };

function tRender() {
  const tbl = $("t-table"); tbl.innerHTML = "";
  const thead = document.createElement("tr");
  T.cols.forEach((c, ci) => {
    const th = document.createElement("th");
    if (ci === T.cols.length - 1) th.className = "target";
    const inp = document.createElement("input"); inp.value = c;
    // Renommer une colonne met aussi à jour le récap et les champs de test
    // (avant, le panneau « Prédire » gardait les anciens noms).
    inp.addEventListener("input", () => { T.cols[ci] = inp.value; tUpdateMeta(); });
    th.appendChild(inp);
    if (T.cols.length > 2 && ci < T.cols.length - 1) { const d = document.createElement("span"); d.className = "delcol"; d.textContent = "✕"; d.title = "Supprimer la colonne"; d.addEventListener("click", () => { T.cols.splice(ci, 1); T.rows.forEach((r) => r.splice(ci, 1)); tRender(); }); th.appendChild(d); }
    thead.appendChild(th);
  });
  tbl.appendChild(thead);
  T.rows.forEach((row, ri) => {
    const tr = document.createElement("tr");
    T.cols.forEach((_, ci) => {
      const td = document.createElement("td");
      const inp = document.createElement("input"); inp.value = row[ci] ?? "";
      inp.addEventListener("input", () => { row[ci] = inp.value; });
      td.appendChild(inp); tr.appendChild(td);
    });
    tbl.appendChild(tr);
  });
  tUpdateMeta();
}
// Récap du dataset + champs du panneau de test (dépendent des noms de colonnes).
function tUpdateMeta() {
  $("t-shape").textContent = `${T.rows.length} lignes · ${T.cols.length - 1} features → ${T.cols[T.cols.length - 1]}`;
  renderTestInputs();
}
function renderTestInputs() {
  const box = $("t-inputs"); box.innerHTML = "";
  T.cols.slice(0, -1).forEach((c) => {
    const l = document.createElement("label"); l.innerHTML = `<span>${c}</span>`;
    const inp = document.createElement("input"); inp.type = "number"; inp.value = "0"; inp.dataset.feat = c;
    l.appendChild(inp); box.appendChild(l);
  });
}
function tExtract() {
  const X = [], yraw = [];
  for (const r of T.rows) {
    const feats = r.slice(0, -1).map((v) => parseFloat(v));
    if (feats.some((v) => Number.isNaN(v))) continue;
    X.push(feats); yraw.push(String(r[r.length - 1] ?? "").trim());
  }
  return { X, yraw };
}

function tTrain() {
  const { X, yraw } = tExtract();
  const kind = $("t-model").value;
  let task = kind === "linear" ? "regression" : kind === "logistic" ? "classification" : $("t-task").value;
  if (X.length < 4) {
    // Diagnostic précis : la cause la plus fréquente est une colonne de feature
    // NON numérique (texte) → toutes les lignes sont rejetées en silence.
    const featCols = T.cols.slice(0, -1);
    const bad = featCols.filter((_, ci) =>
      T.rows.some((r) => { const v = String(r[ci] ?? "").trim(); return v !== "" && Number.isNaN(parseFloat(v)); }));
    if (bad.length) {
      setStatus(`Colonne(s) non numérique(s) : ${bad.join(", ")}. Les features doivent être des nombres (encode le texte, ex. 0/1/2).`);
    } else {
      setStatus(`Seulement ${X.length} ligne(s) valide(s) sur ${T.rows.length} — il en faut au moins 4 (cellules de features vides ou non numériques).`);
    }
    return;
  }
  // La régression exige une cible numérique : sinon prévenir clairement plutôt
  // que de produire des NaN silencieux.
  if (task === "regression" && yraw.some((v) => v !== "" && Number.isNaN(parseFloat(v)))) {
    setStatus(`Cible « ${T.cols[T.cols.length - 1]} » non numérique : choisis « Régression logistique » / classification, ou une colonne cible numérique.`);
    return;
  }
  const hidden = kind === "mlp" ? $("t-hidden").value.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => n > 0) : [];
  const lr = parseFloat($("t-lr").value) || 0.05, epochs = parseInt($("t-epochs").value, 10) || 200;
  const split = parseInt($("t-split").value, 10) / 100;

  const { mean, std, Z } = standardize(X);
  let Y, outAct, classes = null, ymean = 0, ystd = 1, outDim = 1;
  if (task === "regression") {
    const yv = yraw.map(Number); ymean = yv.reduce((a, b) => a + b, 0) / yv.length;
    ystd = Math.sqrt(yv.reduce((a, b) => a + (b - ymean) ** 2, 0) / yv.length) || 1;
    Y = yv.map((v) => [(v - ymean) / ystd]); outAct = "linear";
  } else {
    classes = [...new Set(yraw)].sort();
    if (classes.length < 2) { setStatus("La classification requiert ≥ 2 classes dans la cible."); return; }
    if (classes.length === 2) { outAct = "sigmoid"; outDim = 1; Y = yraw.map((v) => [classes.indexOf(v)]); }
    else { outAct = "softmax"; outDim = classes.length; Y = yraw.map((v) => classes.map((c) => (c === v ? 1 : 0))); }
  }

  // split train/test
  const idx = Z.map((_, i) => i); for (let i = idx.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0;[idx[i], idx[j]] = [idx[j], idx[i]]; }
  const nTest = Math.floor(Z.length * split), testIdx = new Set(idx.slice(0, nTest));
  const Xtr = [], Ytr = [], Xte = [], Yte = [];
  Z.forEach((z, i) => { if (testIdx.has(i)) { Xte.push(z); Yte.push(Y[i]); } else { Xtr.push(z); Ytr.push(Y[i]); } });

  const layers = buildNet(X[0].length, hidden, outDim, outAct);
  const hist = []; setStatus(tt("Entraînement…")); $("t-train").disabled = true;
  // train() est async (rend la main au navigateur) : la courbe de perte se
  // dessine en direct et l'UI ne gèle plus.
  (async () => {
    try {
      await train(layers, Xtr, Ytr, { lr, epochs, onEpoch: (ep, loss) => { hist.push(loss); drawLoss($("t-loss"), hist); } });
      T.model = { task, input: "tabular", features: T.cols.slice(0, -1), mean, std, ymean, ystd, classes, layers };
      // métriques
      const evalSet = nTest ? { X: Xte, Y: Yte } : { X: Xtr, Y: Ytr };
      const m = evaluate(layers, evalSet, task, classes, ymean, ystd);
      $("t-metrics").innerHTML = task === "regression"
        ? `Évalué sur ${evalSet.X.length} ex.<br>R² : <b>${m.r2.toFixed(3)}</b> · RMSE : <b>${m.rmse.toFixed(3)}</b>`
        : `Évalué sur ${evalSet.X.length} ex.<br>Exactitude : <b>${(m.acc * 100).toFixed(1)}%</b> · classes : ${classes.join(", ")}`;
      setStatus(tt("Modèle entraîné ✓"));
      $("t-predict").disabled = false; $("t-save").disabled = false; $("t-download").disabled = false; $("t-onnx").disabled = false;
    } finally { $("t-train").disabled = false; }
  })();
}
function evaluate(layers, set, task, classes, ymean, ystd) {
  if (task === "regression") {
    let se = 0, tot = 0; const ys = set.Y.map((y) => y[0] * ystd + ymean); const ym = ys.reduce((a, b) => a + b, 0) / ys.length;
    set.X.forEach((x, i) => { const p = predictVec(layers, x)[0] * ystd + ymean; se += (p - ys[i]) ** 2; tot += (ys[i] - ym) ** 2; });
    return { rmse: Math.sqrt(se / set.X.length), r2: 1 - se / (tot || 1) };
  }
  let ok = 0;
  set.X.forEach((x, i) => { const out = predictVec(layers, x); const pred = classes.length === 2 ? (out[0] >= 0.5 ? 1 : 0) : out.indexOf(Math.max(...out)); const truth = classes.length === 2 ? set.Y[i][0] : set.Y[i].indexOf(1); if (pred === truth) ok++; });
  return { acc: ok / set.X.length };
}
function tPredict() {
  if (!T.model) return;
  const x = [...$("t-inputs").querySelectorAll("input")].map((i) => parseFloat(i.value) || 0);
  const z = x.map((v, i) => (v - T.model.mean[i]) / T.model.std[i]);
  const out = predictVec(T.model.layers, z);
  if (T.model.task === "regression") { $("t-pred").innerHTML = (out[0] * T.model.ystd + T.model.ymean).toFixed(3); return; }
  const cls = T.model.classes;
  if (cls.length === 2) { const p = out[0]; $("t-pred").innerHTML = `${cls[p >= 0.5 ? 1 : 0]}<small>p=${(p >= 0.5 ? p : 1 - p).toFixed(2)}</small>`; }
  else { const k = out.indexOf(Math.max(...out)); $("t-pred").innerHTML = `${cls[k]}<small>p=${out[k].toFixed(2)}</small>`; }
}

/* ----- Dataset : CSV + synthétique ----- */
function tLoadMatrix(cols, rows) { T.cols = cols; T.rows = rows; tRender(); }
// Charge une table de l'app « Bases de données » comme matrice d'entraînement.
async function tFromTable() {
  if (!tablesDb.hasBackend) { return; }
  let items = [];
  try {
    const bases = await tablesDb.listBases();
    for (const b of bases) {
      const ts = await tablesDb.listTables(b.base_id);
      for (const t of ts) items.push({ label: `${b.name} / ${t.name}`, table_id: t.table_id });
    }
  } catch { return; }
  if (!items.length) { alert("Aucune table. Créez-en dans l'app « Bases de données »."); return; }
  const pick = await mlPickOverlay("Charger une table", items);
  if (!pick) return;
  try { tCSV(await tablesDb.exportCsv(pick.table_id)); } catch (e) { alert("Échec : " + (e.message || e)); }
}
function mlPickOverlay(title, items) {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:9999";
    const box = document.createElement("div");
    // Variables du thème (l'ancien style codait un fond sombre en dur : boîte
    // incohérente en mode clair).
    box.style.cssText = "background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:12px;min-width:280px;max-width:90vw;max-height:70vh;overflow:auto;padding:14px;box-shadow:var(--shadow)";
    box.innerHTML = `<div style="font-weight:600;margin-bottom:10px">${title}</div>`;
    for (const it of items) {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = it.label;
      b.style.cssText = "display:block;width:100%;text-align:left;border:1px solid var(--border);background:var(--surface-2);color:inherit;border-radius:9px;padding:9px 11px;margin-bottom:6px;cursor:pointer;font:inherit";
      b.addEventListener("click", () => { document.body.removeChild(back); resolve(it); });
      box.appendChild(b);
    }
    back.addEventListener("click", (e) => { if (e.target === back) { document.body.removeChild(back); resolve(null); } });
    back.appendChild(box); document.body.appendChild(back);
  });
}
function tCSV(text) {
  // Parseur robuste (guillemets, virgules dans les cellules) partagé avec
  // l'onglet Texte — l'ancien split() naïf cassait sur les CSV quotés.
  const first = (text.trim().split(/\r?\n/)[0] || "");
  const sep = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ";" : ",";
  const parsed = parseSimpleCSV(text, sep);
  if (!parsed.length) return;
  const cols = parsed[0].map((s) => s.trim());
  // Lignes alignées sur l'en-tête (cellules manquantes → vides).
  const rows = parsed.slice(1).map((r) => cols.map((_, i) => (r[i] ?? "").trim()));
  tLoadMatrix(cols, rows);
}
function tSynth(kind) {
  const rows = [];
  if (kind === "linreg") { for (let i = 0; i < 40; i++) { const x1 = (Math.random() * 10).toFixed(2), x2 = (Math.random() * 5).toFixed(2); rows.push([x1, x2, (3 * x1 + 2 * x2 + 5 + rng() * 2).toFixed(2)]); } tLoadMatrix(["x1", "x2", "y"], rows); }
  else if (kind === "blobs") { for (let i = 0; i < 50; i++) { const a = Math.random() < 0.5; rows.push([(rng() * 1.5 + (a ? 2 : -2)).toFixed(2), (rng() * 1.5 + (a ? 2 : -2)).toFixed(2), a ? "A" : "B"]); } tLoadMatrix(["x1", "x2", "classe"], rows); }
  else if (kind === "iris3") { const C = [[2, 2], [-2, 2], [0, -2]], L = ["A", "B", "C"]; for (let i = 0; i < 60; i++) { const k = i % 3; rows.push([(C[k][0] + rng()).toFixed(2), (C[k][1] + rng()).toFixed(2), L[k]]); } tLoadMatrix(["x1", "x2", "classe"], rows); }
}

/* ===================== TEXTE / DISTILBERT ===================== */
const TXT = { classes: [], rows: [] };
function textRender() {
  const cls = $("x-classes"), label = $("x-label");
  cls.innerHTML = ""; label.innerHTML = "";
  TXT.classes.forEach((name, ci) => {
    label.appendChild(new Option(name, String(ci)));
    const card = document.createElement("div"); card.className = "classcard";
    const n = TXT.rows.filter((r) => r.label === name).length;
    const head = document.createElement("div"); head.className = "ch";
    head.innerHTML = `<span>${name} · ${n}</span>`;
    const del = document.createElement("button"); del.textContent = "supprimer";
    del.addEventListener("click", () => { TXT.classes.splice(ci, 1); TXT.rows = TXT.rows.filter((r) => r.label !== name); textRender(); });
    head.appendChild(del); card.appendChild(head);
    const thumbs = document.createElement("div"); thumbs.className = "metrics";
    TXT.rows.filter((r) => r.label === name).slice(-3).forEach((r) => { const p = document.createElement("div"); p.textContent = r.text.slice(0, 120); thumbs.appendChild(p); });
    card.appendChild(thumbs); cls.appendChild(card);
  });
  $("x-export").disabled = TXT.classes.length < 2 || TXT.rows.length < 4;
  $("x-metrics").innerHTML = `${TXT.rows.length} exemples · ${TXT.classes.length} classes`;
  tjsRefreshButtons();
}
function parseSimpleCSV(text, sep = ",") {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (ch === '"' && q && next === '"') { cell += '"'; i++; }
    else if (ch === '"') q = !q;
    else if (ch === sep && !q) { row.push(cell); cell = ""; }
    else if ((ch === "\n" || ch === "\r") && !q) {
      if (ch === "\r" && next === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell); if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}
function textAddClass(name) {
  const n = name.trim();
  if (n && !TXT.classes.includes(n)) TXT.classes.push(n);
}
function textAddExample(text, label) {
  const t = text.trim();
  if (!t || !label) return;
  textAddClass(label);
  TXT.rows.push({ text: t, label });
}
function textLoadCSV(text) {
  const rows = parseSimpleCSV(text);
  const start = rows[0] && rows[0].map((v) => v.toLowerCase().trim()).includes("text") ? 1 : 0;
  for (const r of rows.slice(start)) {
    const txt = r[0]?.trim(), lab = r[1]?.trim();
    if (txt && lab) textAddExample(txt, lab);
  }
  textRender();
}
function textSynth() {
  TXT.classes = []; TXT.rows = [];
  [
    ["J'adore ce produit, il marche parfaitement.", "positif"],
    ["Service rapide et interface tres agreable.", "positif"],
    ["Resultat excellent, je recommande.", "positif"],
    ["Je suis decu, rien ne fonctionne correctement.", "negatif"],
    ["Support lent et experience frustrante.", "negatif"],
    ["Le produit est arrive casse.", "negatif"],
    ["La livraison est prevue demain matin.", "neutre"],
    ["Votre dossier a ete mis a jour.", "neutre"],
    ["Le rendez-vous est confirme pour vendredi.", "neutre"],
  ].forEach(([t, l]) => textAddExample(t, l));
  textRender();
}
function textDatasetJsonl() {
  return TXT.rows.map((r) => JSON.stringify({ text: r.text, label: r.label })).join("\n") + "\n";
}
function textTrainScript() {
  const cfg = {
    model_name: $("x-base").value.trim() || "distilbert-base-multilingual-cased",
    max_length: parseInt($("x-maxlen").value, 10) || 128,
    val_percent: parseInt($("x-val").value, 10) || 20,
    epochs: parseInt($("x-epochs").value, 10) || 5,
    batch_size: parseInt($("x-batch").value, 10) || 16,
    lr: parseFloat($("x-lr").value) || 0.001,
    frozen: $("x-mode").value === "frozen",
    classes: TXT.classes,
  };
  return `#!/usr/bin/env python3
import argparse, json, random, pathlib
import torch
from torch import nn
from torch.utils.data import DataLoader, Dataset
from transformers import AutoTokenizer, AutoModel
from onnxruntime.quantization import quantize_dynamic, QuantType

CONFIG = ${JSON.stringify(cfg, null, 2)}

class TextRows(Dataset):
    def __init__(self, rows, tokenizer, labels):
        self.rows = rows
        self.tokenizer = tokenizer
        self.label_to_id = {v: i for i, v in enumerate(labels)}
    def __len__(self): return len(self.rows)
    def __getitem__(self, i):
        r = self.rows[i]
        enc = self.tokenizer(r["text"], truncation=True, padding="max_length", max_length=CONFIG["max_length"], return_tensors="pt")
        return {
            "input_ids": enc["input_ids"].squeeze(0),
            "attention_mask": enc["attention_mask"].squeeze(0),
            "labels": torch.tensor(self.label_to_id[r["label"]], dtype=torch.long),
        }

class DistilBertLinear(nn.Module):
    def __init__(self, base, n_classes, frozen=True):
        super().__init__()
        self.base = base
        if frozen:
            for p in self.base.parameters(): p.requires_grad = False
        self.classifier = nn.Linear(base.config.hidden_size, n_classes)
    def forward(self, input_ids, attention_mask):
        out = self.base(input_ids=input_ids, attention_mask=attention_mask)
        cls = out.last_hidden_state[:, 0]
        return self.classifier(cls)

def load_rows(path):
    return [json.loads(line) for line in pathlib.Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]

def eval_acc(model, loader, device):
    model.eval(); ok = total = 0
    with torch.no_grad():
        for b in loader:
            ids = b["input_ids"].to(device); mask = b["attention_mask"].to(device); y = b["labels"].to(device)
            pred = model(ids, mask).argmax(dim=1)
            ok += (pred == y).sum().item(); total += y.numel()
    return ok / max(1, total)

def llm_prompt(report):
    return f"""Tu es un expert ML. Explique cet entraînement DistilBERT + tête linéaire à une personne technique, puis propose des améliorations concrètes.

Contraintes de sortie:
- réponds ${inLang()}
- commence par un diagnostic court
- liste les risques de dataset, d'overfitting/underfitting et de validation
- propose 5 actions prioritaires
- précise si le modèle INT8 ONNX semble approprié pour CPU multiplateforme

Rapport JSON:
{json.dumps(report, ensure_ascii=False, indent=2)}
"""

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="text_dataset.jsonl")
    ap.add_argument("--out", default="${($("x-name")?.value || "texte_distilbert").replace(/[^a-z0-9_-]/gi, "_")}")
    args = ap.parse_args()
    out_dir = pathlib.Path(args.out); out_dir.mkdir(parents=True, exist_ok=True)
    rows = load_rows(args.data)
    labels = CONFIG["classes"]
    random.shuffle(rows)
    n_val = int(len(rows) * CONFIG["val_percent"] / 100)
    val_rows, train_rows = rows[:n_val], rows[n_val:] or rows
    tokenizer = AutoTokenizer.from_pretrained(CONFIG["model_name"])
    base = AutoModel.from_pretrained(CONFIG["model_name"])
    model = DistilBertLinear(base, len(labels), frozen=CONFIG["frozen"])
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model.to(device)
    train_loader = DataLoader(TextRows(train_rows, tokenizer, labels), batch_size=CONFIG["batch_size"], shuffle=True)
    val_loader = DataLoader(TextRows(val_rows or train_rows, tokenizer, labels), batch_size=CONFIG["batch_size"])
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=CONFIG["lr"])
    loss_fn = nn.CrossEntropyLoss()
    metrics = []
    for ep in range(CONFIG["epochs"]):
        model.train()
        total = 0.0
        for b in train_loader:
            ids = b["input_ids"].to(device); mask = b["attention_mask"].to(device); y = b["labels"].to(device)
            opt.zero_grad(); loss = loss_fn(model(ids, mask), y); loss.backward(); opt.step()
            total += loss.item()
        loss_avg = total / max(1, len(train_loader))
        val_acc = eval_acc(model, val_loader, device)
        item = {"epoch": ep + 1, "train_loss": loss_avg, "val_accuracy": val_acc}
        metrics.append(item)
        with (out_dir / "metrics.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps(item, ensure_ascii=False) + "\\n")
        print(f"epoch={ep+1} loss={loss_avg:.4f} val_acc={val_acc:.3f}")
    model.eval().cpu()
    tokenizer.save_pretrained(out_dir)
    (out_dir / "labels.json").write_text(json.dumps(labels, ensure_ascii=False, indent=2), encoding="utf-8")
    dummy_ids = torch.ones(1, CONFIG["max_length"], dtype=torch.long)
    dummy_mask = torch.ones(1, CONFIG["max_length"], dtype=torch.long)
    fp32 = out_dir / "model.fp32.onnx"
    torch.onnx.export(
        model, (dummy_ids, dummy_mask), fp32,
        input_names=["input_ids", "attention_mask"], output_names=["logits"],
        dynamic_axes={"input_ids": {0: "batch", 1: "sequence"}, "attention_mask": {0: "batch", 1: "sequence"}, "logits": {0: "batch"}},
        opset_version=17,
    )
    quantize_dynamic(str(fp32), str(out_dir / "model.int8.onnx"), weight_type=QuantType.QInt8)
    warnings = []
    counts = {label: sum(1 for r in rows if r["label"] == label) for label in labels}
    if min(counts.values() or [0]) < 5:
        warnings.append("Certaines classes ont moins de 5 exemples : les métriques seront instables.")
    if len(rows) < 50:
        warnings.append("Dataset très petit : privilégier validation manuelle, augmentation de données et exemples difficiles.")
    if len(metrics) >= 2 and metrics[-1]["train_loss"] > metrics[0]["train_loss"] * 0.95:
        warnings.append("La perte baisse peu : vérifier les labels, augmenter les époques ou dégeler DistilBERT.")
    report = {
        "task": "text_classification",
        "architecture": "DistilBERT + linear classifier",
        "base_model": CONFIG["model_name"],
        "frozen_distilbert": CONFIG["frozen"],
        "classes": labels,
        "class_counts": counts,
        "train_examples": len(train_rows),
        "validation_examples": len(val_rows or train_rows),
        "config": CONFIG,
        "metrics": metrics,
        "final": metrics[-1] if metrics else None,
        "exports": {"fp32": str(fp32), "int8": str(out_dir / "model.int8.onnx")},
        "warnings": warnings,
    }
    (out_dir / "training_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "llm_training_prompt.md").write_text(llm_prompt(report), encoding="utf-8")
    print("exports:", fp32, out_dir / "model.int8.onnx")
    print("monitoring:", out_dir / "metrics.jsonl", out_dir / "training_report.json", out_dir / "llm_training_prompt.md")

if __name__ == "__main__":
    main()
`;
}
function textExportKit() {
  const name = ($("x-name").value.trim() || "texte_distilbert").replace(/[^a-z0-9_-]/gi, "_");
  downloadText(`${name}.text_dataset.jsonl`, textDatasetJsonl(), "application/x-ndjson");
  downloadText(`${name}.train_distilbert_linear.py`, textTrainScript(), "text/x-python");
  downloadText(`${name}.requirements.txt`, "torch\ntransformers\nonnx\nonnxruntime\n", "text/plain");
  $("x-status").textContent = "Dataset + script téléchargés. Lancez le script pour produire model.fp32.onnx, model.int8.onnx et les rapports de monitoring.";
}
function textSnapshot() {
  return {
    classes: TXT.classes,
    examples: TXT.rows.length,
    class_counts: Object.fromEntries(TXT.classes.map((c) => [c, TXT.rows.filter((r) => r.label === c).length])),
    base_model: $("x-base").value.trim() || "distilbert-base-multilingual-cased",
    mode: $("x-mode").value,
    max_length: parseInt($("x-maxlen").value, 10) || 128,
    epochs: parseInt($("x-epochs").value, 10) || 5,
    batch_size: parseInt($("x-batch").value, 10) || 16,
    learning_rate: parseFloat($("x-lr").value) || 0.001,
    // Dernier entraînement local (worker) : le LLM peut commenter des métriques
    // réelles même sans rapport Python collé.
    local_training: TJS.lastTrain,
  };
}
function textMonitoringPrompt(reportText = "") {
  const snapshot = textSnapshot();
  return `Tu es un expert ML chargé d'expliquer un entraînement de classification de texte.

Architecture:
- DistilBERT
- tête linéaire pour classification
- export ONNX FP32 et quantification dynamique INT8 pour CPU multiplateforme

Snapshot atelier:
${JSON.stringify(snapshot, null, 2)}

Rapport / métriques fournis:
${reportText || "(aucun rapport collé ; analyse seulement le snapshot et les risques probables)"}

Réponds ${inLang()} avec:
1. diagnostic court
2. lecture des métriques
3. risques de dataset et de validation
4. recommandations d'amélioration priorisées
5. impact attendu de l'export ONNX INT8 sur CPU`;
}
function textDownloadPrompt() {
  const name = ($("x-name").value.trim() || "texte_distilbert").replace(/[^a-z0-9_-]/gi, "_");
  downloadText(`${name}.llm_training_prompt.md`, textMonitoringPrompt($("x-report").value.trim()), "text/markdown");
}
async function textExplainWithLLM() {
  const out = $("x-llm");
  out.textContent = "Analyse LLM en cours…";
  // Texte brut (pas de Markdown ici) : rendu échappé, en flux.
  const escapeForStream = (t) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const live = streamTarget(out, escapeForStream);
  try {
    const { messages } = PROMPTS["app.ml"].build({ snapshot: textSnapshot(), report: $("x-report").value.trim(), lang: replyLang() });
    const { content } = await llmChat(messages, { rawSystem: true, onUpdate: live.onUpdate });
    live.done(escapeForStream(content || "Réponse vide."));
  } catch (e) {
    out.textContent = "LLM indisponible : " + (e?.message || e);
  }
}

/* ============== Inférence locale texte (transformers.js) ==============
   Le moteur n'est PAS inclus dans le build : au clic sur « Télécharger le
   moteur », la bibliothèque est chargée (fetch CDN → import blob) et les poids
   du modèle sont mis en cache → les sessions suivantes fonctionnent hors-ligne.
   Toute l'inférence tourne dans un WORKER dédié (src/lib/embeddings-worker.js) :
   le backend ONNX WASM est synchrone, l'exécuter sur le thread principal gelait
   l'app entière pendant le calcul des embeddings. Repli thread principal (via
   transformers-loader.js) si le worker ne peut pas démarrer. Pipeline :
   embeddings gelés (quantifiés q8) + tête linéaire softmax entraînée DANS
   l'app avec le même moteur de descente de gradient que les autres onglets. */
const TJS = { worker: null, workerDead: false, mainMod: null, mainFe: null, ready: false, modelId: "", head: null, classes: null, lastTrain: null, pending: new Map(), seq: 0 };

function tjsWorker() {
  if (TJS.workerDead) return null;
  if (!TJS.worker) {
    try {
      TJS.worker = new Worker(new URL("../lib/embeddings-worker.js", import.meta.url), { type: "module" });
      TJS.worker.onmessage = (ev) => {
        const { id, type, payload } = ev.data || {};
        const p = TJS.pending.get(id);
        if (!p) return;
        if (type === "progress") { p.onProgress?.(payload); return; }
        TJS.pending.delete(id);
        if (type === "error") p.reject(new Error(payload));
        else p.resolve(payload);
      };
      // Échec du script du worker lui-même (pas d'un appel) : on bascule en
      // mode compatibilité (thread principal) pour toute la session.
      TJS.worker.onerror = () => {
        TJS.workerDead = true;
        for (const p of TJS.pending.values()) p.reject(new Error("worker indisponible"));
        TJS.pending.clear();
        TJS.worker.terminate(); TJS.worker = null;
      };
    } catch { TJS.workerDead = true; TJS.worker = null; }
  }
  return TJS.worker;
}
function tjsCall(type, payload, onProgress) {
  const w = tjsWorker();
  if (!w) return Promise.reject(new Error("worker indisponible"));
  const id = ++TJS.seq;
  return new Promise((resolve, reject) => {
    TJS.pending.set(id, { resolve, reject, onProgress });
    w.postMessage({ id, type, payload });
  });
}
// Repli thread principal : même pipeline, mais l'UI peut ralentir pendant les calculs.
async function tjsMainLoad(id, onProgress) {
  if (!TJS.mainMod) TJS.mainMod = await loadTransformers();
  TJS.mainFe = await TJS.mainMod.pipeline("feature-extraction", id, { dtype: "q8", progress_callback: onProgress });
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Modèle d'embeddings du moteur local : sélecteur dédié (conversions ONNX
// Xenova validées). Indépendant du champ « Modèle Hugging Face » qui sert au
// kit Python — tous les repos PyTorch n'existent pas en version web (ex.
// distilbert-base-multilingual-cased → 401 sur Xenova/).
function tjsModelId() {
  return $("x-tjs-model").value || "Xenova/multilingual-e5-small";
}

// Les modèles E5 sont entraînés avec un préfixe de requête : on l'applique de
// façon cohérente à l'entraînement ET à la prédiction.
function tjsPrepText(text) {
  return TJS.modelId.toLowerCase().includes("e5") ? `query: ${text}` : text;
}

async function tjsDownload() {
  const st = $("x-tjs-status"), btn = $("x-tjs-dl");
  btn.disabled = true;
  const id = tjsModelId();
  let lastPct = -1;
  const onProgress = (p) => {
    if (p.status === "progress" && p.total) {
      const pct = Math.round((p.loaded / p.total) * 100);
      if (pct !== lastPct) { lastPct = pct; st.textContent = `${tt("Téléchargement")} ${p.file || ""} — ${pct}%`; }
    }
  };
  try {
    st.textContent = `${tt("Téléchargement du moteur…")} (${id}, quantifié q8)`;
    try {
      await tjsCall("load", { modelId: id }, onProgress);
    } catch (e) {
      if (!TJS.workerDead) throw e; // vraie erreur (réseau, modèle…) : remonter
      st.textContent = tt("Worker indisponible : mode compatibilité (l'UI peut ralentir)…");
      await tjsMainLoad(id, onProgress);
    }
    TJS.ready = true; TJS.modelId = id;
    st.textContent = tt("Moteur prêt ✓ (mis en cache : disponible hors-ligne ensuite).");
    btn.textContent = tt("Moteur téléchargé ✓");
    tjsRefreshButtons();
  } catch (e) {
    st.textContent = tt("Échec du téléchargement :") + " " + (e?.message || e);
    btn.disabled = false;
  }
}

async function tjsEmbed(text) {
  // Pooling moyen : les modèles sentence-transformers/E5 sont conçus pour lui
  // (contrairement au CLS de BERT brut). Calculé dans le worker (UI fluide).
  if (TJS.mainFe) {
    const out = await TJS.mainFe(tjsPrepText(text), { pooling: "mean", normalize: true });
    return Array.from(out.data);
  }
  const { data } = await tjsCall("embed", { text: tjsPrepText(text) });
  return data;
}

async function tjsTrain() {
  const st = $("x-tjs-status");
  if (!TJS.ready) return;
  if (TXT.classes.length < 2 || TXT.rows.length < 4) {
    st.textContent = tt("Il faut au moins 2 classes et 4 exemples.");
    return;
  }
  $("x-tjs-train").disabled = true; $("x-tjs-predict").disabled = true;
  try {
    // Embeddings de tous les exemples (progression affichée : c'est l'étape lente).
    const X = [], Y = [], classes = TXT.classes.slice();
    for (let i = 0; i < TXT.rows.length; i++) {
      st.textContent = `${tt("Calcul des embeddings…")} ${i + 1}/${TXT.rows.length}`;
      X.push(await tjsEmbed(TXT.rows[i].text));
      Y.push(classes.map((c) => (c === TXT.rows[i].label ? 1 : 0)));
    }
    // Split validation (réutilise le champ « Part validation » de l'onglet).
    const valPct = Math.min(50, Math.max(0, parseInt($("x-val").value, 10) || 20)) / 100;
    const idx = X.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [idx[i], idx[j]] = [idx[j], idx[i]]; }
    // Une validation < 3 exemples ne mesure rien (0 % ou 100 % au hasard) : on
    // évalue alors sur l'apprentissage, en l'affichant clairement.
    let nVal = Math.floor(X.length * valPct);
    if (nVal < 3) nVal = 0;
    const valIdx = new Set(idx.slice(0, nVal));
    const Xtr = [], Ytr = [], Xva = [], Yva = [];
    X.forEach((x, i) => { if (valIdx.has(i)) { Xva.push(x); Yva.push(Y[i]); } else { Xtr.push(x); Ytr.push(Y[i]); } });
    // Tête linéaire softmax sur embeddings normalisés (DistilBERT reste gelé).
    // Adam + mini-batches : sur un gros dataset, l'ancienne descente full-batch
    // à taux fixe (lr 0,5 × 300 époques) sous-apprenait — probabilités quasi
    // uniformes et exactitude en retrait.
    st.textContent = tt("Entraînement de la tête linéaire…");
    const layers = buildNet(X[0].length, [], classes.length, "softmax");
    const evalOn = nVal ? { X: Xva, Y: Yva } : { X: Xtr, Y: Ytr };
    const accOn = (set) => {
      let ok = 0;
      set.X.forEach((x, i) => { const o = predictVec(layers, x); if (o.indexOf(Math.max(...o)) === set.Y[i].indexOf(1)) ok++; });
      return ok / (set.X.length || 1);
    };
    // Nombre d'époques adapté à la taille du dataset : on vise ~600 pas d'Adam
    // minimum (un petit dataset n'a qu'un mini-batch par époque : 40 époques ne
    // suffiraient pas), sans dépasser 200 époques ni descendre sous 40.
    const stepsPerEpoch = Math.max(1, Math.ceil(Xtr.length / 32));
    const epochs = Math.min(200, Math.max(40, Math.ceil(600 / stepsPerEpoch)));
    const lossHist = [], accHist = [];
    await train(layers, Xtr, Ytr, {
      lr: 0.01, epochs, batchSize: 32, adam: true,
      onEpoch: (ep, loss) => {
        lossHist.push(loss); accHist.push(accOn(evalOn));
        drawTrainChart($("x-loss"), lossHist, accHist);
        st.textContent = `${tt("Époque")} ${ep + 1}/${epochs} — ${tt("perte")} ${loss.toFixed(3)} — ${nVal ? tt("validation") : tt("apprentissage")} ${(accHist[accHist.length - 1] * 100).toFixed(1)}%`;
      },
    });
    const acc = accHist[accHist.length - 1] ?? accOn(evalOn);
    TJS.head = layers; TJS.classes = classes;
    TJS.lastTrain = {
      embed_model: TJS.modelId, classes, examples: X.length,
      optimizer: "adam", batch_size: 32, epochs,
      eval_on: nVal ? "validation" : "apprentissage", eval_examples: evalOn.X.length,
      accuracy: acc, loss_history: lossHist.map((v) => +v.toFixed(4)), val_accuracy_history: accHist.map((v) => +v.toFixed(4)),
    };
    st.textContent = `${tt("Tête entraînée ✓")} — ${tt("exactitude")} (${nVal ? tt("validation") : tt("apprentissage")}) : ${(acc * 100).toFixed(1)}% (${evalOn.X.length} ex.)`;
    $("x-tjs-predict").disabled = false;
    $("x-tjs-save").disabled = false; $("x-tjs-download").disabled = false;
  } catch (e) {
    st.textContent = tt("Échec :") + " " + (e?.message || e);
  }
  $("x-tjs-train").disabled = false;
}

async function tjsPredict() {
  if (!TJS.head) return;
  const text = $("x-tjs-input").value.trim();
  const out = $("x-tjs-pred");
  if (!text) { out.textContent = "—"; return; }
  out.textContent = "…";
  try {
    const o = predictVec(TJS.head, await tjsEmbed(text));
    const k = o.indexOf(Math.max(...o));
    out.innerHTML = `<div style="font-size:16px"><b>${esc(TJS.classes[k])}</b></div>` +
      TJS.classes.map((c, i) => `<div class="probbar"><span>${esc(c)}</span><span class="b"><i style="width:${Math.round(o[i] * 100)}%"></i></span><span>${Math.round(o[i] * 100)}%</span></div>`).join("");
  } catch (e) {
    out.textContent = tt("Échec :") + " " + (e?.message || e);
  }
}

// Le bouton « Entraîner » ne s'active que si moteur prêt ET dataset suffisant.
function tjsRefreshButtons() {
  const ready = TJS.ready && TXT.classes.length >= 2 && TXT.rows.length >= 4;
  const btn = $("x-tjs-train");
  if (btn) btn.disabled = !ready;
}

// Changer de modèle de base invalide le moteur téléchargé et la tête entraînée.
function tjsResetOnModelChange() {
  if (!TJS.ready || TJS.modelId === tjsModelId()) return;
  TJS.ready = false; TJS.mainFe = null; TJS.head = null; TJS.classes = null; TJS.lastTrain = null;
  const btn = $("x-tjs-dl");
  btn.disabled = false; btn.textContent = tt("⬇ Télécharger le moteur");
  $("x-tjs-predict").disabled = true;
  $("x-tjs-save").disabled = true; $("x-tjs-download").disabled = true;
  $("x-tjs-status").textContent = tt("Modèle de base changé : retélécharge le moteur.");
  tjsRefreshButtons();
}

function resetTextEngineState() {
  TJS.ready = false; TJS.mainFe = null; TJS.head = null; TJS.classes = null; TJS.lastTrain = null;
  if (TJS.worker) {
    TJS.worker.terminate();
    TJS.worker = null;
  }
  TJS.workerDead = false;
  for (const p of TJS.pending.values()) p.reject(new Error("cache ML nettoyé"));
  TJS.pending.clear();
  const dl = $("x-tjs-dl");
  if (dl) { dl.disabled = false; dl.textContent = tt("⬇ Télécharger le moteur"); }
  $("x-tjs-train").disabled = true;
  $("x-tjs-predict").disabled = true;
  $("x-tjs-save").disabled = true;
  $("x-tjs-download").disabled = true;
}

async function deleteIndexedDb(name) {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve(true);
    req.onerror = () => resolve(false);
    req.onblocked = () => resolve(false);
  });
}

async function tjsCleanCache() {
  const st = $("x-tjs-status"), btn = $("x-tjs-clean");
  btn.disabled = true;
  st.textContent = tt("Nettoyage du cache ML…");
  try {
    resetTextEngineState();
    const cacheNames = "caches" in window ? await caches.keys() : [];
    const cacheMatch = (name) => /lumen-ml|transformers|huggingface|xenova|onnx/i.test(name);
    const deletedCaches = [];
    for (const name of cacheNames) {
      if (cacheMatch(name) && await caches.delete(name)) deletedCaches.push(name);
    }

    const dbNames = indexedDB.databases ? (await indexedDB.databases()).map((db) => db.name).filter(Boolean) : [];
    const dbMatch = (name) => /transformers|huggingface|xenova|onnx|lumen-ml/i.test(name);
    let deletedDbs = 0;
    for (const name of dbNames) if (dbMatch(name) && await deleteIndexedDb(name)) deletedDbs++;

    st.textContent = `${tt("Cache ML nettoyé.")} ${deletedCaches.length} cache(s), ${deletedDbs} base(s) IndexedDB. ${tt("Retélécharge le moteur avant le prochain entraînement.")}`;
  } catch (e) {
    st.textContent = tt("Échec du nettoyage :") + " " + (e?.message || e);
  } finally {
    btn.disabled = false;
  }
}

// Modèle texte exportable : id du modèle d'embeddings + tête linéaire + classes.
// Rechargeable/inspectable depuis la sandbox ; format aligné sur les autres
// onglets (clé `layers`) avec `input: "text"`.
function tjsModel() {
  if (!TJS.head) return null;
  return {
    task: "classification", input: "text",
    embedModel: TJS.modelId,
    e5QueryPrefix: TJS.modelId.toLowerCase().includes("e5"),
    pooling: "mean", normalize: true,
    classes: TJS.classes, layers: TJS.head,
    metrics: TJS.lastTrain,
  };
}

/* ===================== Init & bind ===================== */
function bindTabs() {
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active")); t.classList.add("active");
    document.querySelectorAll(".page").forEach((p) => { p.hidden = p.id !== t.dataset.tab; });
  }));
}
function init() {
  bindTabs();
  // Tabulaire
  T.rows = []; tSynth("linreg");
  $("t-model").addEventListener("change", () => {
    const k = $("t-model").value; $("t-hidden-f").hidden = k !== "mlp"; $("t-task-f").hidden = k !== "mlp";
  });
  $("t-split").addEventListener("input", () => ($("t-split-out").textContent = $("t-split").value + "%"));
  $("t-synth").addEventListener("change", (e) => { if (e.target.value) { tSynth(e.target.value); e.target.value = ""; } });
  $("t-csv").addEventListener("change", async (e) => { const f = e.target.files[0]; if (f) tCSV(await f.text()); });
  $("t-from-table").addEventListener("click", tFromTable);
  $("t-addrow").addEventListener("click", () => { T.rows.push(T.cols.map(() => "")); tRender(); });
  $("t-addcol").addEventListener("click", () => { T.cols.splice(T.cols.length - 1, 0, "x" + T.cols.length); T.rows.forEach((r) => r.splice(r.length - 1, 0, "")); tRender(); });
  $("t-train").addEventListener("click", tTrain);
  $("t-predict").addEventListener("click", tPredict);
  $("t-save").addEventListener("click", () => saveModel($("t-sandbox"), $("t-name").value.trim() || "modele", T.model, $("t-saved")));
  $("t-onnx").addEventListener("click", () => downloadOnnxSet(T.model, $("t-name").value.trim() || "modele", $("t-onnx-q"), $("t-saved")));
  $("t-download").addEventListener("click", () => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(T.model)], { type: "application/json" })); a.download = ($("t-name").value.trim() || "modele") + ".mlmodel.json"; a.click(); });

  // Texte
  $("x-addclass").addEventListener("click", () => { textAddClass($("x-classname").value); $("x-classname").value = ""; textRender(); });
  $("x-add").addEventListener("click", () => {
    const ci = parseInt($("x-label").value, 10);
    textAddExample($("x-text").value, TXT.classes[ci]);
    $("x-text").value = "";
    textRender();
  });
  $("x-csv").addEventListener("change", async (e) => { const f = e.target.files[0]; if (f) textLoadCSV(await f.text()); e.target.value = ""; });
  $("x-synth").addEventListener("click", textSynth);
  $("x-export").addEventListener("click", textExportKit);
  $("x-prompt").addEventListener("click", textDownloadPrompt);
  $("x-explain").addEventListener("click", textExplainWithLLM);
  // Inférence locale transformers.js (moteur téléchargé à la demande, hors build).
  $("x-tjs-dl").addEventListener("click", tjsDownload);
  $("x-tjs-train").addEventListener("click", tjsTrain);
  $("x-tjs-predict").addEventListener("click", tjsPredict);
  $("x-tjs-clean").addEventListener("click", tjsCleanCache);
  $("x-tjs-input").addEventListener("keydown", (e) => { if (e.key === "Enter") tjsPredict(); });
  $("x-tjs-model").addEventListener("change", tjsResetOnModelChange);
  $("x-tjs-save").addEventListener("click", () => saveModel($("x-sandbox"), ($("x-name").value.trim() || "texte_distilbert"), tjsModel(), $("x-saved")));
  $("x-tjs-download").addEventListener("click", () => {
    const m = tjsModel(); if (!m) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(m)], { type: "application/json" }));
    a.download = ($("x-name").value.trim() || "texte_distilbert") + ".mlmodel.json"; a.click();
    $("x-saved").textContent = tt("Téléchargé.");
  });
  textRender();

  fillSandboxes($("t-sandbox")); fillSandboxes($("x-sandbox"));
  if (!invoke) setStatus("Hors application : sauvegarde sandbox indisponible (téléchargement possible).");
}
init();

export { onnxFromModel, mlPickOverlay };
