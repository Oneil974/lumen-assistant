import { imageGenerationConfig, imageProvider, imageProviderLabel, imageModel, imageModelKey, imageModelsFor, imageSizesFor, nearestImageSize, listOllamaImageModels, imageErrorMessage } from "../lib/image-provider.js";
import { autoTranslate, tt } from "../apps-i18n.js";
// Studio d'images — galerie de génération locale via l'API Bonsai.
// invoke("bonsai_generate_data_url", …) renvoie une data URL PNG affichée
// directement. La galerie (prompt + image + métadonnées) est persistée en
// localStorage, plafonnée pour rester sous le quota du navigateur embarqué.
// Fallback parent : permet un éventuel embed iframe (même origine).
const __TAURI = window.__TAURI__ || (window.parent && window.parent.__TAURI__) || {};
const { invoke } = __TAURI.core || {};
import { recordImageGeneration } from "../ollama-usage.js";

const $ = (s) => document.querySelector(s);
const STORE_KEY = "studioGallery";
const MAX_KEEP = 24; // plafond galerie (data URLs volumineuses → quota localStorage)

let gallery = [];
let busy = false;
let sandboxes = [];
const SANDBOX_KEY = "studioSandbox"; // id de sandbox de destination choisi

// ---------- Persistance ----------
function loadGallery() {
  try { gallery = JSON.parse(localStorage.getItem(STORE_KEY) || "[]"); }
  catch { gallery = []; }
  if (!Array.isArray(gallery)) gallery = [];
}
function saveGallery() {
  // On plafonne la galerie en mémoire, mais on n'écrase JAMAIS la liste
  // affichée avec une version tronquée pour cause de quota de persistance :
  // les data URLs base64 sont volumineuses et peuvent dépasser le quota
  // localStorage. L'éviction ne concerne que ce qu'on persiste sur disque.
  if (gallery.length > MAX_KEEP) gallery = gallery.slice(0, MAX_KEEP);
  let items = gallery;
  while (items.length) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(items)); return; }
    catch { items = items.slice(0, items.length - 1); }
  }
  try { localStorage.removeItem(STORE_KEY); } catch {}
}

// ---------- UI utilitaires ----------
let toastTimer = null;
function toast(msg, ms = 2600) {
  const el = $("#toast");
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function setBusy(on) {
  busy = on;
  const btn = $("#btn-generate");
  btn.disabled = on;
  btn.classList.toggle("busy", on);
  $("#gen-label").textContent = on ? "Génération…" : "Générer";
}

function setProgress(done, total, label) {
  const bar = $("#progress");
  if (total <= 0 || done >= total) { bar.hidden = true; return; }
  bar.hidden = false;
  $("#progress-fill").style.width = `${Math.round((done / total) * 100)}%`;
  $("#progress-label").textContent = label || "";
}

// ---------- Rendu galerie ----------
function renderGallery() {
  const grid = $("#gallery");
  const empty = $("#empty");
  grid.innerHTML = "";
  const hasContent = gallery.length > 0 || busy;
  empty.hidden = hasContent;
  $("#btn-clear").hidden = gallery.length === 0;

  for (const item of gallery) {
    const card = document.createElement("div");
    card.className = "card";
    const fmt = `${item.width}×${item.height}`;
    card.innerHTML =
      `<img loading="lazy" src="${item.url}" alt="" />` +
      `<span class="badge">${fmt}</span>` +
      `<div class="cap">${escapeHtml(item.prompt)}</div>`;
    card.addEventListener("click", () => openLightbox(item));
    grid.appendChild(card);
  }
}

function addPendingCards(n) {
  const grid = $("#gallery");
  $("#empty").hidden = true;
  const placeholders = [];
  for (let i = 0; i < n; i += 1) {
    const card = document.createElement("div");
    card.className = "card pending";
    card.innerHTML = `<div class="shimmer"></div>`;
    grid.prepend(card);
    placeholders.push(card);
  }
  return placeholders;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---------- Lightbox ----------
let lbItem = null;
function openLightbox(item) {
  lbItem = item;
  $("#lb-img").src = item.url;
  $("#lb-prompt").textContent = item.prompt;
  $("#lightbox").hidden = false;
}
function closeLightbox() { $("#lightbox").hidden = true; lbItem = null; }

// ---------- Statut API ----------
async function refreshStatus() {
  const dot = $("#status-dot");
  const txt = $("#status-text");
  if (!invoke) { txt.textContent = "Hors application"; return false; }
  const provider = imageProvider();
  if (provider === "openai") {
    // SÉCURITÉ : la clé n'est plus côté front ; on interroge l'état backend.
    let ok = false;
    try { const st = await invoke("llm_secret_status"); ok = !!(st && st.configured); } catch {}
    dot.className = ok ? "status-dot ok" : "status-dot off";
    txt.textContent = ok ? imageProviderLabel("openai") : "Clé OpenAI manquante";
    return ok;
  }
  if (provider === "playground") {
    // Image Playground : la feuille système s'ouvre à chaque génération ;
    // l'utilisateur valide l'image lui-même.
    let ok = false;
    try { const st = await invoke("imageplayground_status"); ok = !!(st && st.available); } catch {}
    dot.className = ok ? "status-dot ok" : "status-dot off";
    txt.textContent = ok ? imageProviderLabel("playground") : "Image Playground indisponible (Apple Intelligence)";
    return ok;
  }
  if (provider === "ollama") {
    // Ollama est local et sans clé : le seul état à vérifier est « le serveur
    // répond-il ? ». Le modèle d'image, lui, est celui des réglages.
    let ok = false;
    try { const models = await invoke("ollama_list_models", { url: localStorage.getItem("ollamaUrl") || null }); ok = Array.isArray(models); } catch {}
    dot.className = ok ? "status-dot ok" : "status-dot off";
    txt.textContent = ok ? imageProviderLabel("ollama") : "Ollama injoignable";
    return ok;
  }
  try {
    const s = await invoke("bonsai_status");
    if (s.running) {
      dot.className = "status-dot ok";
      txt.textContent = "API Bonsai active";
      // Charge la liste des modèles si elle n'a pas encore pu l'être.
      if ($("#opt-backend").options.length <= 1) refreshBackends();
      return true;
    }
    dot.className = "status-dot off";
    txt.textContent = !s.engine_bundled ? "Moteur Bonsai non embarqué pour cette plateforme"
      : s.model_present ? "API arrêtée — lance-la dans les Réglages"
      : "Modèle absent — installe-le depuis le Catalogue ou les Réglages";
    return false;
  } catch (e) {
    dot.className = "status-dot off";
    txt.textContent = "API indisponible";
    return false;
  }
}

// ---------- Génération ----------
function readOptions() {
  const [w, h] = ($("#opt-resolution").value || "512x512").split("x").map((n) => parseInt(n, 10));
  const seedRaw = $("#opt-seed").value.trim();
  const seed = seedRaw === "" ? null : (Number.isFinite(+seedRaw) ? Math.abs(parseInt(seedRaw, 10)) : null);
  const steps = Math.min(64, Math.max(1, parseInt($("#opt-steps").value, 10) || 4));
  const batch = Math.min(8, Math.max(1, parseInt($("#opt-batch").value, 10) || 1));
  // Le sélecteur porte un backend Bonsai, ou un MODÈLE pour les autres moteurs
  // (déjà mémorisé à part) : n'envoyer `backend` que pour Bonsai.
  const backend = imageProvider() === "bonsai" ? ($("#opt-backend").value || null) : null;
  return { prompt: $("#prompt").value.trim(), width: w, height: h, seed, steps, batch, backend };
}


// Modèles Ollama installés, interrogés une fois puis mémorisés.
let ollamaImageNames = null;

// Les résolutions acceptées dépendent du moteur et, pour OpenAI, du modèle :
// l'API refuse toute autre valeur. On repeuple donc le sélecteur au lieu de
// laisser la liste figée du HTML.
function refreshResolutions() {
  const sel = $("#opt-resolution");
  if (!sel) return;
  const provider = imageProvider();
  const model = provider === "bonsai" ? "" : ($("#opt-backend")?.value || imageModel(provider));
  const sizes = imageSizesFor(provider, model);
  const wanted = nearestImageSize(provider, model, sel.value || localStorage.getItem("studioResolution") || "");
  sel.innerHTML = "";
  for (const s of sizes) sel.appendChild(new Option(s.label, s.value));
  sel.value = wanted;
  localStorage.setItem("studioResolution", sel.value);
}

// Libellé lisible d'un id de backend : « bonsai-binary-mlx » → « Bonsai · Binary ».
function prettyModel(id) {
  return String(id)
    .replace(/-(mlx|gemlite|diffusers|unpacked)$/i, "")
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" · ") || String(id);
}

// Peuple le sélecteur de modèle depuis l'API Bonsai. Conserve le choix précédent
// (localStorage) s'il est encore disponible.
async function refreshBackends() {
  const sel = $("#opt-backend");
  if (!invoke || !sel) return;
  const provider = imageProvider();
  if (provider === "openai" || provider === "ollama" || provider === "playground") {
    // Modèles du moteur : ceux de l'API OpenAI, ou les modèles d'image
    // réellement installés dans Ollama (le catalogue complète en suggestion).
    if (provider === "ollama" && ollamaImageNames === null) ollamaImageNames = await listOllamaImageModels(invoke);
    const models = imageModelsFor(provider, ollamaImageNames || []);
    const current = imageModel(provider);
    sel.innerHTML = "";
    for (const m of models) sel.appendChild(new Option(m.missing ? `${m.label} — à installer` : m.label, m.id));
    if (!models.some((m) => m.id === current)) sel.appendChild(new Option(current, current));
    sel.value = current;
    sel.closest(".opt").hidden = false;
    refreshResolutions();
    return;
  }
  let info;
  try { info = await invoke("bonsai_backends"); } catch { return; }
  const saved = localStorage.getItem("studioBackend") || "";
  sel.innerHTML = "";
  const autoLabel = info.default ? `Automatique (${prettyModel(info.default)})` : "Automatique";
  sel.appendChild(new Option(autoLabel, ""));
  for (const name of info.available || []) sel.appendChild(new Option(prettyModel(name), name));
  // Restaure la sélection si toujours présente, sinon « Automatique ».
  sel.value = (saved && [...sel.options].some((o) => o.value === saved)) ? saved : "";
  // Masque le sélecteur quand un seul modèle est proposé (pas de choix réel).
  sel.closest(".opt").hidden = (info.available || []).length <= 1;
  refreshResolutions();
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "image";
}

// Identifiant de sandbox cible. En mode workspace (iframe), la fenêtre parente
// expose la sandbox courante ; sinon on laisse le backend choisir la sandbox
// dédiée « Studio d'images ».
function targetSandboxId() {
  try { return (window.parent && window.parent.LumenCurrentSandbox && window.parent.LumenCurrentSandbox()) || null; }
  catch { return null; }
}

// ---------- Sandbox de destination ----------
// Id réellement sélectionné (chaîne vide = « Mémoire seule », non conservé).
function selectedSandboxId() {
  const v = $("#opt-sandbox")?.value || "";
  return v && v !== "__new__" ? v : null;
}

// Affiche/masque l'avertissement selon la destination courante.
function updateDestWarning() {
  const warn = $("#dest-warn");
  const txt = $("#dest-warn-text");
  const action = $("#dest-warn-action");
  if (!warn) return;
  if (!sandboxes.length) {
    warn.hidden = false;
    txt.textContent = "Aucune sandbox : vos créations resteront en mémoire et seront perdues à la fermeture du studio. Crée une sandbox pour les conserver.";
    action.hidden = false;
  } else if (!selectedSandboxId()) {
    warn.hidden = false;
    txt.textContent = "Destination « Mémoire seule » : les images ne seront pas enregistrées et seront perdues à la fermeture. Choisis une sandbox ou télécharge-les.";
    action.hidden = true;
  } else {
    warn.hidden = true;
  }
}

// (Re)peuple le sélecteur de sandbox depuis le backend.
async function refreshSandboxes() {
  const sel = $("#opt-sandbox");
  if (!invoke || !sel) return;
  try { sandboxes = await invoke("sandbox_list"); } catch { sandboxes = []; }
  const saved = localStorage.getItem(SANDBOX_KEY) || targetSandboxId() || "";
  sel.innerHTML = "";
  sel.appendChild(new Option("Mémoire seule (non conservé)", ""));
  for (const s of sandboxes) sel.appendChild(new Option(s.name, s.id));
  sel.appendChild(new Option("＋ Nouvelle sandbox…", "__new__"));
  sel.value = sandboxes.some((s) => s.id === saved) ? saved : "";
  updateDestWarning();
}

// Modale de création (prompt() est inopérant dans WKWebView).
function openSandboxModal() {
  $("#sb-name").value = "";
  $("#sb-modal").hidden = false;
  setTimeout(() => $("#sb-name").focus(), 30);
}
function closeSandboxModal() { $("#sb-modal").hidden = true; }

async function createSandbox() {
  const name = $("#sb-name").value.trim();
  if (!name) { $("#sb-name").focus(); return; }
  if (!invoke) { toast("Disponible uniquement dans l'application Lumen."); return; }
  const btn = $("#sb-create");
  btn.disabled = true;
  try {
    const meta = await invoke("sandbox_create", { name, maxMb: 256 });
    localStorage.setItem(SANDBOX_KEY, meta.id);
    closeSandboxModal();
    await refreshSandboxes();
    $("#opt-sandbox").value = meta.id;
    updateDestWarning();
    toast(`Sandbox « ${meta.name} » créée ✓`);
  } catch (e) {
    toast("Échec de la création : " + ((e && e.message) || e), 4200);
  } finally {
    btn.disabled = false;
  }
}

async function generate() {
  if (busy) return;
  const opts = readOptions();
  if (!opts.prompt) { toast("Décris d'abord l'image à créer…"); $("#prompt").focus(); return; }
  if (!invoke) { toast("Disponible uniquement dans l'application Lumen."); return; }

  setBusy(true);
  const pending = addPendingCards(opts.batch);
  setProgress(0, opts.batch, "Préparation…");
  const created = [];
  const imageConfig = imageGenerationConfig();
  // Destination explicite choisie dans le studio ; sinon sandbox courante du
  // workspace (embed). Si rien n'est choisi (« Mémoire seule »), l'image n'est
  // PAS écrite sur disque : elle ne vit que dans la galerie en mémoire.
  const sid = selectedSandboxId() || targetSandboxId();
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const slug = slugify(opts.prompt);
  try {
    for (let i = 0; i < opts.batch; i += 1) {
      setProgress(i, opts.batch, `Image ${i + 1}/${opts.batch}…`);
      const suffix = opts.batch > 1 ? `_${String(i + 1).padStart(2, "0")}` : "";
      const path = `${slug}_${stamp}${suffix}.png`;
      const common = {
        prompt: opts.prompt,
        width: opts.width,
        height: opts.height,
        seed: opts.seed === null ? null : opts.seed + i,
        steps: opts.steps,
        backend: opts.backend,
        provider: imageConfig.provider,
        apiBase: imageConfig.apiBase,
        apiKey: imageConfig.apiKey,
        apiModel: imageConfig.apiModel,
      };
      // Avec sandbox : on écrit le fichier. Sinon (« Mémoire seule ») : data URL pur.
      const res = sid
        ? await invoke("bonsai_generate_to_sandbox_url", { id: sid, path, ...common })
        : { data_url: await invoke("bonsai_generate_data_url", common), sandbox_id: null, path: null };
      const item = {
        id: `${Date.now()}_${i}`,
        url: res.data_url,
        sandboxId: res.sandbox_id,
        path: res.path,
        prompt: opts.prompt,
        width: opts.width,
        height: opts.height,
        seed: opts.seed === null ? null : opts.seed + i,
        steps: opts.steps,
        at: Date.now(),
      };
      gallery.unshift(item);
      created.push(item);
      // Comptabilise l'image dans le compteur d'usage (widget de tokens/images).
      recordImageGeneration(1, imageConfig.provider);
      // Remplace le placeholder correspondant par l'image réelle.
      pending[i]?.remove();
      saveGallery();
      renderGallery();
      // En mode workspace, rafraîchit l'explorateur parent pour voir le fichier.
      try { if (res.sandbox_id) window.parent && window.parent.LumenRefreshSandbox && window.parent.LumenRefreshSandbox(res.sandbox_id); } catch {}
      setProgress(i + 1, opts.batch, `Image ${i + 1}/${opts.batch}…`);
    }
    if (sid) {
      toast(created.length === 1 ? "Image générée et enregistrée dans la sandbox ✓"
                                 : `${created.length} images enregistrées dans la sandbox ✓`);
    } else {
      toast(created.length === 1 ? "Image générée (mémoire seule) — télécharge-la pour la conserver"
                                 : `${created.length} images générées (mémoire seule) — à télécharger pour les conserver`, 4200);
    }
  } catch (e) {
    pending.forEach((p) => p.remove());
    renderGallery();
    // Message traduit côté Lumen : le backend renvoie un statut HTTP et le
    // jargon du moteur, illisibles dans un toast.
    const msg = imageErrorMessage(e);
    toast(msg, 7000);
    refreshStatus();
  } finally {
    setProgress(0, 0);
    setBusy(false);
  }
}

// ---------- Initialisation ----------
function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = Math.min(160, el.scrollHeight) + "px";
}

function init() {
  loadGallery();
  renderGallery();
  refreshStatus();
  refreshBackends();
  refreshSandboxes();
  $("#opt-resolution")?.addEventListener("change", (e) => localStorage.setItem("studioResolution", e.target.value));
  setInterval(refreshStatus, 15000);

  $("#opt-backend").addEventListener("change", (e) => {
    // Pour Ollama/OpenAI, la liste contient des MODÈLES : le choix est
    // mémorisé là où `imageGenerationConfig()` ira le relire. Pour Bonsai,
    // c'est un identifiant de backend, propre au Studio.
    const provider = imageProvider();
    if (provider === "ollama" || provider === "openai" || provider === "playground") {
      localStorage.setItem(imageModelKey(provider), e.target.value);
      refreshResolutions();
      refreshStatus();
      return;
    }
    if (e.target.value) localStorage.setItem("studioBackend", e.target.value);
    else localStorage.removeItem("studioBackend");
  });

  // Destination (sandbox) : persistance du choix + ouverture de la modale de création.
  $("#opt-sandbox").addEventListener("change", (e) => {
    if (e.target.value === "__new__") {
      // Restaure l'ancien choix tant que la sandbox n'est pas créée.
      e.target.value = localStorage.getItem(SANDBOX_KEY) || "";
      openSandboxModal();
      return;
    }
    if (e.target.value) localStorage.setItem(SANDBOX_KEY, e.target.value);
    else localStorage.removeItem(SANDBOX_KEY);
    updateDestWarning();
  });
  $("#dest-warn-action").addEventListener("click", openSandboxModal);
  $("#sb-cancel").addEventListener("click", closeSandboxModal);
  $("#sb-create").addEventListener("click", createSandbox);
  $("#sb-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); createSandbox(); }
    if (e.key === "Escape") closeSandboxModal();
  });
  $("#sb-modal").addEventListener("click", (e) => { if (e.target.id === "sb-modal") closeSandboxModal(); });

  const prompt = $("#prompt");
  prompt.addEventListener("input", () => autoGrow(prompt));
  prompt.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); generate(); }
  });

  $("#btn-generate").addEventListener("click", generate);

  $("#opt-seed-dice").addEventListener("click", () => {
    $("#opt-seed").value = String(Math.floor(Math.random() * 2147483647));
  });

  $("#chips").querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      // Remplace le contenu de la barre de prompt (ne pas concaténer).
      prompt.value = b.textContent;
      autoGrow(prompt);
      prompt.focus();
    });
  });

  $("#btn-clear").addEventListener("click", () => {
    if (gallery.length === 0) return;
    gallery = [];
    saveGallery();
    renderGallery();
  });

  // Lightbox
  $("#lb-close").addEventListener("click", closeLightbox);
  $("#lightbox").addEventListener("click", (e) => { if (e.target.id === "lightbox") closeLightbox(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeLightbox(); });
  $("#lb-reuse").addEventListener("click", () => {
    if (!lbItem) return;
    prompt.value = lbItem.prompt;
    autoGrow(prompt);
    closeLightbox();
    prompt.focus();
  });
  $("#lb-save").addEventListener("click", async () => {
    if (!lbItem || !invoke) return;
    try {
      const slug = lbItem.prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "bonsai";
      const path = await invoke("bonsai_save_png", { dataUrl: lbItem.url, name: slug });
      toast("Enregistré : " + path, 4200);
    } catch (e) {
      toast("Échec de l'enregistrement : " + ((e && e.message) || e), 4200);
    }
  });
}

document.addEventListener("DOMContentLoaded", init);

// i18n : traduit le DOM statique + le contenu rendu dynamiquement (mode EN).
autoTranslate({ observe: true });
