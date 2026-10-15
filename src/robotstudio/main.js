// Robot Studio — éditeur par blocs pour Raspberry Pi.
//
// Les blocs et leurs générateurs Python viennent tels quels de Rpi-Robot-Studio
// (blocks.js, script classique qui s'appuie sur le `Blockly` global). Ce module
// apporte ce que faisait le serveur Flask : projets, appareils, blocs perso,
// export et déploiement — ce dernier par les commandes SSH de Lumen
// (`pi_scp_push` / `pi_ssh_exec`, authentification par clé uniquement).
//
// Sur le Pi : un environnement Python partagé `~/rpirobotstudio` (le même
// chemin que l'app d'origine, pour qu'un Pi déjà préparé serve tel quel) et
// un dossier par projet `~/robot-studio/<projet>/`.

import { autoTranslate, tt, registerTranslations } from "../apps-i18n.js";
import { createStore } from "../lib/app-state.js";
import { confirmSheet, promptSheet } from "../lib/confirm.js";
import { markdownToHtml } from "../lib/markdown.js";
import { llmChat } from "../llm.js";
import { streamTarget } from "../lib/stream-view.js";
import { replyLang } from "../lib/prompt-lang.js";
import { PROMPTS } from "./prompts.js";
import { ROBOTSTUDIO_EN } from "./i18n.js";

registerTranslations(ROBOTSTUDIO_EN);
autoTranslate({ observe: true });

const __TAURI = window.__TAURI__ || (window.parent && window.parent.__TAURI__) || {};
const invoke = __TAURI.core?.invoke;
const Blockly = window.Blockly;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = createStore("robotstudio");

const ENV_DIR = "rpirobotstudio";      // relatif au $HOME du Pi
const PROJECTS_DIR = "robot-studio";

let projects = [];      // [{ id, name, xml, updated }]
let devices = [];       // [{ id, name, host, user, port }]
let components = [];    // blocs perso, forme de Rpi-Robot-Studio
let currentId = "";
let deviceId = "";
let workspace = null;
let saveTimer = null;

// Blockly 9 : `Blockly.Xml.textToDom` ; les versions récentes l'ont déplacé.
const textToDom = (t) => (Blockly.utils.xml.textToDom || Blockly.Xml.textToDom)(t);

// ===== Boîtes de dialogue de Blockly ======================================
// `prompt()` / `confirm()` ne font rien dans la webview de Lumen : Blockly
// (nouvelle variable, renommage, suppression) passe par les feuilles maison.
Blockly.dialog.setPrompt((message, defaultValue, callback) => {
  promptSheet({ title: message, value: defaultValue || "", confirm: tt("Valider"), cancel: tt("Annuler") }).then(callback);
});
Blockly.dialog.setConfirm((message, callback) => {
  confirmSheet({ title: message, confirm: tt("Confirmer"), cancel: tt("Annuler") }).then(callback);
});
Blockly.dialog.setAlert((message, callback) => {
  confirmSheet({ title: message, confirm: "OK", cancel: tt("Fermer") }).then(() => callback?.());
});

// ===== Boîte à blocs =======================================================
const CATEGORIES = [
  ["Logique", "210", ["controls_if", "logic_compare", "logic_boolean"]],
  ["Boucles", "120", ["controls_repeat_ext", "logic_while", "logic_loop", "time_wait"]],
  ["Structure", "20", ["setup_block", "loop_block", "loop_function", "loop_function_call"]],
  ["Maths", "230", ["math_number"]],
  ["Texte", "160", ["text"]],
  ["Variables", "330", null],
  ["Raspberry Pi", "#BC3657", ["rpi_gpio_write", "rpi_rgb_led", "ws2812b_set_pixel", "ws2812b_fill", "rpi_gpio_read", "rpi_servo", "rpi_ultrasonic", "rpi_cpu_temp", "rpi_gpu_temp", "rpi_cpu_usage", "rpi_ram_usage", "i2c_write", "i2c_read", "serial_send", "serial_read", "mfrc522_read", "mfrc522_write", "ds18b20_temp", "dht11_temp", "dht11_humidity", "dht22_temp", "dht22_humidity", "rpi_motion", "ir_receive", "ir_send", "rpi_encoder_steps", "rpi_encoder_direction", "ads1015_read", "rpi_camera_photo", "rpi_camera_video"]],
  ["Réseau", "#76CB6F", ["http_get", "https_get", "http_wait", "http_get_request", "mqtt_config", "mqtt_publish", "mqtt_subscribe", "ws_start", "ws_running", "ws_send", "ws_client_count"]],
  ["Mémoire", "#795548", ["memory_set", "memory_get", "memory_delete"]],
  ["Journal", "#5C6BC0", ["device_log_message", "device_log_metric"]],
  ["IA", "#87CEEB", ["hailo_yolo_start", "hailo_yolo_get", "ai_request", "ollama_start", "ollama_stop", "ollama_ps", "ml_predict", "ml_predict_image", "ml_predict_yolo", "ml_local_predict", "ml_local_predict_image", "ml_local_predict_yolo"]],
  ["Écran", "#FF9800", ["ui_start", "ui_launch", "ui_config", "ui_add_text", "ui_set_text", "ui_add_image", "ui_add_sprite", "ui_set_text_color", "ui_set_text_size", "ui_set_position", "ui_set_rotation", "ui_set_image_source", "ui_set_sprite_frames", "ui_sprite_play", "ui_sprite_pause", "ui_sprite_set_frame", "ui_sprite_set_fps", "ui_sprite_set_loop", "ui_set_size", "ui_set_visible", "ui_get_event"]],
  ["Audio", "#E91E63", ["play_audio", "pause_audio", "stop_audio", "set_volume", "piper_config", "piper_speak", "piper_cli"]],
  ["JSON", "65", ["json_parse", "json_get", "json_set", "json_stringify"]],
  ["Lumen", "#7C5CFF", window.LUMEN_BLOCKS || []],
];

// Entrées numériques livrées avec une valeur, pour qu'un bloc posé tel quel
// génère du Python valide.
const SHADOWS = { set_volume: ["VOL", 100], time_wait: ["SECS", 1], controls_repeat_ext: ["TIMES", 10], lumen_reminder: ["MIN", 10] };
// Textes par défaut des blocs Lumen, pour qu'ils soient utilisables posés tels quels.
const TEXT_SHADOWS = {
  lumen_notify: { TITLE: "Robot", BODY: "Bonjour depuis le Raspberry Pi" },
  lumen_ask: { PROMPT: "Donne-moi une idée de mouvement pour un petit robot" },
  lumen_speak: { TEXT: "Bonjour" },
  lumen_remember: { TEXT: "Le robot a démarré" },
  lumen_recall: { QUERY: "robot" },
  lumen_mem_set: { KEY: "etat", VALUE: "actif" },
  lumen_mem_get: { KEY: "etat" },
  lumen_agent: { AGENT: "Assistant", TASK: "Résume la situation" },
  lumen_agent_task: { AGENT: "Assistant", TASK: "Vérifier le robot" },
  lumen_workflow: { NAME: "", INPUT: "" },
  lumen_inbox: { SUBJECT: "Robot", BODY: "Tâche terminée" },
  lumen_reminder: { TITLE: "Recharger le robot" },
  lumen_photo: { PATH: "photo.jpg", CAPTION: "" },
  lumen_domotique: { DEVICE: "Lampe" },
};

function toolbox() {
  const contents = [];
  for (const [name, colour, blocks] of CATEGORIES) {
    if (!blocks) { contents.push({ kind: "category", name: tt(name), colour, custom: "VARIABLE" }); continue; }
    contents.push({
      kind: "category", name: tt(name), colour,
      contents: blocks.filter((b) => Blockly.Blocks[b]).map((type) => {
        const inputs = {};
        if (SHADOWS[type]) inputs[SHADOWS[type][0]] = { shadow: { type: "math_number", fields: { NUM: SHADOWS[type][1] } } };
        for (const [name, text] of Object.entries(TEXT_SHADOWS[type] || {})) {
          inputs[name] = { shadow: { type: "text", fields: { TEXT: tt(text) } } };
        }
        return Object.keys(inputs).length ? { kind: "block", type, inputs } : { kind: "block", type };
      }),
    });
  }
  const perso = {};
  for (const c of components) (perso[c.category || "Perso"] ||= { colour: c.color || "160", blocks: [] }).blocks.push(c.name);
  for (const [name, { colour, blocks }] of Object.entries(perso)) {
    contents.push({ kind: "category", name, colour, contents: blocks.map((type) => ({ kind: "block", type })) });
  }
  return { kind: "categoryToolbox", contents };
}

// ===== Génération ==========================================================
function generate() {
  if (!workspace) return { code: "", reqs: [] };
  window.workspace = workspace;          // lu par collectRequirements() de blocks.js
  window.savedUiState = {};              // pas de concepteur d'écran visuel ici
  let code = Blockly.Python.workspaceToCode(workspace);
  code = window.injectUiInit(code, window.generateUiInitCode());
  return { code, reqs: window.collectRequirements() };
}

function refreshPython() {
  const { code, reqs } = generate();
  $("python-code").textContent = code || tt("# Assemblez des blocs : le Python apparaît ici.");
  $("python-reqs").textContent = reqs.join("\n") || tt("(aucun paquet)");
}

// ===== Projets =============================================================
const current = () => projects.find((p) => p.id === currentId);
const slug = (name) => String(name || "projet").normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "projet";

function persist() {
  store.set("projects", projects);
  store.set("devices", devices);
  store.set("components", components);
  store.set("current", currentId);
  store.set("device", deviceId);
}

function status(text, kind = "") {
  const el = $("status");
  el.textContent = text || "";
  el.dataset.kind = kind;
}

function saveWorkspaceSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const p = current();
    if (!p || !workspace) return;
    p.xml = Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(workspace));
    p.updated = Date.now();
    persist();
    status(tt("Enregistré"));
  }, 600);
}

function loadProject(id) {
  currentId = id;
  const p = current();
  workspace.clear();
  if (p?.xml) {
    try { Blockly.Xml.domToWorkspace(textToDom(p.xml), workspace); }
    catch (e) { console.warn("[robotstudio] projet illisible", e); }
  } else {
    starterBlocks();
  }
  window.refreshAllLoopFunctionCalls?.(workspace);
  renderProjects();
  refreshPython();
  persist();
}

function starterBlocks() {
  const xml = `<xml><block type="setup_block" x="40" y="40"></block><block type="loop_block" x="40" y="160"><statement name="DO"><block type="rpi_gpio_write"><next><block type="time_wait"><value name="SECS"><shadow type="math_number"><field name="NUM">1</field></shadow></value></block></next></block></statement></block></xml>`;
  try { Blockly.Xml.domToWorkspace(textToDom(xml), workspace); } catch {}
}

function renderProjects() {
  const sel = $("project-select");
  sel.innerHTML = projects.map((p) => `<option value="${esc(p.id)}"${p.id === currentId ? " selected" : ""}>${esc(p.name)}</option>`).join("");
}

async function newProject() {
  const name = await promptSheet({ title: tt("Nom du projet"), value: tt("Mon robot"), confirm: tt("Créer"), cancel: tt("Annuler") });
  if (!name?.trim()) return;
  const p = { id: `p${Date.now()}`, name: name.trim(), xml: "", updated: Date.now() };
  projects.unshift(p);
  loadProject(p.id);
}

async function renameProject() {
  const p = current();
  if (!p) return;
  const name = await promptSheet({ title: tt("Renommer le projet"), value: p.name, confirm: tt("Renommer"), cancel: tt("Annuler") });
  if (!name?.trim()) return;
  p.name = name.trim();
  renderProjects();
  persist();
}

async function deleteProject() {
  const p = current();
  if (!p) return;
  const ok = await confirmSheet({ title: tt("Supprimer « {n} » ?", { n: p.name }), body: tt("Le projet et ses blocs seront effacés de Robot Studio."), confirm: tt("Supprimer"), cancel: tt("Annuler"), danger: true });
  if (!ok) return;
  projects = projects.filter((x) => x.id !== p.id);
  if (!projects.length) projects.push({ id: `p${Date.now()}`, name: tt("Mon robot"), xml: "", updated: Date.now() });
  loadProject(projects[0].id);
}

// ===== Fichiers du projet (export et déploiement) ==========================
async function pickSandbox() {
  let list = [];
  try { list = (await invoke("sandbox_list")) || []; } catch (e) { throw new Error(String(e?.message || e)); }
  if (!list.length) throw new Error(tt("Aucune sandbox : créez-en une dans l'explorateur de fichiers."));
  const saved = store.get("sandbox", "");
  return list.find((s) => s.id === saved) || list[0];
}

/** Écrit project.py, requirements.txt et run_project.sh ; renvoie leurs chemins. */
async function writeProjectFiles() {
  const p = current();
  const { code, reqs } = generate();
  if (!code.trim()) throw new Error(tt("Le projet est vide : ajoutez des blocs."));
  const sb = await pickSandbox();
  const dir = `Robot Studio/${slug(p.name)}`;
  const files = { "project.py": code, "requirements.txt": reqs.join("\n") + (reqs.length ? "\n" : ""), "run_project.sh": `${window.RUN_SH}\n` };
  // Blocs « ml local … » : ils importent ml_inference.py (module de
  // Rpi-Robot-Studio), qui doit voyager avec le programme.
  if (/^import ml_inference$/m.test(code)) {
    files["ml_inference.py"] = await (await fetch("./assets/ml_inference.py")).text();
  }
  // Blocs Lumen : l'adresse et le jeton voyagent à côté du code, pas dedans.
  if (usesLumen() && bridge?.token) {
    files["lumen.json"] = JSON.stringify({ url: bridge.url, token: bridge.token }, null, 2) + "\n";
  }
  for (const [name, content] of Object.entries(files)) {
    await invoke("sandbox_write_file", { id: sb.id, path: `${dir}/${name}`, content });
  }
  return { sb, dir, paths: Object.keys(files).map((n) => `${dir}/${n}`) };
}

async function exportProject() {
  try {
    const { sb, dir } = await writeProjectFiles();
    status(tt("Exporté dans {s} › {d}", { s: sb.name, d: dir }), "ok");
  } catch (e) {
    status(String(e?.message || e), "err");
  }
}

// ===== Appareils ===========================================================
const device = () => devices.find((d) => d.id === deviceId);

function renderDevices() {
  const box = $("device-list");
  if (!devices.length) {
    box.innerHTML = `<div class="empty">${esc(tt("Aucun appareil. Ajoutez votre Raspberry Pi ci-dessous."))}</div>`;
    return;
  }
  box.innerHTML = devices.map((d) => `
    <label class="device${d.id === deviceId ? " on" : ""}">
      <input type="radio" name="device" value="${esc(d.id)}"${d.id === deviceId ? " checked" : ""} />
      <span><b>${esc(d.name || d.host)}</b><i>${esc(d.user)}@${esc(d.host)}:${esc(d.port)}</i></span>
      <button type="button" class="x" data-del="${esc(d.id)}" title="${esc(tt("Retirer"))}">✕</button>
    </label>`).join("");
  box.querySelectorAll('input[name="device"]').forEach((r) => r.addEventListener("change", () => {
    deviceId = r.value; persist(); renderDevices();
  }));
  box.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", (e) => {
    e.preventDefault();
    devices = devices.filter((d) => d.id !== b.dataset.del);
    if (deviceId === b.dataset.del) deviceId = devices[0]?.id || "";
    persist(); renderDevices();
  }));
}

function log(text, reset = false) {
  const el = $("log");
  if (reset) el.textContent = "";
  el.textContent += `${text}\n`;
  el.scrollTop = el.scrollHeight;
}

async function ssh(command) {
  const d = device();
  if (!d) throw new Error(tt("Choisissez d'abord un appareil (onglet Appareils)."));
  const r = await invoke("pi_ssh_exec", { host: d.host, user: d.user, port: Number(d.port) || 22, command });
  if (r.stdout?.trim()) log(r.stdout.trim());
  if (r.stderr?.trim()) log(r.stderr.trim());
  if (!r.ok) throw new Error(tt("La commande SSH a échoué."));
  return r;
}

const remoteDir = () => `${PROJECTS_DIR}/${slug(current()?.name)}`;
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// Motif pour pkill/pgrep -f : la 1re lettre entre crochets. Sans ça, le motif
// figure en clair dans la ligne de commande du shell SSH lui-même, qui se
// retrouve tué (pkill) ou compté (pgrep).
const procPattern = (dir) => shq(`[${dir[0]}]${dir.slice(1)}/project.py`);

async function withLog(label, fn) {
  showTab("devices");
  log(label, true);
  try { await fn(); } catch (e) { log(`✗ ${e?.message || e}`); status(String(e?.message || e), "err"); }
}

const testConnection = () => withLog(tt("Connexion…"), async () => {
  await ssh("uname -a && python3 --version && df -h ~ | tail -1");
  log(`✓ ${tt("Accès SSH OK")}`);
});

const prepareEnv = () => withLog(tt("Préparation de l'environnement Python (~/rpirobotstudio) : plusieurs minutes la première fois…"), async () => {
  await ssh(`[ -d ~/${ENV_DIR} ] || python3 -m venv --system-site-packages ~/${ENV_DIR}; ~/${ENV_DIR}/bin/pip install --quiet --upgrade pip 2>&1 | tail -2; ~/${ENV_DIR}/bin/python --version`);
  log(`✓ ${tt("Environnement prêt")}`);
});

const deploy = () => withLog(tt("Déploiement…"), async () => {
  const d = device();
  if (!d) throw new Error(tt("Choisissez d'abord un appareil (onglet Appareils)."));
  const { sb, paths } = await writeProjectFiles();
  const dir = remoteDir();
  log(tt("Copie des fichiers vers {h}…", { h: d.host }));
  const push = await invoke("pi_scp_push", { host: d.host, user: d.user, port: Number(d.port) || 22, sandbox: sb.id, paths, remoteDir: dir });
  if (!push.ok) { log(push.stderr || push.stdout || ""); throw new Error(tt("La copie a échoué.")); }
  log(tt("Installation des paquets et lancement…"));
  await ssh([
    `cd ${shq(dir)} || exit 1`,
    `chmod +x run_project.sh; [ -f lumen.json ] && chmod 600 lumen.json`,
    `[ -d ~/${ENV_DIR} ] || python3 -m venv --system-site-packages ~/${ENV_DIR}`,
    `if [ -s requirements.txt ]; then ~/${ENV_DIR}/bin/pip install --quiet -r requirements.txt 2>&1 | tail -5; fi`,
    `pkill -f ${procPattern(dir)} || true`,
    `nohup ~/${ENV_DIR}/bin/python "$PWD/project.py" > project.log 2>&1 < /dev/null &`,
    `sleep 1`,
    `if pgrep -f ${procPattern(dir)} > /dev/null; then echo RUNNING; else echo STOPPED; tail -n 20 project.log; exit 1; fi`,
  ].join("\n"));
  log(`✓ ${tt("Programme lancé sur {h}. Journal : ~/{d}/project.log", { h: d.host, d: dir })}`);
  status(tt("Déployé sur {h}", { h: d.name || d.host }), "ok");
});

const stopRemote = () => withLog(tt("Arrêt…"), async () => {
  await ssh(`pkill -f ${procPattern(remoteDir())} && echo ${shq(tt("Programme arrêté."))} || echo ${shq(tt("Aucun programme en cours."))}`);
});

const remoteStatus = () => withLog(tt("État…"), async () => {
  await ssh(`pgrep -af ${procPattern(remoteDir())} || echo ${shq(tt("Le programme ne tourne pas."))}`);
});

const remoteLogs = () => withLog(tt("Journal du programme :"), async () => {
  await ssh(`tail -n 80 ${shq(`${remoteDir()}/project.log`)} 2>/dev/null || echo ${shq(tt("Pas encore de journal."))}`);
});

// ===== Pont Lumen ==========================================================
let bridge = null;
const usesLumen = () => !!workspace?.getAllBlocks(false).some((b) => b.type.startsWith("lumen_"));

async function refreshBridge(opts = {}) {
  if (!invoke) return;
  try {
    bridge = await invoke("robot_bridge_info", { regenerate: !!opts.regenerate, photoSandbox: opts.photoSandbox ?? null });
  } catch (e) {
    $("bridge-url").textContent = String(e?.message || e);
    return;
  }
  $("bridge-url").textContent = bridge.url;
  $("bridge-url").title = bridge.hostname || "";
  $("bridge-token").textContent = `${bridge.token.slice(0, 8)}…${bridge.token.slice(-4)}`;
  let list = [];
  try { list = (await invoke("sandbox_list")) || []; } catch {}
  $("bridge-sandbox").innerHTML = `<option value="">${esc(tt("— aucune —"))}</option>`
    + list.map((sb) => `<option value="${esc(sb.id)}"${sb.id === bridge.photo_sandbox ? " selected" : ""}>${esc(sb.name)}</option>`).join("");
}

// ===== Aide des blocs ======================================================
let docIndex = [];

async function loadDocIndex() {
  try {
    const txt = await (await fetch("./assets/docs/index.txt")).text();
    docIndex = txt.split(/\r?\n/).map((l) => l.trim().replace(/\.md$/, "")).filter(Boolean).sort();
  } catch { docIndex = []; }
  $("doc-select").innerHTML = `<option value="">${esc(tt("Choisir un bloc…"))}</option>`
    + docIndex.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join("");
}

async function showDoc(type) {
  if (!type || !docIndex.includes(type)) return;
  $("doc-select").value = type;
  // Résumé tiré du bloc lui-même : il suit la langue de Lumen, là où les
  // notes détaillées (reprises de Rpi-Robot-Studio) restent en l'état.
  let summary = "";
  try {
    const b = workspace.newBlock(type);
    const tip = typeof b.tooltip === "function" ? b.tooltip() : b.tooltip;
    const pip = String(window.builtinRequirements?.[type] || "").split("\n").filter(Boolean);
    summary = `<div class="doc-sum"><div class="doc-block">${esc(b.toString())}</div>`
      + (tip ? `<p>${esc(tip)}</p>` : "")
      + (pip.length ? `<p class="doc-pip">${esc(tt("Paquets installés sur le Pi :"))} <code>${pip.map(esc).join("</code> <code>")}</code></p>` : "")
      + `</div>`;
    b.dispose(false);
  } catch {}
  let notes = "";
  try {
    const md = await (await fetch(`./assets/docs/${type}.md`)).text();
    notes = `<h2 class="doc-notes-title">${esc(tt("Notes détaillées"))}</h2>${markdownToHtml(md.replace(/^#\s+.*\n/, ""))}`;
  } catch {}
  $("doc").innerHTML = summary + notes || esc(tt("Aide introuvable pour ce bloc."));
}

// ===== Blocs perso =========================================================
function renderCustom() {
  const box = $("custom-list");
  box.innerHTML = components.length
    ? components.map((c) => `<div class="custom"><b>${esc(c.name)}</b><i>${esc(c.category || "Perso")}</i><button type="button" class="x" data-del="${esc(c.name)}" title="${esc(tt("Supprimer"))}">✕</button></div>`).join("")
    : `<div class="empty">${esc(tt("Aucun bloc perso pour l'instant."))}</div>`;
  box.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
    components = components.filter((c) => c.name !== b.dataset.del);
    persist(); renderCustom();
    status(tt("Bloc retiré : il disparaîtra de la boîte à blocs au prochain lancement."));
  }));
}

function addCustom(e) {
  e.preventDefault();
  const comp = {
    name: $("cb-name").value.trim(),
    category: $("cb-category").value.trim() || "Perso",
    color: $("cb-color").value.trim() || "#607D8B",
    params: $("cb-params").value.trim() || "[]",
    imports: $("cb-imports").value.trim(),
    code: $("cb-code").value,
    requirement: $("cb-req").value.trim(),
    output: $("cb-output").value,
    doc: $("cb-doc").value.trim(),
  };
  try { JSON.parse(comp.params); } catch { status(tt("Paramètres : JSON invalide."), "err"); return; }
  if (Blockly.Blocks[comp.name] && !components.some((c) => c.name === comp.name)) {
    status(tt("Ce nom est déjà pris par un bloc existant."), "err"); return;
  }
  components = components.filter((c) => c.name !== comp.name).concat(comp);
  window.loadCustomComponents([comp]);
  workspace.updateToolbox(toolbox());
  persist(); renderCustom();
  e.target.reset();
  status(tt("Bloc « {n} » ajouté à la boîte à blocs.", { n: comp.name }), "ok");
}

// ===== IA ==================================================================
async function explain() {
  const { code } = generate();
  if (!code.trim()) return;
  const box = $("explain");
  box.hidden = false;
  box.textContent = tt("L'IA lit le programme…");
  const live = streamTarget(box, markdownToHtml);
  try {
    const { content } = await llmChat(PROMPTS["app.robotstudio.explain"].build({ code, lang: replyLang() }).messages, { rawSystem: true, onUpdate: live.onUpdate });
    live.done(markdownToHtml(content || ""));
  } catch (e) {
    box.textContent = String(e?.message || e);
  }
}

// ===== Coquille ============================================================
function showTab(name) {
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  document.querySelectorAll(".pane").forEach((p) => { p.hidden = p.dataset.pane !== name; });
  if (workspace) Blockly.svgResize(workspace);
}

async function init() {
  await store.ready();
  projects = store.getJSON("projects", []) || [];
  devices = store.getJSON("devices", []) || [];
  components = store.getJSON("components", []) || [];
  currentId = store.get("current", "");
  deviceId = store.get("device", "") || devices[0]?.id || "";
  window.loadCustomComponents(components);

  workspace = Blockly.inject("blockly", {
    toolbox: toolbox(),
    grid: { spacing: 20, length: 3, colour: "rgba(127,127,127,.25)", snap: true },
    zoom: { controls: true, wheel: true, startScale: 0.9 },
    trashcan: true,
    renderer: "zelos",
  });
  window.applyBlockStyles?.(workspace);
  workspace.addChangeListener((ev) => {
    if (ev.isUiEvent) {
      if (ev.type === Blockly.Events.SELECTED && ev.newElementId) {
        const b = workspace.getBlockById(ev.newElementId);
        if (b && docIndex.includes(b.type) && !$("doc").closest(".pane").hidden) showDoc(b.type);
        else if (b && docIndex.includes(b.type)) $("doc-select").value = b.type;
      }
      return;
    }
    refreshPython();
    saveWorkspaceSoon();
  });
  new ResizeObserver(() => Blockly.svgResize(workspace)).observe($("blockly"));

  if (!projects.length) projects.push({ id: `p${Date.now()}`, name: tt("Mon robot"), xml: "", updated: Date.now() });
  loadProject(projects.some((p) => p.id === currentId) ? currentId : projects[0].id);
  renderDevices();
  renderCustom();
  loadDocIndex();

  $("project-select").addEventListener("change", (e) => loadProject(e.target.value));
  $("btn-new").addEventListener("click", newProject);
  $("btn-rename").addEventListener("click", renameProject);
  $("btn-delete").addEventListener("click", deleteProject);
  $("btn-export").addEventListener("click", exportProject);
  $("btn-deploy").addEventListener("click", deploy);
  $("btn-test").addEventListener("click", testConnection);
  $("btn-env").addEventListener("click", prepareEnv);
  $("btn-stop").addEventListener("click", stopRemote);
  $("btn-status").addEventListener("click", remoteStatus);
  $("btn-logs").addEventListener("click", remoteLogs);
  $("btn-explain").addEventListener("click", explain);
  $("btn-copy").addEventListener("click", () => navigator.clipboard?.writeText(generate().code).then(() => status(tt("Code copié"), "ok")).catch(() => {}));
  $("doc-select").addEventListener("change", (e) => showDoc(e.target.value));
  $("custom-form").addEventListener("submit", addCustom);
  document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => {
    showTab(b.dataset.tab);
    if (b.dataset.tab === "docs") {
      const sel = Blockly.getSelected?.();
      if (sel && docIndex.includes(sel.type)) showDoc(sel.type);
    }
  }));
  $("device-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const d = {
      id: `d${Date.now()}`,
      name: $("dev-name").value.trim(),
      host: $("dev-host").value.trim(),
      user: $("dev-user").value.trim() || "pi",
      port: Number($("dev-port").value) || 22,
    };
    if (!d.host) return;
    devices.push(d);
    deviceId = d.id;
    persist(); renderDevices();
    e.target.reset();
    $("dev-user").value = "pi"; $("dev-port").value = "22";
  });
  $("btn-bridge-regen").addEventListener("click", async () => {
    const ok = await confirmSheet({ title: tt("Créer un nouveau jeton ?"), body: tt("Les programmes déjà déployés ne pourront plus joindre Lumen tant qu'ils n'auront pas été redéployés."), confirm: tt("Nouveau jeton"), cancel: tt("Annuler"), danger: true });
    if (ok) { await refreshBridge({ regenerate: true }); status(tt("Nouveau jeton créé : redéployez vos programmes."), "ok"); }
  });
  $("bridge-sandbox").addEventListener("change", (e) => refreshBridge({ photoSandbox: e.target.value }));
  refreshBridge();
  window.addEventListener("beforeunload", () => store.flush?.());
}

init().catch((e) => { console.error("[robotstudio]", e); status(String(e?.message || e), "err"); });
