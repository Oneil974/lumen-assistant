// Vocabulaire des permissions : ce que chaque capacité autorise, dit dans les
// mots de la personne qui doit répondre.
//
// Ce fichier est la source unique des libellés — la feuille de consentement, la
// fiche du Catalogue et l'écran Confidentialité des Paramètres y puisent tous.
// Une capacité décrite ici de trois façons différentes ailleurs, c'est un
// utilisateur qui n'accorde pas ce qu'il croit accorder.

export const CAPABILITIES = {
  ai: {
    label: "Intelligence artificielle",
    // Ce qu'on annonce doit être vrai *y compris quand c'est gênant* : si le
    // backend actif est une API distante, le texte doit le dire.
    ask: "utiliser l'IA de Lumen",
    detail: "L'app pourra envoyer du texte au modèle actif. Si vous utilisez une clé API, ce texte sort de votre machine.",
    icon: "sparkles",
  },
  assistant: {
    label: "Mode assistant",
    ask: "s'intégrer à l'assistant",
    detail: "L'assistant de Lumen pourra proposer et déclencher les actions de cette app en langage naturel.",
    icon: "message-circle",
  },
  tools: {
    label: "Outils pour les agents",
    ask: "publier des outils",
    detail: "Vos agents pourront appeler les fonctions de cette app pendant leurs tâches.",
    icon: "wrench",
  },
  storage: {
    label: "Espace de stockage",
    ask: "utiliser son espace de stockage",
    detail: "Un espace réservé à cette app. Elle n'y voit rien des autres apps, et aucune autre n'y voit ses données.",
    icon: "disk",
  },
  files: {
    label: "Vos fichiers",
    ask: "ouvrir des fichiers que vous choisissez",
    detail: "L'app ne peut ni parcourir ni lister vos fichiers : elle ne reçoit que ceux que vous lui désignez.",
    icon: "folder",
  },
  tables: {
    label: "Bases de données",
    ask: "accéder à vos bases de données locales",
    detail: "Lecture et écriture des tables de Lumen.",
    icon: "table",
  },
  memory: {
    label: "Mémoire de Lumen",
    ask: "lire et enrichir votre mémoire",
    detail: "L'app pourra rappeler des souvenirs et en ajouter, dans les limites de votre politique de mémoire.",
    icon: "brain",
  },
  network: {
    label: "Accès internet",
    ask: "se connecter à internet",
    detail: "L'app pourra faire des requêtes vers des serveurs distants.",
    icon: "globe",
  },
  notifications: {
    label: "Notifications",
    ask: "vous envoyer des notifications",
    detail: "Messages dans le centre de notifications et la capsule.",
    icon: "bell",
  },
  clipboard: {
    label: "Presse-papier",
    ask: "lire et écrire le presse-papier",
    detail: "L'app pourra voir ce que vous avez copié.",
    icon: "clipboard",
  },
};

/** Description d'une capacité, `interop:<app>` compris. */
export function describeCapability(cap, appNameOf = (id) => id) {
  const [base, target] = String(cap).split(":");
  if (base === "interop" && target) {
    return {
      label: `Envoi vers ${appNameOf(target)}`,
      ask: `envoyer des données à ${appNameOf(target)}`,
      detail: "L'app pourra transmettre du contenu à cette autre application sans vous le redemander à chaque fois.",
      icon: "share",
    };
  }
  return CAPABILITIES[cap] || {
    label: cap,
    ask: `utiliser « ${cap} »`,
    detail: "Capacité non reconnue par cette version de Lumen.",
    icon: "shield",
  };
}

/** Liste des capacités connues, pour les écrans de réglages. */
export const CAPABILITY_IDS = Object.keys(CAPABILITIES);
