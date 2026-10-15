import { resolvePrompt } from "./lib/prompt-registry.js";

// Quatre types (session, sémantique, procédurale, épisodique). Les anciens noms
// restent lisibles : recall.rs les replie sur ces quatre.
export const MEMORY_KINDS = ["session", "semantic", "procedural", "episodic"];
const KIND_LABELS = {
  session: "session",
  semantic: "sémantique",
  procedural: "procédurale",
  episodic: "épisodique",
  emotional: "sémantique",
  narrative: "sémantique",
  shared: "sémantique",
  behavioral: "procédurale",
  prospective: "épisodique",
};
export const LEGACY_KIND = { emotional: "semantic", narrative: "semantic", shared: "semantic", behavioral: "procedural", prospective: "episodic" };
export const normalizeKind = (k) => (MEMORY_KINDS.includes(k) ? k : LEGACY_KIND[k] || "semantic");

/// Outils mémoire de l'IA — UNE définition pour la barre, le mode application
/// et le bureau (elles avaient divergé en trois copies).
export function memoryToolDefs() {
  return [
    { type: "function", function: { name: "memory_recall",
      description: "Rappelle les souvenirs pertinents : session (conversation en cours), semantic (faits et préférences de l'utilisateur), procedural (façons de faire, routines, méthodes qui ont marché), episodic (ce qui s'est passé ou est prévu). À utiliser quand le contexte personnel aide la réponse.",
      parameters: { type: "object", properties: {
        query: { type: "string", description: "Sujet ou question pour cibler le rappel" },
        kinds: { type: "array", items: { type: "string", enum: MEMORY_KINDS }, description: "Types à interroger (vide = tous)" },
      }, required: ["query"] } } },
    { type: "function", function: { name: "memory_remember",
      description: "Mémorise une information que l'utilisateur formule ou confirme. kind = semantic (fait ou préférence durable : « je suis végétarien »), procedural (façon de faire : « mes factures : toujours en PDF avec copie à la compta »), episodic (événement daté ou prévu), session (contexte de cette conversation, oublié sous 24 h). Jamais d'information sensible sans demande explicite.",
      parameters: { type: "object", properties: {
        text: { type: "string", description: "Le souvenir, formulé clairement et de façon autonome" },
        kind: { type: "string", enum: MEMORY_KINDS, description: "Type de souvenir (semantic par défaut)" },
        tags: { type: "array", items: { type: "string" } },
      }, required: ["text"] } } },
  ];
}

/// Exécution partagée des outils mémoire.
export async function runMemoryTool(invoke, name, args = {}, { context = "bar", source = "Conversation" } = {}) {
  if (name === "memory_recall") {
    const kinds = Array.isArray(args.kinds) && args.kinds.length ? args.kinds.map(normalizeKind) : undefined;
    const res = await invoke("mem_recall", { context, query: String(args.query || ""), kinds, limit: 8 });
    if (!res || !res.length) return "Aucun souvenir pertinent.";
    return res.map((r) => `• [${KIND_LABELS[r.kind] || r.kind}] ${r.text}`).join("\n");
  }
  if (name === "memory_remember") {
    const kind = normalizeKind(String(args.kind || "semantic"));
    const tags = Array.isArray(args.tags) ? args.tags.map(String) : [];
    const item = await rememberWithUndo(invoke, { context, kind, text: String(args.text || ""), source, tags });
    return item ? `Souvenir enregistré (${KIND_LABELS[kind]}). L'utilisateur peut l'annuler depuis la note affichée.` : "Aucun souvenir enregistré.";
  }
  throw new Error(`Outil mémoire inconnu : ${name}`);
}

const SENSITIVE_RE = /\b(mot de passe|password|secret|token|api key|clé api|carte bancaire|cb|iban|numéro de sécurité sociale|medical|médical|santé|diagnostic|religion|politique|sexualité|adresse personnelle)\b/i;

export function looksSensitive(text) {
  return SENSITIVE_RE.test(String(text || ""));
}

export async function recallPromptBlock(invoke, query, {
  context = "bar",
  limit = 5,
  title = "Souvenirs pertinents rappelés localement",
} = {}) {
  const q = String(query || "").trim();
  if (!invoke || q.length < 4) return "";
  try {
    const memories = await invoke("mem_recall", { context, query: q, limit });
    if (!Array.isArray(memories) || !memories.length) return "";
    const lines = memories
      .filter((m) => m && m.text)
      .slice(0, limit)
      .map((m) => `- [${KIND_LABELS[m.kind] || m.kind}] ${String(m.text).replace(/\s+/g, " ").trim()}`);
    if (!lines.length) return "";
    // L'en-tête cadre la façon dont le modèle doit traiter ces souvenirs : c'est
    // une consigne, donc personnalisable, contrairement aux souvenirs eux-mêmes.
    const header = resolvePrompt("memory.inject", `[${title} — à utiliser seulement si utile, sans les révéler inutilement]`);
    return `${header}\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

export async function withMemoryRecall(invoke, messages, query, opts = {}) {
  const block = await recallPromptBlock(invoke, query, opts);
  if (!block) return messages;
  const copy = messages.slice();
  const systemIndex = copy.findIndex((m) => m.role === "system");
  if (systemIndex >= 0) {
    copy.splice(systemIndex + 1, 0, { role: "system", content: block });
  } else {
    copy.unshift({ role: "system", content: block });
  }
  return copy;
}

export async function rememberWithUndo(invoke, {
  context = "bar",
  kind = "episodic",
  text,
  source = "Conversation",
  tags = [],
  salience,
  toast = true,
} = {}) {
  const clean = String(text || "").trim();
  if (!invoke || !clean) return null;
  const item = await invoke("mem_remember", { context, kind, text: clean, tags, salience, source });
  if (toast && item?.id) showMemoryToast(invoke, item);
  return item;
}

export function showMemoryToast(invoke, item) {
  if (typeof document === "undefined" || !item) return;
  let wrap = document.querySelector(".memory-toast-wrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "memory-toast-wrap";
    document.body.appendChild(wrap);
  }
  const toast = document.createElement("div");
  toast.className = "memory-toast";
  toast.innerHTML = `<span>Souvenir ajouté</span><button type="button">Annuler</button>`;
  const timer = setTimeout(() => toast.remove(), 7000);
  toast.querySelector("button")?.addEventListener("click", async () => {
    clearTimeout(timer);
    try { await invoke("mem_forget", { context: "app:memory", kind: item.kind, id: item.id }); } catch {}
    toast.remove();
  });
  wrap.appendChild(toast);
}
