// Prompts IA du courrier : app Email et outils @mail_* du chat (lib/mail-tools.js).
// Lus aussi par le banc `npm run bench`.
import { buildPrompt } from "../lib/prompt-kit.js";

const SAMPLE_MAIL = "Objet : Commande 48213 — livraison\nDe : service@meublo.fr\n\nBonjour,\nVotre commande n° 48213 (canapé Oslo, 1 290 €) sera livrée le mardi 14 octobre entre 8 h et 12 h. Merci de confirmer votre présence avant le 10 octobre en répondant à ce message.\nCordialement,\nMeublo";

export const PROMPTS = {
  "app.mail.summary": {
    kind: "summary",
    label: "Email — résumer un message",
    role: "Tu résumes un courriel pour son destinataire : l'essentiel, ce qu'on attend de lui, les échéances et montants exacts.",
    build: ({ mail, lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.mail.summary", kind: "summary", lang, role: PROMPTS["app.mail.summary"].role,
        data: { COURRIEL: mail }, format: "3 puces au plus, puis une ligne « Action attendue : … » si le message en demande une. Pas de formule de politesse." }),
    }),
    bench: [{ vars: { mail: SAMPLE_MAIL }, expect: { re: ["48213|canapé", "14 octobre", "10 octobre", "Action attendue"], not: ["^bonjour"] } }],
  },
  "app.mail.draft": {
    kind: "write",
    label: "Email — brouillon de réponse",
    role: "Tu rédiges un brouillon de réponse à un courriel, dans la langue du message reçu : ton professionnel et bref. Ne signe pas, n'invente aucun fait, et laisse « … » là où seul l'utilisateur peut décider.",
    build: ({ mail }) => ({
      messages: buildPrompt({ id: "app.mail.draft", kind: "write", lang: "", role: PROMPTS["app.mail.draft"].role,
        data: { "COURRIEL REÇU": mail }, format: "le corps du message seulement, sans objet ni signature." }),
    }),
    bench: [{ vars: { mail: SAMPLE_MAIL }, expect: { re: ["14 octobre|livraison|présen"], not: ["^objet", "cordialement,?\\s*\\n\\s*\\w+\\s*$"], lang: "fr" } }],
  },
  "app.mail.compose": {
    kind: "write",
    label: "Email — rédiger à partir d'une consigne",
    role: "Tu rédiges un courriel à partir d'une consigne : ton professionnel, direct, sans emphase.",
    build: ({ brief, draft = "", lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.mail.compose", kind: "write", lang, role: PROMPTS["app.mail.compose"].role,
        data: { "BROUILLON EXISTANT": draft }, request: brief, format: "le corps du message seulement, sans objet ni signature." }),
    }),
    bench: [{ vars: { brief: "Demander à Paul de décaler notre rendez-vous de jeudi à vendredi même heure" }, expect: { re: ["Paul", "vendredi", "jeudi"], not: ["^objet\\s*:"], lang: "fr" } }],
  },
  "tool.mail.summarize": {
    kind: "summary",
    label: "Chat @mail — résumé du courrier",
    role: "Tu résumes du courrier électronique sans rien inventer : n'utilise QUE le texte fourni, pas d'emoji, pas de formule de politesse.",
    build: ({ mails, single = false, focus = "", lang = "fr" }) => ({
      messages: buildPrompt({ id: "tool.mail.summarize", kind: "summary", lang, role: PROMPTS["tool.mail.summarize"].role,
        data: { "E-MAILS": mails },
        request: focus ? `Angle demandé : ${focus}` : "",
        format: single
          ? "3 à 5 puces : l'essentiel, ce qu'on attend du destinataire, les échéances et montants exacts."
          : "une ligne par message utile, triés par importance : « [uid N] Expéditeur — l'essentiel (action attendue, échéance) ». Lettres d'information et notifications regroupées en une ligne à la fin. Termine par « À traiter : … » si des réponses sont attendues." }),
    }),
    bench: [{ vars: { single: true, mails: `[uid 12] De : service@meublo.fr · 01/10/2026\n${SAMPLE_MAIL}` }, expect: { re: ["^\\s*[-*•]", "14 octobre", "1 ?290"] } }],
  },
  "tool.mail.find": {
    kind: "grounded",
    label: "Chat @mail — trouver une information",
    role: "Tu réponds à une question à partir des e-mails fournis UNIQUEMENT, en citant la source sous la forme (uid N, « objet »).",
    build: ({ question, mails, lang = "fr" }) => ({
      messages: buildPrompt({ id: "tool.mail.find", kind: "grounded", lang, role: PROMPTS["tool.mail.find"].role,
        data: { "E-MAILS": mails }, request: question, format: "la réponse en une ou deux phrases, puis la source (uid N, « objet »)." }),
    }),
    bench: [
      { vars: { question: "Quel est le numéro de ma commande de canapé ?", mails: `[uid 12] De : service@meublo.fr\n${SAMPLE_MAIL}` }, expect: { re: ["48213", "uid 12"] } },
      { vars: { question: "Quel est le code de suivi du colis ?", mails: `[uid 12] De : service@meublo.fr\n${SAMPLE_MAIL}` }, expect: { re: ["(pas|aucun|ne|n'est).{0,60}(indiqu|pr[ée]cis|mentionn|trouv|figur|sp[ée]cifi|disponible|connu|passage|information)"], not: ["\\b[A-Z]{2}\\d{6,}"] } },
    ],
  },
  "tool.mail.draft": {
    kind: "write",
    label: "Chat @mail — brouillon",
    role: "Tu rédiges un e-mail prêt à envoyer : salutation, corps concis, formule de politesse. N'invente ni date, ni montant, ni engagement : écris [à compléter] si une information manque.",
    build: ({ original = "", instructions = "", to = "", subject = "", lang = "fr" }) => ({
      messages: buildPrompt({ id: "tool.mail.draft", kind: "write", lang, role: PROMPTS["tool.mail.draft"].role,
        data: { "MESSAGE AUQUEL RÉPONDRE": original, DESTINATAIRE: to, OBJET: subject },
        request: instructions || "réponse adaptée au message", format: "le corps du message seulement, sans objet ni commentaire." }),
    }),
    bench: [{ vars: { original: SAMPLE_MAIL, instructions: "confirme ma présence" }, expect: { re: ["confirm", "14 octobre|mardi|présen"], not: ["^objet\\s*:"], lang: "fr" } }],
  },
};
