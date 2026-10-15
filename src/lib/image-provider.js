// Configuration du MOTEUR D'IMAGE partagée par toutes les surfaces de Lumen
// (Studio d'images, Moodboard, Canevas créatif, éditeur créatif, explorateur
// de sandbox, blocs Fluxo). Chacune dupliquait auparavant son propre
// `imageGenerationConfig()`, ce qui a rendu l'ajout d'un moteur pénible.
//
// Quatre moteurs, tous derrière les mêmes commandes Rust `bonsai_generate_*` :
//   - « bonsai » : moteur PrismML Bonsai Image 4B EMBARQUÉ (runtime Python par
//     plateforme, modèles ternary / binary téléchargés depuis Hugging Face) ;
//   - « ollama » : modèle d'image servi par Ollama en local, via son endpoint
//     compatible OpenAI `/v1/images/generations` — aucune clé requise ;
//   - « openai » : cloud (GPT Image, DALL·E), clé stockée côté backend ;
//   - « playground » : Image Playground d'Apple Intelligence (macOS 27). Sans
//     API programmatique depuis macOS 27, la feuille système s'ouvre avec le
//     prompt et l'utilisateur valide — le « modèle » est le STYLE. Option
//     masquée tant que `imageplayground_status` ne la dit pas disponible.
//
// Chaque moteur a SES modèles et SES résolutions : une taille valable pour
// Bonsai (512×512) est refusée par DALL·E 3, et l'inverse est vrai aussi. Les
// interfaces peuplent donc leurs sélecteurs depuis `imageModelsFor()` et
// `imageSizesFor()` au lieu de proposer une liste figée.

export const IMAGE_PROVIDERS = ["bonsai", "ollama", "openai", "playground"];
export const DEFAULT_OLLAMA_IMAGE_MODEL = "flux";
export const DEFAULT_OPENAI_IMAGE_MODEL = "gpt-image-1";
export const DEFAULT_BONSAI_MODEL = "ternary";
export const DEFAULT_PLAYGROUND_STYLE = "any";
export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

export const IMAGE_ENGINES = [
  { id: "bonsai", label: "Bonsai local" },
  { id: "ollama", label: "Ollama local" },
  { id: "openai", label: "GPT (OpenAI)" },
  { id: "playground", label: "Image Playground (Apple)" },
];

// Les deux quantifications du pack Bonsai. Le nom réellement envoyé au backend
// (`bonsai-ternary-mlx`…) est reconstruit par `bonsaiBackendId()`, car le
// suffixe dépend de la variante installée sur la machine.
export const BONSAI_MODELS = [
  { id: "ternary", label: "Ternary · qualité" },
  { id: "binary", label: "Binary · rapide (1-bit)" },
];

// Catalogue des modèles d'image distribués par Ollama. Il ne sert qu'à
// SUGGÉRER : seuls les modèles réellement installés (api/tags) fonctionnent,
// et un modèle absent de cette liste reste utilisable en le saisissant.
export const OLLAMA_IMAGE_MODELS = [
  { id: "flux", label: "FLUX.1 schnell · rapide" },
  { id: "flux-dev", label: "FLUX.1 dev · qualité" },
  { id: "sdxl-turbo", label: "SDXL Turbo · très rapide" },
  { id: "qwen-image", label: "Qwen-Image" },
];

// Styles d'Image Playground. « any » (macOS 27) laisse Apple choisir, photo
// réaliste comprise ; les trois autres existent depuis macOS 15.4.
export const PLAYGROUND_STYLES = [
  { id: "any", label: "Automatique · tous styles" },
  { id: "illustration", label: "Illustration" },
  { id: "animation", label: "Animation" },
  { id: "sketch", label: "Croquis" },
];

export const OPENAI_IMAGE_MODELS = [
  { id: "gpt-image-1", label: "GPT Image 1" },
  { id: "dall-e-3", label: "DALL·E 3" },
  { id: "dall-e-2", label: "DALL·E 2" },
];

// Un modèle Ollama sait-il générer des images ? `api/tags` ne le dit pas : on
// se rabat sur les familles connues, ce qui évite de proposer un modèle de
// texte dans le sélecteur d'images.
const IMAGE_MODEL_RE = /(flux|sdxl|sd3|sd-?turbo|stable[-_]?diffusion|qwen-image|janus|image|diffusion)/i;
export function isImageModelName(name) {
  return IMAGE_MODEL_RE.test(String(name || ""));
}

// ---------------------------------------------------------------------------
//  Modèles
// ---------------------------------------------------------------------------
/// Modèles proposés pour un moteur. `installed` = noms renvoyés par Ollama
/// (`ollama_list_models`) ; ils passent devant le catalogue, et les entrées du
/// catalogue absentes de la machine sont marquées `missing`.
export function imageModelsFor(provider, installed = []) {
  if (provider === "bonsai") return BONSAI_MODELS.map((m) => ({ ...m }));
  if (provider === "openai") return OPENAI_IMAGE_MODELS.map((m) => ({ ...m }));
  if (provider === "playground") return PLAYGROUND_STYLES.map((m) => ({ ...m }));
  const names = (installed || []).map(String);
  const image = names.filter(isImageModelName);
  const out = image.map((id) => ({ id, label: id }));
  for (const m of OLLAMA_IMAGE_MODELS) {
    // Un `ollama pull flux` installe « flux:latest » : on compare sur la base
    // du nom, sinon le catalogue doublonnerait ce qui est déjà là.
    if (image.some((n) => n === m.id || n.startsWith(`${m.id}:`))) continue;
    out.push({ ...m, missing: true });
  }
  return out;
}

export function ollamaImageModel() {
  return localStorage.getItem("imageOllamaModel") || DEFAULT_OLLAMA_IMAGE_MODEL;
}

export function openaiImageModel() {
  return localStorage.getItem("imageOpenaiModel") || DEFAULT_OPENAI_IMAGE_MODEL;
}

export function bonsaiModel() {
  return localStorage.getItem("imageBonsaiModel") === "binary" ? "binary" : DEFAULT_BONSAI_MODEL;
}

export function playgroundStyle() {
  const v = localStorage.getItem("imagePlaygroundStyle") || DEFAULT_PLAYGROUND_STYLE;
  return PLAYGROUND_STYLES.some((s) => s.id === v) ? v : DEFAULT_PLAYGROUND_STYLE;
}

/// Clé localStorage du modèle d'un moteur (chaque moteur garde le sien).
export function imageModelKey(provider = imageProvider()) {
  return provider === "bonsai" ? "imageBonsaiModel"
    : provider === "ollama" ? "imageOllamaModel"
    : provider === "playground" ? "imagePlaygroundStyle"
    : "imageOpenaiModel";
}

/// Modèle courant du moteur demandé.
export function imageModel(provider = imageProvider()) {
  if (provider === "bonsai") return bonsaiModel();
  if (provider === "ollama") return ollamaImageModel();
  if (provider === "playground") return playgroundStyle();
  return openaiImageModel();
}

/// Identifiant de backend Bonsai complet. Le suffixe (`mlx`, `gemlite`…) dépend
/// de la variante installée ; il est détecté une fois puis mémorisé.
export function bonsaiBackendId(model = bonsaiModel()) {
  const kind = localStorage.getItem("canvasBonsaiKind") || "";
  return kind ? `bonsai-${model}-${kind}` : `bonsai-${model}`;
}

// ---------------------------------------------------------------------------
//  Résolutions
// ---------------------------------------------------------------------------
const SIZES = {
  bonsai: ["512x512", "768x768", "768x512", "512x768", "1024x1024"],
  ollama: ["512x512", "768x768", "1024x1024", "1024x768", "768x1024"],
  // Image Playground ramène lui-même la demande sur la résolution la plus
  // proche qu'il sait produire (`sizeSpecification = .closest(to:)`).
  playground: ["1024x1024", "1024x768", "768x1024", "1536x1024", "1024x1536"],
  // L'API OpenAI n'accepte QUE ces triplets, par modèle.
  "gpt-image-1": ["1024x1024", "1536x1024", "1024x1536"],
  "dall-e-3": ["1024x1024", "1792x1024", "1024x1792"],
  "dall-e-2": ["256x256", "512x512", "1024x1024"],
};

function sizeLabel(value) {
  const [w, h] = value.split("x").map((n) => parseInt(n, 10));
  const shape = w === h ? "Carré" : w > h ? "Paysage" : "Portrait";
  return `${shape} · ${w}×${h}`;
}

/// Résolutions acceptées par un moteur (et, pour OpenAI, par son modèle).
/// Renvoie `[{ value, label }]`, la première étant le défaut raisonnable.
export function imageSizesFor(provider = imageProvider(), model = imageModel(provider)) {
  const list = provider === "openai"
    ? (SIZES[model] || SIZES["gpt-image-1"])
    : (SIZES[provider] || SIZES.bonsai);
  return list.map((value) => ({ value, label: sizeLabel(value) }));
}

/// Ramène une taille quelconque sur la plus proche autorisée par le moteur —
/// utile quand on change de moteur avec une taille déjà choisie.
export function nearestImageSize(provider, model, value) {
  const sizes = imageSizesFor(provider, model);
  if (sizes.some((s) => s.value === value)) return value;
  const [w, h] = String(value || "").split("x").map((n) => parseInt(n, 10) || 0);
  const ratio = h ? w / h : 1;
  let best = sizes[0].value, bestScore = Infinity;
  for (const s of sizes) {
    const [sw, sh] = s.value.split("x").map(Number);
    const score = Math.abs(sw / sh - ratio) * 1000 + Math.abs(sw * sh - w * h) / 1e5;
    if (score < bestScore) { bestScore = score; best = s.value; }
  }
  return best;
}

// ---------------------------------------------------------------------------
//  Configuration envoyée aux commandes Rust
// ---------------------------------------------------------------------------
export function imageProvider() {
  const v = localStorage.getItem("imageProvider") || "bonsai";
  return IMAGE_PROVIDERS.includes(v) ? v : "bonsai";
}

/// Payload commun (provider / apiBase / apiKey / apiModel / backend) attendu par
/// les commandes `bonsai_generate_*`. `provider` peut être forcé (Canvas, qui
/// choisit son moteur par nœud) ; sinon on prend celui des réglages.
export function imageGenerationConfig(provider = imageProvider()) {
  if (provider === "ollama") {
    return {
      provider: "ollama",
      // Le backend complète le suffixe « /v1 » et force l'IPv4.
      apiBase: localStorage.getItem("ollamaUrl") || DEFAULT_OLLAMA_URL,
      apiKey: "",                     // Ollama local : pas d'authentification
      apiModel: ollamaImageModel(),
      backend: null,
    };
  }
  if (provider === "openai") {
    return {
      provider: "openai",
      apiBase: localStorage.getItem("apiBaseUrl") || "https://api.openai.com/v1",
      apiKey: localStorage.getItem("apiKey") || "",
      apiModel: openaiImageModel(),
      backend: null,
    };
  }
  if (provider === "playground") {
    // Le style voyage dans `apiModel` : côté Rust, c'est le seul champ libre.
    return { provider: "playground", apiBase: "", apiKey: "", apiModel: playgroundStyle(), backend: null };
  }
  return {
    provider: "bonsai",
    apiBase: localStorage.getItem("apiBaseUrl") || "https://api.openai.com/v1",
    apiKey: localStorage.getItem("apiKey") || "",
    apiModel: openaiImageModel(),
    backend: bonsaiBackendId(),
  };
}

/// Libellé du moteur, pour les bandeaux d'état.
export function imageProviderLabel(provider = imageProvider()) {
  if (provider === "ollama") return `Ollama · ${ollamaImageModel()}`;
  if (provider === "openai") return `OpenAI · ${openaiImageModel()}`;
  if (provider === "playground") {
    const style = PLAYGROUND_STYLES.find((s) => s.id === playgroundStyle());
    return `Image Playground · ${style ? style.label : playgroundStyle()}`;
  }
  return `Bonsai · ${bonsaiModel() === "binary" ? "Binary" : "Ternary"}`;
}

// ---------------------------------------------------------------------------
//  Erreurs
// ---------------------------------------------------------------------------
/// Traduit l'erreur brute d'un moteur en phrase actionnable. Les backends
/// répondent dans leur propre langue et leur propre jargon (« model requires
/// 5.3 GiB but only 4.8 GiB are available ») : sans ce filtre, l'utilisateur
/// lit un statut HTTP et ne sait pas quoi faire.
export function imageErrorMessage(err, provider = imageProvider()) {
  const raw = String(err?.message || err || "").trim();
  const moteur = provider === "ollama" ? "Ollama" : provider === "openai" ? "GPT"
    : provider === "playground" ? "Image Playground" : "Bonsai";

  if (/playground-cancelled/.test(raw)) {
    return "Génération annulée : la feuille Image Playground a été refermée sans valider d'image.";
  }
  if (/Moteur Bonsai non embarqué|not bundled/i.test(raw)) {
    return "Le moteur Bonsai n'est pas embarqué dans cette version de Lumen pour cette plateforme.";
  }
  if (/Aucun modèle Bonsai installé|n'est pas installé\./i.test(raw)) {
    return "Aucun modèle Bonsai installé : téléchargez Ternary ou Binary depuis le Catalogue (Modèles → Image) ou les Réglages.";
  }
  if (/API Bonsai non démarrée/i.test(raw)) {
    return "Le moteur Bonsai n'est pas démarré : lancez-le depuis les Réglages (Génération d'images) ou le Studio.";
  }

  // Mémoire insuffisante : de loin la cause la plus fréquente en local, et la
  // seule dont la solution ne saute pas aux yeux.
  const mem = raw.match(/requires\s+([\d.]+\s*[KMGT]i?B).*?only\s+([\d.]+\s*[KMGT]i?B)\s+are available/i);
  if (mem) {
    return `Mémoire insuffisante : le modèle demande ${mem[1]}, il n'en reste que ${mem[2]}. `
      + "Fermez des applications, déchargez le modèle de discussion, ou choisissez un modèle d'image plus léger.";
  }
  if (/not found|no such model|pull the model/i.test(raw)) {
    return provider === "ollama"
      ? `Modèle absent d'${moteur} : récupérez-le avec « ollama pull ${imageModel(provider)} ».`
      : `Modèle introuvable côté ${moteur} : vérifiez son nom dans les Réglages.`;
  }
  if (/connection refused|error sending request|failed to connect|tcp connect/i.test(raw)) {
    return provider === "ollama"
      ? "Ollama ne répond pas : vérifiez qu'il tourne et que son URL est correcte dans les Réglages."
      : `${moteur} injoignable : vérifiez l'URL de l'API dans les Réglages.`;
  }
  if (/401|403|invalid[_ ]api[_ ]key|incorrect api key|clé/i.test(raw)) {
    return "Clé API refusée : vérifiez-la dans les Réglages.";
  }
  if (/timed? ?out|timeout/i.test(raw)) {
    return `${moteur} n'a pas répondu à temps (4 min). Le modèle est peut-être trop lourd pour cette machine.`;
  }
  if (/invalid.*size|size.*not supported|unsupported.*size/i.test(raw)) {
    return `Résolution refusée par ${moteur}. Choisissez-en une dans la liste proposée.`;
  }
  if (/ne génère probablement pas d'images|sans image/i.test(raw)) {
    return `« ${imageModel(provider)} » n'est pas un modèle de génération d'images.`;
  }
  // Erreur HTTP sans détail exploitable : au moins nommer le moteur et le
  // code, plutôt que l'URL interne du backend.
  const http = raw.match(/\b([45]\d\d)\b/);
  if (http && raw.length > 90) {
    return `${moteur} a refusé la demande (HTTP ${http[1]}) sans message détaillé. `
      + "Vérifiez que le modèle choisi sait générer des images.";
  }
  return raw || `Échec de la génération (${moteur}).`;
}

/// Détecte une fois la variante Bonsai installée (`mlx`, `gemlite`,
/// `diffusers`) et la mémorise : sans ce suffixe, `bonsaiBackendId()` produit
/// un identifiant que l'API Bonsai ne connaît pas. Le moteur embarqué annonce
/// son noyau dans `bonsai_status().kind` sans avoir à tourner ; l'API distante
/// (URL personnalisée) reste interrogée via `/backends`.
export async function ensureBonsaiKind(invoke) {
  if (!invoke || localStorage.getItem("canvasBonsaiKind")) return;
  try {
    const st = await invoke("bonsai_status");
    if (st?.kind && !localStorage.getItem("bonsaiUrl")) {
      localStorage.setItem("canvasBonsaiKind", st.kind);
      return;
    }
  } catch {}
  try {
    const res = await invoke("bonsai_backends");
    const ids = [res?.default, ...(res?.available || [])].filter(Boolean);
    const hit = ids.find((id) => /-(mlx|gemlite|diffusers)$/.test(id));
    const kind = hit && hit.match(/-(mlx|gemlite|diffusers)$/)?.[1];
    if (kind) localStorage.setItem("canvasBonsaiKind", kind);
  } catch {}
}

/// Liste des modèles Ollama installés, filtrée aux modèles d'image. Renvoie un
/// tableau vide si le serveur ne répond pas — l'appelant retombe alors sur le
/// catalogue.
export async function listOllamaImageModels(invoke) {
  if (!invoke) return [];
  try {
    const names = await invoke("ollama_list_models", { url: localStorage.getItem("ollamaUrl") || null });
    return Array.isArray(names) ? names : [];
  } catch { return []; }
}

// ---------------------------------------------------------------------------
//  Copie des réglages d'image côté backend (image.json)
// ---------------------------------------------------------------------------
/// Les surfaces sans fenêtre (boucle agentique, Telegram, blocs Fluxo sans
/// backend explicite) n'ont pas accès au localStorage : on leur pousse le
/// moteur par défaut et le modèle de chaque moteur, comme `set_ollama_config`
/// pour le modèle de texte. À appeler après toute modification de ces clés.
export async function pushImageConfig(invoke) {
  if (!invoke) return;
  try {
    await invoke("image_set_config", { config: {
      provider: imageProvider(),
      bonsai_model: bonsaiModel(),
      ollama_model: ollamaImageModel(),
      openai_model: openaiImageModel(),
      playground_style: playgroundStyle(),
      ollama_url: localStorage.getItem("ollamaUrl") || DEFAULT_OLLAMA_URL,
    } });
  } catch (e) { console.warn("[image] réglages non poussés au backend", e); }
}

// ---------------------------------------------------------------------------
//  Disponibilité des moteurs à option masquée
// ---------------------------------------------------------------------------
let playgroundProbe = null;   // { at, state }

/// État d'Image Playground (sonde Rust cachée 60 s, mémoire ici 30 s). Renvoie
/// `{ available, bundled, reason, styles }` ; jamais d'exception.
export async function playgroundBackendState(invoke, force = false) {
  if (!invoke) return { available: false, bundled: false, reason: "no_tauri", styles: [] };
  if (!force && playgroundProbe && Date.now() - playgroundProbe.at < 30_000) return playgroundProbe.state;
  try {
    const st = await invoke("imageplayground_status", { force });
    const state = {
      available: !!st?.available, bundled: !!st?.bundled,
      reason: st?.reason || null, styles: Array.isArray(st?.styles) ? st.styles : [],
    };
    playgroundProbe = { at: Date.now(), state };
    return state;
  } catch {
    return { available: false, bundled: false, reason: "probe_failed", styles: [] };
  }
}

/// Explication courte quand Image Playground n'est pas proposé.
export function playgroundReasonText(reason) {
  switch (reason) {
    case "not_bundled": return "Image Playground n'est pas embarqué dans cette version de Lumen (macOS 27 requis).";
    case "unsupported_platform": return "Image Playground n'existe que sur macOS.";
    case "image_playground_unavailable": return "Image Playground est indisponible : activez Apple Intelligence dans Réglages Système, puis attendez la fin du téléchargement du modèle.";
    default: return "Image Playground n'est pas disponible sur cette machine.";
  }
}

/// Masque ou révèle l'option « Image Playground » d'un sélecteur de moteur,
/// et retombe sur Bonsai si l'option sélectionnée disparaît. Réutilisé par la
/// barre, les Réglages, le Canvas et le Studio.
export async function refreshPlaygroundOption(select, invoke, { onFallback } = {}) {
  if (!select) return null;
  const opt = select.querySelector('option[value="playground"]');
  if (!opt) return null;
  const st = await playgroundBackendState(invoke);
  opt.hidden = !st.available;
  opt.disabled = !st.available;
  if (!st.available && select.value === "playground") {
    select.value = "bonsai";
    if (typeof onFallback === "function") onFallback("bonsai");
  }
  return st;
}
