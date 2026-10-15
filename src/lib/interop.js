// Tissu conjonctif : un format d'objet commun et un bus « Envoyer vers… »
// partagé par toutes les apps de Lumen.
//
// LE PROBLÈME QUE ÇA RÉSOUT
// Chaque app de Lumen est excellente seule, mais faire passer quelque chose de
// l'une à l'autre demandait jusqu'ici du code de colle spécifique à CHAQUE
// paire (cf. `window.LumenOpenSheetFile`, écrit pour la seule route Analyse →
// Calc). À vingt-huit apps, ça ne tient plus : il faut un format que tout le
// monde parle et un point de rendez-vous unique.
//
// LE MODÈLE
//   1. Un **objet Lumen** : { kind, title, ... } — cf. makeObject().
//   2. Un **registre de cibles** : chaque app déclare les `kind` qu'elle
//      accepte et ce qu'elle sait en faire.
//   3. Un **relais** (handoff) : share() dépose l'objet dans une file au nom de
//      l'app cible, ouvre cette app, et l'app le récupère au démarrage avec
//      takeHandoff(). L'expéditeur n'a jamais besoin de connaître le
//      destinataire.
//   4. Une **étagère** : un presse-papier universel et persistant, pour parquer
//      un objet sans choisir tout de suite où il va.
//
// OÙ VIT L'ÉTAT
// Les apps sont des iframes MÊME ORIGINE du bureau : le bus vit donc sur la
// fenêtre du haut (`top.__lumenBus`), ce qui permet de passer des objets
// volumineux (images, tableaux) par référence, sans sérialisation ni quota
// localStorage. Seule l'étagère est miroitée sur le disque, allégée.

import { tt } from "../apps-i18n.js";

const SHELF_KEY = "lumen:shelf";
const SHELF_MAX = 30;
// Un objet plus gros que ça ne part pas sur le disque : il reste en mémoire
// pour la session. Évite de faire exploser le quota localStorage avec une
// image en data: URL.
const SHELF_PERSIST_MAX_BYTES = 256 * 1024;

/** Les natures d'objet que Lumen sait faire circuler. */
export const KINDS = {
  /** Du texte, éventuellement en Markdown. { text, markdown? } */
  text: "text",
  /** Un tableau. { columns: string[], rows: any[][] } */
  table: "table",
  /** Une image. { dataUrl } ou { path, sandboxId } */
  image: "image",
  /** Une adresse web. { url, excerpt? } */
  link: "link",
  /** Un fichier de sandbox. { path, sandboxId, mime? } */
  file: "file",
  /** Une chose à faire. { text, due?, tags? } */
  task: "task",
  /** Une personne du carnet d'adresses. { name, email?, phone? } */
  contact: "contact",
};

/** Le bus partagé, hébergé par la fenêtre du haut. */
/**
 * Vrai quand l'app tourne dans une iframe d'une AUTRE origine (apps paquets
 * `lumenapp://`) : la fenêtre du haut est alors hors d'atteinte, et tout doit
 * passer par le SDK AppKit (`window.lumen.interop`), qui relaie à l'hôte.
 */
function isolated() {
  try {
    if (!window.top || window.top === window) return false;
    void window.top.document; // jette en cross-origin
    return false;
  } catch {
    return true;
  }
}

/** Pont AppKit disponible ? (posé par guest.js dans les apps paquets) */
function sdk() {
  return isolated() && window.lumen && window.lumen.__appkit ? window.lumen.interop : null;
}

function bus() {
  let host = window;
  try {
    // `top` est inaccessible en cross-origin : un accès à une propriété jette
    // une SecurityError. On retombe alors sur un bus local — et les échanges
    // réels passent par le SDK (cf. sdk()).
    if (window.top && window.top !== window && !isolated()) host = window.top;
  } catch {}
  if (!host.__lumenBus) {
    host.__lumenBus = { queues: new Map(), receivers: new Map(), shelf: null };
  }
  return host.__lumenBus;
}

/**
 * Construit un objet Lumen valide. Toujours passer par ici : la provenance
 * (`meta.sourceApp`) est ce qui permet à la cible d'afficher « depuis Notes »
 * et à l'utilisateur de comprendre d'où sort ce qu'il voit.
 *
 * @param {string} kind une valeur de KINDS
 * @param {object} payload les champs propres au kind
 * @param {{app?:string, title?:string}} [source]
 */
export function makeObject(kind, payload, source = {}) {
  if (!KINDS[kind]) throw new Error(`Nature d'objet inconnue : ${kind}`);
  return {
    kind,
    title: payload.title || "",
    ...payload,
    meta: {
      sourceApp: source.app || currentAppId(),
      sourceTitle: source.title || document.title || "",
      createdAt: Date.now(),
    },
  };
}

/**
 * Devine l'app courante depuis l'URL (/notes/notes.html → "notes"). Les apps
 * peuvent surcharger en posant `window.LUMEN_APP_ID`.
 */
function currentAppId() {
  if (window.LUMEN_APP_ID) return window.LUMEN_APP_ID;
  const seg = location.pathname.split("/").filter(Boolean)[0] || "";
  return seg.replace(/\.html$/, "");
}

// ===== Registre des cibles =================================================
// Déclaré ici, en un seul endroit, plutôt que dispersé dans chaque app : c'est
// la carte de ce que Lumen sait relier. Ajouter une app = ajouter une ligne
// ici + un appel à takeHandoff() dans l'app.
//
// `appId` doit être un identifiant que `window.LumenOpenAppById` sait ouvrir
// (cf. DT_APPS et DT_LEGACY dans sandbox/desktop.js).

// `icon` : nom Lucide (cf. lib/icons.js), affiché par le sélecteur « Envoyer vers… ».
export const TARGETS = [
  { appId: "notes", label: "Notes", icon: "notes", accepts: ["text", "link", "task"],
    hint: "Créer une note" },
  { appId: "documents", label: "Opus", icon: "pages", accepts: ["text", "table", "image", "link"],
    hint: "Nouveau document" },
  { appId: "sheets", label: "Calc", icon: "table", accepts: ["table"],
    hint: "Ouvrir dans le tableur" },
  { appId: "tables", label: "Bases de données", icon: "database", accepts: ["table"],
    hint: "Créer une table" },
  { appId: "dataanalysis", label: "Analyse de données", icon: "chart-line", accepts: ["table", "file"],
    hint: "Charger le jeu de données" },
  { appId: "mindmap", label: "Carte mentale", icon: "mindmap", accepts: ["text"],
    hint: "Nouveau nœud (et ses enfants)" },
  { appId: "kanban", label: "Tableau", icon: "kanban", accepts: ["task", "text"],
    hint: "Ajouter une carte" },
  { appId: "knowledge", label: "Corpus", icon: "knowledge", accepts: ["text", "file", "link"],
    hint: "Indexer pour le RAG" },
  { appId: "research", label: "Enquête", icon: "research", accepts: ["text"],
    hint: "Approfondir : rapport sourcé" },
  { appId: "moodboard", label: "Planche", icon: "moodboard", accepts: ["image", "link", "text"],
    hint: "Épingler (image) ou compléter le brief" },
  { appId: "memory", label: "Mémoire", icon: "brain", accepts: ["text"],
    hint: "Mémoriser" },
  { appId: "fluxo", label: "Fluxo", icon: "workflow", accepts: ["text"],
    hint: "Créer une automatisation à partir du texte" },
  { appId: "mail", label: "Email", icon: "mail", accepts: ["contact", "text", "file"],
    hint: "Écrire un message" },
  { appId: "contacts", label: "Contacts", icon: "users", accepts: ["contact"],
    hint: "Ajouter au carnet d'adresses" },
  { appId: "pdf", label: "PDF", icon: "pdf", accepts: ["file"],
    hint: "Lire et annoter" },
  { appId: "studies", label: "Études", icon: "book-open", accepts: ["text", "file"],
    hint: "Fiches et quiz à partir du cours" },
  { appId: "media", label: "Médias", icon: "play", accepts: ["file"],
    hint: "Lire ou monter" },
];

/**
 * Les cibles capables d'accueillir un objet donné.
 *
 * « Capable » ne se limite pas au type : une app désinstallée ne peut RIEN
 * recevoir — son `handoff` mettrait l'objet dans une file que personne ne lira
 * et ouvrirait le Catalogue. Le bureau publie `LumenCanOpenApp` pour qu'on ne
 * propose que ce qui existe vraiment ; hors du bureau (barre principale), le
 * filtre est absent et on propose tout, c'est lui qui tranchera.
 */
export function targetsFor(obj) {
  let can = null;
  try {
    let host = window;
    if (window.top && window.top !== window && !isolated()) host = window.top;
    if (typeof host.LumenCanOpenApp === "function") can = host.LumenCanOpenApp;
  } catch {}
  return TARGETS.filter(
    (target) => target.accepts.includes(obj.kind)
      && target.appId !== obj.meta?.sourceApp
      && (!can || can(target.appId)),
  );
}

// ===== Relais ==============================================================

/**
 * Dépose `obj` pour l'app `appId` et l'ouvre. Si l'app est déjà ouverte et
 * s'est abonnée via onHandoff(), elle le reçoit immédiatement.
 */
/**
 * Le bus vit dans la fenêtre qui héberge les apps (le bureau). Une autre
 * fenêtre — la barre principale, les Réglages, l'aperçu — n'a ni le registre
 * des fenêtres ni `LumenOpenAppById` : son `handoff()` déposait l'objet dans
 * une file que personne ne lisait, et « Envoyer vers… » ne faisait rien. On
 * relaie donc l'objet au bureau par un événement Tauri, après s'être assuré
 * qu'il est ouvert.
 */
// Objets relayés en attente d'accusé de réception, par identifiant.
// Le bureau peut être FERMÉ (sa webview n'est pas encore chargée) ou
// VERROUILLÉ (écran de session) : dans les deux cas, un simple `emit` part
// dans le vide et l'objet est perdu. On garde donc l'objet ici jusqu'à
// l'accusé, et on le renvoie dès que le bureau annonce qu'il est prêt.
const relayPending = new Map();
const RELAY_TTL = 5 * 60 * 1000;
let relayWired = false;

function relayId() {
  return `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function wireRelay(tauri) {
  if (relayWired || !tauri?.event?.listen) return;
  relayWired = true;
  // Accusé : l'objet est arrivé, le bureau en est responsable.
  tauri.event.listen("lumen-interop-ack", (e) => {
    const id = e?.payload?.id;
    if (id) relayPending.delete(id);
  });
  // Le bureau vient de se monter (démarrage, ou session déverrouillée) :
  // c'est le moment de lui repasser ce qu'il n'a pas pu recevoir.
  tauri.event.listen("lumen-interop-ready", () => {
    const now = Date.now();
    for (const [id, item] of [...relayPending]) {
      if (now - item.at > RELAY_TTL) { relayPending.delete(id); continue; }
      tauri.event.emit("lumen-interop-handoff", { id, appId: item.appId, object: item.object });
    }
  });
}

function relayToDesktop(appId, obj) {
  const tauri = window.__TAURI__;
  if (!tauri?.event?.emit) return false;
  wireRelay(tauri);
  const id = relayId();
  relayPending.set(id, { appId, object: obj, at: Date.now() });
  const send = () => tauri.event.emit("lumen-interop-handoff", { id, appId, object: obj });
  // Le bureau n'est peut-être pas ouvert : on le demande, puis on relaie. S'il
  // est déjà là et déverrouillé, il accuse réception tout de suite ; sinon
  // l'objet attend son signal « prêt » (après le mot de passe).
  const open = tauri.core?.invoke?.("open_sandbox_explorer", { desktop: true });
  if (open?.then) open.then(() => setTimeout(send, 300)).catch(() => send());
  else send();
  return true;
}

/** Les objets relayés qui n'ont pas encore été pris en charge (tests, diagnostic). */
export function pendingRelays() {
  return [...relayPending.entries()].map(([id, v]) => ({ id, appId: v.appId }));
}

/** Vrai quand CETTE fenêtre héberge les apps (le bureau les ouvre lui-même). */
function hostsApps() {
  let host = window;
  try { if (window.top && window.top !== window && !isolated()) host = window.top; } catch {}
  return typeof host.LumenOpenAppById === "function";
}

export function handoff(appId, obj) {
  const api = sdk();
  if (api) {
    // App paquet : l'hôte reconstruit l'objet et ouvre la cible.
    api.send(appId, obj.kind, obj).catch((e) => console.warn("Envoi impossible", e));
    return true;
  }
  const b = bus();
  const live = b.receivers.get(appId);
  if (live) {
    // App déjà ouverte et à l'écoute : livraison directe, pas de file. On
    // n'appelle PAS openApp() ici — le récepteur ouvre ou rafraîchit lui-même
    // sa fenêtre, et rouvrir par-dessus créerait un doublon vide (Opus et Calc
    // ne dédoublonnent pas leurs fenêtres comme le fait openAppFrame).
    try {
      live(obj);
      return true;
    } catch {
      // Le récepteur a échoué — on retombe sur la file, l'app le relira au
      // prochain démarrage plutôt que de perdre l'objet.
    }
  }
  // Hors du bureau : c'est lui qui sait ouvrir l'app, on lui passe l'objet.
  if (!hostsApps() && relayToDesktop(appId, obj)) return true;
  const queue = b.queues.get(appId) || [];
  queue.push(obj);
  b.queues.set(appId, queue);
  openApp(appId);
  return true;
}

function openApp(appId) {
  let host = window;
  try { if (window.top && window.top !== window) host = window.top; } catch {}
  host.LumenOpenAppById?.(appId);
}

/**
 * À appeler au démarrage d'une app : récupère les objets qui l'attendent.
 * Vider la file est délibéré — un objet ne doit être traité qu'une fois.
 * @returns {object[]}
 */
export function takeHandoff(appId) {
  const b = bus();
  const queue = b.queues.get(appId) || [];
  b.queues.set(appId, []);
  return queue;
}

/**
 * S'abonne aux objets arrivant pendant que l'app est ouverte. Le retour
 * désabonne. À appeler APRÈS takeHandoff() pour ne rien manquer.
 */
export function onHandoff(appId, handler) {
  const b = bus();
  b.receivers.set(appId, handler);
  return () => {
    if (b.receivers.get(appId) === handler) b.receivers.delete(appId);
  };
}

/**
 * Raccourci pour une app qui veut simplement « recevoir » : traite ce qui
 * attend et reste à l'écoute.
 */
export function receive(appId, handler) {
  const api = sdk();
  if (api) {
    // App paquet : l'hôte livre ce qui attendait puis relaie en direct.
    api.receive(handler, appId).catch((e) => console.warn("Réception impossible", e));
    return () => {};
  }
  for (const obj of takeHandoff(appId)) {
    try { handler(obj); } catch (e) { console.warn("Réception échouée", e); }
  }
  return onHandoff(appId, handler);
}

// ===== Étagère (presse-papier universel) ===================================

function loadShelf() {
  const b = bus();
  if (b.shelf) return b.shelf;
  try {
    const parsed = JSON.parse(localStorage.getItem(SHELF_KEY) || "[]");
    b.shelf = Array.isArray(parsed) ? parsed : [];
  } catch {
    b.shelf = [];
  }
  return b.shelf;
}

function persistShelf(shelf) {
  // On ne persiste que ce qui est raisonnable : les gros objets restent
  // disponibles en mémoire jusqu'à la fermeture de Lumen.
  const light = shelf.filter((o) => JSON.stringify(o).length <= SHELF_PERSIST_MAX_BYTES);
  try {
    localStorage.setItem(SHELF_KEY, JSON.stringify(light));
  } catch {
    // Quota dépassé malgré le filtre : on abandonne la persistance plutôt que
    // de faire échouer l'action de l'utilisateur.
  }
}

/** Pose un objet sur l'étagère (le plus récent en premier). */
export function shelve(obj) {
  const shelf = loadShelf();
  shelf.unshift(obj);
  shelf.splice(SHELF_MAX);
  persistShelf(shelf);
  return shelf;
}

export function readShelf() {
  return loadShelf().slice();
}

export function clearShelf() {
  const b = bus();
  b.shelf = [];
  persistShelf([]);
}

// ===== Résumé lisible ======================================================

/** Une ligne de description d'un objet, pour les listes et le sélecteur. */
export function describe(obj) {
  if (!obj) return "";
  if (obj.title) return obj.title;
  switch (obj.kind) {
    case "text":
      return (obj.text || "").replace(/\s+/g, " ").slice(0, 80) || tt("Texte vide");
    case "table":
      return tt("{r} lignes × {c} colonnes", { r: obj.rows?.length || 0, c: obj.columns?.length || 0 });
    case "link":
      return obj.url || tt("Lien");
    case "image":
      return tt("Image");
    case "file":
      return obj.path || tt("Fichier");
    case "task":
      return obj.text || tt("Tâche");
    case "contact":
      return obj.name || obj.email || tt("Contact");
    default:
      return obj.kind;
  }
}

/**
 * Convertit un objet en texte, pour les cibles qui ne savent lire que ça
 * (Notes, Mémoire, un champ de saisie…). Une table devient du Markdown.
 */
export function toText(obj) {
  switch (obj.kind) {
    case "text":
      return obj.text || "";
    case "link":
      return obj.excerpt ? `[${obj.title || obj.url}](${obj.url})\n\n${obj.excerpt}` : obj.url || "";
    case "task":
      return obj.text || "";
    case "table": {
      const cols = obj.columns || [];
      const head = `| ${cols.join(" | ")} |`;
      const sep = `| ${cols.map(() => "---").join(" | ")} |`;
      const body = (obj.rows || [])
        .map((r) => `| ${r.map((c) => String(c ?? "")).join(" | ")} |`)
        .join("\n");
      return [head, sep, body].join("\n");
    }
    case "image":
      return obj.dataUrl ? `![${obj.title || "image"}](${obj.dataUrl})` : "";
    case "file":
      return obj.path || "";
    case "contact":
      return [obj.name, obj.email, obj.phone].filter(Boolean).join(" · ");
    default:
      return "";
  }
}
