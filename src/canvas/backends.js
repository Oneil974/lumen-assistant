import { appleFmBackendState } from "../llm.js";
// Choix des moteurs de génération (texte, image, modèle, taille), partagé par
// le Canevas créatif et le Studio Nodal. Les réglages vivent en localStorage
// (clés canvas*), lus par generate.js à chaque génération.

import { backendsStatus, resetProbes } from "./generate.js";
import { imageProvider, imageModel, imageModelKey, imageModelsFor, imageSizesFor, nearestImageSize, listOllamaImageModels, refreshPlaygroundOption } from "../lib/image-provider.js";

// Modèles Ollama installés, interrogés une fois puis mémorisés.
let ollamaImageNames = null;

export async function refreshBackendStatus(el) {
  if (!el) return;
  try {
    const s = await backendsStatus();
    const LABEL = { applefm: "Apple FM", local: "local", cloud: "cloud", bonsai: "Bonsai", ollama: "Ollama", openai: "GPT", playground: "Image Playground" };
    const fmt = (x) => LABEL[x] || "—";
    const textPref = s.textPref === "auto" ? "auto" : `${LABEL[s.textPref] || s.textPref} forcé`;
    // Le moteur d'image n'est plus automatique : on affiche celui qui est
    // imposé, et si sa sonde échoue, « indisponible ».
    el.textContent = `Texte : ${fmt(s.text)} (${textPref}) · Image : ${LABEL[s.imagePref] || s.imagePref}`
      + (s.image ? "" : " — indisponible");
    el.classList.toggle("warn", !s.text && !s.image);
  } catch { el.textContent = "Backends : inconnus"; }
}

export function mountBackendSwitches(root = document, { invoke, onChange } = {}) {
  const $ = (sel) => root.querySelector(sel);
  const status = $("#status-text");
  const text = $("#text-backend-select");
  const image = $("#image-backend-select");
  const model = $("#image-model-select");
  const size = $("#image-size-select");
  if (![...text.options].some(o => o.value === 'ollama')) text.add(new Option('Ollama', 'ollama'));
  const appleOption = new Option('Apple Foundation Models', 'applefm');
  appleOption.hidden = localStorage.getItem('canvasTextBackend') !== 'applefm';
  appleOption.disabled = true;
  text.add(appleOption);
  text.value = localStorage.getItem("canvasTextBackend") || "auto";
  appleFmBackendState().then(state => {
    appleOption.hidden = !state.available && text.value !== 'applefm';
    appleOption.disabled = !state.available;
    appleOption.textContent = state.available ? 'Apple Foundation Models' : 'Apple Foundation Models · indisponible';
    refreshBackendStatus(status);
  });
  // Anciennes valeurs (« auto », « local », « cloud ») : le canevas impose
  // désormais un moteur explicite, on retombe sur celui des réglages.
  const savedImage = localStorage.getItem("canvasImageBackend") || "";
  image.value = [...image.options].some((o) => o.value === savedImage) ? savedImage : imageProvider();
  // Image Playground n'apparaît que si Apple Intelligence répond présent.
  refreshPlaygroundOption(image, invoke, { onFallback: () => image.dispatchEvent(new Event("change")) });

  // Les modèles et les résolutions suivent le moteur choisi.
  const fillSizes = () => {
    const sizes = imageSizesFor(image.value, model.value);
    const wanted = nearestImageSize(image.value, model.value, localStorage.getItem("canvasImageSize") || "");
    size.innerHTML = "";
    for (const sz of sizes) size.appendChild(new Option(sz.label, sz.value));
    size.value = wanted;
    localStorage.setItem("canvasImageSize", size.value);
  };
  const fillModels = async (refresh = false) => {
    const provider = image.value;
    if (provider === "ollama" && (refresh || ollamaImageNames === null)) {
      ollamaImageNames = await listOllamaImageModels(invoke);
    }
    const models = imageModelsFor(provider, ollamaImageNames || []);
    const current = imageModel(provider);
    model.innerHTML = "";
    for (const m of models) model.appendChild(new Option(m.missing ? `${m.label} — à installer` : m.label, m.id));
    if (!models.some((m) => m.id === current)) model.appendChild(new Option(current, current));
    model.value = current;
    fillSizes();
  };

  const update = () => {
    localStorage.setItem("canvasTextBackend", text.value);
    localStorage.setItem("canvasImageBackend", image.value);
    if (model.value) localStorage.setItem(imageModelKey(image.value), model.value);
    localStorage.setItem("canvasImageSize", size.value);
    resetProbes();
    refreshBackendStatus(status);
    onChange?.();
  };
  text.addEventListener("change", update);
  image.addEventListener("change", async () => { await fillModels(); update(); });
  model.addEventListener("change", () => { fillSizes(); update(); });
  size.addEventListener("change", update);
  fillModels().then(update);
  detectBonsaiKind(invoke);
}

async function detectBonsaiKind(invoke) {
  if (!invoke) return;
  try {
    // Le moteur embarqué annonce son noyau sans avoir à tourner.
    const st = await invoke("bonsai_status");
    if (st?.kind && !localStorage.getItem("bonsaiUrl")) { localStorage.setItem("canvasBonsaiKind", st.kind); return; }
  } catch {}
  try {
    const res = await invoke("bonsai_backends");
    const ids = [res?.default, ...(res?.available || [])].filter(Boolean);
    const hit = ids.find((id) => /-(mlx|gemlite|diffusers)$/.test(id));
    const kind = hit ? hit.match(/-(mlx|gemlite|diffusers)$/)?.[1] : "";
    if (kind) localStorage.setItem("canvasBonsaiKind", kind);
  } catch {}
}

