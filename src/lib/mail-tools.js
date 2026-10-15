// Outils « @mail_* » des barres de chat : le courrier relevé par l'app Email.
//
// Lecture, recherche, résumé, extraction d'information et brouillons. Jamais
// d'envoi ni de suppression — même règle que pour les agents (native_tools.rs) :
// ce sont des gestes que seul l'utilisateur fait, depuis l'app Email.
//
// Tout passe par la commande Rust `mail_chat_tool` (mail.rs), qui lit la boîte
// locale (`mail.json`) : aucun réseau ici, le courrier doit avoir été relevé.
// Résumer et répondre à une question passent par le modèle courant (`llmChat`)
// DANS l'outil : le modèle du chat reçoit une synthèse courte au lieu de dix
// corps de messages, ce qui compte avec un petit contexte.
//
// Partagé par la barre principale (main.js) et le bureau (sandbox/desktop.js).

import { llmChat } from "../llm.js";
import { PROMPTS } from "../mail/prompts.js";
import { appDecider } from "./decisions.js";

const safeGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

export const MAIL_TOOL_NAMES = new Set([
  "mail_boite", "mail_rechercher", "mail_lire", "mail_resumer", "mail_trouver_info", "mail_brouillon",
]);

const fn = (name, description, properties = {}, required = []) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});

export function buildMailTools() {
  return [
    fn("mail_boite",
      "Liste les derniers e-mails relevés (uid, expéditeur, objet, date, lu/non lu). À utiliser pour « qu'est-ce que j'ai reçu », « mes mails non lus ».",
      {
        limit: { type: "integer", description: "Nombre de messages (défaut 10, max 50)." },
        unread_only: { type: "boolean", description: "Seulement les non lus." },
      }),
    fn("mail_rechercher",
      "Recherche dans les e-mails relevés par mots-clés (objet, expéditeur, corps). Renvoie les messages trouvés avec leur uid et un extrait.",
      {
        query: { type: "string", description: "Mots à chercher : nom, adresse, sujet, numéro…" },
        limit: { type: "integer", description: "Nombre maximal de résultats (défaut 8)." },
      }, ["query"]),
    fn("mail_lire",
      "Lit un e-mail en entier. Donne son uid (vu dans mail_boite / mail_rechercher) ou un morceau de son objet.",
      {
        uid: { type: "integer", description: "uid du message." },
        subject: { type: "string", description: "Morceau de l'objet, si l'uid n'est pas connu." },
      }),
    fn("mail_resumer",
      "Résume le courrier : un ou plusieurs messages (uids), ou les derniers reçus / non lus. Fait ressortir priorités, demandes et échéances. Préfère cet outil à la lecture de chaque message.",
      {
        uids: { type: "array", items: { type: "integer" }, description: "Messages précis à résumer (facultatif)." },
        query: { type: "string", description: "Ou : résumer les messages qui parlent de ce sujet." },
        unread_only: { type: "boolean", description: "Seulement les non lus (si ni uids ni query)." },
        limit: { type: "integer", description: "Nombre de messages récents (défaut 10)." },
        focus: { type: "string", description: "Angle du résumé (ex. « ce qui demande une réponse »)." },
      }),
    fn("mail_trouver_info",
      "Répond à une question factuelle à partir des e-mails (numéro de commande, date de rendez-vous, adresse, montant, lien…). Cherche lui-même les messages pertinents et cite celui d'où vient la réponse.",
      {
        question: { type: "string", description: "La question, telle que l'utilisateur la pose." },
        query: { type: "string", description: "Mots-clés de recherche (facultatif, déduits de la question sinon)." },
      }, ["question"]),
    fn("mail_brouillon",
      "Enregistre un brouillon d'e-mail dans l'app Email (il n'est PAS envoyé). Pour répondre, donne reply_to_uid : destinataire et objet se déduisent. Soit tu écris le corps dans body, soit tu donnes des consignes dans instructions et l'outil le rédige à partir du message d'origine.",
      {
        reply_to_uid: { type: "integer", description: "uid du message auquel on répond (facultatif)." },
        to: { type: "string", description: "Destinataire (nouveau message)." },
        subject: { type: "string", description: "Objet (nouveau message)." },
        body: { type: "string", description: "Corps complet du message, prêt à envoyer." },
        instructions: { type: "string", description: "Ou : ce que doit dire le message (ton, points à couvrir)." },
      }),
  ];
}

const call = (invoke, action, args = {}) => invoke("mail_chat_tool", { action, args });

async function complete(messages) {
  const { content } = await llmChat(messages, { rawSystem: true });
  return String(content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

// Corps nettoyé et borné : les lettres d'information (liens de suivi, pieds
// de page) noyaient les petits modèles, qui inventaient alors le contenu.
function cleanBody(body, max = 2500) {
  const txt = String(body || "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
  return txt.length > max ? `${txt.slice(0, max)}…` : txt;
}

function asBlock(m) {
  return `[uid ${m.uid}] De : ${m.from} · ${m.date}${m.read ? "" : " · NON LU"}\nObjet : ${m.subject}\n${cleanBody(m.body)}`;
}

// « non lus », « nouveaux », « unread » passés en mot-clé : c'est un filtre,
// pas une recherche (sinon on résumait les messages CONTENANT « non lus »).
const UNREAD_WORDS = /^\s*(?:mails?\s+|messages?\s+|e-?mails?\s+)?(?:non[- ]?lus?|pas\s+lus?|nouveaux?|r[ée]cents?|derniers?|unread|new|latest|recent)\s*$/i;

// Le même appel répété dans un tour (petits modèles) : on renvoie le résultat
// déjà calculé avec une consigne de conclure, au lieu de relancer un résumé
// différent à chaque fois.
const recentCalls = new Map();   // clé d'arguments → { at, text }
function memo(key) {
  const hit = recentCalls.get(key);
  return hit && Date.now() - hit.at < 90_000 ? hit.text : null;
}

/// uids des meilleurs résultats d'une recherche (lus dans le texte renvoyé).
async function searchUids(invoke, query, limit) {
  const text = String(await call(invoke, "search", { query, limit }));
  return [...text.matchAll(/uid (\d+)/g)].map((x) => Number(x[1])).slice(0, limit);
}


/**
 * Exécute un outil `mail_*` et renvoie le texte destiné au modèle.
 * @param {Function} invoke
 * @param {string} name
 * @param {object} args
 * @param {{lang?: string}} [opts]
 */
export async function callMailTool(invoke, name, args = {}, opts = {}) {
  const code = String(opts.lang || "").startsWith("en") ? "en" : "fr";
  switch (name) {
    case "mail_boite":
      return String(await call(invoke, "list", { limit: Number(args.limit) || 10, unread_only: Boolean(args.unread_only) }));

    case "mail_rechercher":
      return String(await call(invoke, "search", { query: String(args.query || ""), limit: Number(args.limit) || 8 }));

    case "mail_lire":
      return String(await call(invoke, "read", { uid: Number(args.uid) || 0, subject: String(args.subject || "") }));

    case "mail_resumer": {
      if (typeof args === "string") args = { query: args };
      if (args.query && UNREAD_WORDS.test(String(args.query))) { args = { ...args, unread_only: true }; delete args.query; }
      const key = JSON.stringify(["resumer", args.uids || null, args.query || "", Boolean(args.unread_only), args.limit || 0]);
      const seen = memo(key);
      if (seen) return `${seen}\n\n(Résultat déjà fourni : n'appelle plus cet outil, rédige maintenant la réponse.)`;
      let uids = Array.isArray(args.uids) ? args.uids.map(Number).filter(Boolean) : [];
      if (!uids.length && args.query) uids = await searchUids(invoke, String(args.query), 8);
      if (!uids.length && args.query) return `Aucun message ne parle de « ${args.query} ».`;
      let msgs = await call(invoke, "bodies", { uids, limit: Number(args.limit) || 10, unread_only: Boolean(args.unread_only) });
      if (!msgs?.length) return args.unread_only ? "Aucun message non lu." : "Aucun message relevé : ouvre l'app Email et relève le courrier.";
      const single = msgs.length === 1;
      // Système 1 (Tev1) : urgence de chaque message ; les urgents passent en tête.
      const urgent = new Set();
      const decider = !single && opts.decider !== null ? (opts.decider || appDecider({ aiSource: safeGet("aiSource") || "llama", ollamaUrl: safeGet("ollamaUrl") || "http://localhost:11434", invoke })) : null;
      if (decider) {
        for (const m of msgs) {
          const t = await decider.decide("triage", { from: m.from, subject: m.subject, body: cleanBody(m.body, 1200) }).catch(() => null);
          if (t?.value === "urgent") urgent.add(m.uid);
        }
        msgs = [...msgs.filter((m) => urgent.has(m.uid)), ...msgs.filter((m) => !urgent.has(m.uid))];
      }
      const summary = await complete(PROMPTS["tool.mail.summarize"].build({
        mails: msgs.map((m) => (urgent.has(m.uid) ? "[URGENT selon le tri] " : "") + asBlock(m)).join("\n\n---\n\n"), single, focus: args.focus || "", lang: code,
      }).messages);
      // En-têtes exacts, posés par l'outil : le modèle ne peut pas se tromper
      // d'expéditeur ni d'objet.
      const heads = msgs.map((m) => `- ${urgent.has(m.uid) ? "⚠️ URGENT " : ""}[uid ${m.uid}] ${m.from} — « ${m.subject} »${m.read ? "" : " (non lu)"}`).join("\n");
      const text = `${msgs.length} message(s)${args.unread_only ? " non lu(s)" : ""} :\n${heads}\n\nRésumé :\n${summary}`;
      recentCalls.set(key, { at: Date.now(), text });
      return text;
    }

    case "mail_trouver_info": {
      const question = String(args.question || "").trim();
      if (!question) return "Question vide.";
      let uids = await searchUids(invoke, String(args.query || question), 6);
      // Rien avec la question entière : on retente avec ses mots les plus longs.
      if (!uids.length && !args.query) {
        const words = question.split(/\s+/).filter((w) => w.length >= 5).sort((a, b) => b.length - a.length).slice(0, 3);
        for (const w of words) {
          uids = await searchUids(invoke, w, 6);
          if (uids.length) break;
        }
      }
      if (!uids.length) return `Aucun e-mail relevé ne semble contenir la réponse à « ${question} ». Propose de relever le courrier ou de préciser des mots-clés.`;
      const msgs = await call(invoke, "bodies", { uids });
      const answer = await complete(PROMPTS["tool.mail.find"].build({
        question, mails: msgs.map(asBlock).join("\n\n---\n\n"), lang: code,
      }).messages);
      return answer;
    }

    case "mail_brouillon": {
      const replyUid = Number(args.reply_to_uid) || 0;
      let body = String(args.body || "").trim();
      if (!body) {
        const instructions = String(args.instructions || "").trim();
        if (!instructions && !replyUid) return "Brouillon vide : donne le corps (body) ou des consignes (instructions).";
        const original = replyUid ? String(await call(invoke, "read", { uid: replyUid })) : "";
        body = await complete(PROMPTS["tool.mail.draft"].build({
          original, instructions, to: String(args.to || ""), subject: String(args.subject || ""), lang: code,
        }).messages);
      }
      const res = await call(invoke, "draft", {
        to: String(args.to || ""), subject: String(args.subject || ""), body, reply_to_uid: replyUid,
      });
      return `${res}\n\nCorps du brouillon :\n${body}\n\n(Rappelle à l'utilisateur que rien n'est envoyé : il relit et envoie depuis l'app Email.)`;
    }
  }
  return `Outil courrier inconnu : ${name}`;
}
