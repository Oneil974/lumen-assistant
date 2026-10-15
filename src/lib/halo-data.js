// Sources partagées avec Fichiers, Mémoire et Calendrier. Aucun jeu de données de démonstration.
export async function loadHaloAgenda(invoke, now = Date.now()) {
  const results = await Promise.allSettled([
    invoke("reminders_load"), invoke("app_state_load", { name: "calendar" }),
  ]);
  const parse = (raw, fallback) => typeof raw === "string" ? JSON.parse(raw || JSON.stringify(fallback)) : raw || fallback;
  const events = [];
  const errors = [];
  if (results[0].status === "fulfilled") {
    const reminders = parse(results[0].value, []);
    if (!Array.isArray(reminders)) throw new Error("Invalid reminders data");
    events.push(...reminders.filter(r => !r.done));
  } else errors.push(String(results[0].reason));
  if (results[1].status === "fulfilled") {
    const state = parse(results[1].value, {});
    const sources = parse(state["ext.sources"], []);
    for (const source of sources) {
      if (source.hidden) continue;
      for (const item of parse(state[`ext.events.${source.id}`], [])) {
        events.push({ title: item.title, due_at: item.start, end_at: item.end, location: item.location, note: item.description, source: source.name });
      }
    }
  } else errors.push(String(results[1].reason));
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  return { items: events.filter(r => Number(r.end_at || r.due_at) >= today.getTime())
    .sort((a,b) => Number(a.due_at) - Number(b.due_at)).slice(0, 12), errors };
}
export async function loadHaloMemories(invoke) {
  const results = await Promise.allSettled([
    invoke("mem_recall", { context: "app:memory", query: null, kinds: null, limit: 25 }),
    invoke("memory_get", { key: "user/memories" }),
  ]);
  const items = [], errors = [];
  if (results[0].status === "fulfilled") {
    if (!Array.isArray(results[0].value)) throw new Error("Invalid memory data");
    items.push(...results[0].value.map(r => r.item));
  } else errors.push(String(results[0].reason));
  if (results[1].status === "fulfilled") {
    const profile = results[1].value?.value || [];
    if (Array.isArray(profile)) items.unshift(...profile.map((m, i) => ({ id: `profile-${i}`, kind: "Profil", text: typeof m === "string" ? m : m.text, source: "Profil utilisateur" })));
  } else errors.push(String(results[1].reason));
  return { items, errors };
}
