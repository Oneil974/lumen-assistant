// Langue de réponse demandée au modèle par les apps.
//
// Les consignes des apps sont écrites en français (les modèles les suivent
// très bien) mais elles disaient « réponds en français » en dur : en interface
// anglaise, l'utilisateur recevait quand même du français. Ces helpers
// n'injectent que le NOM de la langue cible, en gardant la consigne en
// français — « Tu résumes des pages web en anglais » — ce qui évite de
// maintenir chaque prompt en double.
//
// La langue suit celle de l'interface (localStorage « lang », partagé par les
// trois sous-systèmes i18n), comme lib/system-prompt.js.

export function replyLang() {
  try {
    const stored = localStorage.getItem("lang");
    if (stored === "en" || stored === "fr") return stored;
  } catch {}
  return ((typeof navigator !== "undefined" ? navigator.language : "fr") || "fr").toLowerCase().startsWith("en") ? "en" : "fr";
}

/** « français » ou « anglais » — à insérer dans une phrase en français. */
export function langName() {
  return replyLang() === "en" ? "anglais" : "français";
}

/** « en français » ou « en anglais ». */
export function inLang() {
  return `en ${langName()}`;
}

/** Une consigne complète : « Réponds en français. » / « Réponds en anglais. » */
export function replyRule() {
  return `Réponds ${inLang()}.`;
}
