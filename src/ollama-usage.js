import { recordCall as recordProfilerCall } from "./lib/profiler.js";

const BASE_KEY = "ollamaDailyUsage";

// Préfixe de profil : posé par le bureau sur SA fenêtre. Une app native en
// iframe même origine (Fil, Kanban, Éditeur…) ne l'a pas : elle écrivait sous
// la clé nue, que le widget du bureau — qui lit la clé préfixée — ignorait.
// On remonte donc les parents même origine pour retrouver le préfixe.
function profilePrefix() {
  let w = window;
  for (let guard = 0; guard < 8 && w; guard++) {
    try {
      const p = w.__LUMEN_PROFILE_STORAGE_PREFIX__;
      if (p) return p;
      if (!w.parent || w.parent === w) break;
      void w.parent.document; // autre origine : on s'arrête
      w = w.parent;
    } catch { break; }
  }
  return "";
}
function key() {
  return profilePrefix() + BASE_KEY;
}

// Pont vers le Journal LLM global (backend, llmlog.rs) : chaque enregistrement
// d'usage côté front alimente aussi le log des agissements. Best-effort — les
// contextes sans Tauri (tests, iframe non pontée) sont silencieusement ignorés.
function pushToGlobalLog(entry) {
  try {
    const invoke = (window.__TAURI__ || (window.parent && window.parent.__TAURI__) || {}).core?.invoke;
    if (invoke) invoke("llm_log_push", entry);
  } catch { /* hors contexte Tauri */ }
}

function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function readAll() {
  try {
    // La barre principale historique écrit sans préfixe de profil, alors que
    // les apps du bureau utilisent désormais le stockage profilé. Lire les
    // deux formats permet au widget et aux apps embarquées de partager le
    // compteur pendant la transition.
    const k = key();
    const main = JSON.parse(localStorage.getItem(k) || "{}") || {};
    if (k === BASE_KEY) return main;
    // Clé nue héritée (barre principale, iframe sans préfixe) : on la FUSIONNE
    // dans la clé profilée puis on la retire, pour que rien ne se perde.
    const legacyRaw = localStorage.getItem(BASE_KEY);
    if (!legacyRaw) return main;
    try {
      const legacy = JSON.parse(legacyRaw) || {};
      for (const [day, v] of Object.entries(legacy)) {
        const cur = { prompt: 0, generated: 0, total: 0, calls: 0, images: 0, ...(main[day] || {}) };
        cur.prompt += Number(v?.prompt || 0); cur.generated += Number(v?.generated || 0);
        cur.calls += Number(v?.calls || 0); cur.images += Number(v?.images || 0);
        cur.total = cur.prompt + cur.generated;
        main[day] = cur;
      }
      localStorage.removeItem(BASE_KEY);
      localStorage.setItem(k, JSON.stringify(main));
    } catch { /* clé nue illisible : ignorée */ }
    return main;
  }
  catch { return {}; }
}

function writeAll(data) {
  localStorage.setItem(key(), JSON.stringify(data || {}));
}

export function getOllamaTodayUsage() {
  const all = readAll();
  return { prompt: 0, generated: 0, total: 0, calls: 0, images: 0, ...(all[todayKey()] || {}) };
}

// Marqueur non énumérable : une réponse n'est comptée qu'UNE fois, quel que
// soit le nombre d'appelants qui la passent ici (l'app, puis le repli central
// de llm.js, ou l'inverse). `markUsageHandled` permet à un adaptateur qui
// recompose la réponse (contrat Ollama ← OpenAI) de neutraliser l'original.
const USAGE_FLAG = "__lumenUsageRecorded";
export function isUsageRecorded(stats) {
  return !!(stats && typeof stats === "object" && stats[USAGE_FLAG]);
}
export function markUsageHandled(stats) {
  if (!stats || typeof stats !== "object") return;
  try { Object.defineProperty(stats, USAGE_FLAG, { value: true, enumerable: false, configurable: true }); }
  catch { /* objet gelé : on laisse passer */ }
}

// Repli central : si aucun appelant n'a compté la réponse peu après son
// arrivée, on la compte nous-mêmes sous une source générique. Le délai laisse
// aux apps le temps de poser leur propre étiquette (« notes », « kanban »…),
// plus parlante dans le Journal LLM, sans jamais perdre un appel.
export function scheduleUsageFallback(stats, source = "llm") {
  if (!stats || typeof stats !== "object" || isUsageRecorded(stats)) return;
  setTimeout(() => { if (!isUsageRecorded(stats)) recordOllamaUsage(stats, source); }, 1500);
}

// App PACKAGÉE (.lumenapp) : elle vit sur une autre origine, avec SON
// localStorage. Compter ici laissait les jetons de Notes, Kanban… dans un
// stockage que le bureau ne lit jamais (« Générer avec l'IA », assistant
// d'app). On délègue donc le comptage à l'hôte par le pont, qui l'inscrit dans
// le compteur du bureau et le Journal LLM.
function bridgedHost() {
  try {
    if (!window.__TAURI__?.__bridged) return null;
    let w = window;
    for (let guard = 0; guard < 8; guard++) {
      const up = w.parent;
      if (!up || up === w) return null;
      try { void up.document; } catch { return up; } // autre origine : c'est l'hôte
      w = up;
    }
  } catch { /* pas de pont */ }
  return null;
}
function forwardToHost(payload) {
  const host = bridgedHost();
  if (!host) return false;
  try { host.postMessage({ __lumenAppkitUsage: 1, ...payload }, "*"); return true; } catch { return false; }
}

export function recordOllamaUsage(stats, source = "ollama") {
  if (!stats || typeof stats !== "object") return getOllamaTodayUsage();
  if (isUsageRecorded(stats)) return getOllamaTodayUsage();
  markUsageHandled(stats);
  if (forwardToHost({
    kind: "call",
    source,
    model: String(stats.model || ""),
    prompt: Number(stats.prompt_eval_count || stats.usage?.prompt_tokens || 0),
    generated: Number(stats.eval_count || stats.usage?.completion_tokens || 0),
    evalDuration: Number(stats.eval_duration || 0),
    promptDuration: Number(stats.prompt_eval_duration || 0),
  })) return getOllamaTodayUsage();
  // Contrat Ollama (`*_eval_count`) ou contrat OpenAI (`usage.*`) : le backend
  // « api » renvoie la seconde forme telle quelle, et sans ce repli ses appels
  // ne comptaient aucun jeton dans le compteur journalier.
  const prompt = Number(stats.prompt_eval_count || stats.usage?.prompt_tokens || 0);
  const generated = Number(stats.eval_count || stats.usage?.completion_tokens || 0);
  if (prompt <= 0 && generated <= 0) return getOllamaTodayUsage();

  // Le Profiler reçoit la réponse BRUTE : elle porte les durées, les outils
  // appelés et (via llm.js) les métadonnées de requête, que le compteur
  // journalier ci-dessous réduit à deux nombres.
  recordProfilerCall(stats, source);

  const all = readAll();
  const day = todayKey();
  const cur = { prompt: 0, generated: 0, total: 0, calls: 0, images: 0, ...(all[day] || {}) };
  cur.prompt += Math.max(0, prompt);
  cur.generated += Math.max(0, generated);
  cur.total = cur.prompt + cur.generated;
  cur.calls += 1;
  cur.lastSource = source;
  cur.updatedAt = Date.now();
  all[day] = cur;
  writeAll(all);
  if (!stats.__nativeSkipLog) pushToGlobalLog({
    kind: "call",
    source: source || "chat",
    sourceId: source || "chat",
    model: String(stats.model || ""),
    detail: "",
    promptTokens: Math.max(0, prompt),
    genTokens: Math.max(0, generated),
    success: true,
  });
  window.dispatchEvent(new CustomEvent("ollama-usage-updated", { detail: cur }));
  return cur;
}

export function recordImageGeneration(count = 1, source = "image") {
  const n = Math.max(0, Number(count) || 0);
  if (!n) return getOllamaTodayUsage();
  if (forwardToHost({ kind: "image", source, count: n })) return getOllamaTodayUsage();
  const all = readAll();
  const day = todayKey();
  const cur = { prompt: 0, generated: 0, total: 0, calls: 0, images: 0, ...(all[day] || {}) };
  cur.images += n;
  cur.lastSource = source;
  cur.updatedAt = Date.now();
  all[day] = cur;
  writeAll(all);
  window.dispatchEvent(new CustomEvent("ollama-usage-updated", { detail: cur }));
  return cur;
}

// Générations NATIVES (boucle agentique, Telegram, routeur, distillation…) :
// le Rust émet `llm-usage` vers la fenêtre principale (cf. llmlog.rs,
// emit_native_usage). On l'écoute une seule fois, uniquement depuis la
// fenêtre hôte (pas depuis une iframe : elle ne reçoit pas l'événement, et si
// elle le recevait, elle compterait en double). Les autres fenêtres lisent le
// résultat via l'événement `storage`.
(function listenNativeUsage() {
  const ev = window.__TAURI__?.event;
  if (!ev?.listen || window.parent !== window) return;
  if (window.__lumenNativeUsageListening) return;
  window.__lumenNativeUsageListening = true;
  ev.listen("llm-usage", (e) => {
    const p = e?.payload || {};
    recordOllamaUsage({
      model: p.model || "",
      prompt_eval_count: Number(p.prompt_tokens || 0),
      eval_count: Number(p.gen_tokens || 0),
      __nativeSkipLog: true,
    }, p.source || "native");
  }).catch(() => {});
})();
