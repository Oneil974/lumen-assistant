import { autoTranslate, tt } from "../apps-i18n.js";
import { llmChat, ollamaGetJson, ollamaPostJson } from "../llm.js";
import { recordOllamaUsage } from "../ollama-usage.js";
import { PROMPTS } from "./prompts.js";
import { appDecider } from "../lib/decisions.js";

const $ = (s) => document.querySelector(s);
const storeKey = "lumenGameScores";
const ICONS = {
  gamepad: '<path d="M6.5 11h3M8 9.5v3M15 10.8h.01M17.5 12.8h.01"/><path d="M7 7h10a5 5 0 0 1 4.6 6.9l-1 2.5a2.6 2.6 0 0 1-4.5.6l-1.4-1.8H9.3L7.9 18a2.6 2.6 0 0 1-4.5-.6l-1-2.5A5 5 0 0 1 7 7z"/>',
  sparkles: '<path d="M12 3l1.7 4.8L18.5 9.5 13.7 11.2 12 16 10.3 11.2 5.5 9.5 10.3 7.8z"/><path d="M18.5 14l.8 2.2L21.5 17l-2.2.8L18.5 20l-.8-2.2L15.5 17l2.2-.8z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.7 2.7 0 1 1 4.6 1.9c-1.2 1-2.1 1.5-2.1 3.1"/><path d="M12 17.5h.01"/>',
  word: '<path d="M4 19V5h7a4 4 0 0 1 0 8H4"/><path d="M12 13l5 6"/><path d="M15 5h5M17.5 5v14"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
  trophy: '<path d="M8 21h8M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4a3 3 0 0 0 3 3M17 6h3a3 3 0 0 1-3 3"/>',
  handshake: '<path d="M8.5 13.5l2 2a2 2 0 0 0 2.8 0l4.2-4.2"/><path d="M14 7l1.5-1.5a3 3 0 0 1 4.2 0l1.3 1.3-5 5"/><path d="M10 7 8.5 5.5a3 3 0 0 0-4.2 0L3 6.8l6.5 6.7"/>',
  code: '<path d="M8 9l-4 3 4 3M16 9l4 3-4 3M14 5l-4 14"/>',
  speaker: '<path d="M5 9.5v5h3l4.5 3.5V6L8 9.5z"/><path d="M16 9.5a4 4 0 0 1 0 5"/><path d="M18.5 7.5a7 7 0 0 1 0 9"/>',
  trash: '<path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.sparkles}</svg>`;

const PERSONAS = [
  { id: "coach", name: "Coach cool", tone: "bienveillant, malicieux, concis" },
  { id: "rival", name: "Rival piquant", tone: "compétitif, drôle, jamais méchant" },
  { id: "detective", name: "Détective froid", tone: "calme, précis, soupçonneux" },
  { id: "chaos", name: "Imprévisible", tone: "créatif, joueur, surprenant" },
];
const GAMES = [
  { id: "detective", name: "Détective IA", tag: "Interroge, déduis, accuse", icon: "search", c1: "#5856d6", c2: "#ff2d92" },
  { id: "connect4", name: "Puissance 4", tag: "Tactique rapide", icon: "grid", c1: "#ff2d55", c2: "#ff9f0a" },
  { id: "twenty", name: "20 Questions", tag: "Devine sans spoiler", icon: "help", c1: "#0a84ff", c2: "#64d2ff" },
  { id: "language", name: "Jeux de langage", tag: "Mots, chaînes, punchlines", icon: "word", c1: "#34c759", c2: "#30d158" },
  { id: "battleship", name: "Bataille navale", tag: "Grille cachée, tirs honnêtes", icon: "target", c1: "#007aff", c2: "#5ac8fa" },
  { id: "trivia", name: "Duel de trivia", tag: "Culture générale nerveuse", icon: "trophy", c1: "#ff9f0a", c2: "#ff375f" },
  { id: "negotiation", name: "Négociation", tag: "Convaincre sans forcer", icon: "handshake", c1: "#af52de", c2: "#0a84ff" },
  { id: "code", name: "Code breaker", tag: "Devine la sortie JS", icon: "code", c1: "#30d158", c2: "#0a84ff" },
];

let state = { game: "detective", data: null, busy: false };
let scores = loadScores();
let audioCtx = null;
let soundOn = localStorage.getItem("gamesSound") !== "false";

function loadScores() {
  try { return JSON.parse(localStorage.getItem(storeKey)) || freshScores(); } catch { return freshScores(); }
}
function freshScores() { return { user: 0, games: 0, models: {} }; }
function saveScores() { localStorage.setItem(storeKey, JSON.stringify(scores)); renderScores(); }
function addScore(delta, model, game) {
  scores.user += delta;
  scores.games += 1;
  const key = model || "bot-local";
  scores.models[key] = scores.models[key] || { points: 0, games: 0, wins: 0 };
  scores.models[key].points -= delta;
  scores.models[key].games += 1;
  if (delta < 0) scores.models[key].wins += 1;
  log(`<strong>${game}</strong> score ${delta >= 0 ? "+" : ""}${delta} pour toi.`);
  if (delta > 0) notify("Victoire", `${game} · +${delta} points`, "win");
  else if (delta < 0) notify("Défaite", `${game} · ${delta} points`, "lose");
  else notify("Égalité", `${game} · score neutre`, "hit");
  playSound(delta > 0 ? "win" : delta < 0 ? "lose" : "draw");
  flash(delta > 0 ? "win" : delta < 0 ? "lose" : "hit");
  saveScores();
}
function selectedModelValue() { return $("#model-input")?.value || ""; }
function selectedModelName() {
  const v = selectedModelValue();
  if (v.startsWith("ollama:")) return v.slice(7);
  if (v.startsWith("api:")) return v.slice(4);
  return "";
}
function modelName() { return selectedModelName() || localStorage.getItem("apiModel") || localStorage.getItem("selectedModel") || "bot-local"; }
function persona() { return PERSONAS.find((p) => p.id === $("#persona-select").value) || PERSONAS[0]; }
function mode() { return $("#mode-select").value; }
function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c])); }
function log(html) { const el = document.createElement("div"); el.className = "log-item"; el.innerHTML = html; $("#log").prepend(el); }

function ensureAudio() {
  if (!soundOn) return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!audioCtx) audioCtx = new AC();
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  return audioCtx;
}
function tone(freq, at, dur, gain = 0.06, type = "sine") {
  const ctx = ensureAudio();
  if (!ctx) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, ctx.currentTime + at);
  g.gain.setValueAtTime(0.0001, ctx.currentTime + at);
  g.gain.exponentialRampToValueAtTime(gain, ctx.currentTime + at + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + dur);
  o.connect(g); g.connect(ctx.destination);
  o.start(ctx.currentTime + at); o.stop(ctx.currentTime + at + dur + 0.03);
}
function noise(at, dur, gain = 0.04) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const buf = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * dur)), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const src = ctx.createBufferSource();
  const hp = ctx.createBiquadFilter();
  const g = ctx.createGain();
  hp.type = "highpass"; hp.frequency.value = 1800;
  g.gain.value = gain;
  src.buffer = buf; src.connect(hp); hp.connect(g); g.connect(ctx.destination);
  src.start(ctx.currentTime + at);
}
function playSound(kind) {
  if (!soundOn) return;
  if (kind === "tap") tone(520, 0, .07, .035, "triangle");
  else if (kind === "ai") { tone(330, 0, .06, .03, "sine"); tone(440, .05, .08, .025, "sine"); }
  else if (kind === "hit") { noise(0, .16, .055); tone(180, 0, .12, .035, "sawtooth"); }
  else if (kind === "miss") { tone(260, 0, .09, .03, "triangle"); tone(190, .07, .11, .025, "triangle"); }
  else if (kind === "ok") { tone(520, 0, .08, .04); tone(780, .07, .12, .04); }
  else if (kind === "bad") { tone(220, 0, .12, .04, "sawtooth"); tone(165, .08, .16, .032, "sawtooth"); }
  else if (kind === "win") { [523, 659, 784, 1046].forEach((f, i) => tone(f, i * .07, .16, .045)); }
  else if (kind === "lose") { [392, 330, 262].forEach((f, i) => tone(f, i * .09, .18, .04, "triangle")); }
  else if (kind === "draw") { tone(440, 0, .1, .035); tone(440, .12, .1, .028); }
  else if (kind === "start") { tone(440, 0, .07, .03); tone(660, .06, .1, .035); }
}
function notify(title, message = "", kind = "hit") {
  const host = $("#toast-host");
  if (!host) return;
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="toast-ic">${icon(kind === "win" ? "trophy" : kind === "lose" ? "target" : "sparkles")}</span><div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}</span></div>`;
  host.prepend(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transform = "translateY(-8px) scale(.97)"; }, 2200);
  setTimeout(() => el.remove(), 2600);
}
function flash(kind = "hit") {
  const arena = $("#arena");
  if (!arena) return;
  const cls = kind === "win" ? "flash-win" : kind === "lose" ? "flash-lose" : "flash-hit";
  arena.classList.remove("flash-win", "flash-lose", "flash-hit");
  void arena.offsetWidth;
  arena.classList.add(cls);
}
function setSoundButton() {
  const b = $("#btn-sound");
  if (!b) return;
  b.classList.toggle("muted-sound", !soundOn);
  b.title = soundOn ? "Désactiver les sons" : "Activer les sons";
}

function applyIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((el) => { el.innerHTML = icon(el.dataset.icon); });
}
function renderScores() {
  $("#user-score").textContent = scores.user;
  $("#score-sub").textContent = scores.games ? `${scores.games} parties terminées` : "Aucune partie terminée.";
  const rows = Object.entries(scores.models).sort((a, b) => b[1].points - a[1].points).slice(0, 8);
  $("#model-board").innerHTML = rows.length ? rows.map(([name, s]) => `<div class="rank"><span>${escapeHtml(name)}<br>${s.games} parties · ${s.wins} victoires</span><strong>${s.points}</strong></div>`).join("") : `<div class="log-item">Les modèles apparaîtront ici après les premières parties.</div>`;
}

// `tool.moves` (facultatif) : coups légaux énumérés [{ key, description, action }].
// Le moteur de décision (Tev1, ~0,2 s) choisit alors directement parmi eux ;
// le modèle de discussion ne sert qu'aux coups ouverts (mots, réponses libres).
async function aiAction(tool, publicState, fallback) {
  const p = persona();
  if (mode() === "coach") return fallback();
  const moves = (tool.moves || []).slice(0, 24);
  if (moves.length >= 2) {
    const decider = appDecider({ aiSource: localStorage.getItem("aiSource") || "llama", ollamaUrl: localStorage.getItem("ollamaUrl") || "http://localhost:11434", invoke: window.__TAURI__?.core?.invoke });
    const pick = decider ? await decider.decide("gameMove", { game: GAMES.find((g) => g.id === state.game)?.name || state.game, state: publicState, moves }).catch(() => null) : null;
    const move = pick && moves.find((m) => String(m.key) === String(pick.value));
    if (move && tool.validate(move.action)) return move.action;
  }
  const prompt = PROMPTS["app.games.player"].build({ toolName: tool.name, schema: tool.schema, state: publicState, tone: p.tone }).messages;
  try {
    const { content } = await gameChat(prompt, { json: true });
    const parsed = JSON.parse(content.replace(/^```json|```$/g, "").trim());
    if (tool.validate(parsed)) return parsed;
  } catch (e) {
    log(`Le modèle n'a pas répondu proprement, bot local activé.`);
  }
  return fallback();
}

async function gameChat(messages, opts = {}) {
  const value = selectedModelValue();
  if (value.startsWith("ollama:")) {
    const model = value.slice(7);
    const body = { model, messages, stream: false };
    if (opts.json) body.format = "json";
    const data = await ollamaPostJson("api/chat", body, localStorage.getItem("ollamaUrl") || "http://localhost:11434");
    recordOllamaUsage(data, "games");
    return { content: data?.message?.content || "", data };
  }
  if (value.startsWith("api:")) {
    return llmChat(messages, { ...opts, rawSystem: true, model: value.slice(4) });
  }
  const res = await llmChat(messages, { ...opts, rawSystem: true });
  recordOllamaUsage(res.data, "games");
  return res;
}

async function loadModelOptions() {
  const select = $("#model-input");
  const saved = localStorage.getItem("gamesModel") || "";
  const currentApi = localStorage.getItem("apiModel") || "";
  const currentLocal = localStorage.getItem("selectedModel") || "";
  const options = [{ value: "", label: tt("Modèle global") }];
  if (currentLocal) options.push({ value: `ollama:${currentLocal}`, label: `Local · ${currentLocal}` });
  if (currentApi) options.push({ value: `api:${currentApi}`, label: `API · ${currentApi}` });
  try {
    const data = await ollamaGetJson("api/tags", localStorage.getItem("ollamaUrl") || "http://localhost:11434");
    const names = (data.models || []).map((m) => m.name).filter(Boolean).sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const value = `ollama:${name}`;
      if (!options.some((o) => o.value === value)) options.push({ value, label: `Local · ${name}` });
    }
  } catch {
    log(tt("Impossible de charger la liste Ollama locale. Le modèle global reste disponible."));
  }
  select.innerHTML = options.map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join("");
  if (saved && options.some((o) => o.value === saved)) select.value = saved;
  else if (currentLocal && options.some((o) => o.value === `ollama:${currentLocal}`)) select.value = `ollama:${currentLocal}`;
  select.addEventListener("change", () => {
    localStorage.setItem("gamesModel", select.value);
    log(`${tt("Modèle de jeu :")} <strong>${escapeHtml(modelName())}</strong>`);
  });
}

function setGame(id) {
  state.game = id;
  $("#game-title").textContent = tt(GAMES.find((g) => g.id === id).name);
  $("#game-kicker").textContent = tt(GAMES.find((g) => g.id === id).tag);
  document.querySelectorAll(".game-item").forEach((b) => b.classList.toggle("active", b.dataset.id === id));
  playSound("tap");
  newGame();
}
function newGame() {
  state.busy = false;
  const renderers = { detective, connect4, twenty, language, battleship, trivia, negotiation, code };
  renderers[state.game].start();
  playSound("start");
  notify(tt("Nouvelle partie"), tt(GAMES.find((g) => g.id === state.game)?.name || "Jeu"), "hit");
}

function shell(main, side = "", opts = {}) {
  $("#arena").innerHTML = `<div class="game-shell ${opts.full ? "full" : ""}"><div class="play-panel">${main}</div><div class="side-card">${side}</div></div>`;
}
function chatShell(title, intro, placeholder = "Votre réponse...") {
  shell(`<div class="chat-box"><div class="messages" id="msgs"><div class="bubble">${tt(intro)}</div></div><div class="input-row"><input id="answer" class="input" placeholder="${tt(placeholder)}"/><button id="send" class="btn primary">${tt("Envoyer")}</button></div></div>`, `<strong>${tt(title)}</strong><p class="muted">${tt("Le modèle ne reçoit que le journal public, jamais la solution secrète.")}</p><div class="meter"><span style="width:65%"></span></div>`);
}
function bubble(text, who = "") { const el = document.createElement("div"); el.className = `bubble ${who}`; el.textContent = text; $("#msgs").appendChild(el); $("#msgs").scrollTop = $("#msgs").scrollHeight; }

const connect4 = {
  start() {
    state.data = { board: Array.from({ length: 6 }, () => Array(7).fill(0)), turn: 1, over: false };
    this.render();
  },
  render(msg = "À toi de jouer.") {
    const board = state.data.board.flatMap((row, r) => row.map((v, c) => `<button class="cell" data-col="${c}" ${state.data.over ? "disabled" : ""}>${v ? `<span class="disc ${v === 1 ? "user" : "ai"}"></span>` : ""}</button>`)).join("");
    shell(`<div class="status-line"><span class="pill">${escapeHtml(tt(msg))}</span><span class="pill">${tt("Rouge toi · Bleu IA")}</span></div><div class="grid-connect">${board}</div>`, `<strong>${tt("Règle anti-triche")}</strong><p class="muted">${tt("L'IA appelle seulement l'outil play_column avec une colonne valide.")}</p>`);
    document.querySelectorAll(".cell").forEach((b) => b.addEventListener("click", () => this.user(+b.dataset.col)));
  },
  drop(col, who) {
    for (let r = 5; r >= 0; r--) if (!state.data.board[r][col]) { state.data.board[r][col] = who; return true; }
    return false;
  },
  valid() { return [...Array(7).keys()].filter((c) => !state.data.board[0][c]); },
  winner() {
    const b = state.data.board;
    for (let r = 0; r < 6; r++) for (let c = 0; c < 7; c++) {
      const v = b[r][c]; if (!v) continue;
      for (const [dr, dc] of [[0,1],[1,0],[1,1],[1,-1]]) {
        let n = 0; for (let k = 0; k < 4; k++) if (b[r + dr*k]?.[c + dc*k] === v) n++;
        if (n === 4) return v;
      }
    }
    return this.valid().length ? 0 : 3;
  },
  async user(col) {
    if (state.busy || state.data.over || !this.drop(col, 1)) return;
    playSound("tap"); flash("hit");
    let w = this.winner(); if (w) return this.end(w);
    this.render("L'IA réfléchit...");
    state.busy = true;
    const action = await aiAction({ name: "play_column", schema: { column: "number 0..6" }, validate: (a) => this.valid().includes(a.column),
      moves: this.valid().map((c) => ({ key: c, description: `Drop a disc in column ${c} (0 = leftmost).`, action: { column: c } })) }, { board: state.data.board, validColumns: this.valid() }, () => ({ column: this.bestMove() }));
    this.drop(action.column, 2);
    playSound("ai");
    state.busy = false;
    w = this.winner(); if (w) return this.end(w);
    this.render(`L'IA joue colonne ${action.column + 1}.`);
  },
  bestMove() {
    const valid = this.valid();
    for (const c of valid) { const copy = structuredClone(state.data.board); this.drop(c, 2); if (this.winner() === 2) { state.data.board = copy; return c; } state.data.board = copy; }
    for (const c of valid) { const copy = structuredClone(state.data.board); this.drop(c, 1); if (this.winner() === 1) { state.data.board = copy; return c; } state.data.board = copy; }
    return valid.sort((a, b) => Math.abs(a - 3) - Math.abs(b - 3))[0];
  },
  end(w) { state.data.over = true; this.render(w === 1 ? "Victoire !" : w === 2 ? "L'IA gagne." : "Égalité."); addScore(w === 1 ? 120 : w === 2 ? -90 : 20, modelName(), "Puissance 4"); },
};

const battleship = {
  start() {
    const ships = () => { const s = new Set(); while (s.size < 7) s.add(Math.floor(Math.random() * 36)); return [...s]; };
    state.data = { userShips: ships(), aiShips: ships(), userShots: [], aiShots: [], over: false };
    this.render("Choisis une case sur la grille IA.");
  },
  render(msg) {
    const grid = (owner) => [...Array(36).keys()].map((i) => {
      const mine = owner === "user";
      const shots = mine ? state.data.aiShots : state.data.userShots;
      const ships = mine ? state.data.userShips : state.data.aiShips;
      const shot = shots.includes(i), hit = shot && ships.includes(i), showShip = mine && ships.includes(i);
      return `<button class="sq ${showShip ? "ship" : ""} ${shot ? (hit ? "hit" : "miss") : ""}" data-shot="${owner === "ai" ? i : ""}">${shot ? (hit ? "×" : "•") : ""}</button>`;
    }).join("");
    shell(`<div class="status-line"><span class="pill">${msg}</span><span class="pill">L'IA joue via fire_cell</span></div><div class="battle-wrap"><div class="battle-board"><p class="panel-title">Ta flotte</p><div class="battle-grid">${grid("user")}</div></div><div class="battle-board"><p class="panel-title">Flotte IA</p><div class="battle-grid">${grid("ai")}</div></div></div>`, "", { full: true });
    document.querySelectorAll("[data-shot]").forEach((b) => b.dataset.shot && b.addEventListener("click", () => this.user(+b.dataset.shot)));
  },
  async user(i) {
    if (state.busy || state.data.over || state.data.userShots.includes(i)) return;
    state.data.userShots.push(i);
    const userHit = state.data.aiShips.includes(i);
    playSound(userHit ? "hit" : "miss");
    notify(userHit ? "Touché" : "À l'eau", userHit ? "La flotte IA encaisse." : "Le tir disparaît dans les vagues.", userHit ? "hit" : "miss");
    flash("hit");
    if (this.sunk("ai")) return this.end(1);
    state.busy = true; this.render("L'IA vise...");
    const available = [...Array(36).keys()].filter((x) => !state.data.aiShots.includes(x));
    const action = await aiAction({ name: "fire_cell", schema: { cell: "number 0..35" }, validate: (a) => available.includes(a.cell),
      moves: available.length <= 24 ? available.map((c) => ({ key: c, description: `Fire at cell ${c} (row ${Math.floor(c / 6)}, column ${c % 6}).`, action: { cell: c } })) : [] }, { previousShots: state.data.aiShots.map((x) => ({ cell: x, hit: state.data.userShips.includes(x) })), available }, () => ({ cell: available[Math.floor(Math.random() * available.length)] }));
    state.data.aiShots.push(action.cell); state.busy = false;
    const aiHit = state.data.userShips.includes(action.cell);
    playSound(aiHit ? "hit" : "ai");
    if (aiHit) notify("Impact sur ta flotte", `Case ${action.cell + 1}`, "lose");
    if (this.sunk("user")) return this.end(2);
    this.render(state.data.aiShips.includes(i) ? "Touché ! Continue." : "À l'eau. À toi.");
  },
  sunk(owner) { const ships = owner === "ai" ? state.data.aiShips : state.data.userShips; const shots = owner === "ai" ? state.data.userShots : state.data.aiShots; return ships.every((s) => shots.includes(s)); },
  end(w) { state.data.over = true; this.render(w === 1 ? "Tu as coulé toute la flotte IA." : "L'IA a gagné la bataille."); addScore(w === 1 ? 140 : -100, modelName(), "Bataille navale"); },
};

const twenty = {
  items: ["un volcan", "un piano", "un satellite", "une montre", "un cactus", "un navigateur web"],
  start() {
    state.data = { secret: this.items[Math.floor(Math.random() * this.items.length)], q: 0, done: false };
    chatShell("20 Questions", "Je pense à quelque chose. Pose des questions fermées, puis tente ta chance.", "Question ou accusation...");
    $("#send").addEventListener("click", () => this.ask());
    $("#answer").addEventListener("keydown", (e) => { if (e.key === "Enter") this.ask(); });
  },
  async ask() {
    const text = $("#answer").value.trim(); if (!text || state.data.done) return; $("#answer").value = ""; bubble(text, "user");
    playSound("tap");
    if (text.toLowerCase().includes(state.data.secret.replace(/^un |^une /, ""))) { state.data.done = true; bubble("Bingo. Tu l'as trouvé.", ""); playSound("ok"); return addScore(Math.max(40, 220 - state.data.q * 8), modelName(), "20 Questions"); }
    state.data.q++;
    const ans = await this.answer(text);
    bubble(ans);
    if (state.data.q >= 20) { bubble(`Fin du round. C'était ${state.data.secret}.`); addScore(-40, modelName(), "20 Questions"); }
  },
  async answer(q) {
    const s = state.data.secret;
    const text = q.toLowerCase();
    const facts = {
      "un volcan": [["naturel", "oui"], ["chaud", "oui"], ["vivant", "non"], ["objet", "non"], ["grand", "oui"]],
      "un piano": [["musique", "oui"], ["objet", "oui"], ["électronique", "non"], ["vivant", "non"], ["bois", "probablement"]],
      "un satellite": [["espace", "oui"], ["objet", "oui"], ["vivant", "non"], ["naturel", "non"], ["vole", "oui"]],
      "une montre": [["temps", "oui"], ["objet", "oui"], ["vivant", "non"], ["portable", "oui"], ["grand", "non"]],
      "un cactus": [["vivant", "oui"], ["plante", "oui"], ["eau", "peu"], ["objet", "non"], ["piquant", "oui"]],
      "un navigateur web": [["logiciel", "oui"], ["internet", "oui"], ["objet", "non"], ["vivant", "non"], ["écran", "probablement"]],
    };
    const hit = (facts[s] || []).find(([k]) => text.includes(k));
    if (!hit) return "Je ne sais pas.";
    return hit[1][0].toUpperCase() + hit[1].slice(1) + ".";
  },
};

const detective = {
  cases: [{ culprit: "Mara", clue: "Le reçu du parking contredit son alibi.", people: ["Mara", "Noé", "Iris"], scene: "Un prototype a disparu dans le labo à 22h." }],
  start() {
    state.data = { ...this.cases[0], asked: 0, done: false };
    chatShell("Détective IA", `${state.data.scene} Suspects: ${state.data.people.join(", ")}. Interroge quelqu'un ou accuse.`, "Question ou accusation...");
    $("#send").addEventListener("click", () => this.ask());
    $("#answer").addEventListener("keydown", (e) => { if (e.key === "Enter") this.ask(); });
  },
  async ask() {
    const text = $("#answer").value.trim(); if (!text || state.data.done) return; $("#answer").value = ""; bubble(text, "user");
    if (/accuse|coupable|responsable/i.test(text)) {
      const ok = text.toLowerCase().includes(state.data.culprit.toLowerCase());
      state.data.done = true; bubble(ok ? `Exact. ${state.data.clue}` : `Raté. Le coupable était ${state.data.culprit}. ${state.data.clue}`);
      playSound(ok ? "ok" : "bad");
      return addScore(ok ? Math.max(80, 220 - state.data.asked * 12) : -80, modelName(), "Détective IA");
    }
    playSound("tap");
    state.data.asked++;
    const lower = text.toLowerCase();
    if (lower.includes("mara")) bubble("Mara ajuste ses lunettes: elle dit être partie tôt, mais hésite sur l'heure exacte du parking.");
    else if (lower.includes("noé") || lower.includes("noe")) bubble("Noé montre son badge: il était en salle serveur, confirmé par deux passages de porte.");
    else if (lower.includes("iris")) bubble("Iris est agacée: elle a entendu une voiture démarrer côté parking vers 22h10.");
    else if (lower.includes("parking") || lower.includes("reçu") || lower.includes("recu")) bubble("Le reçu indique une sortie à 22h14. C'est public, mais personne ne l'explique encore clairement.");
    else bubble("Les réponses restent vagues. Un bon angle serait l'horaire, le parking, ou un suspect précis.");
  },
};

const trivia = {
  qs: [
    { q: "Quel langage exécute `console.log` nativement côté navigateur ?", a: "javascript", choices: ["Python", "JavaScript", "Rust", "Swift"] },
    { q: "Quelle planète est surnommée la planète rouge ?", a: "mars", choices: ["Vénus", "Mars", "Jupiter", "Mercure"] },
    { q: "HTTP 404 signifie généralement...", a: "introuvable", choices: ["Succès", "Introuvable", "Interdit", "Trop de requêtes"] },
  ],
  start() { state.data = { i: 0, pts: 0 }; this.render(); },
  render() {
    const q = this.qs[state.data.i];
    shell(`<div class="status-line"><span class="pill">Question ${state.data.i + 1}/${this.qs.length}</span><span class="pill">${state.data.pts} pts</span></div><h3>${escapeHtml(q.q)}</h3><div class="choice-grid">${q.choices.map((c) => `<button class="btn choice" data-choice="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join("")}</div>`, `<strong>Duel</strong><p class="muted">L'IA répond aussi, sans recevoir la bonne réponse. Rapidité et exactitude comptent.</p>`);
    document.querySelectorAll("[data-choice]").forEach((b) => b.addEventListener("click", () => this.answer(b.dataset.choice)));
  },
  async answer(c) {
    const q = this.qs[state.data.i];
    const ai = await aiAction({ name: "answer_trivia", schema: { answer: "one choice text" }, validate: (a) => q.choices.includes(a.answer),
      moves: q.choices.map((c, i) => ({ key: i, description: `Answer: ${c}`, action: { answer: c } })) }, { question: q.q, choices: q.choices }, () => ({ answer: q.choices[Math.floor(Math.random() * q.choices.length)] }));
    const userOk = c.toLowerCase().includes(q.a), aiOk = ai.answer.toLowerCase().includes(q.a);
    playSound(userOk ? "ok" : "bad");
    notify(userOk ? "Bonne réponse" : "Raté", aiOk ? `L'IA marque aussi: ${ai.answer}` : `L'IA répond: ${ai.answer}`, userOk ? "win" : "lose");
    state.data.pts += userOk ? 60 : -20; if (aiOk) state.data.pts -= 25;
    log(`Trivia: toi ${userOk ? "juste" : "faux"}, IA répond ${escapeHtml(ai.answer)}.`);
    state.data.i++;
    if (state.data.i >= this.qs.length) addScore(state.data.pts, modelName(), "Duel de trivia"); else this.render();
  },
};

const code = {
  puzzles: [
    { code: "const a = [1, 2, 3];\nconsole.log(a.map(x => x * 2).join('-'));", out: "2-4-6" },
    { code: "let x = 0;\nfor (let i = 0; i < 4; i++) x += i;\nconsole.log(x);", out: "6" },
    { code: "console.log(Boolean('false'), Number('08') + 1);", out: "true 9" },
  ],
  start() { state.data = { p: this.puzzles[Math.floor(Math.random() * this.puzzles.length)], done: false }; shell(`<pre class="code-card">${escapeHtml(state.data.p.code)}</pre><div class="input-row"><input id="answer" class="input" placeholder="Sortie attendue"/><button id="send" class="btn primary">Valider</button></div>`, `<strong>Code breaker</strong><p class="muted">Le LLM peut jouer aussi via <b>guess_output</b>, mais il ne voit pas la réponse.</p>`); $("#send").addEventListener("click", () => this.guess()); },
  async guess() {
    const v = $("#answer").value.trim(); if (!v || state.data.done) return;
    const ai = await aiAction({ name: "guess_output", schema: { output: "string" }, validate: (a) => typeof a.output === "string" }, { code: state.data.p.code }, () => ({ output: "?" }));
    const ok = v === state.data.p.out; const aiOk = ai.output.trim() === state.data.p.out;
    state.data.done = true;
    playSound(ok ? "ok" : "bad");
    notify(ok ? "Sortie correcte" : "Sortie incorrecte", `Réponse: ${state.data.p.out}`, ok ? "win" : "lose");
    log(`Code breaker: IA propose <strong>${escapeHtml(ai.output)}</strong>. Réponse: <strong>${escapeHtml(state.data.p.out)}</strong>.`);
    addScore((ok ? 130 : -45) + (aiOk ? -35 : 20), modelName(), "Code breaker");
  },
};

const language = {
  start() {
    state.data = { chain: ["lumen"], last: "lumen", pts: 0 };
    shell(`<div class="language-grid">
      <button class="btn word-tile" data-kind="chain"><strong>Chaîne de mots</strong><span class="muted">Commence par la dernière lettre.</span></button>
      <button class="btn word-tile" data-kind="rhyme"><strong>Rime express</strong><span class="muted">Trouve une rime drôle.</span></button>
      <button class="btn word-tile" data-kind="synonym"><strong>Synonyme sprint</strong><span class="muted">Un mot proche, vite.</span></button>
      <button class="btn word-tile" data-kind="story"><strong>Cadavre exquis</strong><span class="muted">Une phrase chacun.</span></button>
    </div><div class="messages" id="msgs"><div class="bubble">Mot de départ: lumen</div></div><div class="input-row"><input id="answer" class="input" placeholder="Ton mot ou ta phrase"/><button id="send" class="btn primary">Jouer</button></div>`, `<strong>Jeux de langage</strong><p class="muted">Le score récompense vitesse, variété et respect de la contrainte.</p>`);
    state.data.kind = "chain";
    document.querySelectorAll("[data-kind]").forEach((b) => b.addEventListener("click", () => { state.data.kind = b.dataset.kind; bubble(`Mode: ${b.querySelector("strong").textContent}`); }));
    $("#send").addEventListener("click", () => this.play());
  },
  async play() {
    const v = $("#answer").value.trim(); if (!v) return; $("#answer").value = ""; bubble(v, "user");
    playSound("tap");
    let delta = 25;
    if (state.data.kind === "chain" && v[0]?.toLowerCase() !== state.data.last.at(-1)) delta = -15;
    if (state.data.chain.includes(v.toLowerCase())) delta = -20;
    state.data.chain.push(v.toLowerCase()); state.data.last = v.toLowerCase(); state.data.pts += delta;
    const ai = await aiAction({ name: "play_word", schema: { text: "string" }, validate: (a) => typeof a.text === "string" && a.text.length < 120 }, { mode: state.data.kind, chain: state.data.chain.slice(-8), last: state.data.last }, () => ({ text: "nectar" }));
    playSound(delta > 0 ? "ok" : "bad");
    bubble(ai.text); state.data.chain.push(ai.text.toLowerCase()); state.data.last = ai.text.toLowerCase();
    if (state.data.chain.length > 10) addScore(state.data.pts, modelName(), "Jeux de langage");
  },
};

const negotiation = {
  start() { state.data = { turns: 0, trust: 45, price: 1000, done: false }; chatShell("Négociation", "Objectif: obtenir le contrat sous 820 crédits sans casser la confiance.", "Votre proposition..."); $("#send").addEventListener("click", () => this.say()); },
  async say() {
    const text = $("#answer").value.trim(); if (!text || state.data.done) return; $("#answer").value = ""; bubble(text, "user"); state.data.turns++;
    const amount = +(text.match(/\d+/)?.[0] || 0); if (amount && amount < state.data.price) state.data.price = Math.max(amount, 700);
    state.data.trust += /merci|partenariat|long terme|ensemble/i.test(text) ? 12 : -4;
    if (state.data.price <= 820 && state.data.trust >= 45) { state.data.done = true; bubble("Marché conclu. Vous avez été ferme sans être sec."); return addScore(180 - state.data.turns * 10, modelName(), "Négociation"); }
    if (state.data.turns >= 6 || state.data.trust < 15) { state.data.done = true; bubble("La discussion s'arrête. L'accord n'est pas signé."); return addScore(-70, modelName(), "Négociation"); }
    playSound(state.data.trust >= 50 ? "ok" : "tap");
    try {
      const { content } = await gameChat(PROMPTS["app.games.negotiation"].build({ message: text, price: state.data.price, trust: state.data.trust, lang: "fr" }).messages);
      bubble(content);
    } catch { bubble(`Je peux descendre à ${Math.max(850, state.data.price - 40)}, mais j'ai besoin d'une garantie.`); }
  },
};

async function init() {
  applyIcons();
  $("#persona-select").innerHTML = PERSONAS.map((p) => `<option value="${p.id}">${tt(p.name)}</option>`).join("");
  await loadModelOptions();
  $("#game-list").innerHTML = GAMES.map((g, i) => `<button class="game-item ${i === 0 ? "active" : ""}" data-id="${g.id}"><span class="game-ic" style="--c1:${g.c1};--c2:${g.c2}">${icon(g.icon)}</span><span class="game-text"><strong>${tt(g.name)}</strong><span>${tt(g.tag)}</span></span></button>`).join("");
  document.querySelectorAll(".game-item").forEach((b) => b.addEventListener("click", () => setGame(b.dataset.id)));
  $("#btn-new").addEventListener("click", newGame);
  $("#btn-sound").addEventListener("click", () => {
    soundOn = !soundOn;
    localStorage.setItem("gamesSound", String(soundOn));
    setSoundButton();
    if (soundOn) { playSound("ok"); notify(tt("Sons activés"), tt("L'arcade prend vie."), "win"); }
    else notify(tt("Sons désactivés"), tt("Mode discret."), "hit");
  });
  $("#btn-reset-scores").addEventListener("click", () => { scores = freshScores(); saveScores(); log(tt("Scores remis à zéro.")); });
  setSoundButton();
  renderScores();
  setGame("detective");
}
window.addEventListener("DOMContentLoaded", init);

// i18n : traduit le DOM statique + le contenu rendu dynamiquement (mode EN).
autoTranslate({ observe: true });
