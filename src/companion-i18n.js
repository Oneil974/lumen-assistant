// i18n du compagnon mobile — FR/EN, autonome.
//
// Le téléphone ne voit pas la langue choisie sur l'ordinateur (localStorage
// d'une autre origine) : la langue suit celle du téléphone (navigator.language),
// avec un choix explicite dans Réglages (« companionLang »). Même modèle que
// src/apps-i18n.js — dictionnaire FR → EN par chaîne exacte, traduction du DOM
// statique puis observateur pour ce qui est rendu en JS — mais réduit au strict
// nécessaire pour ne pas alourdir la PWA.

const KEY = "companionLang";

/** Réglage : "auto" (langue du téléphone), "fr" ou "en". */
export function companionLangSetting() {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "fr" || v === "en") return v;
  } catch {}
  return "auto";
}

export function setCompanionLang(value) {
  try {
    if (value === "fr" || value === "en") localStorage.setItem(KEY, value);
    else localStorage.removeItem(KEY);
  } catch {}
}

/** Langue effective : "fr" ou "en". */
export function companionLang() {
  const set = companionLangSetting();
  if (set !== "auto") return set;
  return ((typeof navigator !== "undefined" ? navigator.language : "fr") || "fr").toLowerCase().startsWith("en") ? "en" : "fr";
}

/** Code BCP 47 pour la synthèse et la dictée locales. */
export function speechLocale() {
  return companionLang() === "en" ? "en-US" : "fr-FR";
}

const EN = {
  "Capturez une idée. Retrouvez l’essentiel.": "Capture an idea. Keep what matters.",
  "Outils de la note": "Note tools",
  "Liste": "List",
  "Importer un texte": "Import text",
  "Titre de la note": "Note title",
  "Agrandir la note": "Expand note",
  "Corriger avec l’IA": "Proofread with AI",
  "Correction en cours…": "Proofreading…",
  "Proposition de correction": "Suggested correction",
  "Appliquer": "Apply",
  "Garder l’original": "Keep original",
  "Note": "Note",
  "mot": "word",
  "mots": "words",
  "Enregistrement…": "Saving…",
  "Note enregistrée dans la messagerie": "Note saved to inbox",
  "Brouillon conservé sur cet appareil. Les notes sont enregistrées dans la messagerie.": "Draft kept on this device. Notes are saved to the inbox.",
  "Le brouillon ne peut pas être conservé sur cet appareil.": "The draft cannot be stored on this device.",
  "Texte trop volumineux (256 Ko max)": "Text file too large (256 KB max)",
  "Ce fichier n’est pas un texte.": "This is not a text file.",
  "Lecture du fichier impossible": "Unable to read the file",
  "La note a changé. Relancez la correction.": "The note has changed. Run proofreading again.",
  "Aucune correction reçue.": "No correction received.",
  "Relisez la proposition avant de l’appliquer.": "Review the suggestion before applying it.",
  "Correction impossible": "Unable to proofread",
  "Correction appliquée au brouillon.": "Correction applied to the draft.",
  "Texte original conservé.": "Original text kept.",
  // ----- Coquille (companion.html) -----
  "Lumen — Compagnon": "Lumen — Companion",
  "Conversations": "Conversations", "Backend et modèle": "Backend and model", "Activité des agents": "Agent activity",
  "Nouvelle discussion": "New conversation", "Résume ma journée": "Summarise my day",
  "Qu'est-ce qui tourne sur mon ordinateur ?": "What is running on my computer?",
  "Aide-moi à rédiger un message": "Help me write a message", "Message à Lumen": "Message to Lumen",
  "Joindre un fichier": "Attach a file", "Prendre une photo": "Take a photo", "Mode de discussion": "Chat mode",
  "Autre réponse…": "Other answer…",
  "Réglages": "Settings", "Dictée": "Dictation", "Envoyer": "Send", "Déconnecté": "Disconnected", "Connecté": "Connected",
  "Fermer": "Close", "Capture rapide": "Quick capture", "Backend": "Backend", "Mode": "Mode",
  "Lecture auto": "Auto read-aloud", "Aucune": "None", "Cet appareil": "This device", "Ordinateur": "Computer", "Les deux": "Both",
  "Voix de cet appareil": "This device's voice", "Voix par défaut": "Default voice", "Test": "Test",
  "Thème": "Theme", "Clair": "Light", "Sombre": "Dark", "Couleur": "Colour", "Langue": "Language", "Automatique": "Automatic",
  "Notifications": "Notifications", "Tout effacer": "Clear all",
  "Une idée, une course, un rappel…": "An idea, an errand, a reminder…",
  "Agent": "Agent", "Rappel": "Reminder", "Tableau": "Board",
  "Quel agent s'en charge ?": "Which agent handles it?", "Dans combien de temps ?": "How soon?",
  "1 heure": "1 hour", "3 heures": "3 hours", "Demain": "Tomorrow", "La semaine prochaine": "Next week",
  "Enregistrer": "Save", "Agents": "Agents", "Chargement…": "Loading…",
  "Connexion": "Sign in",
  "Saisissez votre nom d'utilisateur Lumen, puis le code à 6 chiffres affiché dans Lumen → Paramètres → Compagnon mobile (ou donné par votre application d'authentification).": "Enter your Lumen user name, then the 6-digit code shown in Lumen → Settings → Mobile companion (or given by your authenticator app).",
  "Comment puis-je vous aider ?": "How can I help?", "Vos messages sont traités par votre ordinateur.": "Your messages are processed by your computer.",
  "Récentes": "Recent", "Lecture à voix haute": "Read aloud", "Apparence": "Appearance", "Couleur d'accent": "Accent colour",
  "Destination": "Destination", "Activité": "Activity",
  "Votre nom": "Your name", "Code à 6 chiffres": "6-digit code", "Se connecter": "Sign in",

  // ----- Connexion, état -----
  "Identifiant ou code invalide.": "Invalid user name or code.", "Connexion impossible.": "Could not connect.",
  "Code accepté. Saisissez maintenant le mot de passe de votre session Lumen.": "Code accepted. Now enter your Lumen session password.",
  "Mot de passe de la session": "Session password",
  "Mot de passe incorrect ({n} essai(s) restant(s)).": "Wrong password ({n} attempt(s) left).",
  "Connexion expirée : saisissez un nouveau code.": "Sign-in expired: enter a new code.",
  "Trop d'essais. Réessayez dans quelques minutes.": "Too many attempts. Try again in a few minutes.",
  "Pour saisir le mot de passe, ouvrez la version sécurisée :": "To enter your password, open the secure version:",
  "Reconnexion à l'ordinateur…": "Reconnecting to the computer…", "Pas de connexion à l'ordinateur": "No connection to the computer",
  "Saisis le code à 6 chiffres de ton application d'authentification.": "Enter the 6-digit code from your authenticator app.",
  "Déverrouiller": "Unlock", "Code requis pour déverrouiller.": "Code required to unlock.",
  "Hors ligne : envoi dès la reconnexion": "Offline: will send when reconnected", "{n} envoi(s) en attente parti(s)": "{n} pending item(s) sent", "Session déverrouillée": "Session unlocked", "Code incorrect.": "Wrong code.",
  "Hors ligne": "Offline", "Je vous écoute…": "Listening…", "Lecture en cours…": "Reading aloud…",
  "Session de {name} ouverte sur l'ordinateur — capture et agents restent disponibles.": "{name}'s session is open on the computer — capture and agents remain available.",
  "Une autre session est ouverte sur l'ordinateur.": "Another session is open on the computer.",

  // ----- Backend / mode -----
  "Source d'IA": "AI source", "Ollama local": "Local Ollama", "Raisonnement": "Reasoning",
  "Le modèle réfléchit avant de répondre (modèles compatibles).": "The model thinks before answering (compatible models).",
  "Modèle llama.cpp": "llama.cpp model", "Modèle de l'API": "API model", "Modèle Ollama": "Ollama model", "Modèle Apple": "Apple model", "Modèle Lumen Server": "Lumen Server model",
  "Aucun modèle renvoyé par l'API (clé manquante ?).": "No model returned by the API (missing key?).",
  "Aucun modèle disponible sur ce backend.": "No model available on this backend.",
  "Workflows Fluxo": "Fluxo workflows", "Exécute ce workflow": "Runs this workflow",
  "Chat": "Chat", "Outils": "Tools", "RAG": "RAG", "Routeur": "Router",

  // ----- Pièces jointes, mentions -----
  "indexé": "indexed", "contexte": "context", "Retirer les images": "Remove the images",
  "Outils — touchez pour insérer": "Tools — tap to insert", "Documents — touchez pour joindre": "Documents — tap to attach",
  "{label} — joint à la discussion": "{label} — attached to the conversation",
  "Ce backend ne lit pas les images": "This backend cannot read images", "Photo trop volumineuse (12 Mo max)": "Photo too large (12 MB max)",
  "Envoi de la photo…": "Sending the photo…", "Lecture de la photo impossible": "Could not read the photo",
  "Fichier trop volumineux (12 Mo max)": "File too large (12 MB max)", "Envoi de {name}…": "Sending {name}…",
  "Lecture du fichier impossible": "Could not read the file",

  // ----- Voix -----
  "Lecture auto désactivée": "Auto read-aloud off", "Lecture auto : cet appareil": "Auto read-aloud: this device",
  "Lecture auto : ordinateur": "Auto read-aloud: computer", "Lecture auto : ordinateur + appareil": "Auto read-aloud: computer + device",
  "Dictée indisponible": "Dictation unavailable", "Touchez le micro du clavier pour dicter": "Tap the keyboard's microphone to dictate",

  // ----- Conversations -----
  "Aucune conversation enregistrée.": "No saved conversation.", "Discussion": "Conversation", "Supprimer ?": "Delete?",
  "Annuler": "Cancel", "Supprimer": "Delete", "Discussion supprimée": "Conversation deleted",

  // ----- Notifications -----
  "Aucune notification.": "No notification.", "Échec sans message": "Failed without a message", "Exécuté (aucune sortie)": "Run (no output)",

  // ----- Apparence -----
  "Défaut": "Default", "Rose": "Pink", "Violet": "Purple", "Bleu": "Blue", "Menthe": "Mint", "Pêche": "Peach",
  "Azur": "Azure", "Vert": "Green", "Ambre": "Amber", "Framboise": "Raspberry",

  // ----- Capture rapide -----
  "Aucun agent disponible": "No agent available", "Rappel programmé": "Reminder scheduled", "Carte ajoutée": "Card added",
  "Tâche ajoutée à {name}": "Task added to {name}", "Capture impossible": "Capture failed",

  // ----- Agents -----
  "en cours": "running", "terminé": "done", "bloqué": "blocked", "annulé": "cancelled", "nouvelle tentative": "retrying",
  "en attente": "waiting", "en file": "queued", "interrompu": "interrupted",
  "À décider": "To decide", "veut utiliser": "wants to use", "Refuser": "Reject", "Approuver": "Approve",
  "En cours": "In progress", "Derniers runs": "Latest runs", "Aucune activité pour l'instant.": "No activity yet.",
  "Activité indisponible.": "Activity unavailable.", "Approuvé": "Approved", "Refusé": "Rejected",
  "Demande déjà traitée": "Request already handled", "Décision impossible": "Could not decide",

  // ----- Commande du bureau -----
  "Commander le bureau": "Control the desktop", "Bureau": "Desktop",
  "Commande pour le bureau…": "Command for the desktop…", "Commande envoyée au bureau": "Command sent to the desktop",

  // ----- Capsule Halo -----
  "Aucune étape pour l'instant.": "No step yet.",
};

/** Traduit une chaîne FR ; renvoie l'original en français ou si inconnue. */
export function tt(fr, vars = {}) {
  const base = companionLang() === "en" && EN[fr] != null ? EN[fr] : fr;
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), base);
}

function translateAttrs(el) {
  if (!el.getAttribute) return;
  for (const a of ["placeholder", "title", "aria-label"]) {
    const v = el.getAttribute(a);
    if (v && EN[v.trim()]) el.setAttribute(a, EN[v.trim()]);
  }
}

function translateTextNode(n) {
  const p = n.parentNode && n.parentNode.nodeName;
  if (p === "SCRIPT" || p === "STYLE" || p === "svg" || p === "SVG") return;
  const t = (n.nodeValue || "").trim();
  if (t && EN[t]) n.nodeValue = n.nodeValue.replace(t, EN[t]);
}

/** Traduit un sous-arbre (attributs + nœuds texte) — libellés exacts seulement. */
export function translateTree(root) {
  if (companionLang() !== "en" || !root) return;
  if (root.nodeType === Node.TEXT_NODE) { translateTextNode(root); return; }
  if (root.nodeType === Node.ELEMENT_NODE) translateAttrs(root);
  root.querySelectorAll?.("[placeholder],[title],[aria-label]").forEach(translateAttrs);
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walk.nextNode()) nodes.push(walk.currentNode);
  nodes.forEach(translateTextNode);
}

/**
 * Traduit la page et suit ce qui est rendu ensuite en JS. Pose aussi la langue
 * sur <html> (césure, sélection de voix du système).
 */
export function installCompanionI18n() {
  document.documentElement.lang = companionLang();
  translateTree(document);
  if (companionLang() !== "en" || typeof MutationObserver === "undefined") return;
  const obs = new MutationObserver((records) => {
    for (const r of records) for (const node of r.addedNodes) translateTree(node);
  });
  obs.observe(document.body, { childList: true, subtree: true });
}
