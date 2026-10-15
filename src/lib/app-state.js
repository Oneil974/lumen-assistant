// État des apps sur disque, en remplacement de localStorage.
//
// `localStorage` est un budget d'environ 10 Mo partagé par TOUTES les fenêtres
// de Lumen (même origine `tauri://localhost`) : un moodboard illustré le
// saturait à lui seul, et plus aucune app ne pouvait écrire — c'est ce qui
// cassait jusqu'au changement de discussion de l'assistant. Ici, chaque app a
// son fichier JSON dans `app-state/`, sans plafond commun, sauvegardable et
// lisible hors de l'app.
//
// L'API imite volontairement `localStorage` (get/set/remove sur des clés
// nommées) pour que la bascule d'une app tienne en un remplacement de mots,
// mais tout est asynchrone à l'ouverture et l'écriture est groupée.
//
//   const store = createStore("moodboard");
//   await store.ready({ migrate: (k) => k.startsWith("moodboard") });
//   store.set("library", JSON.stringify(lib));   // écrit sur disque, différé
//   const raw = store.get("library");            // synchrone, depuis la mémoire

import { lsSet } from "./safe-storage.js";

const invoke = (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke;

/** Un magasin par app. Le même nom renvoie toujours la même instance. */
const stores = new Map();

export function createStore(name) {
  if (stores.has(name)) return stores.get(name);
  const store = makeStore(name);
  stores.set(name, store);
  return store;
}

function makeStore(name) {
  let data = {};          // clé → chaîne
  let loaded = false;
  let saveTimer = null;
  let pending = null;     // promesse d'écriture en cours (pour `flush`)

  // Sans backend (aperçu navigateur, page ouverte hors de Lumen), on retombe
  // sur localStorage : l'app fonctionne, simplement avec l'ancien plafond.
  const backed = !!invoke;

  async function readDisk() {
    try {
      const raw = await invoke("app_state_load", { name });
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") data = parsed;
      }
    } catch (e) {
      console.warn(`[app-state:${name}] lecture impossible :`, e);
    }
  }

  function writeDisk() {
    pending = invoke("app_state_save", { name, data: JSON.stringify(data) })
      .catch((e) => console.warn(`[app-state:${name}] écriture impossible :`, e));
    return pending;
  }

  function schedule() {
    if (!backed) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(writeDisk, 250);
  }

  /// Reprend les clés localStorage de l'app une bonne fois, puis les efface :
  /// c'est ce qui rend la place au stockage partagé.
  function migrate(match) {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && match(k)) keys.push(k);
    }
    let moved = 0;
    for (const k of keys) {
      if (data[k] === undefined) {
        const v = localStorage.getItem(k);
        if (v != null) { data[k] = v; moved += 1; }
      }
      try { localStorage.removeItem(k); } catch {}
    }
    return moved;
  }

  return {
    name,
    get backed() { return backed; },

    /** À appeler une fois au démarrage. `migrate` : prédicat sur les clés. */
    async ready({ migrate: match } = {}) {
      if (loaded) return this;
      loaded = true;
      if (!backed) return this;
      await readDisk();
      if (typeof match === "function") {
        const moved = migrate(match);
        if (moved) {
          await writeDisk();
          console.info(`[app-state:${name}] ${moved} clé(s) migrée(s) depuis localStorage.`);
        }
      }
      return this;
    },

    get(key, fallback = null) {
      if (!backed) return localStorage.getItem(key) ?? fallback;
      const v = data[key];
      return v === undefined ? fallback : v;
    },

    getJSON(key, fallback = null) {
      const raw = this.get(key);
      if (raw == null) return fallback;
      try { return JSON.parse(raw); } catch { return fallback; }
    },

    set(key, value) {
      const v = typeof value === "string" ? value : JSON.stringify(value);
      if (!backed) return lsSet(key, v);
      data[key] = v;
      schedule();
      return true;
    },

    remove(key) {
      if (!backed) { try { localStorage.removeItem(key); } catch {} return; }
      delete data[key];
      schedule();
    },

    keys() {
      if (!backed) return Object.keys(localStorage);
      return Object.keys(data);
    },

    /** Force l'écriture immédiate (avant fermeture, export…). */
    async flush() {
      if (!backed) return;
      clearTimeout(saveTimer);
      await writeDisk();
      await pending;
    },

    /**
     * Rappel quand un AUTRE écrivain (l'IA, une autre fenêtre) modifie cet état
     * et l'annonce par l'évènement Tauri `app-state-changed` { name } : l'état
     * est relu sur disque avant l'appel.
     */
    onExternalChange(fn) {
      const ev = (window.__TAURI__ || window.parent?.__TAURI__)?.event;
      if (!backed || !ev?.listen) return () => {};
      let un = null;
      ev.listen("app-state-changed", async (e) => {
        if (e?.payload?.name !== name) return;
        clearTimeout(saveTimer); // l'écriture externe fait foi
        await readDisk();
        try { fn(); } catch (err) { console.warn(`[app-state:${name}]`, err); }
      }).then((u) => { un = u; });
      return () => un?.();
    },

    /** Poids approximatif de l'état, en octets. */
    bytes() {
      return Object.entries(data).reduce((a, [k, v]) => a + k.length + String(v).length, 0);
    },
  };
}
