// Étapes d'agent en langage courant.
//
// Rust émet `agent-step` avec le nom technique de l'outil (`sandbox_read_file`)
// et ses arguments bruts. C'est parfait pour le journal, illisible pour un
// humain qui regarde la capsule Halo ou la carte d'un agent dans le chat :
// « Lit « cv.pdf » » dit la même chose que « étape · sandbox_read_file ».
//
// Module pur (aucun DOM, aucun Tauri) : partagé par island.js et par la carte
// de délégation des barres de chat (lib/agent-delegation.js).

const L = {
  fr: {
    thinking: "Réfléchit",
    retry: "Corrige son travail",
    list: "Parcourt ses fichiers",
    read: "Lit {x}",
    write: "Écrit {x}",
    web: "Cherche « {x} » sur le web",
    web0: "Cherche sur le web",
    page: "Lit une page web",
    docs: "Fouille les documents",
    tables: "Interroge les bases de données",
    schema: "Regarde la structure des bases",
    recall: "Consulte sa mémoire",
    remember: "Mémorise une information",
    remind: "Crée un rappel",
    mail_list: "Parcourt les e-mails",
    mail_read: "Lit un e-mail",
    mail_draft: "Rédige un brouillon d'e-mail",
    inbox: "Envoie un message",
    image: "Génère une image",
    weather: "Regarde la météo",
    score: "Cherche un score",
    quote: "Consulte un cours de bourse",
    rate: "Consulte un taux de change",
    air: "Mesure la qualité de l'air",
    news: "Lit les actualités",
    home_list: "Inventorie la maison",
    home_state: "Lit l'état d'un objet",
    home_cmd: "Pilote un objet",
    delegate: "Délègue à {x}",
    delegate0: "Délègue à un autre agent",
    skill_new: "Se forge une compétence",
    skill_fix: "Améliore une compétence",
    actions: "Liste les actions possibles",
    plan: "Exécute un plan",
    workflow: "Lance « {x} »",
    ok: "fait",
    fail: "échec",
  },
  en: {
    thinking: "Thinking",
    retry: "Fixing its work",
    list: "Browsing its files",
    read: "Reading {x}",
    write: "Writing {x}",
    web: "Searching the web for “{x}”",
    web0: "Searching the web",
    page: "Reading a web page",
    docs: "Searching the documents",
    tables: "Querying the databases",
    schema: "Looking at the database structure",
    recall: "Checking its memory",
    remember: "Remembering something",
    remind: "Creating a reminder",
    mail_list: "Browsing e-mails",
    mail_read: "Reading an e-mail",
    mail_draft: "Drafting an e-mail",
    inbox: "Sending a message",
    image: "Generating an image",
    weather: "Checking the weather",
    score: "Looking up a score",
    quote: "Checking a market quote",
    rate: "Checking an exchange rate",
    air: "Checking air quality",
    news: "Reading the news",
    home_list: "Listing smart-home devices",
    home_state: "Reading a device state",
    home_cmd: "Controlling a device",
    delegate: "Delegating to {x}",
    delegate0: "Delegating to another agent",
    skill_new: "Forging a new skill",
    skill_fix: "Improving a skill",
    actions: "Listing available actions",
    plan: "Running a plan",
    workflow: "Running “{x}”",
    ok: "done",
    fail: "failed",
  },
};

// Outil → [clé de libellé, icône Lucide de lib/icons.js, argument affiché].
const TOOLS = {
  sandbox_list_files: ["list", "folderOpen"],
  sandbox_read_file: ["read", "file-text", "path"],
  sandbox_write_file: ["write", "pencil", "path"],
  web_search: ["web", "search", "query"],
  web_read_page: ["page", "globe"],
  search_documents: ["docs", "book-open-text"],
  tables_query: ["tables", "database"],
  query_tables: ["tables", "database"],
  tables_schema: ["schema", "tables"],
  memory_recall: ["recall", "brain"],
  memory_remember: ["remember", "brain"],
  create_reminder: ["remind", "clock"],
  mail_list_messages: ["mail_list", "mail"],
  mail_read_message: ["mail_read", "mail"],
  mail_write_draft: ["mail_draft", "send"],
  send_inbox_message: ["inbox", "inbox"],
  generate_image: ["image", "image"],
  weather_now: ["weather", "cloud-sun"],
  sport_score: ["score", "trophy"],
  market_quote: ["quote", "chart"],
  exchange_rate: ["rate", "coins"],
  air_quality: ["air", "cloud"],
  news_headlines: ["news", "scroll-text"],
  domotique_list_devices: ["home_list", "domotique"],
  domotique_get_state: ["home_state", "domotique"],
  domotique_command: ["home_cmd", "power"],
  delegate_to_agent: ["delegate", "users", "agent"],
  create_skill: ["skill_new", "anvil"],
  improve_skill: ["skill_fix", "wrench"],
  list_fluxo_actions: ["actions", "list"],
  execute_plan: ["plan", "list-checks"],
};

function langOf(lang) {
  return String(lang || "fr").toLowerCase().startsWith("en") ? "en" : "fr";
}

function fill(str, x) {
  return String(str).replace("{x}", x);
}

/// Argument lisible d'un appel : `input` est du JSON (arguments du modèle) ou
/// un texte libre. On garde un nom de fichier plutôt qu'un chemin complet.
function argOf(input, key) {
  if (!key) return "";
  let v = "";
  try {
    const o = JSON.parse(input);
    v = o?.[key] ?? o?.name ?? o?.query ?? o?.path ?? "";
  } catch {
    v = String(input || "");
  }
  v = String(v || "").trim();
  if (key === "path") v = v.split("/").pop();
  return v.length > 38 ? `${v.slice(0, 37)}…` : v;
}

/**
 * Étape d'agent → phrase courte, icône et ton.
 * @param {{kind?:string, skill?:string, input?:string, result?:string, success?:boolean}} step
 * @param {"fr"|"en"} [lang]
 * @returns {{text:string, icon:string, tone:"think"|"ok"|"fail"|"retry", detail:string, raw:string}}
 */
export function humanStep(step, lang) {
  const s = L[langOf(lang)];
  const skill = String(step?.skill || "");
  const input = String(step?.input || "");
  const result = String(step?.result || "").replace(/\s+/g, " ").trim();
  if (step?.kind === "thought") {
    const retry = /rattrapage|livrable/i.test(`${skill} ${input}`);
    return {
      text: retry ? s.retry : s.thinking,
      icon: retry ? "retry" : "sparkles",
      tone: retry ? "retry" : "think",
      detail: result,
      raw: skill,
    };
  }
  const def = TOOLS[skill];
  let text;
  let icon = "bolt";
  if (def) {
    const [key, ic, argKey] = def;
    icon = ic;
    const a = argOf(input, argKey);
    const quoted = langOf(lang) === "en" ? `“${a}”` : `« ${a} »`;
    text = a
      ? fill(s[key], key === "web" ? a : quoted)
      : s[`${key}0`] || s[key].replace(/\s*\{x\}/, "");
  } else if (skill.startsWith("mcp_") || skill.includes("__")) {
    text = fill(s.workflow, skill.replace(/^mcp_/, "").replace(/__/g, " · "));
    icon = "plug";
  } else {
    // Skill Fluxo de l'agent : son nom EST déjà une description humaine.
    text = fill(s.workflow, skill.replace(/_/g, " "));
    icon = "workflow";
  }
  return {
    text,
    icon,
    tone: step?.success === false ? "fail" : "ok",
    detail: result,
    raw: skill,
  };
}

/// Libellé court du statut d'une étape terminée (« fait » / « échec »).
export function stepStatus(ok, lang) {
  const s = L[langOf(lang)];
  return ok ? s.ok : s.fail;
}
