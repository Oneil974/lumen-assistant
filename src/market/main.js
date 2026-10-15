import { autoTranslate, appLang, tt } from "../apps-i18n.js";
import { LLAMA_MODEL_CATALOG, llamaModelDescription, llamaModelCardUrl } from "../llama-models.js";
import { OLLAMA_MODEL_CATALOG, ollamaModelDescription, ollamaModelInstalled } from "../ollama-models.js";
import { modelGroup, modelGroupLabel, modelGroupOrder } from "../lib/model-groups.js";
import { DECISION_MODELS, setDecisionModel } from "../lib/decision.js";
import { rememberModelFor } from "../llm.js";
import { icon as lumenIcon } from "../lib/icons.js";
import { confirmSheet } from "../lib/confirm.js";
import { bindExternalLink } from "../lib/open-external.js";
import { WORKFLOW_PACKS, FEATURED, MANIFEST_DOC, OFFICIAL_MANIFEST_URL, parseManifest } from "./catalog.js";

// Catalogue — logique front. Aucune commande Rust nouvelle : chaque rayon parle au
// backend qui possédait déjà le domaine.
//   Modèles   → llama_list_models / llama_download_model / llama_cancel_download
//               + modèles d'IMAGE Bonsai (PrismML) : bonsai_status /
//               bonsai_download_model / bonsai_cancel_download / bonsai_delete_model
//               / llama_partial_downloads / llama_delete_model / llama_start
//   Voix      → tts_catalog / tts_download_voice / tts_delete_voice / tts_set_voice
//   Workflows → list_workflows / save_workflow / delete_workflow / reload_triggers
//   Avatars   → avatar_glb_status / avatar_glb_import / avatar_glb_delete
// Le GLB distant est récupéré par `fetch` (la CSP autorise https:) puis passé en
// Base64 à `avatar_glb_import`, qui valide le fichier avant de le conserver.

const tauri = window.__TAURI__ || window.parent?.__TAURI__;
const invoke = tauri?.core?.invoke;
const SOURCE_KEY = "lumen.market.sourceUrl";
// Deux sources distantes se CUMULENT : le manifeste officiel du dépôt (mis à
// jour sans nouvelle version de l'app) et, éventuellement, celui de
// l'utilisateur. Aucune ne remplace le catalogue embarqué ; toutes trois
// s'additionnent, dédoublonnées par identifiant préfixé.
const OFFICIAL_LABEL = "Liste officielle Lumen";
const CUSTOM_LABEL = "Ma source";

const $ = (id) => document.getElementById(id);
const els = {
  status: $("status"), search: $("search"),
  sections: $("sections"), cats: $("cats"), catsTitle: $("cats-title"), sideFoot: $("side-foot"),
  stageTitle: $("stage-title"),
  hero: $("hero"), heroTrack: $("hero-track"), heroDots: $("hero-dots"),
  gridModels: $("grid-models"), gridVoices: $("grid-voices"),
  gridWorkflows: $("grid-workflows"), gridAvatars: $("grid-avatars"),
  avatarCurrent: $("avatar-current"), avatarUrl: $("avatar-url"), avatarFile: $("avatar-file"),
  sourceUrl: $("source-url"), sourceState: $("source-state"), manifestDoc: $("manifest-doc"),
};

const SECTIONS = [
  // « Applications » ouvre le Catalogue depuis la 0.2 : c'est devenu la raison
  // principale d'y venir, puisque Lumen n'embarque plus que son noyau.
  { id: "apps", label: "Applications", icon: "grid" },
  // Paquets installés dont le dépôt publie une révision plus récente (le
  // contenu a changé : cf. scripts/package-apps.mjs, `version` = x.y.z-rN).
  { id: "updates", label: "Mises à jour", icon: "refresh-cw" },
  { id: "models", label: "Modèles", icon: "brain-circuit" },
  { id: "voices", label: "Voix", icon: "audio-lines" },
  { id: "workflows", label: "Workflows", icon: "fluxo" },
  { id: "avatars", label: "Avatars 3D", icon: "user" },
  { id: "source", label: "Sources", icon: "globe" },
];

let section = "apps";
const filters = { apps: "all", models: "all", voices: "all", workflows: "all" };
const state = {
  ollama: [],          // noms installés côté Ollama (null = Ollama injoignable)
  models: [],          // GGUF présents sur le disque (llama_list_models)
  bonsai: null,        // bonsai_status : moteur + modèles d'image
  bonsaiRemote: null,  // bonsai_engine_remote : archive du moteur publiée pour cette machine
  partials: new Map(), // téléchargements interrompus : filename → octets
  voices: [],
  workflows: [],       // noms des workflows déjà enregistrés dans Fluxo
  avatar: null,        // avatar personnalisé installé, ou null
  official: { workflows: [], avatars: [], featured: [] },
  custom: { workflows: [], avatars: [], featured: [] },
  hardware: null,
};
const busy = new Set();       // ids en cours (téléchargement, installation)
const progress = new Map();   // id → pourcentage du transfert en cours

// ===== Utilitaires ==========================================================
function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function formatBytes(bytes) {
  const units = ["o", "Ko", "Mo", "Go", "To"];
  let value = Number(bytes) || 0, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function setStatus(message) { els.status.textContent = tt(message); }

function toast(message, isError = false) {
  setStatus(message);
  els.status.classList.toggle("err", Boolean(isError));
}

function matchesSearch(...fields) {
  const query = els.search.value.trim().toLowerCase();
  if (!query) return true;
  return fields.filter(Boolean).join(" ").toLowerCase().includes(query);
}

/** Deux lettres lisibles pour la vignette sans image. */
function monogram(label) {
  const words = String(label || "?").replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/);
  return ((words[0]?.[0] || "?") + (words[1]?.[0] || "")).toUpperCase();
}

/**
 * Vignette d'une fiche : un monogramme sur surface teintée d'accent. Pas
 * d'image — le catalogue n'en héberge aucune, et l'écran n'a pas à dépendre de
 * fichiers qui pourraient manquer.
 */
function thumb(label) {
  const el = document.createElement("div");
  el.className = "thumb";
  el.textContent = monogram(label);
  return el;
}

/// Vocabulaire des badges. Les clés sont les `tags` du catalogue de modèles
/// (cf. llama-models.js) ; les workflows et les voix posent les leurs à la
/// volée. Un tag inconnu s'affiche tel quel plutôt que de disparaître.
const BADGES = {
  decision: "Décision",
  ollama: "Ollama",
  tools: "Appel d'outils",
  ocr: "OCR",
  vision: "Vision",
  reasoning: "Raisonnement",
  think: "Réflexion",
  code: "Code",
  multilingual: "Multilingue",
  embedding: "Embedding",
  image: "Image",
  local: "Local",
};

function badgeLabel(tag) { return tt(BADGES[tag] || String(tag)); }

function card({ id, title, badge, meta, description, tags = [], extra = "" }) {
  const el = document.createElement("div");
  el.className = "card";
  const chips = tags.filter(Boolean).map((tag) => `<span class="chip">${esc(badgeLabel(tag))}</span>`).join("");
  el.innerHTML = `
    <div class="card-head">
      <div class="card-id">
        <div class="card-top">
          <div class="card-name">${esc(title)}</div>
          ${badge ? `<span class="tag ok">${esc(badge)}</span>` : ""}
        </div>
        ${meta ? `<div class="card-meta">${esc(meta)}</div>` : ""}
      </div>
    </div>
    ${chips ? `<div class="chips">${chips}</div>` : ""}
    ${description ? `<div class="card-desc">${esc(description)}</div>` : ""}
    ${extra}
    <div class="card-actions"></div>`;
  el.querySelector(".card-head").prepend(thumb(title));
  return el;
}

function button(label, cls, onClick) {
  const el = document.createElement("button");
  el.className = "btn " + cls;
  el.textContent = tt(label);
  el.addEventListener("click", () => onClick(el));
  return el;
}

function emptyState(grid, message) {
  grid.innerHTML = `<div class="empty">${esc(tt(message))}</div>`;
}

// ===== Navigation : rayons puis catégories ==================================
/**
 * Catégories du rayon courant. Chacune porte son test : la grille n'a plus
 * qu'à filtrer, et le compteur affiché dans le panneau vient du même test.
 */
function categoriesFor(id) {
  if (id === "models") {
    return [
      { key: "all", label: "Tout", test: () => true },
      { key: "fast", label: "Léger", test: (m) => m.tier === "fast" },
      { key: "balanced", label: "Équilibré", test: (m) => m.tier === "balanced" },
      { key: "powerful", label: "Puissant", test: (m) => m.tier === "powerful" },
      { key: "vision", label: "Vision", test: (m) => (m.tags || []).includes("vision") },
      { key: "tools", label: "Appel d'outils", test: (m) => (m.tags || []).includes("tools") },
      { key: "code", label: "Code", test: (m) => (m.tags || []).includes("code") },
      { key: "reasoning", label: "Raisonnement", test: (m) => (m.tags || []).includes("reasoning") },
      { key: "multilingual", label: "Multilingue", test: (m) => (m.tags || []).includes("multilingual") },
      { key: "ocr", label: "OCR", test: (m) => (m.tags || []).includes("ocr") },
      { key: "decision", label: "Décision", test: (m) => (m.tags || []).includes("decision") },
      { key: "embedding", label: "Embedding", test: (m) => (m.tags || []).includes("embedding") },
      { key: "image", label: "Image", test: (m) => m.kind === "image" },
      { key: "installed", label: "Installés", test: (m) => isInstalled(m) },
    ];
  }
  if (id === "apps") {
    const entries = appEntries();
    const present = new Set(entries.map((e) => e.category || "create"));
    return [
      { key: "all", label: "Tout", test: () => true },
      { key: "installed", label: "Installées", test: (e) => !!e.installedVersion },
      { key: "updates", label: "Mises à jour", test: (e) => !!e.installedVersion && e.installedVersion !== e.version },
      { key: "available", label: "À découvrir", test: (e) => !e.installedVersion },
      ...APP_CATEGORIES.filter((c) => present.has(c.id))
        .map((c) => ({ key: `cat:${c.id}`, label: c.label, icon: c.icon, test: (e) => (e.category || "create") === c.id })),
    ];
  }
  if (id === "voices") {
    const langs = [...new Set(state.voices.map((voice) => voice.lang).filter(Boolean))].sort();
    return [
      { key: "all", label: "Tout", test: () => true },
      { key: "piper", label: "Piper", test: (v) => v.engine === "piper" },
      { key: "kokoro", label: "Kokoro", test: (v) => v.engine === "kokoro" },
      ...langs.map((lang) => ({ key: `lang:${lang}`, label: lang, test: (v) => v.lang === lang })),
      { key: "installed", label: "Installées", test: (v) => v.installed },
    ];
  }
  if (id === "workflows") {
    const cats = [...new Set(workflowEntries().map((pack) => pack.category).filter(Boolean))];
    return [
      { key: "all", label: "Tout", test: () => true },
      ...cats.map((cat) => ({ key: `cat:${cat}`, label: cat, test: (p) => p.category === cat })),
      { key: "installed", label: "Installés", test: (p) => state.workflows.includes(p.workflow.name) },
    ];
  }
  return [];
}

function itemsFor(id) {
  if (id === "apps") return appEntries();
  if (id === "models") return [...LLAMA_MODEL_CATALOG, ...ollamaEntries(), ...bonsaiEntries()];
  if (id === "voices") return state.voices;
  if (id === "workflows") return workflowEntries();
  return [];
}

function activeCategory() {
  const cats = categoriesFor(section);
  return cats.find((cat) => cat.key === filters[section]) || cats[0];
}

function navItem({ label, iconName, count, active, onClick }) {
  const el = document.createElement("button");
  el.className = "nav-item" + (active ? " active" : "");
  el.innerHTML = `${iconName ? `<span class="ic">${lumenIcon(iconName)}</span>` : ""}
    <span class="lb">${esc(tt(label))}</span>
    ${count === undefined ? "" : `<span class="n">${count}</span>`}`;
  el.addEventListener("click", onClick);
  return el;
}

function renderNav() {
  els.sections.innerHTML = "";
  for (const entry of SECTIONS) {
    els.sections.appendChild(navItem({
      label: entry.label, iconName: entry.icon, active: entry.id === section,
      count: entry.id === "updates" ? (pendingUpdates().length || undefined) : undefined,
      onClick: () => selectSection(entry.id),
    }));
  }
  const cats = categoriesFor(section);
  els.catsTitle.hidden = !cats.length;
  els.cats.innerHTML = "";
  const items = itemsFor(section);
  for (const cat of cats) {
    els.cats.appendChild(navItem({
      label: cat.label, iconName: cat.icon, count: items.filter(cat.test).length,
      active: cat.key === (filters[section] || "all"),
      onClick: () => { filters[section] = cat.key; renderNav(); render(); },
    }));
  }
}

function selectSection(next) {
  section = next;
  for (const entry of SECTIONS) { const p = $(`panel-${entry.id}`); if (p) p.hidden = entry.id !== next; }
  els.stageTitle.textContent = tt(SECTIONS.find((entry) => entry.id === next)?.label || "Catalogue");
  els.search.hidden = next === "avatars" || next === "source" || next === "updates";
  renderNav();
  renderHero();
  render();
}

// ===== Carrousel ============================================================
let heroIndex = 0;
let heroTimer = 0;
let heroSlides = [];

/** Lames du rayon courant, mises en avant embarquées puis distantes. */
function heroFor(id) {
  const remote = [...state.official.featured || [], ...state.custom.featured || []];
  return [...FEATURED, ...remote]
    .filter((slide) => slide.section === id)
    .filter((slide) => {
      if (!slide.target) return true;
      if (id === "models") return LLAMA_MODEL_CATALOG.some((model) => model.id === slide.target);
      if (id === "workflows") return workflowEntries().some((pack) => pack.id.endsWith(slide.target));
      return true;
    });
}

function renderHero() {
  heroSlides = heroFor(section);
  clearInterval(heroTimer);
  els.hero.hidden = heroSlides.length === 0;
  els.heroTrack.innerHTML = "";
  els.heroDots.innerHTML = "";
  if (!heroSlides.length) return;
  heroIndex = 0;

  for (const slide of heroSlides) {
    const el = document.createElement("article");
    el.className = "slide";
    el.innerHTML = `
      <div class="slide-veil"></div>
      <div class="slide-txt">
        <span class="slide-eyebrow">${esc(tt(slide.eyebrow || ""))}</span>
        <span class="slide-title">${esc(slide.title)}</span>
        <span class="slide-sub">${esc(slide.subtitle || "")}</span>
      </div>`;
    if (slide.target) {
      el.querySelector(".slide-txt").appendChild(
        button("Voir la fiche", "primary", () => focusTarget(slide)),
      );
    }
    els.heroTrack.appendChild(el);

    const dot = document.createElement("button");
    dot.className = "hero-dot";
    dot.addEventListener("click", () => goHero(heroSlides.indexOf(slide)));
    els.heroDots.appendChild(dot);
  }
  goHero(0);
  heroTimer = setInterval(() => goHero(heroIndex + 1), 7000);
}

function goHero(index) {
  if (!heroSlides.length) return;
  heroIndex = (index + heroSlides.length) % heroSlides.length;
  els.heroTrack.style.transform = `translateX(-${heroIndex * 100}%)`;
  [...els.heroDots.children].forEach((dot, i) => dot.classList.toggle("active", i === heroIndex));
}

/** « Voir la fiche » : on retombe sur la catégorie complète et on cherche l'élément. */
function focusTarget(slide) {
  filters[section] = "all";
  els.search.value = slide.title;
  renderNav();
  render();
  const first = $(`grid-${section}`)?.querySelector(".card");
  first?.scrollIntoView({ behavior: "smooth", block: "center" });
}

// ===== Modèles GGUF =========================================================
function isInstalled(model) {
  if (model.kind === "image") return !!model.installed;
  if (model.kind === "ollama") return ollamaModelInstalled(model.ollamaName, state.ollama);
  if (model.tags?.includes("ocr")) return state.ocr?.some(m => m.filename === model.filename && m.installed) || false;
  return state.models.some((entry) => entry.filename === model.filename);
}

/**
 * Modèles d'image Bonsai (PrismML), au format des fiches du rayon. Le
 * catalogue vit côté Rust (`bonsai_status().models`), filtré au noyau de la
 * machine (MLX sur Apple Silicon, CUDA ailleurs) : ce qu'on ne peut pas faire
 * tourner ici n'est pas proposé.
 */
function bonsaiEntries() {
  const st = state.bonsai;
  if (!st || !Array.isArray(st.models)) return [];
  const r = state.bonsaiRemote;
  // Le moteur lui-même est une fiche : sans lui, les modèles ne servent à rien.
  const engine = st.kind ? [{
    id: "bonsai:engine", bonsaiId: "engine", kind: "image", engine: true,
    label: st.kind === "mlx" ? "Moteur Bonsai Image (Apple Silicon · MLX)" : "Moteur Bonsai Image (GPU NVIDIA · CUDA)",
    family: "PrismML · runtime", quantization: r?.version || st.engine_version || "",
    sizeBytes: Number(r?.size) || 0, sizeLabel: r?.size ? formatBytes(r.size) : "",
    tags: ["image", "local"], installed: !!st.engine_bundled, downloading: !!st.engine_downloading,
    repo: "", available: !!r?.available, updateAvailable: !!r?.update_available, deletable: !!st.engine_downloaded,
    remoteError: r?.error || null,
  }] : [];
  return [...engine, ...st.models.map((m) => ({
    id: `bonsai:${m.id}`, bonsaiId: m.id, kind: "image", variant: m.variant,
    label: m.label, family: "Bonsai Image 4B", quantization: m.variant === "binary" ? "1 bit" : "1,58 bit",
    sizeBytes: Number(m.size_bytes) || 0, sizeLabel: formatBytes(m.size_bytes),
    tags: ["image", "local"], installed: !!m.installed, downloading: !!m.downloading, repo: m.repo,
    active: !!st.running && st.active_variant === m.variant,
  }))];
}

function bonsaiDescription(model, lang) {
  const en = lang === "en";
  const base = en
    ? "PrismML text-to-image model derived from FLUX.2 Klein 4B, generated locally by the bundled Bonsai engine."
    : "Modèle texte→image PrismML dérivé de FLUX.2 Klein 4B, généré en local par le moteur Bonsai embarqué.";
  const variant = model.variant === "binary"
    ? (en ? " Binary (1-bit): the lightest variant, a bit less faithful." : " Binary (1 bit) : la variante la plus légère, un peu moins fidèle.")
    : (en ? " Ternary (1.58-bit): recommended quality/size balance." : " Ternary (1,58 bit) : le compromis qualité/taille recommandé.");
  const engine = state.bonsai?.engine_bundled ? "" : (en
    ? " The Bonsai engine is not bundled in this build: the model can be downloaded but not run."
    : " Le moteur Bonsai n'est pas embarqué dans cette version : le modèle se télécharge mais ne pourra pas tourner.");
  return base + variant + engine;
}

function bonsaiEngineDescription(model, lang) {
  const en = lang === "en";
  let text = en
    ? "Runtime of the PrismML Bonsai Image 4B engine (mflux + MLX on Apple Silicon, gemlite/Triton on CUDA), downloaded from the Lumen repository. Required before the Ternary/Binary models can generate anything."
    : "Runtime du moteur PrismML Bonsai Image 4B (mflux + MLX sur Apple Silicon, gemlite/Triton sur CUDA), téléchargé depuis le dépôt Lumen. Indispensable avant que les modèles Ternary/Binary ne puissent générer.";
  if (!model.installed && !model.available) {
    text += model.remoteError
      ? (en ? " The repository is unreachable right now." : " Le dépôt est injoignable pour le moment.")
      : (en ? " No archive is published for this platform yet." : " Aucune archive n'est encore publiée pour cette plateforme.");
  }
  return text;
}

function renderEngineCard(model, grid) {
  const percent = progress.get(model.id);
  const el = card({
    id: model.id,
    title: model.label,
    badge: model.installed ? (model.updateAvailable ? tt("Mise à jour") : tt("Installé")) : "",
    tags: model.tags,
    meta: [model.family, model.quantization, model.sizeLabel].filter(Boolean).join(" · "),
    description: bonsaiEngineDescription(model, appLang()),
    extra: percent === undefined ? "" : `<div class="bar"><i style="width:${percent}%"></i></div>`,
  });
  const actions = el.querySelector(".card-actions");
  if (busy.has(model.id) || model.downloading) {
    actions.appendChild(button("Annuler", "tiny ghost", async (b) => {
      b.disabled = true;
      await invoke("bonsai_cancel_download", { id: "engine" }).catch(() => {});
    }));
  } else {
    if (model.available && (!model.installed || model.updateAvailable)) {
      actions.appendChild(button(model.installed ? "Mettre à jour" : "Télécharger", "primary tiny", () => downloadEngine(model)));
    }
    if (model.deletable) {
      actions.appendChild(button("Supprimer", "tiny ghost danger", async () => {
        try { await invoke("bonsai_delete_engine"); toast(tt("Moteur Bonsai supprimé.")); }
        catch (error) { toast(tt("Suppression impossible : {error}", { error: String(error?.message || error) }), true); }
        await refreshModels();
      }));
    }
  }
  grid.appendChild(el);
}

async function downloadEngine(model) {
  if (state.hardware?.free_disk && model.sizeBytes
      && state.hardware.free_disk < Number(model.sizeBytes) * 3) {
    toast(tt("Place insuffisante : {need} nécessaires, {free} disponibles.", {
      need: formatBytes(model.sizeBytes * 3), free: formatBytes(state.hardware.free_disk),
    }), true);
    return;
  }
  busy.add(model.id);
  progress.set(model.id, 0);
  render();
  toast(tt("Téléchargement du moteur Bonsai…"));
  try {
    await invoke("bonsai_download_engine");
    toast(tt("Le moteur Bonsai est installé."));
  } catch (error) {
    const message = String(error?.message || error);
    toast(message.includes("download-cancelled")
      ? tt("Téléchargement interrompu — vous pourrez le reprendre.")
      : tt("Téléchargement impossible : {error}", { error: message }), true);
  } finally {
    busy.delete(model.id);
    progress.delete(model.id);
    await refreshModels();
  }
}

function renderImageModelCard(model, grid) {
  if (model.engine) return renderEngineCard(model, grid);
  const percent = progress.get(model.id);
  const el = card({
    id: model.id,
    title: model.label,
    badge: model.active ? tt("Actif") : model.installed ? tt("Installé") : "",
    tags: model.tags,
    meta: [model.family, model.quantization, model.sizeLabel, state.bonsai?.kind === "mlx" ? "MLX" : "CUDA"].filter(Boolean).join(" · "),
    description: bonsaiDescription(model, appLang()),
    extra: percent === undefined ? "" : `<div class="bar"><i style="width:${percent}%"></i></div>`,
  });
  const actions = el.querySelector(".card-actions");
  if (busy.has(model.id) || model.downloading) {
    actions.appendChild(button("Annuler", "tiny ghost", async (b) => {
      b.disabled = true;
      await invoke("bonsai_cancel_download", { id: model.bonsaiId }).catch(() => {});
    }));
  } else if (model.installed) {
    if (!model.active && state.bonsai?.engine_bundled) {
      actions.appendChild(button("Utiliser ce modèle", "primary tiny", () => useImageModel(model)));
    }
    actions.appendChild(button("Supprimer", "tiny ghost danger", () => deleteImageModel(model)));
  } else {
    actions.appendChild(button("Télécharger", "primary tiny", () => downloadImageModel(model)));
  }
  const link = document.createElement("a");
  link.className = "link";
  link.href = `https://huggingface.co/${model.repo}`;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = tt("Fiche du modèle");
  actions.appendChild(bindExternalLink(link));
  grid.appendChild(el);
}

async function downloadImageModel(model) {
  if (state.hardware?.free_disk && model.sizeBytes
      && state.hardware.free_disk < Number(model.sizeBytes) + 500 * 1024 * 1024) {
    toast(tt("Place insuffisante : {need} nécessaires, {free} disponibles.", {
      need: formatBytes(model.sizeBytes), free: formatBytes(state.hardware.free_disk),
    }), true);
    return;
  }
  busy.add(model.id);
  progress.set(model.id, 0);
  render();
  toast(tt("Téléchargement de {name}…", { name: model.label }));
  try {
    await invoke("bonsai_download_model", { id: model.bonsaiId });
    if (!localStorage.getItem("imageBonsaiModel")) localStorage.setItem("imageBonsaiModel", model.variant);
    toast(tt("{name} est installé.", { name: model.label }));
  } catch (error) {
    const message = String(error?.message || error);
    toast(message.includes("download-cancelled")
      ? tt("Téléchargement interrompu — vous pourrez le reprendre.")
      : tt("Téléchargement impossible : {error}", { error: message }), true);
  } finally {
    busy.delete(model.id);
    progress.delete(model.id);
    await refreshModels();
  }
}

async function deleteImageModel(model) {
  try {
    await invoke("bonsai_delete_model", { id: model.bonsaiId });
    toast(tt("{name} supprimé.", { name: model.label }));
  } catch (error) {
    toast(tt("Suppression impossible : {error}", { error: String(error?.message || error) }), true);
  }
  await refreshModels();
}

// « Utiliser » = choisir cette variante comme modèle Bonsai des réglages, puis
// démarrer le moteur dessus (le serveur ne charge qu'un transformeur à la fois).
async function useImageModel(model) {
  toast(tt("Démarrage de {name}…", { name: model.label }));
  try {
    localStorage.setItem("imageBonsaiModel", model.variant);
    localStorage.setItem("imageProvider", "bonsai");
    await invoke("bonsai_start", { variant: model.variant });
    toast(tt("{name} est le modèle d'image actif de Bonsai.", { name: model.label }));
  } catch (error) {
    toast(tt("Démarrage impossible : {error}", { error: String(error?.message || error) }), true);
  }
  await refreshModels();
}

function renderModels() {
  const grid = els.gridModels;
  const category = activeCategory();
  const lang = appLang();
  const list = itemsFor("models").filter((model) => {
    if (!category.test(model)) return false;
    return matchesSearch(model.label, model.family, model.quantization, (model.tags || []).join(" "));
  });
  grid.innerHTML = "";
  if (!list.length) return emptyState(grid, "Aucun modèle ne correspond à ce filtre.");

  // Sections par famille, comme la bibliothèque Ollama (Discussion,
  // Raisonnement, Vision, Code, Décision, Embedding, Image).
  const groups = new Map();
  for (const model of list) {
    const g = modelGroup(model);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(model);
  }
  const ordered = [...groups].sort((a, b) => modelGroupOrder(a[0]) - modelGroupOrder(b[0]))
    .flatMap(([g, models]) => [{ groupHead: g, count: models.length }, ...models]);

  for (const model of ordered) {
    if (model.groupHead) {
      const head = document.createElement("h3");
      head.className = "grid-group";
      head.innerHTML = `${esc(modelGroupLabel(model.groupHead, lang))}<span class="n">${model.count}</span>`;
      grid.appendChild(head);
      continue;
    }
    if (model.kind === "image") { renderImageModelCard(model, grid); continue; }
    if (model.kind === "ollama") { renderOllamaModelCard(model, grid); continue; }
    const installed = isInstalled(model);
    const partial = state.partials.get(model.filename) || 0;
    const percent = progress.get(model.id);
    const el = card({
      id: model.id,
      title: model.label,
      badge: installed ? "Installé" : "",
      // Vision : le tag du catalogue, ou la simple présence d'un projecteur.
      tags: [...new Set([
        ...(model.tags || []),
        ...(model.mmprojFilename ? ["vision"] : []),
        ...(/thinking/i.test(model.label) ? ["think"] : []),
      ])],
      meta: [model.family, model.quantization, model.sizeLabel, tt("RAM conseillée : {ram}", { ram: model.ramHint })]
        .filter(Boolean).join(" · "),
      description: llamaModelDescription(model, lang),
      extra: percent === undefined ? "" : `<div class="bar"><i style="width:${percent}%"></i></div>`,
    });
    const actions = el.querySelector(".card-actions");
    if (busy.has(model.id)) {
      actions.appendChild(button("Annuler", "tiny ghost", async (b) => {
        b.disabled = true;
        await invoke("llama_cancel_download", { id: model.id }).catch(() => {});
      }));
    } else if (installed) {
      actions.appendChild(button("Utiliser ce modèle", "primary tiny", () => useModel(model)));
      actions.appendChild(button("Supprimer", "tiny ghost danger", () => deleteModel(model)));
    } else {
      const label = partial > 0 && model.sizeBytes
        ? tt("Reprendre ({pct} %)", { pct: Math.min(99, Math.floor((partial / model.sizeBytes) * 100)) })
        : "Télécharger";
      actions.appendChild(button(label, "primary tiny", () => downloadModel(model)));
    }
    const url = llamaModelCardUrl(model);
    if (url) {
      const link = document.createElement("a");
      link.className = "link";
      link.href = url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = tt("Fiche du modèle");
      // `target="_blank"` est inerte dans la WebView : le clic passe par le
      // navigateur du système (cf. lib/open-external.js).
      actions.appendChild(bindExternalLink(link));
    }
    grid.appendChild(el);
  }
}

function renderOllamaModelCard(model, grid) {
  const installed = isInstalled(model);
  const percent = progress.get(model.id);
  const el = card({
    id: model.id,
    title: model.label,
    badge: installed ? tt("Installé") : "",
    tags: ["ollama", ...(model.tags || [])],
    meta: [model.name, model.sizeLabel, tt("RAM conseillée : {ram}", { ram: model.ramHint })].join(" · "),
    description: ollamaModelDescription(model, appLang()),
    extra: percent === undefined ? "" : `<div class="bar"><i style="width:${percent}%"></i></div>`,
  });
  const actions = el.querySelector(".card-actions");
  if (state.ollama === null) {
    actions.innerHTML = `<span class="card-meta">${esc(tt("Ollama n'est pas joignable."))}</span>`;
  } else if (!installed) {
    const b = button("Télécharger", "primary tiny", () => pullOllama(model));
    b.disabled = busy.has(model.id);
    actions.appendChild(b);
  }
  const link = document.createElement("a");
  link.className = "link";
  link.href = `https://ollama.com/library/${model.name.split(":")[0]}`;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = tt("Fiche du modèle");
  actions.appendChild(bindExternalLink(link));
  grid.appendChild(el);
}

async function pullOllama(model) {
  busy.add(model.id);
  progress.set(model.id, 0);
  render();
  toast(tt("Téléchargement de {name}…", { name: model.label }));
  try {
    await invoke("ollama_pull", { url: ollamaUrl(), model: model.name });
    toast(tt("{name} est installé.", { name: model.label }));
  } catch (error) {
    toast(tt("Téléchargement impossible : {error}", { error: String(error?.message || error) }), true);
  } finally {
    busy.delete(model.id);
    progress.delete(model.id);
    await refreshModels();
  }
}

async function downloadModel(model) {
  if (state.hardware?.free_disk && model.sizeBytes
      && state.hardware.free_disk < Number(model.sizeBytes) + 500 * 1024 * 1024) {
    toast(tt("Place insuffisante : {need} nécessaires, {free} disponibles.", {
      need: formatBytes(model.sizeBytes), free: formatBytes(state.hardware.free_disk),
    }), true);
    return;
  }
  busy.add(model.id);
  progress.set(model.id, 0);
  render();
  toast(tt("Téléchargement de {name}…", { name: model.label }));
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
    toast(tt("{name} est installé.", { name: model.label }));
  } catch (error) {
    const message = String(error?.message || error);
    toast(message.includes("download-cancelled")
      ? tt("Téléchargement interrompu — vous pourrez le reprendre.")
      : tt("Téléchargement impossible : {error}", { error: message }), true);
  } finally {
    busy.delete(model.id);
    progress.delete(model.id);
    await refreshModels();
  }
}

async function deleteModel(model) {
  try {
    await invoke("llama_delete_model", { filename: model.filename });
    toast(tt("{name} supprimé.", { name: model.label }));
  } catch (error) {
    toast(tt("Suppression impossible : {error}", { error: String(error?.message || error) }), true);
  }
  await refreshModels();
}

// « Utiliser » = ce que fait la barre : mémoriser le modèle du backend llama.cpp
// puis démarrer le serveur dessus. Le reste de Lumen lit la même clé.
async function useModel(model) {
  if (model.tags?.includes("ocr")) {
    localStorage.setItem("studiesOcrModel", model.id);
    toast("OCR choisi pour Études : " + model.label); return;
  }
  if (model.tags?.includes("decision")) {
    const decision = DECISION_MODELS.find(m => m.filename === model.filename);
    if (decision) { try { await setDecisionModel(decision.id, invoke); toast("Modèle de décision : " + model.label); } catch (error) { toast(String(error), true); } }
    return;
  }
  toast(tt("Démarrage de {name}…", { name: model.label }));
  try {
    rememberModelFor("llama", model.filename);
    await invoke("llama_start", { filename: model.filename });
    toast(tt("{name} est le modèle actif de llama.cpp.", { name: model.label }));
  } catch (error) {
    toast(tt("Démarrage impossible : {error}", { error: String(error?.message || error) }), true);
  }
}

// Modèles servis par Ollama seulement (aujourd'hui : les modèles de décision
// Tev1 et Clef Flash — Ollama ≥ 0.35). Les modèles de discussion Ollama ont
// déjà leur GGUF dans le rayon, on ne les montre pas en double.
const OLLAMA_ONLY = OLLAMA_MODEL_CATALOG.filter((m) => m.tags?.includes("decision"));
const ollamaUrl = () => localStorage.getItem("ollamaUrl") || "http://127.0.0.1:11434";

function ollamaEntries() {
  return OLLAMA_ONLY.map((m) => ({
    ...m, id: `ollama:${m.name}`, kind: "ollama", ollamaName: m.name,
    family: "Ollama", quantization: m.name,
  }));
}

async function refreshModels() {
  invoke("ollama_list_models", { url: ollamaUrl() })
    .then((names) => { state.ollama = Array.isArray(names) ? names : []; })
    .catch(() => { state.ollama = null; })
    .finally(() => { if (section === "models") { renderNav(); renderModels(); } });
  const [models, partials, bonsai, bonsaiRemote, ocr] = await Promise.all([
    invoke("llama_catalog_models").catch(() => []),
    invoke("llama_partial_downloads").catch(() => []),
    invoke("bonsai_status").catch(() => null),
    invoke("bonsai_engine_remote").catch(() => null),
    invoke("ocr_models").catch(() => []),
  ]);
  state.models = Array.isArray(models) ? models : [];
  state.ocr = ocr;
  state.bonsai = bonsai;
  state.bonsaiRemote = bonsaiRemote;
  state.partials = new Map((Array.isArray(partials) ? partials : []).map(([name, size]) => [name, size]));
  renderFoot();
  renderNav();
  if (section === "models") renderModels();
}

// ===== Voix =================================================================
function renderVoices() {
  const grid = els.gridVoices;
  const category = activeCategory();
  const list = state.voices.filter((voice) => {
    if (!category.test(voice)) return false;
    return matchesSearch(voice.label, voice.id, voice.lang);
  });
  grid.innerHTML = "";
  if (!list.length) return emptyState(grid, "Aucune voix ne correspond à ce filtre.");

  for (const voice of list) {
    const el = card({
      id: voice.id,
      title: voice.label,
      badge: voice.installed ? "Installée" : "",
      tags: [voice.engine, voice.lang, voice.quality].filter(Boolean),
      meta: [voice.engine, voice.lang, voice.quality, voice.size_mb ? `${voice.size_mb} Mo` : ""]
        .filter(Boolean).join(" · "),
      description: voice.license ? tt("Licence : {license}", { license: voice.license }) : "",
    });
    const actions = el.querySelector(".card-actions");
    if (busy.has(`voice:${voice.id}`)) {
      actions.innerHTML = `<span class="dl-state">${esc(tt("Téléchargement…"))}</span>`;
    } else if (voice.installed) {
      actions.appendChild(button("Définir comme voix active", "primary tiny", () => setVoice(voice)));
      actions.appendChild(button("Supprimer", "tiny ghost danger", () => deleteVoice(voice)));
    } else {
      actions.appendChild(button("Télécharger", "primary tiny", () => downloadVoice(voice)));
    }
    grid.appendChild(el);
  }
}

async function downloadVoice(voice) {
  busy.add(`voice:${voice.id}`);
  render();
  toast(tt("Téléchargement de {name}…", { name: voice.label }));
  try {
    await invoke("tts_download_voice", { id: voice.id });
    voice.installed = true;
    toast(tt("{name} est installée.", { name: voice.label }));
  } catch (error) {
    toast(tt("Téléchargement impossible : {error}", { error: String(error?.message || error) }), true);
  } finally {
    busy.delete(`voice:${voice.id}`);
    renderNav();
    render();
  }
}

async function deleteVoice(voice) {
  try {
    await invoke("tts_delete_voice", { id: voice.id });
    voice.installed = false;
    toast(tt("{name} supprimée.", { name: voice.label }));
  } catch (error) {
    toast(tt("Suppression impossible : {error}", { error: String(error?.message || error) }), true);
  }
  renderNav();
  render();
}

async function setVoice(voice) {
  try {
    await invoke("tts_set_voice", { voice: voice.id });
    toast(tt("Voix active : {name}", { name: voice.label }));
  } catch (error) {
    toast(tt("Impossible de définir la voix : {error}", { error: String(error?.message || error) }), true);
  }
}

async function refreshVoices() {
  const catalog = await invoke("tts_catalog").catch(() => []);
  state.voices = Array.isArray(catalog) ? catalog : [];
  renderFoot();
  renderNav();
  if (section === "voices") renderVoices();
}

// ===== Workflows Fluxo ======================================================
function remoteEntries(kind) {
  return [...state.official[kind], ...state.custom[kind]];
}

function workflowEntries() {
  return [...WORKFLOW_PACKS, ...remoteEntries("workflows")];
}

function renderWorkflows() {
  const grid = els.gridWorkflows;
  const category = activeCategory();
  const lang = appLang();
  const list = workflowEntries().filter((pack) => {
    if (!category.test(pack)) return false;
    return matchesSearch(pack.title, pack.description, pack.category);
  });
  grid.innerHTML = "";
  if (!list.length) return emptyState(grid, "Aucun workflow ne correspond à ce filtre.");

  for (const pack of list) {
    const installed = state.workflows.includes(pack.workflow.name);
    const steps = (pack.workflow.steps || []).length;
    const trigger = pack.workflow.trigger?.type === "cron" ? tt("déclenché par horaire") : tt("manuel");
    const needs = (pack.needs || []).length
      ? `<div class="needs">${esc(tt("Nécessite :"))} ${esc(pack.needs.join(" · "))}</div>` : "";
    const setup = pack.setup ? `<div class="needs">${esc(pack.setup)}</div>` : "";
    const el = card({
      id: pack.id,
      title: pack.title,
      badge: installed ? "Installé" : (pack.sourceLabel || ""),
      // Ce que le workflow est, lu dans le workflow lui-même : appelable par un
      // agent, et/ou déclenché tout seul.
      tags: [
        ...(pack.workflow.available_as_tool ? ["Outil IA"] : []),
        ...(pack.workflow.trigger?.type === "cron" ? ["Planifié"] : []),
      ],
      meta: [pack.category, tt("{count} bloc(s)", { count: steps }), trigger].filter(Boolean).join(" · "),
      description: lang === "en" && pack.descriptionEn ? pack.descriptionEn : pack.description,
      extra: needs + setup,
    });
    const actions = el.querySelector(".card-actions");
    if (installed) {
      actions.appendChild(button("Réinstaller", "tiny", () => installWorkflow(pack)));
      actions.appendChild(button("Supprimer", "tiny ghost danger", () => removeWorkflow(pack)));
    } else {
      actions.appendChild(button("Installer", "primary tiny", () => installWorkflow(pack)));
    }
    grid.appendChild(el);
  }
}

async function installWorkflow(pack) {
  try {
    await invoke("save_workflow", { workflow: pack.workflow });
    await invoke("reload_triggers").catch(() => {});
    toast(tt("« {name} » installé — retrouvez-le dans Fluxo.", { name: pack.workflow.name }));
  } catch (error) {
    toast(tt("Installation impossible : {error}", { error: String(error?.message || error) }), true);
  }
  await refreshWorkflows();
}

async function removeWorkflow(pack) {
  try {
    await invoke("delete_workflow", { name: pack.workflow.name });
    await invoke("reload_triggers").catch(() => {});
    toast(tt("« {name} » supprimé.", { name: pack.workflow.name }));
  } catch (error) {
    toast(tt("Suppression impossible : {error}", { error: String(error?.message || error) }), true);
  }
  await refreshWorkflows();
}

async function refreshWorkflows() {
  const metas = await invoke("list_workflows").catch(() => []);
  state.workflows = (Array.isArray(metas) ? metas : []).map((meta) => meta.name);
  renderNav();
  if (section === "workflows") renderWorkflows();
}

// ===== Avatars GLB ==========================================================
function renderAvatars() {
  const grid = els.gridAvatars;
  els.avatarCurrent.textContent = state.avatar
    ? tt("Avatar installé : {name} ({size}) · animations : {clips}", {
        name: state.avatar.name,
        size: formatBytes(state.avatar.size),
        clips: (state.avatar.animations || []).join(", "),
      })
    : tt("Aucun avatar personnalisé installé — Lumen affiche son orbe.");
  grid.innerHTML = "";
  const avatars = remoteEntries("avatars");
  if (!avatars.length) {
    return emptyState(grid, "Aucun avatar proposé par une source distante. Installez le vôtre par URL ou depuis un fichier.");
  }
  for (const avatar of avatars) {
    const el = card({
      id: avatar.id,
      title: avatar.title,
      badge: avatar.sourceLabel || "",
      meta: [avatar.author, avatar.sizeLabel].filter(Boolean).join(" · "),
      description: avatar.description,
    });
    const actions = el.querySelector(".card-actions");
    if (busy.has(`avatar:${avatar.id}`)) {
      actions.innerHTML = `<span class="dl-state">${esc(tt("Téléchargement…"))}</span>`;
    } else {
      actions.appendChild(button("Installer", "primary tiny", () => installAvatarFromUrl(avatar.url, avatar.id)));
    }
    grid.appendChild(el);
  }
}

/** Convertit un ArrayBuffer en Base64 sans dépasser la pile d'appels. */
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function installAvatarFromUrl(url, id = "url") {
  const target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target)) {
    toast("Indiquez une URL http(s) vers un fichier .glb.", true);
    return;
  }
  busy.add(`avatar:${id}`);
  render();
  toast(tt("Téléchargement de l'avatar…"));
  try {
    const response = await fetch(target);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    const name = decodeURIComponent(new URL(target).pathname.split("/").pop() || "avatar.glb");
    await importAvatar(name, toBase64(buffer));
  } catch (error) {
    toast(tt("Installation impossible : {error}", { error: String(error?.message || error) }), true);
  } finally {
    busy.delete(`avatar:${id}`);
    render();
  }
}

async function importAvatar(name, base64) {
  const info = await invoke("avatar_glb_import", { name, data: base64 });
  state.avatar = info;
  toast(tt("Avatar « {name} » installé. Activez-le dans Paramètres → Apparence → Avatar.", {
    name: info?.name || name,
  }));
}

async function refreshAvatar() {
  state.avatar = await invoke("avatar_glb_status").catch(() => null);
  if (section === "avatars") renderAvatars();
}

// ===== Sources distantes ====================================================
/**
 * Charge un manifeste et le range dans sa case (officielle ou personnelle).
 * Un échec n'efface jamais l'autre source ni le catalogue embarqué : hors
 * ligne, le Catalogue reste utilisable, il propose simplement moins de choses.
 */
async function fetchManifest(url, origin, label) {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parseManifest(await response.json(), origin, label);
}

const EMPTY_SOURCE = { workflows: [], avatars: [], featured: [] };

async function loadOfficial() {
  try {
    state.official = await fetchManifest(OFFICIAL_MANIFEST_URL, "official", OFFICIAL_LABEL);
  } catch {
    state.official = { ...EMPTY_SOURCE };
  }
  renderSourceState();
}

async function loadCustomSource(url, { silent = false } = {}) {
  const target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target)) {
    if (!silent) toast("Indiquez une URL http(s) vers un manifeste JSON.", true);
    return;
  }
  try {
    state.custom = await fetchManifest(target, "custom", CUSTOM_LABEL);
    localStorage.setItem(SOURCE_KEY, target);
    if (!silent) toast("Source ajoutée au Catalogue.");
  } catch (error) {
    state.custom = { ...EMPTY_SOURCE };
    if (!silent) toast(tt("Source illisible : {error}", { error: String(error?.message || error) }), true);
  }
  renderSourceState();
  renderNav();
  renderHero();
  render();
}

function clearCustomSource() {
  state.custom = { ...EMPTY_SOURCE };
  localStorage.removeItem(SOURCE_KEY);
  els.sourceUrl.value = "";
  renderSourceState();
  renderNav();
  renderHero();
  render();
}

function countLabel(bucket) {
  return tt("{workflows} workflow(s) · {avatars} avatar(s)", {
    workflows: bucket.workflows.length, avatars: bucket.avatars.length,
  });
}

function renderSourceState() {
  const official = state.official.workflows.length + state.official.avatars.length
    ? tt("Liste officielle : {counts}", { counts: countLabel(state.official) })
    : tt("Liste officielle : injoignable ou vide pour l'instant (la liste embarquée reste disponible).");
  const custom = localStorage.getItem(SOURCE_KEY)
    ? tt("Ma source : {counts}", { counts: countLabel(state.custom) })
    : tt("Ma source : aucune.");
  els.sourceState.textContent = `${official}\n${custom}`;
}

// ===== Rendu global =========================================================
function renderFoot() {
  const used = state.models.reduce((total, entry) => total + (entry.size || 0), 0);
  els.sideFoot.textContent = `${tt("{count} modèle(s) sur le disque · {size}", {
    count: state.models.length, size: formatBytes(used),
  })}\n${tt("{count} voix installée(s)", { count: state.voices.filter((voice) => voice.installed).length })}`;
  els.sideFoot.style.whiteSpace = "pre-line";
}

function render() {
  if (section === "apps") renderApps();
  else if (section === "updates") renderUpdates();
  else if (section === "models") renderModels();
  else if (section === "voices") renderVoices();
  else if (section === "workflows") renderWorkflows();
  else if (section === "avatars") renderAvatars();
}

// ===== Câblage ==============================================================
els.search.addEventListener("input", () => {
  // Une recherche porte sur tout le rayon : on lève la catégorie courante,
  // sinon « budget » depuis « Code & Lab » ne trouve rien et on croit à un bug.
  if (section === "apps") { if (els.search.value.trim()) filters.apps = "all"; renderNav(); }
  render();
});
$("hero-prev").addEventListener("click", () => goHero(heroIndex - 1));
$("hero-next").addEventListener("click", () => goHero(heroIndex + 1));
els.hero.addEventListener("mouseenter", () => clearInterval(heroTimer));
els.hero.addEventListener("mouseleave", () => {
  clearInterval(heroTimer);
  if (heroSlides.length > 1) heroTimer = setInterval(() => goHero(heroIndex + 1), 7000);
});
$("btn-avatar-url").addEventListener("click", () => installAvatarFromUrl(els.avatarUrl.value));
$("btn-avatar-file").addEventListener("click", () => els.avatarFile.click());
els.avatarFile.addEventListener("change", async () => {
  const file = els.avatarFile.files?.[0];
  els.avatarFile.value = "";
  if (!file) return;
  try {
    await importAvatar(file.name, toBase64(await file.arrayBuffer()));
  } catch (error) {
    toast(tt("Installation impossible : {error}", { error: String(error?.message || error) }), true);
  }
  render();
});
$("btn-avatar-remove").addEventListener("click", async () => {
  try {
    await invoke("avatar_glb_delete");
    state.avatar = null;
    toast("Avatar personnalisé supprimé.");
  } catch (error) {
    toast(tt("Suppression impossible : {error}", { error: String(error?.message || error) }), true);
  }
  render();
});
$("btn-source-load").addEventListener("click", () => loadCustomSource(els.sourceUrl.value));
$("btn-source-clear").addEventListener("click", clearCustomSource);
$("btn-source-refresh").addEventListener("click", async () => {
  await loadOfficial();
  toast("Liste officielle actualisée.");
  renderNav();
  renderHero();
  render();
});
els.manifestDoc.textContent = MANIFEST_DOC;

// Progression des téléchargements de modèles : le backend émet un évènement par
// tranche de 200 ms, on ne repeint que la grille concernée.
tauri?.event?.listen?.("llama-download-progress", ({ payload }) => {
  if (!payload?.id || !busy.has(payload.id)) return;
  progress.set(payload.id, Number(payload.percent) || 0);
  if (section === "models") renderModels();
});
// Même chose pour les modèles d'image Bonsai (id préfixé « bonsai: » ici). Un
// téléchargement lancé depuis les Réglages est aussi suivi, la grille le
// montre en cours sans qu'on l'ait démarré d'ici.
tauri?.event?.listen?.("bonsai-download-progress", ({ payload }) => {
  if (!payload?.id) return;
  progress.set(`bonsai:${payload.id}`, Number(payload.percent) || 0);
  if (section === "models") renderModels();
});
tauri?.event?.listen?.("ollama-pull-progress", ({ payload }) => {
  const id = `ollama:${payload?.model}`;
  if (!busy.has(id)) return;
  progress.set(id, payload.percent ?? 0);
  const bar = [...els.gridModels.querySelectorAll(".card")].find((c) => c.querySelector(".card-meta")?.textContent.startsWith(payload.model + " "))?.querySelector(".bar i");
  if (bar) bar.style.width = `${payload.percent ?? 0}%`; else if (section === "models") renderModels();
});
tauri?.event?.listen?.("bonsai-download-done", () => { refreshModels(); });

// État du rayon Applications. Déclaré AVANT boot() : selectSection("apps") repeint
// la grille immédiatement, et un `const` lu avant sa ligne fige la page entière.
const appsState = { installed: [], available: [], verified: false, repo: "", offline: false, busy: new Set() };

/**
 * Rayons du bureau, dans son ordre : la fiche d'une app dit la même chose ici
 * que sur l'écran d'accueil. Une catégorie inconnue du manifeste tombe dans
 * « Créer » plutôt que de disparaître.
 */
const APP_CATEGORIES = [
  { id: "create", label: "Création", icon: "sparkles" },
  { id: "organize", label: "Organisation", icon: "calendar" },
  { id: "data", label: "Données", icon: "chart" },
  { id: "search", label: "Recherche", icon: "search" },
  { id: "people", label: "Personnes", icon: "users" },
  { id: "comm", label: "Communication", icon: "messages-square" },
  { id: "audio", label: "Audio", icon: "audio-lines" },
  { id: "lab", label: "Spécialisés", icon: "code" },
  { id: "play", label: "Loisirs", icon: "controller" },
];
// Anciennes catégories (dépôt pas encore republié) → espace le plus proche.
const LEGACY_CATEGORY = { explore: "search", pro: "data" };
/** Libellés des packs facultatifs (champ `pack` du manifeste). */
const PACK_LABELS = { loisirs: "Pack Loisirs", robotique: "Pack Robotique", maison: "Pack Maison connectée", ml: "Pack Apprentissage automatique", dev: "Pack Développement", "audio-creation": "Pack Création audio" };
const categoryOf = (entry) => {
  const id = LEGACY_CATEGORY[entry.category] || entry.category || "create";
  return APP_CATEGORIES.find((c) => c.id === id) || APP_CATEGORIES[0];
};

/** Dépôt + apps installées orphelines, chacune avec sa version installée. */
function appEntries() {
  const byId = new Map(appsState.installed.map((a) => [a.id, a]));
  const seen = new Set();
  const list = [];
  for (const entry of appsState.available) {
    seen.add(entry.id);
    list.push({ ...entry, installedVersion: byId.get(entry.id)?.version || "" });
  }
  // Une app installée que le dépôt ne propose plus doit rester listée : c'est
  // le seul endroit d'où on peut encore la désinstaller.
  for (const app of appsState.installed) {
    if (!seen.has(app.id)) list.push({ ...app, installedVersion: app.version });
  }
  return list;
}

async function boot() {
  // Le rayon des applications s'ouvre en premier, et se charge en premier :
  // c'est ce qu'on vient chercher ici depuis la 0.2.
  selectSection("apps");
  if (!invoke) { setStatus("Backend indisponible (hors application)."); return; }
  await loadApps();
  refreshAppViews();
  // Le bureau peut demander une app précise (raccourci vers une app
  // désinstallée) : on la met en évidence plutôt que d'ouvrir une liste brute.
  const asked = new URLSearchParams(location.search).get("app");
  if (asked) { els.search.value = asked; renderApps(); }
  state.hardware = await invoke("system_resources").catch(() => null);
  await Promise.all([refreshModels(), refreshVoices(), refreshWorkflows(), refreshAvatar()]);
  const saved = localStorage.getItem(SOURCE_KEY);
  if (saved) els.sourceUrl.value = saved;
  renderSourceState();
  // Les deux manifestes sont facultatifs : on ne bloque pas l'affichage dessus.
  Promise.all([
    loadOfficial(),
    saved ? loadCustomSource(saved, { silent: true }) : Promise.resolve(),
  ]).then(() => { renderNav(); renderHero(); render(); });
  toast("Installez ici vos applications, modèles, voix, workflows et avatars.");
  renderNav();
  renderHero();
  render();
}

boot();

// i18n : traduit le DOM statique + le contenu rendu dynamiquement (mode EN).
autoTranslate({ observe: true });

/* ===== Rayon « Applications » ==============================================
 *
 * Depuis la 0.2, Lumen n'embarque plus que son noyau. Muse, Tempo, Prisme,
 * Corpus, Écho, Arcade, le Navigateur, les apps Pro… sont des paquets servis
 * par un dépôt, installés dans le dossier de données, et désinstallables.
 *
 * Ce rayon montre trois choses sans les mélanger : ce qui est installé, ce que
 * le dépôt propose en plus, et — quand c'est le cas — le fait que le dépôt
 * n'est PAS vérifié. Un catalogue qui tairait ce dernier point laisserait
 * croire à une garantie qui n'existe pas.
 */


async function loadApps() {
  try {
    appsState.installed = (await invoke("app_list")) || [];
  } catch { appsState.installed = []; }
  try {
    // On redemande l'index au dépôt à chaque ouverture : le cache ne sert
    // qu'en cas de panne réseau (le backend y retombe seul).
    const index = await invoke("store_index", { refresh: true });
    appsState.available = index.apps || [];
    appsState.verified = !!index.verified;
    appsState.repo = index.repo || "";
    appsState.offline = !!index.offline;
  } catch (error) {
    appsState.available = [];
    appsState.repo = String(error?.message || error);
  }
}

function appCard(entry, installedVersion) {
  const card = document.createElement("article");
  card.className = "card";
  const busy = appsState.busy.has(entry.id);
  const updatable = installedVersion && installedVersion !== entry.version;
  const grad = entry.gradient?.length >= 2 ? entry.gradient : ["#0a84ff", "#5e5ce6"];
  const caps = (entry.capabilities || []).map((c) => esc(capabilityLabel(c))).join(" · ");

  card.innerHTML = `
    <div class="card-head">
      <span class="card-icon" style="background:linear-gradient(135deg,${esc(grad[0])},${esc(grad[1])})">
        ${lumenIcon(entry.icon || "grid")}
      </span>
      <div>
        <div class="card-title">${esc(entry.name)}${entry.pack ? ` <span class="tag">${esc(tt(PACK_LABELS[entry.pack] || entry.pack))}</span>` : ""}</div>
        <div class="card-sub">${esc(tt(categoryOf(entry).label))} · v${esc(entry.version)}${entry.size ? ` · ${(entry.size / 1048576).toFixed(1)} Mo` : ""}${installedVersion ? ` · <span class="installed-dot">${esc(tt("installée"))}</span>` : ""}</div>
      </div>
    </div>
    <p class="card-desc">${esc(entry.description || "")}</p>
    ${caps ? `<p class="card-caps" title="Ce que l'application demandera à l'usage">${caps}</p>` : ""}
    ${entry.prerequisites ? `<p class="card-caps" title="À prévoir avant d'installer">${esc(tt("Prérequis"))} : ${esc(entry.prerequisites)}</p>` : ""}
    <div class="card-actions"></div>`;

  const actions = card.querySelector(".card-actions");
  const button = (label, handler, cls = "") => {
    const b = document.createElement("button");
    b.className = `btn ${cls}`.trim();
    b.textContent = tt(label);
    b.disabled = busy;
    b.addEventListener("click", handler);
    actions.appendChild(b);
    return b;
  };

  if (!installedVersion) {
    button(busy ? "Installation…" : "Installer", () => installApp(entry.id), "primary");
  } else {
    if (updatable) button(busy ? "Mise à jour…" : `Mettre à jour (v${entry.version})`, () => installApp(entry.id), "primary");
    button("Désinstaller", () => uninstallApp(entry), "danger");
  }
  return card;
}

/** Libellé lisible d'une capacité — le même mot que la feuille de consentement. */
function capabilityLabel(cap) {
  const [base, target] = String(cap).split(":");
  if (base === "interop" && target) return tt("Envoi vers {app}", { app: target });
  return {
    ai: "IA", assistant: "Assistant", tools: "Outils des agents", storage: "Stockage",
    files: "Fichiers", tables: "Bases de données", memory: "Mémoire",
    network: "Internet", notifications: "Notifications", clipboard: "Presse-papier",
  }[cap] || cap;
}

async function installApp(id) {
  appsState.busy.add(id);
  refreshAppViews();
  try {
    await invoke("app_install", { id });
    toast(tt("Application installée."));
  } catch (error) {
    toast(String(error?.message || error), true);
  }
  appsState.busy.delete(id);
  await loadApps();
  refreshAppViews();
}

async function uninstallApp(entry) {
  // La désinstallation retire l'app et ses permissions, pas ses données : le
  // dire ici évite qu'on la croie plus destructrice — ou moins — qu'elle n'est.
  // Pas de window.confirm : inopérant dans WKWebView (cf. pièges Tauri), le
  // bouton semblait ne rien faire. La feuille de Lumen, elle, répond toujours.
  const ok = await confirmSheet({
    title: tt("Désinstaller « {name} » ?", { name: entry.name }),
    body: tt("Ses permissions seront oubliées. Ses données restent sur le disque et reviendront si vous la réinstallez."),
    confirm: tt("Désinstaller"),
    cancel: tt("Annuler"),
    danger: true,
  });
  if (!ok) return;
  appsState.busy.add(entry.id);
  refreshAppViews();
  try {
    await invoke("app_uninstall", { id: entry.id });
    toast(tt("Application désinstallée."));
  } catch (error) {
    toast(String(error?.message || error), true);
  }
  appsState.busy.delete(entry.id);
  await loadApps();
  refreshAppViews();
}

/** Applications installées pour lesquelles le dépôt propose une autre version. */
function pendingUpdates() {
  return appEntries().filter((e) => e.installedVersion && appsState.available.some((a) => a.id === e.id) && e.installedVersion !== e.version);
}
const revLabel = (v) => { const m = String(v || "").match(/^(.*)-r(\d+)$/); return m ? `${m[1]} (${tt("révision")} ${m[2]})` : String(v || ""); };

function renderUpdates() {
  const list = $("list-updates");
  if (!list) return;
  const ups = pendingUpdates();
  const note = $("updates-note");
  const installed = appEntries().filter((e) => e.installedVersion).length;
  note.textContent = !appsState.available.length
    ? tt("Dépôt injoignable : impossible de vérifier les mises à jour pour l'instant.")
    : ups.length
      ? tt("{n} application(s) à mettre à jour sur {t} installée(s).", { n: ups.length, t: installed })
      : tt("Toutes vos applications sont à jour ({t} installée(s)).", { t: installed });
  const allBtn = $("btn-updates-all");
  allBtn.hidden = ups.length < 2;
  allBtn.disabled = appsState.busy.size > 0;
  allBtn.textContent = appsState.updatingAll ? tt("Mise à jour… {i}/{n}", { i: appsState.updatingAll.done, n: appsState.updatingAll.total }) : tt("Tout mettre à jour");
  list.innerHTML = "";
  for (const e of ups.sort((a, b) => String(b.updated || "").localeCompare(String(a.updated || "")))) {
    const busy = appsState.busy.has(e.id);
    const grad = e.gradient?.length >= 2 ? e.gradient : ["#0a84ff", "#5e5ce6"];
    const row = document.createElement("article");
    row.className = "upd-row";
    const when = e.updated ? new Date(e.updated).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
    row.innerHTML = `
      <span class="card-icon" style="background:linear-gradient(135deg,${esc(grad[0])},${esc(grad[1])})">${lumenIcon(e.icon || "grid")}</span>
      <div class="upd-body">
        <div class="card-title">${esc(e.name)}</div>
        <div class="card-sub">${esc(revLabel(e.installedVersion))} → <b>${esc(revLabel(e.version))}</b>${when ? ` · ${esc(when)}` : ""}${e.size ? ` · ${(e.size / 1048576).toFixed(1)} Mo` : ""}</div>
        ${e.changes ? `<p class="upd-changes">${esc(e.changes)}</p>` : ""}
      </div>`;
    const b = document.createElement("button");
    b.className = "btn primary";
    b.textContent = tt(busy ? "Mise à jour…" : "Mettre à jour");
    b.disabled = busy;
    b.addEventListener("click", () => installApp(e.id));
    row.appendChild(b);
    list.appendChild(row);
  }
  if (!ups.length && appsState.available.length) list.innerHTML = `<p class="upd-empty">${lumenIcon("check")}<span>${esc(tt("Rien à mettre à jour."))}</span></p>`;
}

async function updateAll() {
  const ups = pendingUpdates();
  if (!ups.length) return;
  appsState.updatingAll = { done: 0, total: ups.length };
  let failed = 0;
  for (const e of ups) {
    appsState.busy.add(e.id);
    renderUpdates();
    try { await invoke("app_install", { id: e.id }); } catch { failed++; }
    appsState.busy.delete(e.id);
    appsState.updatingAll.done++;
  }
  appsState.updatingAll = null;
  await loadApps();
  renderNav(); render();
  toast(failed ? tt("{n} mise(s) à jour en échec.", { n: failed }) : tt("Toutes les applications sont à jour."), !!failed);
}
$("btn-updates-all")?.addEventListener("click", updateAll);
$("btn-updates-check")?.addEventListener("click", async () => {
  const b = $("btn-updates-check");
  b.disabled = true; b.textContent = tt("Vérification…");
  await loadApps();
  b.disabled = false; b.textContent = tt("Vérifier");
  renderNav(); render();
});

/** Après un changement d'installation : grille, mises à jour et compteur du menu. */
function refreshAppViews() { renderNav(); renderApps(); renderUpdates(); }

function renderApps() {
  const grid = $("grid-apps");
  const note = $("apps-repo-note");
  if (!grid) return;

  note.textContent = appsState.available.length
    ? (appsState.verified
        ? tt("Dépôt signé et vérifié : {repo}", { repo: appsState.repo })
        : tt("Dépôt non signé — les paquets sont vérifiés par empreinte, mais l'index lui-même ne l'est pas : {repo}", { repo: appsState.repo }))
    : tt("Dépôt injoignable. Les applications déjà installées restent utilisables. ({repo})", { repo: appsState.repo });
  if (appsState.offline) note.textContent += tt(" — liste hors ligne, en cache.");

  const query = (els.search.value || "").trim().toLowerCase();
  const category = activeCategory();
  const entries = appEntries().filter((e) => category.test(e))
    .filter((e) => !query || `${e.name} ${e.description} ${categoryOf(e).label}`.toLowerCase().includes(query));

  // Vue « Tout » : les fiches sont regroupées par rayon, avec un en-tête par
  // groupe — on parcourt le catalogue comme un rayonnage, pas comme une liste.
  const grouped = category.key === "all" && !query;
  const cards = [];
  const groups = grouped
    ? APP_CATEGORIES.map((c) => ({ cat: c, items: entries.filter((e) => categoryOf(e).id === c.id) })).filter((g) => g.items.length)
    : [{ cat: null, items: entries }];
  for (const g of groups) {
    if (g.cat) {
      const head = document.createElement("h3");
      head.className = "grid-group";
      head.innerHTML = `<span class="ic">${lumenIcon(g.cat.icon)}</span>${esc(tt(g.cat.label))}<span class="n">${g.items.length}</span>`;
      cards.push(head);
    }
    for (const e of g.items.sort((a, b) => a.name.localeCompare(b.name, "fr"))) cards.push(appCard(e, e.installedVersion));
  }

  grid.innerHTML = "";
  if (!cards.length) {
    grid.innerHTML = `<p class="note">${esc(tt("Aucune application à afficher."))}</p>`;
    return;
  }
  for (const card of cards) grid.appendChild(card);
}
