import { autoTranslate, tt } from "../apps-i18n.js";
// Aventure narrative — logique front. L'IA (llmChat, sortie JSON) écrit chaque
// scène et propose des choix ; l'illustration optionnelle est produite localement
// par le moteur d'image choisi dans les réglages (bonsai_generate_data_url).
//
// Les aventures sont HISTORISÉES sous forme d'ARBRE (sandbox Lumen) : chaque scène
// est un nœud rattaché à son parent. On peut ainsi reprendre une aventure, revenir
// à une étape antérieure et repartir dans une autre direction — les branches déjà
// explorées à cette étape sont proposées comme « variantes ».
import { llmChat } from "../llm.js";
import { imageGenerationConfig } from "../lib/image-provider.js";
import { replyLang } from "../lib/prompt-lang.js";
import { PROMPTS } from "./prompts.js";
// L'import installe l'écoute des demandes d'arrêt vocal venues d'une autre
// fenêtre (double-clic sur l'avatar) : cette page coupe alors sa propre
// Web Speech. cf. lib/voice-stop.js
import "../lib/voice-stop.js";

const tauri = window.__TAURI__ || window.parent?.__TAURI__;
const invoke = tauri?.core?.invoke;
const emitEvent = tauri?.event?.emit;
const $ = (id) => document.getElementById(id);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const WORLDS = [
  { id: "fantasy", n: "Royaume oublié", d: "Magie, ruines et créatures anciennes", seed: "Un royaume de fantasy médiévale, magie et donjons." },
  { id: "scifi", n: "Station Orbitale", d: "Espace lointain, IA et mystères", seed: "Un vaisseau-station spatial à la dérive, science-fiction." },
  { id: "noir", n: "Ville sous la pluie", d: "Polar, néons et secrets", seed: "Une enquête noire dans une métropole pluvieuse des années 80." },
  { id: "survival", n: "Après l'effondrement", d: "Survie en monde dévasté", seed: "Un monde post-apocalyptique où chaque ressource compte." },
];

// Tailles d'illustration proposées dans le menu Réglages.
// Dimensions MULTIPLES DE 64 obligatoires : le générateur (Stable Diffusion /
// bonsai) rejette les tailles non alignées sur 64 (512×341 échouait). Ratio 16:10.
const IMG_SIZES = {
  small: { n: "Petite", w: 512, h: 320, steps: 16 },
  medium: { n: "Moyenne", w: 768, h: 512, steps: 18 },
  large: { n: "Grande", w: 1024, h: 640, steps: 20 },
};
const IMG_SIZES_PORTRAIT = {
  small: { n: "Petite", w: 512, h: 768, steps: 16 },
  medium: { n: "Moyenne", w: 640, h: 960, steps: 18 },
  large: { n: "Grande", w: 768, h: 1152, steps: 20 },
};
const SAVES_KEY = "adventure/saves";
const SIZE_KEY = "adventure/imgSize";
const CARD_MODE_KEY = "adventure/cardMode";
const CARD_THEME_KEY = "adventure/cardTheme";
const CARD_THEMES = new Set(["arcane", "relic", "neon", "forest", "noir"]);
const ADVENTURE_SANDBOX_NAME = "Aventures infinies";
const ADVENTURE_SANDBOX_MB = 1024;
const SANDBOX_ID_KEY = "adventure/sandboxId";
const SANDBOX_INDEX_PATH = "adventures/index.json";

let A = null;            // aventure courante (arbre)
let illustrate = true;
let imageOK = false;
let chosenSeed = "";
let chosenWorldName = "";
let speakOn = localStorage.getItem("adventure/speak") === "1";
let cardMode = localStorage.getItem(CARD_MODE_KEY) === "1";
let cardTheme = CARD_THEMES.has(localStorage.getItem(CARD_THEME_KEY)) ? localStorage.getItem(CARD_THEME_KEY) : "arcane";

// ---------- Synthèse vocale ----------
// Énonce la narration. Déclenchée APRÈS l'illustration (voir renderNode) pour
// que la voix accompagne l'image une fois celle-ci prête.
let voices = [];
let localVoices = [];
let activeLocalVoice = "";
function stripForSpeech(text) {
  return (text || "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}]/gu, "")
    .replace(/[ \t]{2,}/g, " ").trim();
}
async function loadVoices() {
  const all = ("speechSynthesis" in window) ? speechSynthesis.getVoices() : [];
  if (invoke) {
    try {
      const [catalog, active] = await Promise.all([
        invoke("tts_catalog"),
        invoke("tts_active_voice").catch(() => ""),
      ]);
      activeLocalVoice = active || "";
      localVoices = catalog
        .filter((v) => v && v.installed)
        .map((v) => ({ ...v, name: v.label || v.id, lang: v.lang || v.engine || "local" }));
    } catch {
      localVoices = [];
      activeLocalVoice = "";
    }
  }
  // Français en tête, mais on garde TOUTES les voix disponibles (utile sous
  // Windows où les voix SAPI installées peuvent couvrir d'autres langues).
  const isFr = (v) => v.lang && v.lang.toLowerCase().startsWith("fr");
  voices = [...all.filter(isFr), ...all.filter((v) => !isFr(v))];
  populateVoiceSelect();
}
function populateVoiceSelect() {
  const sel = $("menu-voice"); if (!sel) return;
  const cur = localStorage.getItem("adventure/voiceURI") || "";
  sel.innerHTML = `<option value="">${tt("Voix française par défaut")}</option>`;
  const localFr = localVoices.filter((v) => /^fr/i.test(v.lang) || /siwis|tom|fr/i.test(v.id));
  const orderedLocal = [...localFr, ...localVoices.filter((v) => !localFr.includes(v))];
  for (const v of orderedLocal) {
    const o = document.createElement("option");
    o.value = `local:${v.id}`;
    o.textContent = `${v.name} (${v.engine || "local"} · ${v.lang})`;
    sel.appendChild(o);
  }
  for (const v of voices) {
    const o = document.createElement("option");
    o.value = `web:${v.voiceURI}`; o.textContent = `${v.name} (${v.lang})`;
    sel.appendChild(o);
  }
  if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
}
function chosenVoiceValue() {
  // Choix propre à l'aventure, sinon voix globale de Lumen (Paramètres), sinon FR.
  const saved = localStorage.getItem("adventure/voiceURI") || "";
  if (saved) return saved;
  const activeLocal = activeLocalVoice || localStorage.getItem("ttsActiveVoice") || localStorage.getItem("ttsVoice") || "";
  if (activeLocal) return `local:${activeLocal}`;
  const uri = localStorage.getItem("lumenVoiceURI") || "";
  if (uri) return `web:${uri}`;
  const firstLocalFr = localVoices.find((v) => /^fr/i.test(v.lang) || /siwis|tom|fr/i.test(v.id));
  if (firstLocalFr) return `local:${firstLocalFr.id}`;
  const firstWebFr = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith("fr"));
  return firstWebFr ? `web:${firstWebFr.voiceURI}` : "";
}
function chosenWebVoice(value) {
  const uri = String(value || "").replace(/^web:/, "");
  return voices.find((x) => x.voiceURI === uri) || null;
}
function speak(text) {
  if (!speakOn) return;
  const clean = stripForSpeech(text); if (!clean) return;
  stopSpeech();
  const selected = chosenVoiceValue();
  if (selected.startsWith("local:") && invoke) {
    invoke("tts_speak", { text: clean, voice: selected.slice(6) }).catch(() => speakWeb(clean, ""));
    return;
  }
  speakWeb(clean, selected);
}
function speakWeb(clean, selected) {
  if (!("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(clean);
  const v = chosenWebVoice(selected);
  if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = "fr-FR"; }
  speechSynthesis.speak(u);
}
function stopSpeech() {
  try { if ("speechSynthesis" in window) speechSynthesis.cancel(); } catch {}
  try { invoke?.("tts_stop"); } catch {}
}
if ("speechSynthesis" in window) {
  loadVoices();
  speechSynthesis.onvoiceschanged = loadVoices;
} else {
  loadVoices();
}

// ---------- Persistance ----------
// Source durable : sandbox Lumen dédiée. localStorage/IndexedDB restent un cache
// et une compatibilité pour les anciennes aventures.
const IDB_NAME = "adventure-media", IDB_STORE = "images";
let _db = null;
let adventureSandboxId = localStorage.getItem(SANDBOX_ID_KEY) || "";
function idb() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    let r;
    try { r = indexedDB.open(IDB_NAME, 1); } catch (e) { return rej(e); }
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(IDB_STORE)) r.result.createObjectStore(IDB_STORE); };
    r.onsuccess = () => { _db = r.result; res(_db); };
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(key) {
  try {
    const db = await idb();
    return await new Promise((res, rej) => {
      const rq = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(key);
      rq.onsuccess = () => res(rq.result || ""); rq.onerror = () => rej(rq.error);
    });
  } catch { return ""; }
}
async function idbPut(key, val) {
  try {
    const db = await idb();
    await new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(val, key);
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
    });
  } catch {}
}
async function idbDelete(key) {
  try {
    const db = await idb();
    await new Promise((res) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = () => res(); tx.onerror = () => res();
    });
  } catch {}
}

function loadSaves() {
  try { const a = JSON.parse(localStorage.getItem(SAVES_KEY) || "[]"); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
// Copie de l'aventure sans les data URL (les images vivent dans IndexedDB).
function stripImages(ad) {
  const nodes = {}; for (const k in ad.nodes) nodes[k] = { ...ad.nodes[k], imageUrl: "" };
  return { ...ad, nodes };
}
function saveAll(list) {
  try { localStorage.setItem(SAVES_KEY, JSON.stringify(list)); return true; }
  catch { return false; }
}
async function ensureAdventureSandbox() {
  if (!invoke) return "";
  try {
    const boxes = await invoke("sandbox_list");
    let box = boxes.find((s) => s.id === adventureSandboxId)
      || boxes.find((s) => s.name === ADVENTURE_SANDBOX_NAME);
    if (!box) box = await invoke("sandbox_create", { name: ADVENTURE_SANDBOX_NAME, maxMb: ADVENTURE_SANDBOX_MB });
    adventureSandboxId = box.id;
    localStorage.setItem(SANDBOX_ID_KEY, box.id);
    notifySandboxChanged(box.id);
    return box.id;
  } catch { return ""; }
}
function notifySandboxChanged(id) {
  try { window.parent && window.parent.LumenRefreshSandbox && window.parent.LumenRefreshSandbox(id); } catch {}
  try { window.parent && window.parent.dispatchEvent && window.parent.dispatchEvent(new CustomEvent("sandbox-refresh-needed", { detail: { id } })); } catch {}
  try { emitEvent && emitEvent("sandbox-refresh-needed", { id }); } catch {}
}
async function loadSavesFromSandbox() {
  const id = await ensureAdventureSandbox();
  if (!id) return loadSaves();
  try {
    const file = await invoke("sandbox_read_file", { id, path: SANDBOX_INDEX_PATH });
    const list = JSON.parse(file.content || "[]");
    if (Array.isArray(list)) {
      saveAll(list);
      return list;
    }
  } catch {}
  return loadSaves();
}
async function writeSavesToSandbox(list) {
  const id = await ensureAdventureSandbox();
  if (!id) return false;
  try {
    await invoke("sandbox_write_file", { id, path: SANDBOX_INDEX_PATH, content: JSON.stringify(list, null, 2) });
    return true;
  } catch { return false; }
}
function dataUrlToB64(url) {
  const m = String(url || "").match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/i);
  return m ? m[1] : "";
}
async function migrateImageDataUrlToSandbox(n) {
  if (!A || !n || n.imagePath || !n.imageUrl || !invoke) return;
  const b64 = dataUrlToB64(n.imageUrl);
  if (!b64) return;
  const sid = await ensureAdventureSandbox();
  if (!sid) return;
  const path = `adventures/images/${A.id}/${n.id}.png`;
  try {
    await invoke("sandbox_import_file", { id: sid, path, dataB64: b64 });
    n.imagePath = path;
    n.imageSandboxId = sid;
    persist();
  } catch {}
}
function persist() {
  if (!A) return;
  A.updatedAt = Date.now();
  const list = loadSaves();
  const lite = stripImages(A); // jamais d'images dans localStorage
  const i = list.findIndex((x) => x.id === A.id);
  if (i >= 0) list[i] = lite; else list.unshift(lite);
  saveAll(list);
  writeSavesToSandbox(list);
}
function deleteSave(id) {
  const ad = loadSaves().find((x) => x.id === id);
  if (ad) for (const k in ad.nodes) idbDelete(k); // purge les images associées
  const list = loadSaves().filter((x) => x.id !== id);
  saveAll(list);
  writeSavesToSandbox(list);
}

// ---------- Modèle d'arbre ----------
function newAdventure(seed, title) {
  return {
    id: uid(), title, seed, createdAt: Date.now(), updatedAt: Date.now(),
    illustrate, cardMode, cardTheme, imgSize: localStorage.getItem(SIZE_KEY) || "medium",
    strongContext: "",
    rootId: null, currentId: null, nodes: {},
  };
}
function pathTo(id) {
  const p = []; let n = A.nodes[id];
  while (n) { p.unshift(n); n = n.parentId ? A.nodes[n.parentId] : null; }
  return p;
}
const depth = (id) => pathTo(id).length;

// Active/désactive les illustrations en cours de partie. En activant, on (re)teste
// la disponibilité du Studio d'images puis on illustre la scène courante — sinon
// `imageOK`, calculé seulement au démarrage/reprise, resterait faux.
async function setIllustrate(on) {
  illustrate = on;
  if (A) A.illustrate = on;
  $("toggle-illus").style.opacity = on ? "1" : ".45";
  if (A) persist();
  if (on) {
    if (!imageOK) await checkImageOK();
    if (A) await illustrateNode(A.nodes[A.currentId]);
  } else {
    $("illus-fig").hidden = true;
    if ("speechSynthesis" in window) { /* la voix continue, indépendante de l'image */ }
  }
}

// ---------- Setup ----------
function initSetup() {
  const w = $("worlds");
  for (const world of WORLDS) {
    const el = document.createElement("button");
    el.className = "world"; el.dataset.id = world.id;
    el.innerHTML = `<div class="wn">${world.n}</div><div class="wd">${world.d}</div>`;
    el.addEventListener("click", () => {
      document.querySelectorAll(".world").forEach((x) => x.classList.remove("sel"));
      el.classList.add("sel");
      chosenSeed = world.seed; chosenWorldName = world.n;
      $("custom").value = "";
    });
    w.appendChild(el);
  }
  $("custom").addEventListener("input", () => {
    if ($("custom").value.trim()) { document.querySelectorAll(".world").forEach((x) => x.classList.remove("sel")); chosenSeed = ""; }
  });
  $("illus").addEventListener("change", (e) => { illustrate = e.target.checked; });
  $("start").addEventListener("click", begin);
  $("restart").addEventListener("click", () => location.reload());
  $("toggle-illus").addEventListener("click", () => setIllustrate(!illustrate));
  $("free-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("free").value.trim();
    if (v) { $("free").value = ""; act(v); }
  });
  bindMenu();
  bindHistory();
  renderSaves();
}

// ---------- Reprise d'aventures ----------
async function renderSaves() {
  const saves = (await loadSavesFromSandbox()).sort((a, b) => b.updatedAt - a.updatedAt);
  const box = $("saves"), list = $("saves-list");
  if (!saves.length) { box.hidden = true; return; }
  box.hidden = false; list.innerHTML = "";
  for (const ad of saves) {
    const steps = Object.keys(ad.nodes).length;
    const el = document.createElement("div"); el.className = "save";
    el.innerHTML = `<button class="save-main"><b></b><small></small></button><button class="save-del" title="Supprimer">🗑</button>`;
    el.querySelector("b").textContent = ad.title || "Aventure";
    el.querySelector("small").textContent = `${steps} étape${steps > 1 ? "s" : ""} · ${new Date(ad.updatedAt).toLocaleDateString()}`;
    el.querySelector(".save-main").addEventListener("click", () => resume(ad.id));
    el.querySelector(".save-del").addEventListener("click", () => { deleteSave(ad.id); renderSaves(); });
    list.appendChild(el);
  }
}
async function resume(id) {
  const ad = (await loadSavesFromSandbox()).find((x) => x.id === id);
  if (!ad || !ad.currentId) return;
  A = ad; illustrate = !!ad.illustrate;
  cardMode = !!ad.cardMode;
  cardTheme = CARD_THEMES.has(ad.cardTheme) ? ad.cardTheme : cardTheme;
  showGame();
  await checkImageOK();
  await renderNode(A.nodes[A.currentId]);
}

function showGame() {
  $("setup").hidden = true;
  $("game").hidden = false;
  $("toggle-illus").style.opacity = illustrate ? "1" : ".45";
  applyCardMode();
}
async function checkImageOK() {
  imageOK = false;
  if (illustrate && invoke) { try { const s = await invoke("bonsai_status"); imageOK = !!s; } catch { imageOK = false; } }
}

async function begin() {
  const custom = $("custom").value.trim();
  const seed = custom || chosenSeed;
  if (!seed) { $("setup-status").textContent = "Choisissez un univers ou décrivez le vôtre."; return; }
  $("start").disabled = true;
  $("setup-status").textContent = "L'IA prépare votre aventure…";
  await checkImageOK();
  A = newAdventure(seed, custom ? custom.slice(0, 40) : (chosenWorldName || "Aventure"));
  try {
    const first = await generateChild(null, null);
    persist();
    showGame();
    await renderNode(first);
  } catch (e) {
    $("setup-status").textContent = "Le moteur IA semble indisponible. Vérifiez Ollama / la clé API dans Paramètres.";
    $("start").disabled = false;
    A = null;
  }
}

// ---------- Génération ----------
async function nextScene(userAction, priorSummary) {
  const { messages, opts } = PROMPTS["app.adventure.scene"].build({ action: userAction, summary: priorSummary, strongContext: String(A?.strongContext || "").trim(), lang: replyLang() });
  const { content } = await llmChat(messages, { ...opts, rawSystem: true });
  try { return JSON.parse(content); }
  catch { return { narration: content, image_prompt: "", choices: [], summary: priorSummary }; }
}
async function generateChild(parentId, action) {
  const parent = parentId ? A.nodes[parentId] : null;
  const prior = parent ? parent.summary : "";
  const prompt = parent == null
    ? `Démarre une nouvelle aventure dans cet univers : ${A.seed}. Plante le décor et place le héros dans une situation initiale intrigante.`
    : `Le joueur décide : « ${action} ». Décris ce qui se passe ensuite.`;
  const data = await nextScene(prompt, prior);
  const n = {
    id: uid(), parentId: parentId || null, action: action || null,
    narration: data.narration || "…", image_prompt: data.image_prompt || "",
    choices: (data.choices || []).slice(0, 4),
    summary: String(data.summary || prior).slice(0, 600),
    imageUrl: "", children: [],
  };
  A.nodes[n.id] = n;
  if (parent) parent.children.push(n.id); else A.rootId = n.id;
  A.currentId = n.id;
  return n;
}

// ---------- Rendu ----------
async function renderNode(n) {
  $("turn").textContent = tt("Tour {n}", { n: depth(n.id) });
  const scene = $("scene");
  scene.classList.remove("thinking");
  scene.classList.remove("fade"); void scene.offsetWidth; scene.classList.add("fade");
  scene.textContent = n.narration || "…";
  renderChoices(n);
  $("scene-wrap").scrollTop = 0;
  await illustrateNode(n); // l'illustration d'abord…
  speak(n.narration);      // …puis la voix, une fois l'image prête
}
function renderChoices(n) {
  const box = $("choices"); box.innerHTML = "";
  // Variantes déjà explorées depuis cette étape (navigation sans régénérer).
  for (const cid of n.children || []) {
    const c = A.nodes[cid]; if (!c) continue;
    const b = document.createElement("button");
    b.className = "choice variant";
    b.innerHTML = `<span class="vtag">↺ ${tt("variante")}</span><span></span>`;
    b.querySelector("span:last-child").textContent = c.action || tt("suite");
    b.addEventListener("click", () => goTo(c.id));
    box.appendChild(b);
  }
  // Nouveaux choix suggérés (créent une nouvelle branche).
  for (const c of (n.choices || []).slice(0, 4)) {
    const b = document.createElement("button");
    b.className = "choice"; b.textContent = c;
    b.addEventListener("click", () => act(c));
    box.appendChild(b);
  }
}
async function illustrateNode(n) {
  const fig = $("illus-fig");
  if (!illustrate || !n.image_prompt) { fig.hidden = true; return; }
  // Cache mémoire → sandbox Lumen → IndexedDB legacy → génération.
  if (!n.imageUrl && n.imagePath && n.imageSandboxId && invoke) {
    try {
      const b64 = await invoke("sandbox_read_b64", { id: n.imageSandboxId, path: n.imagePath });
      if (b64) n.imageUrl = `data:image/png;base64,${b64}`;
    } catch {}
  }
  if (!n.imageUrl) {
    const cached = await idbGet(n.id);
    if (cached) {
      n.imageUrl = cached;
      migrateImageDataUrlToSandbox(n);
    }
  }
  if (n.imageUrl) {
    // Une navigation plus récente a pu changer de scène pendant l'await : on ne
    // pose l'image que si ce nœud est toujours celui affiché.
    if (A.currentId === n.id) { $("illus-img").src = n.imageUrl; fig.hidden = false; fig.classList.remove("loading"); }
    return;
  }
  if (!imageOK) { fig.hidden = true; return; }
  fig.hidden = false; fig.classList.add("loading"); $("illus-img").removeAttribute("src");
  try {
    const sizeSet = cardMode ? IMG_SIZES_PORTRAIT : IMG_SIZES;
    const sz = sizeSet[A.imgSize] || sizeSet.medium;
    const prompt = `${n.image_prompt}, ${cardMode ? "vertical portrait composition, trading card artwork, full-height framing" : "cinematic digital illustration"}, atmospheric, detailed`;
    const sid = await ensureAdventureSandbox();
    const imagePath = `adventures/images/${A.id}/${n.id}.png`;
    const res = sid
      // Moteur d'image des réglages (Bonsai, Ollama ou OpenAI) : l'aventure
      // n'impose plus le local.
      ? await invoke("bonsai_generate_to_sandbox_url", { id: sid, path: imagePath, prompt, width: sz.w, height: sz.h, steps: sz.steps, ...imageGenerationConfig() })
      : { data_url: await invoke("bonsai_generate_data_url", { prompt, width: sz.w, height: sz.h, steps: sz.steps, ...imageGenerationConfig() }) };
    const url = res.data_url;
    n.imageUrl = url;
    n.imagePath = res.path || imagePath;
    n.imageSandboxId = res.sandbox_id || sid || "";
    await idbPut(n.id, url); // cache de reprise rapide
    persist();
    if (A.currentId === n.id) $("illus-img").src = url;
  } catch { fig.hidden = true; }
  finally { fig.classList.remove("loading"); }
}

function goTo(id) {
  if (!A.nodes[id]) return;
  A.currentId = id; persist();
  renderNode(A.nodes[id]);
}

async function act(action) {
  setBusy(true);
  const scene = $("scene");
  scene.textContent = "…"; scene.classList.add("thinking");
  $("choices").innerHTML = "";
  try {
    const n = await generateChild(A.currentId, action);
    persist();
    await renderNode(n);
  } catch {
    scene.classList.remove("thinking");
    scene.textContent = "(L'IA n'a pas répondu. Réessayez.)";
  } finally {
    setBusy(false);
  }
}
function setBusy(b) {
  $("free").disabled = b;
  document.querySelector(".free-go").disabled = b;
}

// ---------- Menu Réglages (taille des images) ----------
function bindMenu() {
  const menu = $("settings-menu");
  $("btn-settings").addEventListener("click", (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    if (!menu.hidden) updateMenu();
  });
  menu.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => { menu.hidden = true; });
  document.querySelectorAll("#size-seg button").forEach((b) => {
    b.addEventListener("click", () => {
      const s = b.dataset.size;
      localStorage.setItem(SIZE_KEY, s);
      if (A) { A.imgSize = s; persist(); }
      updateMenu();
    });
  });
  $("menu-illus").addEventListener("change", (e) => { setIllustrate(e.target.checked); });
  $("menu-card").addEventListener("change", (e) => {
    cardMode = e.target.checked;
    localStorage.setItem(CARD_MODE_KEY, cardMode ? "1" : "0");
    if (A) { A.cardMode = cardMode; persist(); }
    applyCardMode();
    updateMenu();
  });
  $("menu-card-theme").addEventListener("change", (e) => {
    cardTheme = CARD_THEMES.has(e.target.value) ? e.target.value : "arcane";
    localStorage.setItem(CARD_THEME_KEY, cardTheme);
    if (A) { A.cardTheme = cardTheme; persist(); }
    applyCardMode();
  });
  $("menu-speak").addEventListener("change", (e) => {
    speakOn = e.target.checked;
    localStorage.setItem("adventure/speak", speakOn ? "1" : "0");
    if (!speakOn) stopSpeech();
  });
  $("menu-voice").addEventListener("change", (e) => {
    localStorage.setItem("adventure/voiceURI", e.target.value);
    // Petit aperçu de la voix choisie si la lecture est active.
    if (speakOn) speak("Voici la voix de votre aventure.");
  });
  bindStrongContext();
}
function applyCardMode() {
  const game = $("game");
  if (!game) return;
  game.classList.toggle("card-mode", cardMode);
  game.dataset.cardTheme = cardTheme;
}
function updateMenu() {
  const cur = (A ? A.imgSize : localStorage.getItem(SIZE_KEY)) || "medium";
  document.querySelectorAll("#size-seg button").forEach((b) => b.classList.toggle("on", b.dataset.size === cur));
  $("menu-illus").checked = illustrate;
  $("menu-card").checked = cardMode;
  $("menu-card-theme").value = cardTheme;
  document.querySelectorAll(".card-theme-row").forEach((el) => { el.hidden = !cardMode; });
  $("menu-speak").checked = speakOn;
  populateVoiceSelect();
}

function bindStrongContext() {
  $("btn-context").addEventListener("click", () => {
    $("settings-menu").hidden = true;
    $("context-text").value = A?.strongContext || "";
    $("context-overlay").hidden = false;
    $("context-text").focus();
  });
  $("context-close").addEventListener("click", closeStrongContext);
  $("context-overlay").addEventListener("click", (e) => { if (e.target.id === "context-overlay") closeStrongContext(); });
  $("context-clear").addEventListener("click", () => { $("context-text").value = ""; });
  $("context-save").addEventListener("click", () => {
    if (A) {
      A.strongContext = $("context-text").value.trim().slice(0, 4000);
      persist();
    }
    closeStrongContext();
  });
}
function closeStrongContext() { $("context-overlay").hidden = true; }

// ---------- Historique / étapes ----------
function bindHistory() {
  $("btn-history").addEventListener("click", () => { renderTimeline(); $("history-overlay").hidden = false; });
  $("history-close").addEventListener("click", closeHistory);
  $("history-overlay").addEventListener("click", (e) => { if (e.target.id === "history-overlay") closeHistory(); });
}
function closeHistory() { $("history-overlay").hidden = true; }
function renderTimeline() {
  const tl = $("timeline"); tl.innerHTML = "";
  const path = pathTo(A.currentId);
  path.forEach((n, i) => {
    const el = document.createElement("button");
    el.className = "tl-item" + (n.id === A.currentId ? " cur" : "");
    const branches = (n.children || []).length;
    el.innerHTML = `<span class="tl-n">${i + 1}</span><span class="tl-b"><b></b><small></small></span>${branches > 1 ? `<span class="tl-br" title="${branches} variantes">⑃ ${branches}</span>` : ""}`;
    el.querySelector("b").textContent = n.action ? `▸ ${n.action}` : "Début de l'aventure";
    el.querySelector("small").textContent = (n.narration || "").slice(0, 90);
    el.addEventListener("click", () => { goTo(n.id); closeHistory(); });
    tl.appendChild(el);
  });
}

initSetup();

// i18n : traduit le DOM statique + le contenu rendu dynamiquement (mode EN).
autoTranslate({ observe: true });
