#!/usr/bin/env node
// Sonde de tool calling pour un backend OpenAI-compatible.
//
// Répond à une question précise : quand un modèle n'appelle pas les outils dans
// Lumen, est-ce l'API de Lumen qui est mal formée, ou le modèle/endpoint qui ne
// le supporte pas ? Le script envoie la requête MINIMALE de tool calling — un
// seul outil, une question qui l'appelle de façon évidente — et affiche la
// réponse brute, statut HTTP et corps d'erreur compris.
//
//   OPENAI_API_KEY=sk-… node scripts/probe-tool-calling.mjs <modèle> [base]
//
// `base` vaut https://api.openai.com/v1 par défaut. La clé n'est lue que dans
// l'environnement : ne la passe jamais en argument, elle resterait dans
// l'historique du shell.
//
// Trois issues possibles :
//   ✅ tool_calls          → le modèle sait appeler les outils ; si Lumen n'y
//                            arrive pas, le problème est dans Lumen.
//   💬 réponse en texte    → le modèle a VU l'outil et a choisi de ne pas
//                            l'appeler : c'est un comportement du modèle.
//   ❌ erreur HTTP         → l'endpoint refuse la requête ; le corps affiché dit
//                            quel paramètre pose problème.

const [model, base = "https://api.openai.com/v1"] = process.argv.slice(2);
const key = process.env.OPENAI_API_KEY || process.env.LUMEN_API_KEY;

if (!model) {
  console.error("Usage : OPENAI_API_KEY=… node scripts/probe-tool-calling.mjs <modèle> [base-url]");
  process.exit(2);
}
if (!key) {
  console.error("Aucune clé : exporte OPENAI_API_KEY (ou LUMEN_API_KEY).");
  process.exit(2);
}

// L'outil que Lumen expose partout : un nom clair, une description factuelle
// (ce qu'il fait, jamais quand l'appeler) et un schéma simple.
const TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Renvoie la météo actuelle d'une ville.",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "Nom de la ville" } },
      required: ["city"],
    },
  },
};

const PROMPT = "Quel temps fait-il à Saint-Denis de La Réunion ?";

async function call(payload) {
  const url = `${base.replace(/\/+$/, "")}/chat/completions`;
  const started = Date.now();
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* corps non-JSON : on l'affiche brut */ }
  return { ok: r.ok, status: r.status, text, json, ms: Date.now() - started };
}

function report(label, res) {
  console.log(`\n── ${label} ──`);
  if (!res.ok) {
    console.log(`❌ HTTP ${res.status} (${res.ms} ms)`);
    console.log(res.text.slice(0, 1200));
    return "error";
  }
  const message = res.json?.choices?.[0]?.message || {};
  const calls = message.tool_calls || [];
  if (calls.length) {
    console.log(`✅ tool_calls (${res.ms} ms)`);
    for (const c of calls) {
      console.log(`   ${c.function?.name}(${c.function?.arguments})`);
    }
    return "tool_calls";
  }
  console.log(`💬 réponse en texte, aucun appel d'outil (${res.ms} ms)`);
  console.log(`   finish_reason: ${res.json?.choices?.[0]?.finish_reason}`);
  console.log(`   ${String(message.content || "").slice(0, 300)}`);
  return "text";
}

const base_payload = {
  model,
  messages: [{ role: "user", content: PROMPT }],
  tools: [TOOL],
};

console.log(`Modèle : ${model}\nEndpoint : ${base}`);

// 1. Exactement ce que Lumen envoie.
const plain = report("tools + tool_choice auto (ce que Lumen envoie)", await call({
  ...base_payload,
  tool_choice: "auto",
}));

// 2. Appel forcé : distingue « ne sait pas » de « ne veut pas ». Si le forçage
//    marche alors que « auto » renvoyait du texte, le modèle supporte bien les
//    outils et c'est son jugement (ou le prompt système) qu'il faut revoir.
if (plain !== "tool_calls") {
  report("tool_choice forcé sur get_weather", await call({
    ...base_payload,
    tool_choice: { type: "function", function: { name: "get_weather" } },
  }));
}

// 3. Sans aucun paramètre optionnel : isole un rejet dû à `tool_choice` ou à un
//    autre champ que certains modèles récents n'acceptent plus.
if (plain === "error") {
  report("tools seuls, sans tool_choice", await call(base_payload));
  report("sans outils du tout (l'endpoint répond-il ?)", await call({
    model,
    messages: [{ role: "user", content: "Dis bonjour." }],
  }));
}

console.log("\nLecture : ✅ = le modèle sait, cherche le bug dans Lumen · 💬 = choix du modèle · ❌ = lis le corps de l'erreur, il nomme le paramètre fautif.");
