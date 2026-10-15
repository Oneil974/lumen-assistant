/**
 * AppKit, côté hôte — le seul endroit où une application packagée touche Lumen.
 *
 * Une app installée tourne dans une iframe et n'a accès à rien : ni `__TAURI__`,
 * ni le système de fichiers, ni les autres apps. Elle parle uniquement à ce
 * module, par postMessage, et chaque méthode qu'elle appelle passe ici par trois
 * étapes, dans cet ordre :
 *
 *   1. la méthode est-elle au catalogue ? (une méthode inconnue est refusée —
 *      jamais « on ne sait pas, donc on laisse passer ») ;
 *   2. la capacité correspondante est-elle accordée ? sinon on la DEMANDE, et
 *      la réponse est mémorisée par le broker Rust (src-tauri/src/appperms.rs) ;
 *   3. seulement alors, l'appel réel.
 *
 * La feuille de consentement est dessinée par l'HÔTE, jamais par l'app : c'est
 * ce qui la rend crédible. Une app ne peut pas contrefaire un dialogue système
 * puisqu'elle ne dessine pas celui-là — elle ne peut que le déclencher.
 *
 * Le mode d'emploi côté app est dans guest.js, injecté dans son document.
 */
import { registerActionTools } from "../hybrid.js";
import { llmChat } from "../../llm.js";
import { recordImageGeneration, recordOllamaUsage } from "../../ollama-usage.js";
import { confirmSheet, promptSheet } from "../confirm.js";
import { describeCapability } from "./capabilities.js";
import { replyLang } from "../prompt-lang.js";
import { PROMPTS as CORE_PROMPTS } from "../core-prompts.js";

const invoke = (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke;

/**
 * Capacité exigée par chaque méthode du SDK. Une méthode absente de cette table
 * n'existe pas : c'est la liste blanche, pas une liste de cas particuliers.
 *
 * `null` = aucune permission requise. Ces cas ne sont pas des oublis : ce sont
 * les appels où l'utilisateur est DÉJÀ dans la boucle (un dialogue qu'il voit,
 * un sélecteur où il choisit la destination), ou qui ne révèlent rien de lui.
 */
const REQUIRES = {
  "perm.query": null,
  "perm.request": null,
  "ai.chat": "ai",
  "ai.vision": "ai",
  "ai.embed": "ai",
  "ai.info": null,
  "assistant.register": "assistant",
  "assistant.ask": "assistant",
  "tools.register": "tools",
  "intents.ready": null,
  "tools.unregister": null,
  "storage.get": "storage",
  "storage.set": "storage",
  "storage.remove": "storage",
  "storage.keys": "storage",
  "storage.files.list": "storage",
  "storage.files.read": "storage",
  "storage.files.readBytes": "storage",
  "storage.files.write": "storage",
  "storage.files.remove": "storage",
  // `files.pick` / `files.save` passent par un sélecteur : l'utilisateur voit et
  // choisit le fichier à l'instant même. Une demande de permission par-dessus
  // n'ajouterait rien qu'un clic.
  "files.pick": "files",
  "files.save": "files",
  "tables.baseList": "tables",
  "tables.list": "tables",
  "tables.schema": "tables",
  "tables.rows": "tables",
  "tables.query": "tables",
  "tables.rowInsert": "tables",
  "tables.rowUpdate": "tables",
  "tables.rowDelete": "tables",
  "memory.recall": "memory",
  "memory.remember": "memory",
  "interop.share": null,
  // Ouvrir une autre app ne donne accès à AUCUNE de ses données : c'est le
  // geste d'un lanceur, pas une capacité à demander.
  "apps.open": null,
  // Ouvrir un fichier de la suite (Opus, Calc) cité dans un document : le même
  // geste que « Ouvrir », l'app n'en reçoit rien.
  "apps.openFile": null,
  "interop.send": "interop",
  "interop.receive": null,
  "interop.shelf": null,
  "net.fetch": "network",
  notify: "notifications",
  "clipboard.read": "clipboard",
  "clipboard.write": "clipboard",
  "ui.confirm": null,
  "ui.prompt": null,
  "ui.toast": null,
  "ui.theme": null,
  "ui.setTitle": null,
  "ui.askSheet": "ai",
};

/** Erreur qu'une app peut rattraper pour dégrader proprement. */
class DeniedError extends Error {
  constructor(message) {
    super(message);
    this.code = "denied";
  }
}

/**
 * Monte le pont AppKit pour une app.
 *
 * @param {object} opts
 * @param {HTMLIFrameElement} opts.frame  L'iframe qui héberge l'app.
 * @param {object} opts.app  Manifeste : { id, name, version, capabilities }.
 * @param {(title:string)=>void} [opts.onTitle]  Titre de fenêtre demandé par l'app.
 * @param {(name:string)=>string} [opts.appNameOf]  Résout un id d'app en nom lisible.
 * @returns {{ dispose():void, emit(event:string, payload:object):void, callTool(name:string,args:object):Promise<any> }}
 */
export function mountAppHost({ frame, app, onTitle, appNameOf = (id) => id }) {
  const appId = app.id;
  // Les capacités jamais déclarées au manifeste sont refusées AVANT même de
  // poser la question : une app qui demande ce qu'elle n'a pas annoncé au
  // moment de l'installation ment sur ce qu'elle est.
  const declared = new Set(app.capabilities || []);
  const toolCalls = new Map();
  const unlisteners = [];
  let toolSeq = 0;
  let disposed = false;

  const post = (msg) => {
    if (disposed) return;
    try { frame.contentWindow?.postMessage(msg, "*"); } catch { /* iframe partie */ }
  };

  /**
   * Vérifie une capacité, en demandant à l'utilisateur si personne n'a encore
   * tranché. Le refus est mémorisé : on ne harcèle pas.
   */
  async function ensure(cap) {
    if (!cap) return;
    if (!declared.has(cap) && !declared.has(cap.split(":")[0] + ":*")) {
      throw new DeniedError(`« ${app.name} » n'a pas déclaré la permission « ${cap} ».`);
    }
    const current = await invoke("perm_get", { appId, cap });
    if (current === "granted") return;
    if (current === "denied") {
      throw new DeniedError(`Vous avez refusé « ${describeCapability(cap, appNameOf).label} » à ${app.name}.`);
    }
    const d = describeCapability(cap, appNameOf);
    const ok = await confirmSheet({
      title: `« ${app.name} » souhaite ${d.ask}`,
      body: `${d.detail}\n\nVous pourrez revenir sur ce choix dans Paramètres → Confidentialité.`,
      confirm: "Autoriser",
      cancel: "Refuser",
    });
    await invoke("perm_set", { appId, cap, decision: ok ? "granted" : "denied" });
    if (!ok) throw new DeniedError(`Permission refusée : ${d.label}.`);
  }

  /** Sandbox réservée à l'app. Créée à la première écriture, pas avant. */
  let ownSandbox = null;
  async function sandboxId() {
    if (ownSandbox) return ownSandbox;
    const list = await invoke("sandbox_list");
    const name = `app:${appId}`;
    const found = (list || []).find((s) => s.name === name);
    ownSandbox = found ? found.id : await invoke("sandbox_create", { name, maxMb: 256 });
    return ownSandbox;
  }

  // Le stockage clé-valeur est un simple fichier dans la sandbox de l'app :
  // une base de plus pour ça serait un objet à sauvegarder, migrer et purger
  // en plus, pour ranger trois préférences.
  const KV = "appkit-store.json";
  async function readKv() {
    try {
      const file = await invoke("sandbox_read_file", { id: await sandboxId(), path: KV });
      return JSON.parse(file?.content || "{}");
    } catch { return {}; }
  }
  async function writeKv(data) {
    await invoke("sandbox_write_file", { id: await sandboxId(), path: KV, content: JSON.stringify(data) });
  }

  const HANDLERS = {
    "perm.query": ({ cap }) => invoke("perm_get", { appId, cap }),
    "perm.request": async ({ cap }) => {
      try { await ensure(cap); return "granted"; } catch { return "denied"; }
    },

    "ai.chat": async ({ messages, system, model, think, stream }) => {
      const msgs = system ? [{ role: "system", content: system }, ...(messages || [])] : messages || [];
      // Flux demandé par l'app : texte cumulé (raisonnement à part) relayé à
      // chaque mise à jour, cadencé par l'image pour ne pas noyer l'iframe.
      let raf = 0, last = null;
      const onUpdate = stream ? (st) => {
        last = st;
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          post({ __lumenAppkitStream: 1, stream, text: last.answer, reasoning: last.reasoning, thinking: last.thinking });
        });
      } : undefined;
      const out = await llmChat(msgs, { model, think, ...(onUpdate ? { onUpdate } : {}) });
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      return typeof out === "string" ? out : out?.content ?? out;
    },
    "ai.vision": async ({ image, prompt }) => {
      const out = await llmChat(
        [{ role: "user", content: prompt || "Décris cette image.", images: [image] }],
        {}
      );
      return typeof out === "string" ? out : out?.content ?? out;
    },
    "ai.embed": async ({ texts }) => {
      const { embedText } = await import("../embed-service.js");
      const model = localStorage.getItem("embedModel") || "";
      return Promise.all((texts || []).map((t) => embedText(model, String(t))));
    },
    "ai.info": () => {
      const source = localStorage.getItem("aiSource") || "ollama";
      return { source, model: localStorage.getItem(`selectedModel:${source}`) || "" };
    },

    "intents.ready": ({ id }) => {
      const key = `${appId}:${id}`;
      liveIntents.set(key, hostApi);
      // Intentions arrivées avant que l'app ne soit prête : on les exécute
      // maintenant, dans l'ordre.
      const waiting = pendingIntents.get(key) || [];
      pendingIntents.delete(key);
      for (const w of waiting) hostApi.callIntent(id, w.args).then(w.resolve, w.reject);
      return true;
    },

    "assistant.register": ({ actions, name, description }) => {
      assistantSpecs.set(appId, { appId, name: name || app.name, description: description || "", actions: actions || [] });
      return true;
    },
    "assistant.ask": async ({ question, context }) => {
      const out = await llmChat(
        CORE_PROMPTS["core.appkit.assistant"].build({ app: app.name, question, context, lang: replyLang() }).messages,
        { rawSystem: true }
      );
      return typeof out === "string" ? out : out?.content ?? out;
    },

    "tools.register": ({ spec }) => {
      if (!spec?.name) throw new Error("outil sans nom");
      appTools.set(`${appId}.${spec.name}`, { appId, spec, host: hostApi });
      return true;
    },
    "tools.unregister": ({ name }) => appTools.delete(`${appId}.${name}`),

    "storage.get": async ({ key }) => (await readKv())[key] ?? null,
    "storage.set": async ({ key, value }) => { const kv = await readKv(); kv[key] = value; await writeKv(kv); return true; },
    "storage.remove": async ({ key }) => { const kv = await readKv(); delete kv[key]; await writeKv(kv); return true; },
    "storage.keys": async () => Object.keys(await readKv()),
    "storage.files.list": async ({ dir }) => invoke("sandbox_read_dir", { id: await sandboxId(), path: dir || "" }),
    "storage.files.read": async ({ path }) => (await invoke("sandbox_read_file", { id: await sandboxId(), path }))?.content ?? "",
    "storage.files.readBytes": async ({ path }) => invoke("sandbox_read_b64", { id: await sandboxId(), path }),
    "storage.files.write": async ({ path, content }) => invoke("sandbox_write_file", { id: await sandboxId(), path, content: String(content) }),
    "storage.files.remove": async ({ path }) => invoke("sandbox_delete_path", { id: await sandboxId(), path }),

    "files.pick": async () => {
      // Le bureau héberge le sélecteur : lui seul connaît les sandboxes de
      // l'utilisateur, et l'app ne doit jamais en voir la liste.
      const pick = window.top?.LumenPickFile;
      if (!pick) throw new Error("sélecteur de fichiers indisponible");
      return pick({ appName: app.name });
    },
    "files.save": async ({ name, content }) => {
      const save = window.top?.LumenSaveFile;
      if (!save) throw new Error("enregistrement indisponible");
      return save({ appName: app.name, name, content });
    },

    "tables.baseList": () => invoke("table_base_list"),
    "tables.list": ({ baseId }) => invoke("table_list", { baseId }),
    "tables.schema": ({ tableId }) => invoke("table_schema", { tableId }),
    "tables.rows": ({ tableId, limit, offset }) => invoke("table_rows", { tableId, limit, offset }),
    "tables.query": ({ baseId, sql }) => invoke("table_query", { baseId, sql }),
    "tables.rowInsert": ({ tableId, values }) => invoke("table_row_insert", { tableId, values }),
    "tables.rowUpdate": ({ tableId, rowId, values }) => invoke("table_row_update", { tableId, rowId, values }),
    "tables.rowDelete": ({ tableId, rowId }) => invoke("table_row_delete", { tableId, rowId }),

    // Le `context` passé à la mémoire est l'identifiant de l'app, pas « lumen » :
    // la politique de mémoire (cf. recall.rs) peut ainsi cloisonner une app
    // installée exactement comme elle cloisonne un agent.
    "memory.recall": ({ query, limit }) => invoke("mem_recall", { context: `app:${appId}`, query, limit }),
    "memory.remember": ({ text, kind }) => invoke("mem_remember", { context: `app:${appId}`, kind: kind || "note", text }),

    "interop.share": ({ kind, payload }) => {
      const obj = window.top?.LumenMakeObject?.(kind, payload, { app: appId, name: app.name });
      return window.top?.LumenShare?.(obj);
    },
    "interop.send": async ({ appId: target, kind, payload }) => {
      const obj = window.top?.LumenMakeObject?.(kind, payload, { app: appId, name: app.name });
      const { handoff } = await import("../interop.js");
      return handoff(target, obj);
    },
    "interop.receive": ({ appId: sub }) => {
      // Un paquet-hub reçoit au nom de ses onglets (« notes » dans Muse) :
      // seuls les identifiants qu'il déclare sont acceptés.
      const tabs = (app.tabs || []).map((t) => t.id);
      const id = sub && tabs.includes(sub) ? sub : appId;
      const deliver = (obj) => post({ __lumenAppkitEvent: 1, event: "interop", object: obj });
      // Ce qui attendait déjà (objet déposé alors que l'app était fermée).
      for (const obj of window.top?.LumenTakeHandoff?.(id) || []) deliver(obj);
      window.top?.LumenReceive?.(id, deliver);
      return true;
    },
    "interop.shelf": () => window.top?.LumenShelf?.() ?? [],
    "apps.open": ({ appId: target }) => Boolean(window.top?.LumenOpenApp?.(String(target || ""))),
    "apps.openFile": ({ sandboxId, path }) => Boolean(window.top?.LumenOpenFile?.(String(path || ""), String(sandboxId || ""))),

    "net.fetch": async ({ url }) => invoke("web_fetch", { url: String(url) }),

    notify: ({ title, body, kind, icon }) =>
      invoke("notify_island", { payload: { kind: kind || "info", title: title || app.name, body: body || "", icon: icon || "", source: appId } }),

    "clipboard.read": () => navigator.clipboard.readText(),
    "clipboard.write": ({ text }) => navigator.clipboard.writeText(text),

    // Les dialogues portent le nom de l'app : personne ne doit croire que c'est
    // Lumen qui pose la question.
    "ui.confirm": ({ title, body, confirm, cancel }) =>
      confirmSheet({ title: title || app.name, body: body || "", confirm: confirm || "Confirmer", cancel: cancel || "Annuler" }),
    "ui.prompt": ({ title, body, value, placeholder }) =>
      promptSheet({ title: title || app.name, body: body || "", value: value || "", placeholder: placeholder || "" }),
    "ui.toast": ({ message }) => { window.top?.LumenToast?.(message); return true; },
    "ui.theme": () => ({
      theme: document.documentElement.dataset.theme || "light",
      base: document.documentElement.dataset.uiBase || "neutral",
      accent: document.documentElement.dataset.uiAccent || "",
      primary: getComputedStyle(document.documentElement).getPropertyValue("--primary").trim(),
    }),
    "ui.setTitle": ({ title }) => { onTitle?.(title); return true; },
    // Feuille IA flottante posée par le bureau, ancrée dans la fenêtre de l'app.
    "ui.askSheet": ({ title, question, context, images, anchor, placeholder }) => {
      const open = window.top?.LumenAskSheet;
      if (!open) throw new Error("feuille IA indisponible ici");
      const r = frame.getBoundingClientRect();
      const a = anchor && Number.isFinite(anchor.x) ? { x: anchor.x + r.left, y: anchor.y + r.top, w: anchor.w || 0, h: anchor.h || 0 } : { x: r.left + 40, y: r.top + 40, w: 0, h: 0 };
      return new Promise((resolve) => {
        let done = false;
        open({
          title: title || app.name, question, context, placeholder, anchor: a,
          images: (images || []).map((u) => ({ dataUrl: String(u), b64: String(u).split(",")[1] || "" })),
          onAnswer: (txt) => { if (!done) { done = true; resolve(txt); } },
          onClose: () => { if (!done) { done = true; resolve(""); } },
        });
      });
    },
  };

  /* ---- Pont IPC brut (apps first-party seulement) ------------------------
   * Les applications signées par Lumen gardent l'accès direct aux commandes
   * Tauri : ce sont les mêmes que celles qui vivaient dans le bundle, leur
   * déménagement dans le dossier de données ne change pas ce qu'on leur
   * accorde. Une app TIERCE, elle, se voit refuser toute commande brute — il ne
   * lui reste que les capacités nommées de `window.lumen`, accordées une par une.
   *
   * Ce refus est la seule ligne qui sépare les deux niveaux de confiance : il
   * ne doit jamais dépendre d'une valeur envoyée par l'app.
   */
  const trusted = app.trust === "first-party";
  const forwarded = new Set();

  async function onIpc(d) {
    const reply = (ok, payload) =>
      post({ __lumenIpcReply: 1, id: d.id, ok, data: ok ? payload : undefined, error: ok ? undefined : payload });

    if (!trusted) {
      reply(false, `« ${app.name} » est une application tierce : elle n'a pas accès aux commandes système de Lumen.`);
      return;
    }
    if (d.cmd === "__subscribe") {
      const name = String(d.args?.event || "");
      if (!name || forwarded.has(name)) return;
      forwarded.add(name);
      const un = await window.__TAURI__?.event?.listen?.(name, (ev) =>
        post({ __lumenIpcEvent: 1, event: name, payload: ev?.payload })
      );
      if (un) unlisteners.push(un);
      return;
    }
    // Canal de flux de l'app : on crée le vrai `Channel` ici et on relaie
    // chaque message vers sa fenêtre (réponses en flux des générations).
    const args = { ...(d.args || {}) };
    const TauriChannel = window.__TAURI__?.core?.Channel;
    for (const [k, v] of Object.entries(args)) {
      if (v && typeof v === "object" && typeof v.__lumenChannel === "string" && TauriChannel) {
        const ch = new TauriChannel();
        const cid = v.__lumenChannel;
        ch.onmessage = (message) => post({ __lumenIpcChannel: 1, channel: cid, message });
        args[k] = ch;
      }
    }
    try {
      reply(true, await invoke(d.cmd, args));
    } catch (err) {
      reply(false, String(err?.message || err));
    }
  }

  async function onMessage(e) {
    if (e.source !== frame.contentWindow) return;
    const d = e.data;
    if (d?.__lumenIpc) { onIpc(d); return; }
    // Sélection de texte / image dans l'app : les outils d'écriture du bureau
    // dessinent le menu par-dessus la fenêtre et renvoient le remplacement par
    // `emit("selection.replace")`. Pas de permission : l'utilisateur vient de
    // sélectionner lui-même, et rien ne quitte l'app sans son clic.
    if (d?.__lumenAppkitLog) {
      // Erreur JS de l'app → journal de diagnostic (cf. frontend_log).
      try { invoke?.("frontend_log", { level: `app:${appId}`, message: String(d.message || "") }); } catch { /* sans backend */ }
      return;
    }
    if (d?.__lumenAppkitUsage) {
      // Jetons consommés par l'app (elle vit sur une autre origine, cf.
      // ollama-usage.js) : comptés ici, dans le stockage du bureau.
      const src = `${appId}:${String(d.source || "app").replace(/[^\w:-]+/g, "-")}`;
      if (d.kind === "image") recordImageGeneration(Number(d.count) || 1, src);
      else recordOllamaUsage({
        model: d.model || "",
        prompt_eval_count: Number(d.prompt) || 0,
        eval_count: Number(d.generated) || 0,
        eval_duration: Number(d.evalDuration) || 0,
        prompt_eval_duration: Number(d.promptDuration) || 0,
      }, src);
      return;
    }
    if (d?.__lumenAppkitSelection) {
      try { window.top?.LumenWritingTools?.remote?.(frame, hostApi, d); } catch { /* bureau sans outils */ }
      return;
    }
    if (d?.__lumenIpcEmit) {
      if (trusted) window.__TAURI__?.event?.emit?.(d.event, d.payload);
      return;
    }
    if (d?.__lumenAppkitToolReply) {
      const waiting = toolCalls.get(d.callId);
      if (waiting) {
        toolCalls.delete(d.callId);
        d.ok ? waiting.resolve(d.data) : waiting.reject(new Error(d.error || "erreur de l'outil"));
      }
      return;
    }
    if (!d?.__lumenAppkit) return;

    const reply = (ok, payload, code) =>
      post({ __lumenAppkitReply: 1, id: d.id, ok, data: ok ? payload : undefined, error: ok ? undefined : payload, code });

    const handler = HANDLERS[d.method];
    if (!handler || !(d.method in REQUIRES)) {
      reply(false, `méthode inconnue : ${d.method}`);
      return;
    }
    try {
      await ensure(REQUIRES[d.method]);
      reply(true, await handler(d.params || {}));
    } catch (err) {
      reply(false, String(err?.message || err), err?.code);
    }
  }

  window.addEventListener("message", onMessage);

  const hostApi = {
    dispose() {
      disposed = true;
      window.removeEventListener("message", onMessage);
      for (const un of unlisteners) { try { un(); } catch { /* déjà partie */ } }
      assistantSpecs.delete(appId);
      // Un outil dont l'app est fermée ne peut plus répondre : le laisser au
      // catalogue ferait échouer l'agent qui l'appelle, sans explication.
      for (const key of [...appTools.keys()]) {
        if (appTools.get(key)?.appId === appId) appTools.delete(key);
      }
      for (const key of [...liveIntents.keys()]) {
        if (key.startsWith(appId + ":")) liveIntents.delete(key);
      }
    },
    /** Exécute un App Intent chez l'app (qui doit être prête) et attend le résultat. */
    callIntent(intent, args) {
      return new Promise((resolve, reject) => {
        const callId = ++toolSeq;
        toolCalls.set(callId, { resolve, reject });
        post({ __lumenAppkitEvent: 1, event: "intent", intent, args: args || {}, callId });
        setTimeout(() => {
          if (toolCalls.delete(callId)) reject(new Error(`« ${intent} » n'a pas répondu`));
        }, 60000);
      });
    },
    emit(event, detail) { post({ __lumenAppkitEvent: 1, event, detail }); },
    /** Texte visible de la page de l'app (pour « Résumer cette fenêtre »). */
    pageText() {
      return new Promise((resolve, reject) => {
        const callId = ++toolSeq;
        toolCalls.set(callId, { resolve, reject });
        post({ __lumenAppkitEvent: 1, event: "page.text", callId });
        setTimeout(() => { if (toolCalls.delete(callId)) reject(new Error("l'app n'a pas répondu")); }, 5000);
      });
    },
    /** Appelle un outil publié par l'app et attend sa réponse. */
    callTool(name, args) {
      return new Promise((resolve, reject) => {
        const callId = ++toolSeq;
        toolCalls.set(callId, { resolve, reject });
        post({ __lumenAppkitEvent: 1, event: "tool", tool: name, args, callId });
        setTimeout(() => {
          if (toolCalls.delete(callId)) reject(new Error(`« ${name} » n'a pas répondu`));
        }, 60000);
      });
    },
  };
  return hostApi;
}

/**
 * Outils publiés par les apps ouvertes, et actions offertes à l'assistant.
 *
 * Vivants et non persistés, volontairement : ils n'ont de sens que tant que la
 * fenêtre qui sait y répondre est ouverte.
 */
export const appTools = new Map();
export const assistantSpecs = new Map();

// ===== App Intents ==========================================================
// `liveIntents` : intentions dont l'app est ouverte ET prête (`intents.ready`).
// `pendingIntents` : intentions demandées alors que l'app n'était pas prête —
// l'appelant l'a ouverte, on attend qu'elle se déclare.
const liveIntents = new Map();
const pendingIntents = new Map();

/** Nom d'outil vu par le modèle pour une intention d'app. */
export function intentToolName(appId, intentId) {
  return `${appId}_${intentId}`.replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * Outils (format OpenAI) pour les intentions déclarées par des manifestes.
 * `apps` : manifestes installés (`{ id, name, intents }`).
 * Renvoie { tools, map } où map[nomOutil] = { appId, intent }.
 */
export function intentToolDefinitions(apps) {
  const tools = [];
  const map = {};
  for (const app of apps || []) {
    for (const it of app.intents || []) {
      if (!it?.id) continue;
      const name = intentToolName(app.id, it.id);
      map[name] = { appId: app.id, intent: it };
      tools.push({
        type: "function",
        function: {
          name,
          description: `${app.name} — ${it.title || it.id}${it.description ? " : " + it.description : ""}`,
          parameters: { type: "object", properties: it.parameters || {}, required: it.required || [] },
        },
      });
    }
  }
  // Pilier « Actions » de l'intelligence hybride : une intention agit dans
  // une app (cf. lib/hybrid.js).
  registerActionTools(Object.keys(map));
  return { tools, map };
}

/**
 * Exécute une intention. Si l'app est ouverte et prête, tout de suite ; sinon
 * `openApp(appId, tab)` l'ouvre et l'intention attend (15 s max) que l'app
 * appelle `lumen.intents.on()` pour cette intention.
 */
export function runAppIntent(appId, intent, args, openApp) {
  const key = `${appId}:${intent.id}`;
  const live = liveIntents.get(key);
  if (live) return live.callIntent(intent.id, args);
  return new Promise((resolve, reject) => {
    const list = pendingIntents.get(key) || [];
    list.push({ args, resolve, reject });
    pendingIntents.set(key, list);
    try { openApp?.(appId, intent.tab || ""); } catch (e) { reject(e); }
    setTimeout(() => {
      const still = pendingIntents.get(key) || [];
      const i = still.findIndex((w) => w.resolve === resolve);
      if (i >= 0) { still.splice(i, 1); reject(new Error(`« ${appId} » ne s'est pas déclarée prête pour « ${intent.id} »`)); }
    }, 15000);
  });
}

/** Outils des apps, au format attendu par la boucle de tool calling. */
export function appToolDefinitions() {
  return [...appTools.values()].map(({ spec, appId }) => ({
    type: "function",
    function: {
      name: `${appId}_${spec.name}`.replace(/[^a-zA-Z0-9_]/g, "_"),
      description: spec.description || "",
      parameters: spec.parameters || { type: "object", properties: {} },
    },
  }));
}

/** Exécute un outil d'app par le nom que voit le modèle. */
export async function callAppTool(flatName, args) {
  for (const [key, entry] of appTools) {
    const exposed = `${entry.appId}_${entry.spec.name}`.replace(/[^a-zA-Z0-9_]/g, "_");
    if (exposed === flatName) return entry.host.callTool(entry.spec.name, args);
    if (key === flatName) return entry.host.callTool(entry.spec.name, args);
  }
  throw new Error(`outil d'application inconnu : ${flatName}`);
}
