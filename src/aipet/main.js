import { appLang, autoTranslate, tt } from "../apps-i18n.js";
import { ORB_CHARACTERS, characterId } from "../lib/orb-characters.js";
// Luciole (ex-Compagnon IA) — logique front. La créature est incarnée par l'orbe Lumen
// (orb.js → window.LumenOrb), avec ses propres réglages d'apparence stockés sous
// des clés localStorage dédiées (aipetOrb*) et appliqués au runtime, sans toucher
// l'orbe de la barre. L'état (stats, souvenirs, succès) persiste via la mémoire de
// Lumen (memory_get/set) ; les stats décroissent avec le temps réel écoulé.
import { llmChat } from "../llm.js";
import { replyLang } from "../lib/prompt-lang.js";
import { PROMPTS } from "./prompts.js";
import { appDecider } from "../lib/decisions.js";
// L'import installe l'écoute des demandes d'arrêt vocal venues d'une autre
// fenêtre (double-clic sur l'avatar) : cette page coupe alors sa propre
// Web Speech. cf. lib/voice-stop.js
import "../lib/voice-stop.js";

const invoke = (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke;
const KEY = "aipet/state";
const RAINBOW = ["#ff54a3", "#9961ff", "#47a3ff", "#61f2c7", "#ff9e6b"];

const $ = (id) => document.getElementById(id);
const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
const level = (xp) => Math.floor(Math.sqrt(xp / 8)) + 1;
const xpForLevel = (l) => Math.pow(l - 1, 2) * 8;

const STATS = [
  { k: "faim", label: "Faim", color: "#ff9f0a" },
  { k: "humeur", label: "Humeur", color: "#ffd60a" },
  { k: "energie", label: "Énergie", color: "#34c759" },
  { k: "proprete", label: "Propreté", color: "#64d2ff" },
  { k: "complicite", label: "Complicité", color: "#ff2d92" },
];
const STAGES = [
  { min: 1, name: "Étincelle", icons: [] },
  { min: 3, name: "Lutin", icons: ["sphere"] },
  { min: 6, name: "Esprit", icons: ["star"] },
  { min: 10, name: "Gardien", icons: ["diamond", "diamond"] },
  { min: 15, name: "Sage", icons: ["star", "diamond", "star", "diamond"] },
];
const TRAITS = { feed: "Gourmand", play: "Joueur", clean: "Coquet", cuddle: "Câlin", teach: "Curieux", talk: "Bavard", sleep: "Dormeur", heal: "Douillet" };
// `icon` = tracé interne d'un SVG 24×24 (style trait, comme le reste de Lumen).
const ACHS = [
  { id: "firstwords", label: "Premiers mots", icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>', test: (s) => s.acts.talk >= 1 },
  { id: "grown", label: "Petite pousse", icon: '<path d="M12 22V11"/><path d="M12 11C12 7 9 5 5 5c0 4 3 6 7 6z"/><path d="M12 13c0-3 3-5 7-5 0 3-3 5-7 5z"/>', test: (s) => level(s.xp) >= 3 },
  { id: "esprit", label: "Esprit éveillé", icon: '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/>', test: (s) => level(s.xp) >= 6 },
  { id: "sage", label: "Sage", icon: '<polygon points="12 2 15 9 22 9.3 16.5 13.8 18.5 21 12 16.8 5.5 21 7.5 13.8 2 9.3 9 9"/>', test: (s) => level(s.xp) >= 10 },
  { id: "bestie", label: "Inséparables", icon: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/>', test: (s) => s.complicite >= 80 },
  { id: "scholar", label: "Érudit", icon: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>', test: (s) => s.memories.length >= 10 },
  { id: "coquet", label: "Impeccable", icon: '<path d="M12 2.7S5 9.3 5 14a7 7 0 0 0 14 0c0-4.7-7-11.3-7-11.3z"/>', test: (s) => s.acts.clean >= 10 },
  { id: "streak", label: "Fidèle (7 j.)", icon: '<path d="M12 2c1 4 5 5 5 9a5 5 0 0 1-10 0c0-2 1-3 2-4 0 1 .5 2 1.5 2 0-3-1-5 1.5-7z"/>', test: (s) => s.streak >= 7 },
  { id: "healer", label: "Bon docteur", icon: '<rect x="3" y="8" width="18" height="12" rx="3"/><path d="M12 11v6M9 14h6M9 8V5a3 3 0 0 1 6 0v3"/>', test: (s) => s.acts.heal >= 3 },
  { id: "champion", label: "Champion (5 parties gagnées)", icon: '<path d="M8 21h8M12 17v4"/><path d="M7 4h10v6a5 5 0 0 1-10 0z"/><path d="M7 6H4a3 3 0 0 0 3 5M17 6h3a3 3 0 0 1-3 5"/>', test: (s) => (s.games?.won || 0) >= 5 },
  { id: "gourmet", label: "Fin gourmet", icon: '<path d="M5 12a7 7 0 0 1 14 0z"/><path d="M4 15h16M6 19h12"/>', test: (s) => (s.acts.feast || 0) >= 3 },
];
const SLEEP_ICON = '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';
const WAKE_ICON = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.4 1.4M17.6 17.6L19 19M19 5l-1.4 1.4M6.4 17.6L5 19"/>';
const svgIcon = (paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

const DEFAULT = () => ({
  name: "Nimbo",
  born: Date.now(), lastSeen: Date.now(), lastDay: today(),
  faim: 70, humeur: 75, energie: 80, proprete: 80, complicite: 10,
  xp: 0, streak: 1, asleep: false,
  sick: false,            // malade : à soigner avant de pouvoir jouer/progresser
  mess: 0, messAccum: 0,  // salissures visibles dans la scène (0..3), à laver
  lastStageMin: 1,        // détection d'évolution (cérémonie)
  games: { played: 0, won: 0 },
  wallet: 120,            // solde de Lumens (✦) — monnaie du compagnon
  creditedLifetime: null, // repère haut des tokens « generated » déjà crédités (lecture seule du vrai compteur)
  acts: { feed: 0, play: 0, clean: 0, cuddle: 0, teach: 0, talk: 0, sleep: 0, heal: 0, feast: 0 },
  achievements: [],
  memories: [], history: [],
});

// Coût en ✦ de chaque interaction (0 = gratuit). Apprendre est gratuit (ça nous
// enrichit), Dormir aussi.
// feed ouvre un menu (chaque plat a son prix) ; play un mini-jeu.
const COST = { feed: 0, play: 40, clean: 25, cuddle: 20, teach: 0, sleep: 0, heal: 45, settings: 0 };

let S = DEFAULT();
let orb = null;

function today() { return new Date().toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 86400000); }

// ---------- Orbe ----------
function orbReady(cb, tries = 0) {
  if (window.LumenOrb) cb(window.LumenOrb);
  else if (tries < 60) setTimeout(() => orbReady(cb, tries + 1), 50);
}
const setting = (k, d) => { const v = localStorage.getItem(k); return v == null ? d : v; };
function baseColors() { try { const c = JSON.parse(localStorage.getItem("aipetOrbColors")); if (Array.isArray(c) && c.length === 5) return c; } catch {} return RAINBOW.slice(); }

function desat(hex, amt) {
  const n = parseInt(hex.replace("#", ""), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const gray = 0.3 * r + 0.59 * g + 0.11 * b;
  r = Math.round(r + (gray - r) * amt); g = Math.round(g + (gray - g) * amt); b = Math.round(b + (gray - b) * amt);
  return "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// Personnage de Luciole : l'un des orbes de Lumen (Original en verre ou
// personnage doux), choisi ici et gardé sous sa propre clé — changer celui de
// Luciole ne change pas celui de la barre, et inversement.
const orbCharacter = () => characterId(setting("aipetOrbCharacter", "default"));

function applyOrbAppearance() {
  if (!orb) return;
  orb.setEnabled(true);
  orb.setCharacter?.(orbCharacter());
  // orb.js reprend à l'init le mode d'avatar global (un GLB personnalisé
  // possible) : Luciole est toujours une orbe.
  orb.setAvatarMode?.("orb");
  orb.setSize(parseInt(setting("aipetOrbSize", "210"), 10));
  orb.setCoreScale(parseInt(setting("aipetOrbCore", "82"), 10));
  orb.setGlassType(setting("aipetOrbGlass", "crystal"));
  applyOrbMood();
  orb.setInnerIcons(stage().icons, "#ffffff");
}

function applyOrbMood() {
  if (!orb) return;
  const vit = (health() + S.humeur) / 2;
  let amt = vit >= 60 ? 0 : (60 - vit) / 60 * 0.8; // 0 vivace → 0.8 terne
  if (S.asleep) amt = Math.min(0.85, amt + 0.45);
  const cols = baseColors().map((c) => desat(c, amt));
  orb.setColors(cols);
  // Les personnages doux n'ont pas de couleurs à ternir : le sommeil passe par
  // l'humeur de l'orbe (yeux fermés, « z z »), commune à tous les orbes.
  if (S.asleep) orb.setMood?.("sleep", { ms: 0, quiet: true });
  else if (orbSleeping) orb.setMood?.("");
  orbSleeping = S.asleep;
}
let orbSleeping = false;

// Description du personnage choisi, et masquage des réglages propres à
// l'orbe de verre quand un personnage doux est sélectionné.
function showCharacter() {
  const c = ORB_CHARACTERS[orbCharacter()];
  $("character-desc").textContent = appLang() === "en" ? c.enDescription : c.description;
  $("settings").querySelector(".panel").classList.toggle("soft-character", c.renderer !== "original");
}

// Couleur de fond de la scène (au choix de l'utilisateur), avec un léger halo de
// l'orbe par-dessus pour garder de la profondeur. Vide = dégradé par défaut (CSS).
function applyBg() {
  const c = localStorage.getItem("aipetBg");
  const st = document.querySelector(".stage");
  if (!st) return;
  st.style.background = c ? `radial-gradient(120% 80% at 30% -5%, var(--sel), transparent 60%), ${c}` : "";
}

// Couleur du texte de la scène, à accorder à la couleur de fond choisie.
// "auto" = suit le thème du bureau (par défaut), "dark"/"light" = forçage.
function applyText() {
  const mode = localStorage.getItem("aipetText") || "auto";
  const st = document.querySelector(".stage");
  if (!st) return;
  st.classList.toggle("txt-dark", mode === "dark");
  st.classList.toggle("txt-light", mode === "light");
}

function setOrbState(s) { orb?.setState(s); }
function orbCelebrate() { orb?.pulseHeart?.(); if (!S.asleep) orb?.setMood?.("joy", { ms: 1600, quiet: true }); $("orb-wrap").classList.add("happy"); setTimeout(() => $("orb-wrap").classList.remove("happy"), 700); }

// ---------- Monnaie (✦ Lumens) ----------
// On LIT seulement le compteur réel `ollamaDailyUsage` (somme des tokens generated
// sur tous les jours = monotone croissante) ; on n'y écrit JAMAIS. Le compagnon
// tient son propre solde, crédité du delta depuis le dernier repère.
function lifetimeGenerated() {
  try {
    const all = JSON.parse(localStorage.getItem("ollamaDailyUsage") || "{}");
    return Object.values(all).reduce((a, d) => a + Number(d?.generated || 0), 0);
  } catch { return 0; }
}
function creditGlobal() {
  const lt = lifetimeGenerated();
  if (S.creditedLifetime == null) { S.creditedLifetime = lt; return 0; } // 1re fois : on cale le repère sans crédit rétroactif
  const delta = Math.max(0, lt - S.creditedLifetime);
  if (delta > 0) { S.wallet += delta; S.creditedLifetime = lt; }
  return delta;
}
function earn(n, label) {
  n = Math.max(0, Math.round(n));
  if (!n) return;
  S.wallet += n;
  flashWallet();
  if (label) toast(`+${n} ✦ ${label}`);
}
function spend(n) {
  if (S.wallet < n) return false;
  S.wallet -= n; return true;
}
function renderWallet() { const w = $("wallet-val"); if (w) w.textContent = S.wallet; }
function flashWallet() { const w = $("wallet"); if (!w) return; w.classList.remove("flash"); void w.offsetWidth; w.classList.add("flash"); }

// ---------- Persistance ----------
async function load() {
  if (invoke) { try { const e = await invoke("memory_get", { key: KEY }); if (e && e.value && typeof e.value === "object") S = { ...DEFAULT(), ...e.value, acts: { ...DEFAULT().acts, ...(e.value.acts || {}) } }; } catch {} }
  applyTimePassage();
  creditGlobal();
  applyBg();
  applyText();
  orbReady((o) => { orb = o; applyOrbAppearance(); });
  renderAll();
  greet();
}

// Le vrai compteur est mis à jour par la barre principale (autre document) :
// l'event `storage` nous parvient ici, on crédite le delta.
window.addEventListener("storage", (e) => {
  if (e.key !== "ollamaDailyUsage") return;
  const d = creditGlobal();
  if (d > 0) { flashWallet(); renderWallet(); save(); }
});
async function save() { S.lastSeen = Date.now(); if (invoke) { try { await invoke("memory_set", { key: KEY, value: S }); } catch {} } }

function applyTimePassage() {
  const h = Math.max(0, (Date.now() - (S.lastSeen || Date.now())) / 3600000);
  if (S.asleep) {
    S.energie = clamp(S.energie + h * 18);
    S.faim = clamp(S.faim - h * 5);
    if (S.energie >= 100) S.asleep = false;
  } else {
    S.energie = clamp(S.energie - h * 6);
    S.faim = clamp(S.faim - h * 9);
  }
  // Salissures façon Tamagotchi : ~1 toutes les 5 h d'éveil (max 3), chacune
  // accélère la baisse de propreté tant qu'elle n'est pas nettoyée.
  if (!S.asleep) {
    S.messAccum = (S.messAccum || 0) + h / 5;
    while (S.messAccum >= 1 && S.mess < 3) { S.messAccum -= 1; S.mess += 1; }
    S.messAccum = Math.min(S.messAccum, 1);
  }
  S.proprete = clamp(S.proprete - h * (4 + S.mess * 3));
  let moodDrop = h * 5;
  if (S.faim < 25) moodDrop += h * 4;
  if (S.proprete < 25) moodDrop += h * 3;
  if (S.sick) moodDrop += h * 6;
  S.humeur = clamp(S.humeur - moodDrop);
  // Maladie : négligé (santé très basse ou saleté maximale) → risque de tomber malade.
  if (!S.sick && h > 0.5 && (health() < 20 || (S.proprete <= 5 && S.mess >= 3))) {
    if (Math.random() < Math.min(0.8, h * 0.2)) S.sick = true;
  }
  // Bonus de fidélité quotidien
  const t = today();
  if (S.lastDay !== t) {
    const d = daysBetween(S.lastDay, t);
    S.streak = d === 1 ? (S.streak || 1) + 1 : 1;
    S.lastDay = t;
    S.humeur = clamp(S.humeur + 10);
  }
}

// ---------- Dérivés ----------
function health() { return clamp((S.faim + S.proprete + S.energie) / 3); }
function stage() { let st = STAGES[0]; for (const s of STAGES) if (level(S.xp) >= s.min) st = s; return st; }
function topTraits() {
  return Object.entries(S.acts).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => TRAITS[k]);
}

// ---------- Rendu ----------
function renderAll() {
  const lv = level(S.xp);
  $("pet-name").textContent = S.name;
  $("pet-stage").textContent = tt(stage().name);
  $("pet-level").textContent = lv;
  $("pet-health").textContent = health();
  $("pet-state").textContent = S.asleep ? tt("endormi") + " 💤" : S.sick ? tt("malade") + " 🤒" : S.humeur > 70 ? tt("joyeux") : S.humeur > 40 ? tt("calme") : health() < 30 ? tt("patraque") : tt("grognon");
  const cur = xpForLevel(lv), next = xpForLevel(lv + 1);
  $("xp-fill").style.width = Math.round(((S.xp - cur) / (next - cur)) * 100) + "%";
  $("xp-label").textContent = `${S.xp - cur} / ${next - cur} XP`;
  $("pet-sub").textContent = tt("{days} j. ensemble · série {streak} · {count} souvenir(s)", { days: ageDays(), streak: S.streak, count: S.memories.length });
  $("mem-count").textContent = tt("{count} souvenir(s)", { count: S.memories.length });

  // Stats
  const box = $("stats"); box.innerHTML = "";
  for (const st of STATS) {
    const v = S[st.k];
    const row = document.createElement("div");
    // La complicité démarre à 10 et grandit : ce n'est pas un besoin en alerte.
    row.className = "stat" + (v < 25 && st.k !== "complicite" ? " low" : "");
    row.innerHTML = `<span>${tt(st.label)}</span><div class="bar"><i style="width:${v}%;background:${st.color}"></i></div><span class="val">${v}</span>`;
    box.appendChild(row);
  }
  // Traits + succès
  const tb = $("traits"); tb.innerHTML = "";
  for (const tr of topTraits()) { const c = document.createElement("span"); c.className = "chip"; c.textContent = tr; tb.appendChild(c); }
  for (const a of ACHS.filter((a) => S.achievements.includes(a.id))) {
    const c = document.createElement("span"); c.className = "chip ach"; c.innerHTML = svgIcon(a.icon); c.title = a.label; tb.appendChild(c);
  }

  renderWallet();
  renderBadges();
  renderMess();
  $("act-sleep").querySelector("small").textContent = S.asleep ? tt("Réveiller") : tt("Dormir");
  $("sleep-ic").innerHTML = svgIcon(S.asleep ? WAKE_ICON : SLEEP_ICON);
  $("act-heal").hidden = !S.sick;
  document.querySelectorAll(".act").forEach((b) => {
    if (b.dataset.act === "sleep") return;
    const sickBlock = S.sick && ["play", "teach"].includes(b.dataset.act); // trop malade pour jouer/apprendre
    b.disabled = S.asleep || sickBlock;
  });
  // Barres critiques : clignotement d'appel à l'aide (façon Tamagotchi).
  document.querySelectorAll(".stat.low .bar i").forEach((i) => i.classList.add("blink"));

  celebrateEvolution();
  applyOrbMood();
}

// Appels d'attention : petites pastilles sous le nom quand quelque chose ne va pas.
function renderBadges() {
  const box = $("badges");
  if (!box) return;
  const items = [];
  if (S.sick) items.push({ cls: "bad", ic: '<path d="M12 3v3M12 3a7 7 0 0 1 7 7c0 4-3 5-3 8h-8c0-3-3-4-3-8a7 7 0 0 1 7-7z"/><path d="M9 21h6"/>', label: "Malade — soigne-moi !" });
  if (!S.asleep) {
    if (S.faim < 25) items.push({ cls: "warn", ic: '<path d="M12 20.9c1.5 0 2.7 1.1 4 1.1 3 0 6-8 6-12.2A4.9 4.9 0 0 0 17 5c-2.2 0-4 1.4-5 2-1-.6-2.8-2-5-2A4.9 4.9 0 0 0 2 9.8C2 14 5 22 8 22c1.3 0 2.5-1.1 4-1.1z"/>', label: "Faim !" });
    if (S.energie < 25) items.push({ cls: "warn", ic: SLEEP_ICON, label: "Épuisé" });
    if (S.mess > 0) items.push({ cls: "warn", ic: '<path d="M12 2.7S5 9.3 5 14a7 7 0 0 0 14 0c0-4.7-7-11.3-7-11.3z"/>', label: `À nettoyer (${S.mess})` });
    if (S.humeur < 25) items.push({ cls: "warn", ic: '<circle cx="12" cy="12" r="9"/><path d="M8 16s1.5-2 4-2 4 2 4 2"/><path d="M9 10h.01M15 10h.01"/>', label: "Triste" });
  }
  box.innerHTML = items.map((i) => `<span class="badge ${i.cls}" title="${i.label}">${svgIcon(i.ic)}<em>${i.label}</em></span>`).join("");
}

// Salissures visibles autour de l'orbe, à faire disparaître avec « Laver ».
const MESS_ICON = '<path d="M12 4c1.5 2 .5 3.4 2.6 4.6C17 10 19 11.5 19 14.5A5.5 5.5 0 0 1 13.5 20h-3A5.5 5.5 0 0 1 5 14.5c0-3 2-4.5 4.4-5.9C11.5 7.4 10.5 6 12 4z"/><path d="M9.5 15.5h.01M14.5 15.5h.01"/>';
const MESS_SPOTS = [{ left: "4%", bottom: "6%", r: "-12deg" }, { right: "2%", bottom: "12%", r: "9deg" }, { left: "16%", bottom: "-4%", r: "4deg" }];
function renderMess() {
  const layer = $("mess");
  if (!layer) return;
  layer.innerHTML = "";
  for (let i = 0; i < Math.min(S.mess, MESS_SPOTS.length); i += 1) {
    const sp = MESS_SPOTS[i];
    const el = document.createElement("span");
    el.className = "mess-spot";
    el.title = "Beurk… lave-moi !";
    Object.assign(el.style, { left: sp.left || "", right: sp.right || "", bottom: sp.bottom, transform: `rotate(${sp.r})` });
    el.innerHTML = svgIcon(MESS_ICON);
    layer.appendChild(el);
  }
}

// Cérémonie d'évolution : quand le palier change, on le fête.
function celebrateEvolution() {
  const st = stage();
  if (st.min !== S.lastStageMin) {
    const up = st.min > S.lastStageMin;
    S.lastStageMin = st.min;
    if (up) {
      orbCelebrate();
      say(`✨ J'ai évolué : je suis maintenant ${st.name} !`, 6000);
      toast(`Évolution : ${st.name} !`);
      orb?.setInnerIcons(st.icons, "#ffffff");
      save();
    }
  }
}
function ageDays() { return Math.max(0, Math.floor((Date.now() - S.born) / 86400000)); }

function say(text, ms = 4200) {
  const sp = $("speech"); sp.textContent = text; sp.hidden = false;
  clearTimeout(say._t); say._t = setTimeout(() => { sp.hidden = true; }, ms);
}
function toast(text) {
  const t = $("toast"); t.textContent = text; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2600);
}

// ---------- Synthèse vocale ----------
// Énonce les réponses du compagnon via la Web Speech API, comme le chat de la
// barre. Choix de voix propre au compagnon (aipetVoiceURI) ; activable (aipetSpeak).
let voices = [];
function stripForSpeech(text) {
  return (text || "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}]/gu, "")
    .replace(/[ \t]{2,}/g, " ").trim();
}
function populateVoices() {
  if (!("speechSynthesis" in window)) return;
  const all = speechSynthesis.getVoices(); if (!all.length) return;
  const isFr = (v) => v.lang && v.lang.toLowerCase().startsWith("fr");
  const isEn = (v) => v.lang && v.lang.toLowerCase().startsWith("en");
  voices = [...all.filter(isFr), ...all.filter(isEn)];
  const sel = $("set-voice"); if (!sel) return;
  const cur = localStorage.getItem("aipetVoiceURI") || "";
  sel.innerHTML = '<option value="">Voix par défaut</option>';
  for (const v of voices) {
    const o = document.createElement("option");
    o.value = v.voiceURI; o.textContent = `${v.name} (${v.lang})`;
    sel.appendChild(o);
  }
  if (cur && voices.some((v) => v.voiceURI === cur)) sel.value = cur;
}
function speak(text) {
  if (!("speechSynthesis" in window)) return;
  if (localStorage.getItem("aipetSpeak") !== "1") return;
  const clean = stripForSpeech(text); if (!clean) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(clean);
  // Voix propre au compagnon, sinon voix globale de Lumen (Paramètres).
  const uri = localStorage.getItem("aipetVoiceURI") || localStorage.getItem("lumenVoiceURI") || "";
  const v = uri ? voices.find((x) => x.voiceURI === uri) : null;
  if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = "fr-FR"; }
  // Pilote l'orbe pendant la parole, comme les autres états vocaux.
  u.onstart = () => setOrbState("speaking");
  u.onend = () => setOrbState("idle");
  u.onerror = () => setOrbState("idle");
  speechSynthesis.speak(u);
}
if ("speechSynthesis" in window) {
  populateVoices();
  speechSynthesis.onvoiceschanged = populateVoices; // iOS/Safari : liste asynchrone
}

// ---------- Consolidation de la mémoire ----------
// Passe les souvenirs à l'IA pour fusionner les doublons et retirer le superflu.
async function consolidateMemory() {
  const btn = $("consolidate-mem"), hint = $("mem-hint");
  if (!S.memories.length) { hint.textContent = "Aucun souvenir à consolider."; return; }
  const prev = btn.textContent; btn.disabled = true; btn.textContent = "Consolidation…";
  try {
    const list = S.memories.map((m, i) => `${i + 1}. ${m.note}`).join("\n");
    const { messages, opts } = PROMPTS["app.aipet.consolidate"].build({ list, lang: replyLang() });
    const { content } = await llmChat(messages, { ...opts, rawSystem: true });
    let arr = null;
    try { const j = JSON.parse(content); if (Array.isArray(j.memories)) arr = j.memories; } catch {}
    if (!arr) { hint.textContent = "Consolidation impossible (réponse invalide)."; return; }
    const now = Date.now();
    S.memories = arr.filter((x) => typeof x === "string" && x.trim()).slice(0, 60)
      .map((x) => ({ t: now, note: String(x).trim().slice(0, 200) }));
    renderAll(); save();
    hint.textContent = `Mémoire consolidée : ${S.memories.length} souvenir${S.memories.length > 1 ? "s" : ""}.`;
    toast("Mémoire consolidée ✨");
  } catch { hint.textContent = "Échec de la consolidation (moteur IA configuré ?)."; }
  finally { btn.disabled = false; btn.textContent = prev; }
}
function greet() {
  const hour = new Date().getHours();
  if (S.asleep) { say("Zzz… (clique Réveiller)"); return; }
  if (S.sick) { say("Je suis malade… soigne-moi vite 🤒"); return; }
  if (S.memories.length === 0) say(`Bonjour ! Je suis ${S.name}. Apprends-moi des choses sur toi 🙂`);
  else if (health() < 30) say("Je ne me sens pas très bien… occupe-toi de moi ?");
  else if (S.faim < 25) say("J'ai une petite faim 🍎");
  else if (hour < 6 || hour >= 22) say("Il se fait tard… bonne nuit bientôt 🌙");
  else say(`Content de te revoir 💜 (série de ${S.streak} jours)`);
}

// ---------- Interactions ----------
function gain(xp) { S.xp += S.sick ? Math.ceil(xp / 2) : xp; } // malade : progresse deux fois moins vite
function after(msg, st = "speaking") {
  orbCelebrate(); setOrbState(st); setTimeout(() => setOrbState("idle"), 1800);
  if (msg) say(msg);
  checkAchievements(); renderAll(); save();
}

const ACTIONS = {
  feed() { openFeedMenu(); return false; }, // le menu gère lui-même les prix
  play() {
    if (S.energie < 15) { say("Trop fatigué pour jouer… fais-moi dormir."); return false; }
    openMiniGame();
    return true; // les 40 ✦ paient la partie (jeton d'arcade)
  },
  clean() {
    S.proprete = 100; S.mess = 0; S.messAccum = 0;
    S.humeur = clamp(S.humeur + 6); S.acts.clean++; gain(2); after("Tout propre ! 🛁");
  },
  cuddle() { S.complicite = clamp(S.complicite + 6); S.humeur = clamp(S.humeur + 10); S.acts.cuddle++; gain(2); after("🫧 ronron…"); },
  heal() {
    if (!S.sick) return false;
    S.sick = false; S.humeur = clamp(S.humeur + 8); S.acts.heal++; gain(1);
    after("Merci docteur, ça va déjà mieux 💊");
  },
  async teach() {
    // window.prompt() est inopérant dans la webview Tauri : dialogue maison.
    const fact = await askTextDialog("Apprendre quelque chose", "Un fait sur toi, un goût, un objectif…");
    if (!fact || !fact.trim()) return false;
    S.memories.push({ t: Date.now(), note: fact.trim().slice(0, 200) });
    if (S.memories.length > 60) S.memories = S.memories.slice(-60);
    S.complicite = clamp(S.complicite + 3); S.acts.teach++; gain(3); after("Je m'en souviendrai 📚");
    return false; // gratuit
  },
  sleep() {
    S.asleep = !S.asleep;
    if (S.asleep) { S.acts.sleep++; setOrbState("idle"); say("Bonne nuit… 💤"); }
    else { say("Bien reposé ! ✨"); }
    renderAll(); save();
  },
  settings() { openSettings(); },
};

// ---------- Dialogues maison (prompt/confirm natifs inopérants sous Tauri) ----------
function makeOverlay(inner) {
  const back = document.createElement("div");
  back.className = "overlay";
  const panel = document.createElement("div");
  panel.className = "panel";
  panel.innerHTML = inner;
  back.appendChild(panel);
  document.body.appendChild(back);
  return { back, panel, close: () => back.remove() };
}
function askTextDialog(title, placeholder) {
  return new Promise((resolve) => {
    const { back, panel, close } = makeOverlay(`
      <div class="panel-head"><h3>${title}</h3><button class="x" data-close>✕</button></div>
      <input type="text" class="dlg-input" maxlength="200" placeholder="${placeholder}">
      <div class="dlg-actions"><button class="mini" data-close>Annuler</button><button class="mini primary" data-ok>Retenir</button></div>`);
    const input = panel.querySelector(".dlg-input");
    const done = (v) => { close(); resolve(v); };
    panel.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => done(null)));
    panel.querySelector("[data-ok]").addEventListener("click", () => done(input.value));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") done(input.value); if (e.key === "Escape") done(null); });
    back.addEventListener("click", (e) => { if (e.target === back) done(null); });
    input.focus();
  });
}
function confirmDialog(message, okLabel = "Confirmer") {
  return new Promise((resolve) => {
    const { back, panel, close } = makeOverlay(`
      <div class="panel-head"><h3>Confirmer</h3><button class="x" data-close>✕</button></div>
      <p class="dlg-text">${message}</p>
      <div class="dlg-actions"><button class="mini" data-close>Annuler</button><button class="mini danger-btn" data-ok>${okLabel}</button></div>`);
    const done = (v) => { close(); resolve(v); };
    panel.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => done(false)));
    panel.querySelector("[data-ok]").addEventListener("click", () => done(true));
    back.addEventListener("click", (e) => { if (e.target === back) done(false); });
  });
}

// ---------- Menu de repas ----------
const FOODS = [
  { id: "meal", name: "Repas", cost: 30, faim: 32, humeur: 4, note: "équilibré", ic: '<path d="M5 12a7 7 0 0 1 14 0z"/><path d="M4 15h16M6 19h12"/>' },
  { id: "treat", name: "Friandise", cost: 15, faim: 10, humeur: 14, proprete: -6, note: "plaisir, mais salissant", ic: '<circle cx="12" cy="12" r="5"/><path d="M17 9l4-3M17 15l4 3M7 9L3 6M7 15l-4 3"/>' },
  { id: "feast", name: "Festin", cost: 60, faim: 100, humeur: 10, note: "faim comblée", ic: '<path d="M4 18h16l-1.5-8h-13z"/><path d="M12 10V7M8.5 10l-1-2.5M15.5 10l1-2.5"/><path d="M3 21h18"/>' },
];
function openFeedMenu() {
  const { back, panel, close } = makeOverlay(`
    <div class="panel-head"><h3>${tt("Nourrir {name}", { name: S.name })}</h3><button class="x" data-close>✕</button></div>
    <div class="food-list">${FOODS.map((f) => `
      <button class="food" data-food="${f.id}" ${S.wallet < f.cost ? "disabled" : ""}>
        <span class="ic">${svgIcon(f.ic)}</span>
        <span class="food-txt"><b>${f.name}</b><small>${f.note}</small></span>
        <span class="food-cost">✦${f.cost}</span>
      </button>`).join("")}</div>`);
  panel.querySelector("[data-close]").addEventListener("click", close);
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  panel.querySelectorAll(".food").forEach((b) => b.addEventListener("click", () => {
    const f = FOODS.find((x) => x.id === b.dataset.food);
    if (!f || !spend(f.cost)) return;
    close();
    S.faim = clamp(S.faim + f.faim);
    S.humeur = clamp(S.humeur + (f.humeur || 0));
    if (f.proprete) S.proprete = clamp(S.proprete + f.proprete);
    S.acts.feed++;
    if (f.id === "feast") S.acts.feast = (S.acts.feast || 0) + 1;
    gain(f.id === "feast" ? 3 : 2);
    renderWallet();
    after(f.id === "treat" ? "Mmmh, sucré ! 🍬" : f.id === "feast" ? "Quel festin ! 🎂" : "Miam, merci ! 🍎");
    save();
  }));
}

// ---------- Mini-jeu « Cache-cache » (façon Tamagotchi : gauche ou droite) ----------
// 5 manches : le compagnon se cache derrière une des deux bulles ; ≥ 3 trouvés = gagné.
function openMiniGame() {
  let round = 0, found = 0, busy = false;
  const { back, panel, close } = makeOverlay(`
    <div class="panel-head"><h3>Cache-cache</h3><button class="x" data-close>✕</button></div>
    <p class="dlg-text" id="mg-say">Où suis-je caché ? (5 manches)</p>
    <div class="mg-arena">
      <button class="mg-bubble" data-side="0" aria-label="Bulle de gauche"></button>
      <button class="mg-bubble" data-side="1" aria-label="Bulle de droite"></button>
    </div>
    <div class="mg-dots" id="mg-dots">${"<span></span>".repeat(5)}</div>`);
  const sayEl = panel.querySelector("#mg-say");
  const dots = [...panel.querySelectorAll("#mg-dots span")];
  const endGame = (aborted) => {
    close();
    if (aborted && round === 0) return; // fermé sans jouer
    const won = found >= 3;
    S.games.played++; if (won) S.games.won++;
    S.humeur = clamp(S.humeur + (won ? 18 : 8));
    S.energie = clamp(S.energie - 12);
    S.complicite = clamp(S.complicite + (won ? 5 : 2));
    S.proprete = clamp(S.proprete - 6);
    S.acts.play++; gain(won ? 5 : 2);
    if (won) earn(10, "victoire !");
    after(won ? `Trouvé ${found}/5 — tu me connais trop bien ! 🏆` : `${found}/5… on se recache quand tu veux 😄`);
  };
  panel.querySelector("[data-close]").addEventListener("click", () => endGame(true));
  back.addEventListener("click", (e) => { if (e.target === back) endGame(true); });
  panel.querySelectorAll(".mg-bubble").forEach((b) => b.addEventListener("click", () => {
    if (busy) return;
    busy = true;
    const hidden = Math.random() < 0.5 ? 0 : 1;
    const pick = Number(b.dataset.side);
    const ok = pick === hidden;
    panel.querySelectorAll(".mg-bubble")[hidden].classList.add("reveal");
    dots[round].className = ok ? "hit" : "miss";
    if (ok) { found++; orbCelebrate(); }
    sayEl.textContent = ok ? "Trouvé ! 🎉" : "Raté, j'étais de l'autre côté !";
    round++;
    setTimeout(() => {
      panel.querySelectorAll(".mg-bubble").forEach((x) => x.classList.remove("reveal"));
      if (round >= 5) { endGame(false); return; }
      sayEl.textContent = `Manche ${round + 1} / 5 — où suis-je ?`;
      busy = false;
    }, 700);
  }));
}

function checkAchievements() {
  for (const a of ACHS) {
    if (!S.achievements.includes(a.id) && a.test(S)) {
      S.achievements.push(a.id);
      toast(`Succès : ${a.label}`);
    }
  }
}

// ---------- Conversation ----------
function addRow(who, text, cls = "") {
  const row = document.createElement("div");
  row.className = `row ${who} ${cls}`;
  row.innerHTML = `<div class="bubble"></div>`;
  row.querySelector(".bubble").textContent = text;
  $("log").appendChild(row); $("log").scrollTop = $("log").scrollHeight;
  return row;
}
function petPrompt(history) {
  const mem = S.memories.slice(-14).map((m) => "- " + m.note).join("\n") || "(aucun pour l'instant)";
  const state = `État — faim ${S.faim}, humeur ${S.humeur}, énergie ${S.energie}, propreté ${S.proprete}, complicité ${S.complicite} (sur 100).`
    + (S.asleep ? " Tu es à moitié endormi." : "") + (S.sick ? " Tu es malade et tu aimerais être soigné." : "") + (S.mess ? " Ton coin est un peu sale, tu aimerais un nettoyage." : "");
  return PROMPTS["app.aipet.chat"].build({
    name: S.name, stage: stage().name, level: level(S.xp), traits: topTraits().join(", ") || "encore en formation",
    state, memories: mem, history, lang: replyLang(),
  });
}
async function talk(text) {
  addRow("me", text);
  S.history.push({ role: "user", text });
  const thinking = addRow("pet", "…", "thinking");
  $("send").disabled = true; setOrbState("thinking");
  const { messages, opts } = petPrompt(S.history.slice(-8).map((h) => ({ role: h.role === "user" ? "user" : "assistant", content: h.text })));
  // Système 1 (Tev1), en parallèle de la réponse : faut-il mémoriser ce que
  // dit l'humain, et quelle humeur montrer ? (le modèle de discussion ratait
  // des faits importants, comme un permis de conduire tout juste obtenu)
  const decider = appDecider({ aiSource: localStorage.getItem("aiSource") || "llama", ollamaUrl: localStorage.getItem("ollamaUrl") || "http://localhost:11434", invoke: window.__TAURI__?.core?.invoke });
  const judged = decider ? Promise.all([
    decider.decide("rememberFact", { message: text }).catch(() => null),
    decider.decide("mood", { character: `${S.name}, a virtual pet`, event: `Its human says: ${text}` }).catch(() => null),
  ]) : Promise.resolve([null, null]);
  try {
    const { content, data } = await llmChat(messages, { ...opts, rawSystem: true });
    const [keep, felt] = await judged;
    // Récompense en ✦ = tokens générés par CETTE réponse (Ollama: eval_count ;
    // API: usage.completion_tokens). Lu seulement, jamais reporté au vrai compteur.
    const gen = Number(data?.eval_count || data?.usage?.completion_tokens || 0);
    let reply = content, remember = null, mood = "neutral";
    try { const j = JSON.parse(content); reply = j.reply || content; remember = j.remember || null; mood = j.mood || "neutral"; } catch {}
    if (remember && String(remember).toLowerCase() === "null") remember = null;
    // Le moteur de décision tranche quand il est sûr de lui : un fait durable
    // oublié est gardé tel que l'humain l'a dit ; une banalité n'est pas retenue.
    if (keep?.value === true && !remember) remember = text;
    if (keep?.value === false) remember = null;
    if (felt?.value) mood = felt.value;
    thinking.remove();
    addRow("pet", reply);
    speak(reply);
    S.history.push({ role: "pet", text: reply });
    if (S.history.length > 16) S.history = S.history.slice(-16);
    if (remember && String(remember).toLowerCase() !== "null") {
      S.memories.push({ t: Date.now(), note: String(remember).slice(0, 200) });
      if (S.memories.length > 60) S.memories = S.memories.slice(-60);
    }
    S.acts.talk++; S.complicite = clamp(S.complicite + 2);
    S.humeur = clamp(S.humeur + (mood === "happy" ? 5 : mood === "sad" ? -2 : 2));
    gain(2);
    if (gen > 0) earn(gen); // crédite le solde de ✦ sans toucher le compteur réel
    setOrbState("speaking"); setTimeout(() => setOrbState("idle"), 2200);
    checkAchievements(); renderAll(); save();
  } catch {
    thinking.querySelector(".bubble").textContent = "(je n'arrive pas à répondre… le moteur IA est-il configuré ?)";
    setOrbState("idle");
  } finally {
    $("send").disabled = false;
  }
}

// ---------- Réglages ----------
function openSettings() {
  $("set-name").value = S.name;
  const charSel = $("set-character");
  const en = appLang() === "en";
  charSel.innerHTML = Object.entries(ORB_CHARACTERS)
    .map(([id, c]) => `<option value="${id}">${en ? c.en : c.name}</option>`).join("");
  charSel.value = orbCharacter();
  showCharacter();
  $("set-size").value = setting("aipetOrbSize", "210"); $("size-out").textContent = $("set-size").value;
  $("set-core").value = setting("aipetOrbCore", "82");
  $("set-glass").value = setting("aipetOrbGlass", "crystal");
  $("set-bg").value = localStorage.getItem("aipetBg") || "#f0eefb";
  $("set-text").value = localStorage.getItem("aipetText") || "auto";
  $("set-speak").checked = localStorage.getItem("aipetSpeak") === "1";
  populateVoices();
  $("mem-hint").textContent = "Fusionne et nettoie les souvenirs à l'aide de l'IA.";
  const sw = $("swatches"); sw.innerHTML = "";
  baseColors().forEach((c, i) => {
    const inp = document.createElement("input");
    inp.type = "color"; inp.value = c;
    inp.addEventListener("input", () => {
      const cols = baseColors(); cols[i] = inp.value;
      localStorage.setItem("aipetOrbColors", JSON.stringify(cols));
      applyOrbMood();
    });
    sw.appendChild(inp);
  });
  $("settings").hidden = false;
}
function bindSettings() {
  $("settings").addEventListener("click", (e) => { if (e.target.id === "settings" || e.target.dataset.close !== undefined) $("settings").hidden = true; });
  $("set-name").addEventListener("input", () => { S.name = $("set-name").value.trim().slice(0, 24) || "Nimbo"; renderAll(); save(); });
  $("set-character").addEventListener("change", () => {
    localStorage.setItem("aipetOrbCharacter", $("set-character").value);
    showCharacter();
    applyOrbAppearance();
  });
  $("set-size").addEventListener("input", () => { localStorage.setItem("aipetOrbSize", $("set-size").value); $("size-out").textContent = $("set-size").value; orb?.setSize(parseInt($("set-size").value, 10)); });
  $("set-core").addEventListener("input", () => { localStorage.setItem("aipetOrbCore", $("set-core").value); orb?.setCoreScale(parseInt($("set-core").value, 10)); });
  $("set-glass").addEventListener("change", () => { localStorage.setItem("aipetOrbGlass", $("set-glass").value); orb?.setGlassType($("set-glass").value); });
  $("set-bg").addEventListener("input", () => { localStorage.setItem("aipetBg", $("set-bg").value); applyBg(); });
  $("bg-auto").addEventListener("click", () => { localStorage.removeItem("aipetBg"); applyBg(); });
  $("set-text").addEventListener("change", () => { localStorage.setItem("aipetText", $("set-text").value); applyText(); });
  $("set-voice").addEventListener("change", () => { localStorage.setItem("aipetVoiceURI", $("set-voice").value); });
  $("set-speak").addEventListener("change", () => {
    const on = $("set-speak").checked;
    localStorage.setItem("aipetSpeak", on ? "1" : "0");
    if (on) speak(`Coucou, je suis ${S.name} !`); else speechSynthesis.cancel();
  });
  $("consolidate-mem").addEventListener("click", consolidateMemory);
  $("rainbow").addEventListener("click", () => { localStorage.setItem("aipetOrbColors", JSON.stringify(RAINBOW)); openSettings(); applyOrbMood(); });
  $("reset-pet").addEventListener("click", async () => {
    // window.confirm() est inopérant dans la webview Tauri : dialogue maison.
    if (!(await confirmDialog("Oublier ce compagnon et tout recommencer ?", "Recommencer"))) return;
    S = DEFAULT(); $("log").innerHTML = ""; $("settings").hidden = true; renderAll(); save(); greet();
  });
}

// ---------- Bind ----------
function doAction(act) {
  const fn = ACTIONS[act]; if (!fn) return;
  const cost = COST[act] || 0;
  if (cost > 0 && S.wallet < cost) {
    say(`Il me faut ${cost} ✦ pour ça…`);
    toast(`Pas assez de ✦ (${cost}) — discute avec l'IA pour en gagner`);
    return;
  }
  const ok = fn();
  if (ok !== false && cost > 0) { spend(cost); }
  renderWallet(); save();
}
// Étiquette de prix sous chaque bouton d'action payant.
document.querySelectorAll(".act").forEach((b) => {
  const c = COST[b.dataset.act] || 0;
  if (c > 0) { const e = document.createElement("span"); e.className = "cost"; e.textContent = "✦" + c; b.appendChild(e); }
});
document.querySelectorAll(".act, .tool").forEach((b) => b.addEventListener("click", () => doAction(b.dataset.act)));
$("composer").addEventListener("submit", (e) => { e.preventDefault(); const v = $("msg").value.trim(); if (!v || S.asleep) { if (S.asleep) say("Zzz… réveille-moi d'abord."); return; } $("msg").value = ""; talk(v); });
window.addEventListener("beforeunload", save);
bindSettings();
load();

// i18n : traduit le DOM statique + le contenu rendu dynamiquement (mode EN).
autoTranslate({ observe: true });
