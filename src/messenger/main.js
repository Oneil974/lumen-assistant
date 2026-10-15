// Hôte bureau de la messagerie : transport par invoke() + évènements Tauri.
import { mountMessenger } from "../lib/messenger-ui.js";
import { desktopVoice } from "../lib/voice-adapters.js";

const T = window.__TAURI__ || window.parent?.__TAURI__;
const invoke = T?.core?.invoke;
const listen = T?.event?.listen;
const lang = (localStorage.getItem("lang") || "fr").toLowerCase().startsWith("en") ? "en" : "fr";

const transport = {
  contacts: () => invoke("messenger_contacts"),
  threads: () => invoke("messenger_threads"),
  thread: (id) => invoke("messenger_thread", { id }),
  create: (contact) => invoke("messenger_new", { contact, title: null }),
  send: (thread, text, images) => invoke("messenger_send", { thread, text, images }),
  cut: (thread) => invoke("messenger_cut", { thread }),
  stop: (thread) => invoke("messenger_stop", { thread }),
  remove: (thread) => invoke("messenger_delete", { thread }),
  update: (thread, patch) => invoke("messenger_update", { thread, title: patch.title ?? null, pinned: patch.pinned ?? null, read: patch.read ?? null, orchestrate: patch.orchestrate ?? null }),
  tools: (thread) => invoke("messenger_tools", { thread }),
  fileUrl: (id) => invoke("messenger_file", { id }),
  // Mode vocal : Whisper local + voix Piper/Kokoro de Lumen.
  voice: invoke && listen ? desktopVoice({ invoke, listen, lang }) : undefined,
  onEvent(cb) {
    let un = null;
    listen?.("messenger", (e) => cb(e.payload)).then((u) => { un = u; });
    return () => un?.();
  },
};

const params = new URLSearchParams(location.search);
mountMessenger(document.getElementById("app"), transport, { lang, openThread: params.get("thread") || undefined });
