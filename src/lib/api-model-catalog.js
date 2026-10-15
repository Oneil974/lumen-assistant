// Suggestions de modèles pour les API OpenAI-compatibles, par fournisseur.
//
// ⚠️ Ce catalogue est un REPLI, jamais la source de vérité. Les catalogues des
// fournisseurs changent vite (OpenAI est passé à gpt-5.6, Groq a déprécié ses
// modèles Llama, DeepSeek retire deepseek-chat en juillet 2026…) : une liste
// figée dans Lumen serait fausse en quelques semaines.
//
// La liste réelle vient de `GET {api_base}/models`, exposée par la commande
// backend `llm_api_models` — exhaustive par construction, à jour, et valable
// pour n'importe quel serveur compatible (y compris vLLM ou LM Studio en local).
// Ces suggestions ne servent qu'avant l'enregistrement d'une clé, ou si
// l'endpoint ne répond pas.
//
// Identifiants vérifiés le 31/07/2026 (OpenAI, Groq, Mistral, DeepSeek) et le
// 09/10/2026 (Anthropic, Gemini, xAI ajoutés) — « Charger depuis l'API » reste
// la référence.

export const API_PROVIDERS = [
  {
    id: "openai",
    name: "OpenAI",
    base: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    keyHint: "sk-…",
    match: /(^|\.)openai\.com/i,
    // Volontairement court : les principaux, pas le catalogue. `gpt-5.6` est
    // l'alias de Sol (raisonnement le plus profond), `terra` équilibre coût et
    // intelligence, `luna` vise le volume. /models donne la liste exhaustive.
    models: ["gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-4o-mini"],
  },
  {
    id: "anthropic",
    name: "Anthropic (Claude)",
    // Couche de compatibilité OpenAI d'Anthropic (/v1/chat/completions).
    base: "https://api.anthropic.com/v1",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyHint: "sk-ant-…",
    match: /anthropic\.com/i,
    models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
  },
  {
    id: "gemini",
    name: "Google Gemini",
    base: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyUrl: "https://aistudio.google.com/apikey",
    keyHint: "AIza…",
    match: /generativelanguage\.googleapis\.com/i,
    models: ["gemini-3-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash"],
  },
  {
    id: "mistral",
    name: "Mistral",
    base: "https://api.mistral.ai/v1",
    keyUrl: "https://console.mistral.ai/api-keys",
    keyHint: "",
    match: /mistral\.ai/i,
    models: ["mistral-large-latest", "mistral-small-latest", "ministral-8b-2512"],
  },
  {
    id: "groq",
    name: "Groq",
    base: "https://api.groq.com/openai/v1",
    keyUrl: "https://console.groq.com/keys",
    keyHint: "gsk_…",
    match: /groq\.com/i,
    models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.6-27b", "groq/compound"],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    base: "https://api.deepseek.com/v1",
    keyUrl: "https://platform.deepseek.com/api_keys",
    keyHint: "sk-…",
    match: /deepseek\.com/i,
    models: ["deepseek-v4-pro", "deepseek-v4-flash"],
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    base: "https://api.x.ai/v1",
    keyUrl: "https://console.x.ai",
    keyHint: "xai-…",
    match: /(^|\.)x\.ai/i,
    models: ["grok-4", "grok-3-mini"],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    base: "https://openrouter.ai/api/v1",
    keyUrl: "https://openrouter.ai/keys",
    keyHint: "sk-or-…",
    match: /openrouter\.ai/i,
    // Passerelle multi-fournisseurs au catalogue mouvant : seul le routeur
    // automatique est proposé d'office, le reste se charge par /models.
    models: ["openrouter/auto"],
  },
  {
    id: "local",
    name: "Serveur local (LM Studio, vLLM…)",
    base: "http://localhost:1234/v1",
    keyUrl: "",
    keyHint: "facultative",
    local: true,
    match: /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i,
    models: [],
  },
];

/// Fournisseur du catalogue par identifiant.
export const providerById = (id) => API_PROVIDERS.find((p) => p.id === id) || null;

/// Fournisseur déduit de l'URL de base, ou `null` si inconnu.
export function providerFor(baseUrl) {
  const url = String(baseUrl || "").trim();
  if (!url) return null;
  return API_PROVIDERS.find((p) => p.match.test(url)) || null;
}

/// Suggestions pour cette URL (vide si le fournisseur est inconnu : mieux vaut
/// ne rien proposer qu'induire en erreur avec le catalogue d'un autre).
export function suggestedModels(baseUrl) {
  return providerFor(baseUrl)?.models || [];
}

/// Remonte les modèles principaux en tête d'un catalogue chargé depuis
/// `/models`. Un catalogue OpenAI complet compte des dizaines d'entrées
/// (snapshots datés, variantes internes) : sans ce tri, les quelques modèles
/// qui intéressent vraiment se perdent au milieu.
export function prioritiseModels(list, baseUrl) {
  const all = Array.isArray(list) ? list : [];
  const main = suggestedModels(baseUrl);
  if (!main.length) return all;
  const first = main.filter((m) => all.includes(m));
  const seen = new Set(first);
  return [...first, ...all.filter((m) => !seen.has(m))];
}

/// Nom lisible du fournisseur, pour l'interface.
export function providerName(baseUrl) {
  return providerFor(baseUrl)?.name || "";
}
