// Application navigation, labels and icon paths; no DOM or runtime state.
const I = {
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  side: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 4v16"/>',
  msg: '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>',
  box: '<path d="M3 9.5h18V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M8 9.5V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v3.5"/><path d="M3 13.5h6v1.5h6v-1.5h6"/>',
  flow: '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
  min: '<path d="M5 12h14"/>',
  max: '<rect x="5" y="5" width="14" height="14" rx="1.5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  lib: '<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>',
  bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1"/><path d="M9 13v1M15 13v1"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  note: '<path d="M15 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M8 13h8M8 17h5M8 9h3"/>',
  cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
  folders: '<path d="M20 17a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6.1a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 9.7 4H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2Z"/><path d="M2 8v11a2 2 0 0 0 2 2h14"/>',
  brain: '<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M12 5v13"/>',
  apps: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><path d="M17.5 14v7M14 17.5h7"/>',
  store: '<path d="M3 9 4.5 4h15L21 9"/><path d="M3 9h18v2a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0z"/><path d="M5 13v7h14v-7"/>',
  chev: '<path d="m9 18 6-6-6-6"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  quote: '<path d="M17 6H3M21 12H8M21 18H8M3 12v6"/>',
  speaker: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
  retry: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
};

// Outils natifs (pages même origine, en iframe comme les fenêtres du bureau).
// Les apps installées (paquets) viennent en plus, rangées par la catégorie de
// leur manifeste (cf. CATS) ; leur vue s'appelle `pkg:<id>`.
export const TOOLS = [
  { id: "messages", icon: "msg", fr: "Messages", en: "Messages", url: "/messenger/messenger.html" },
  { id: "library", icon: "lib", fr: "Bibliothèque", en: "Library", url: "/sandbox/explorer.html" },
  { id: "agents", icon: "bot", fr: "Agents", en: "Agents", url: "/agents/manager.html" },
  { id: "projects", icon: "folders", fr: "Projets", en: "Projects", url: "/projects/projects.html" },
  { id: "fluxo", icon: "zap", fr: "Fluxo", en: "Fluxo", url: "/fluxo/designer.html" },
  { id: "automations", icon: "flow", fr: "Automatisations", en: "Automations", url: "/automations/automations.html" },
  { id: "diagnostic", icon: "chart", fr: "Diagnostic", en: "Diagnostics", url: "/diagnostic/diagnostic.html" },
  { id: "memory", icon: "brain", fr: "Mémoire", en: "Memory", url: "/memory/memory.html" },
  { id: "documents", icon: "doc", fr: "Documents", en: "Documents", url: "/sandbox/office.html?kind=document" },
  { id: "presentations", icon: "layers", fr: "Présentations", en: "Presentations", url: "/sandbox/office.html?kind=presentation" },
];
// Rail (1er niveau) → panneau (2e niveau). `native` : outils ci-dessus (ou
// `@notifications`, bouton de la barre) ; `cats` : catégories de manifeste
// dont les apps installées s'affichent, chacune sous son sous-titre ; `pkgs` :
// apps précises rangées ici quelle que soit leur catégorie.
export const CATS = [
  { id: "chats", icon: "chat", fr: "Discussions", en: "Chats" },
  { id: "organize", icon: "cal", fr: "Organisation", en: "Organize", native: ["projects"], cats: ["organize"] },
  { id: "create", icon: "pen", fr: "Création", en: "Create", cats: ["create"] },
  { id: "data", icon: "chart", fr: "Productivité", en: "Productivity", native: ["documents", "presentations"], pkgs: ["notes", "pdf", "relia"], cats: ["data"] },
  { id: "search", icon: "search", fr: "Recherche", en: "Research", cats: ["search"] },
  { id: "comms", icon: "msg", fr: "Communication", en: "Communication", native: ["messages", "@notifications"], cats: ["comm", "people"] },
  { id: "audio", icon: "speaker", fr: "Audio", en: "Audio", cats: ["audio"] },
  { id: "agents", icon: "bot", fr: "Agents & automatisations", en: "Agents & automations", native: ["automations", "fluxo", "agents", "memory", "diagnostic"] },
  { id: "files", icon: "lib", fr: "Fichiers", en: "Files", native: ["library"] },
  { id: "extensions", icon: "apps", fr: "Extensions", en: "Extensions", cats: ["lab", "play"] },
];
export const SUBTITLE = {
  comm: { fr: "Communication", en: "Communication" }, people: { fr: "Personnes", en: "People" },
  data: { fr: "Données", en: "Data" },
  lab: { fr: "Spécialisés", en: "Specialized" }, play: { fr: "Loisirs", en: "Leisure" },
};
export const MARKET = { id: "market", icon: "store", fr: "Catalogue", en: "Catalog", url: "/market/market.html" };
export const FRAME_PERMS = "camera; microphone; display-capture; autoplay; clipboard-write; fullscreen";
export const svg = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[k]}</svg>`;

export const TXT = {
  fr: {
    copy: "Copier", speak: "Lire à voix haute", quote: "Citer dans la réponse", retry: "Réessayer", open: "Ouvrir",
    pin: "Épingler / désépingler", folder: "Ranger dans un dossier", summarize: "Résumer", del: "Supprimer", searchChats: "Rechercher une discussion",
    tools: "Outils", more: "Plus d'apps", missing: "Cette app n'est pas installée.", install: "Ouvrir le Catalogue", chat: "Discussion",
    newChat: "Nouvelle discussion", search: "Rechercher", messages: "Messages", toolbox: "Agents & outils",
    flows: "Automatisations", notifs: "Notifications", desktop: "Lumen Desktop", chats: "Discussions",
    settings: "Réglages", theme: "Thème clair / sombre", mode: "Changer de mode", side: "Afficher / masquer la barre latérale",
    me: "Mon espace", morning: "Bonjour", evening: "Bonsoir", ask: "Que puis-je faire pour vous ?",
    sub: "Discutez, cherchez dans vos données, agissez dans vos apps — en local.",
    foot: "Lumen peut se tromper : vérifiez les informations importantes.",
    min: "Réduire", max: "Agrandir", close: "Quitter Lumen",
    cards: [
      { k: "sun", tint: "#f59e0b", t: "Ma journée", d: "Agenda, rappels et météo", q: "Qu'ai-je au programme aujourd'hui ?", send: true },
      { k: "mail", tint: "#3b82f6", t: "Mes mails", d: "Résumé des derniers messages", q: "Résume mes derniers mails non lus", send: true },
      { k: "doc", tint: "#10b981", t: "Mes documents", d: "Chercher, résumer, comparer", q: "Dans mes documents, ", send: false },
      { k: "zap", tint: "#8b5cf6", t: "Automatiser", d: "Créer un workflow Fluxo", q: "Crée un workflow qui ", send: false },
    ],
  },
  en: {
    copy: "Copy", speak: "Read aloud", quote: "Quote in reply", retry: "Retry", open: "Open",
    pin: "Pin / unpin", folder: "Move to folder", summarize: "Summarize", del: "Delete", searchChats: "Search chats",
    tools: "Tools", more: "More apps", missing: "This app isn't installed.", install: "Open the Catalog", chat: "Chat",
    newChat: "New chat", search: "Search", messages: "Messages", toolbox: "Agents & tools",
    flows: "Automations", notifs: "Notifications", desktop: "Lumen Desktop", chats: "Chats",
    settings: "Settings", theme: "Light / dark theme", mode: "Switch mode", side: "Show / hide sidebar",
    me: "My space", morning: "Good morning", evening: "Good evening", ask: "What can I do for you?",
    sub: "Chat, search your data, act in your apps — locally.",
    foot: "Lumen can make mistakes: double-check important information.",
    min: "Minimize", max: "Maximize", close: "Quit Lumen",
    cards: [
      { k: "sun", tint: "#f59e0b", t: "My day", d: "Calendar, reminders, weather", q: "What's on my plate today?", send: true },
      { k: "mail", tint: "#3b82f6", t: "My email", d: "Summary of recent messages", q: "Summarize my latest unread emails", send: true },
      { k: "doc", tint: "#10b981", t: "My documents", d: "Search, summarize, compare", q: "In my documents, ", send: false },
      { k: "zap", tint: "#8b5cf6", t: "Automate", d: "Build a Fluxo workflow", q: "Create a workflow that ", send: false },
    ],
  },
};

