// Actions sur Lumen lui-même (pilier « Actions » de l'intelligence hybride,
// cf. lib/hybrid.js) : ouvrir une app, ouvrir une section des Réglages,
// changer le thème. Partagé par la barre (main.js) et le bureau
// (sandbox/desktop.js) ; chacun fournit ses propres `host.openApp` /
// `host.openSettings` (la barre relaie au bureau par l'évènement `lumen-open`).

import { setTheme } from "./theme.js";

export const SYSTEM_TOOL_NAMES = new Set(["lumen_open_app", "lumen_open_settings", "lumen_set_theme"]);

export const SETTINGS_SECTIONS = {
  general: "langue, intelligence hybride",
  appearance: "thème, couleurs, fond d'écran, avatar",
  models: "backend, modèle, API cloud, contexte",
  voice: "dictée, voix",
  notifications: "notifications",
  toolbox: "outils proposés à l'IA",
  mcp: "connecteurs",
  devices: "objets connectés",
  profile: "profil de l'utilisateur",
  memory: "mémoire",
  companion: "compagnon mobile",
  maintenance: "sauvegarde, mises à jour",
  licence: "applications installées",
};

const fn = (name, description, properties = {}, required = []) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});

export function buildSystemTools(lang = "fr") {
  const en = lang === "en";
  const sections = Object.entries(SETTINGS_SECTIONS).map(([k, v]) => `${k} (${v})`).join(", ");
  return [
    fn("lumen_open_app",
      en ? "Opens a Lumen app (Notes, Kanban, Calendar, Mail, Browser, Photos…) on the user's screen." : "Ouvre une application de Lumen (Notes, Kanban, Agenda, Email, Navigateur, Photos…) à l'écran.",
      { app: { type: "string", description: en ? "App name, e.g. Notes" : "Nom de l'app, par exemple Notes" } }, ["app"]),
    fn("lumen_open_settings",
      en ? `Opens Lumen settings on a section. Sections: ${sections}.` : `Ouvre les Réglages de Lumen sur une section. Sections : ${sections}.`,
      { section: { type: "string", enum: Object.keys(SETTINGS_SECTIONS) } }, ["section"]),
    fn("lumen_set_theme",
      en ? "Switches Lumen's appearance to light, dark or automatic (follows the system)." : "Passe l'apparence de Lumen en clair, sombre ou automatique (suit le système).",
      { theme: { type: "string", enum: ["light", "dark", "auto"] } }, ["theme"]),
  ];
}

/**
 * @param {{ openApp:(name:string)=>(string|boolean|Promise<string|boolean>), openSettings:(section:string)=>void }} host
 *   `openApp` renvoie le nom de l'app ouverte, ou false si rien ne correspond.
 */
export async function callSystemTool(name, args = {}, { host, lang = "fr" } = {}) {
  const en = lang === "en";
  if (name === "lumen_open_app") {
    const app = String(args.app || "").trim();
    if (!app) return en ? "Error: missing app name." : "Erreur : nom d'app manquant.";
    const opened = await host.openApp(app);
    if (!opened) return en ? `Error: no app named "${app}". Use apps_list to see installed apps.` : `Erreur : aucune app nommée « ${app} ». Utilise apps_list pour voir les apps installées.`;
    return en ? `Opened ${opened === true ? app : opened}.` : `${opened === true ? app : opened} est ouverte.`;
  }
  if (name === "lumen_open_settings") {
    const section = SETTINGS_SECTIONS[args.section] ? args.section : "general";
    host.openSettings(section);
    return en ? `Settings opened on "${section}".` : `Réglages ouverts sur « ${section} ».`;
  }
  if (name === "lumen_set_theme") {
    const theme = ["light", "dark", "auto"].includes(args.theme) ? args.theme : "auto";
    setTheme(theme);
    const label = { light: en ? "light" : "clair", dark: en ? "dark" : "sombre", auto: en ? "automatic" : "automatique" }[theme];
    return en ? `Theme set to ${label}.` : `Thème passé en ${label}.`;
  }
  return en ? `Error: unknown tool ${name}.` : `Erreur : outil inconnu ${name}.`;
}
