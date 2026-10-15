// Ouvre une app du bureau depuis n'importe quelle fenêtre : directement si la
// page vit dans le bureau (iframe), sinon par l'évènement que le bureau
// écoute (`lumen-orb-open-app`), comme le font l'orbe et les raccourcis.
// Outils qui ont aussi leur propre fenêtre : hors du bureau (Réglages, app
// Agents ouverts depuis la barre), l'évènement ci-dessous n'a personne pour
// l'écouter et le clic ne faisait rien. On ouvre alors la fenêtre dédiée.
const STANDALONE = { vault: "open_vault", diagnostic: "open_diagnostic", agents: "open_agents_manager", profiler: "open_profiler", messages: "open_messenger" };

export function openLumenApp(id) {
  try {
    const top = window.top;
    if (top && typeof top.LumenOpenAppById === "function") { top.LumenOpenAppById(id); return true; }
  } catch { /* autre origine */ }
  const invoke = (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke;
  if (STANDALONE[id] && invoke) { invoke(STANDALONE[id]).catch((e) => console.warn(`[open-app] ${id}`, e)); return true; }
  const ev = (window.__TAURI__ || window.parent?.__TAURI__)?.event;
  if (ev?.emit) { ev.emit("lumen-orb-open-app", { app: id }).catch?.(() => {}); return true; }
  return false;
}
