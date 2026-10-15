// Shared navigation contract for Application, Desktop and catalogue packages.
// Known ids keep their space when an older installed manifest has an old category.
export const APP_SPACES = ["create", "organize", "data", "search", "people", "comm", "audio", "lab", "play"];
export const APP_SPACE_OF = {
  notes: "create", mindmap: "create", moodboard: "create", canvas: "create", nodal: "create", imagestudio: "create", pdf: "create", media: "create", photos: "create",
  kanban: "organize", calendar: "organize", morning: "organize", scheduler: "organize", budget: "organize", studies: "organize",
  vault: "data", tables: "data", dataanalysis: "data", calculator: "data", dbstudio: "data", etl: "data", datasources: "data",
  knowledge: "search", research: "search", browser: "search", carte: "search",
  contacts: "people", directory: "people", relia: "people",
  mail: "comm", meet: "comm", messages: "comm",
  podcast: "audio", voicelab: "audio", musicstudio: "audio",
  editor: "lab", robotstudio: "lab", python: "lab", domotique: "lab", ml: "lab",
  games: "play", adventure: "play", aipet: "play", village: "play",
};

export function appSpace(app) {
  if (APP_SPACE_OF[app?.id]) return APP_SPACE_OF[app.id];
  const category = app?.category || app?.cat;
  if (APP_SPACES.includes(category)) return category;
  // Legacy categories; unknown third-party packages stay discoverable.
  return ({ explore: "search", pro: "data", code: "lab" })[category] || "lab";
}
