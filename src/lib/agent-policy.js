// Shared policy for the chat adapters. Decisions are bounded, observable and
// never switch providers: model overrides stay on an explicitly selected host.
export function executionProfile(query, analysis = {}, signals = {}) {
  const q = String(query || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const action = /\b(cree|creer|ecris|enregistre|modifie|supprime|envoie|organise|planifie|execute|corrige|construis|create|write|save|update|delete|send|schedule|execute|build|fix)\b/.test(q);
  const long = analysis.complexity === 'complex' || (analysis.subquestions || []).length > 1 || q.length > 450;
  if (action || long || (analysis.needs_tools && analysis.complexity === 'moderate')) return 'agent';
  if (analysis.needs_tools || analysis.needs_data || signals.strong?.length) return 'tools';
  return 'direct';
}
export function obviousDirect(query, signals = {}) {
  if (signals.strong?.length || signals.weak?.length) return false;
  const q = String(query || '').trim();
  // Narrow opt-in: transformations with supplied material, not arbitrary
  // questions whose answer may require live or personal data.
  return /^(traduis|translate|reformule|rewrite|corrige l['’]orthographe)\s*[:：]/i.test(q) && q.length < 1500;
}
export function canOverrideModel(backend) {
  return !!backend && !backend.applefm && !backend.llama && !backend.litert && !backend.lumen;
}
export function chooseBackend({ main, fast, strong, phase, attempt = 0, failures = 0 }) {
  if (phase === 'verify' || phase === 'compact') return (failures > 0 && strong) || main;
  if (attempt > 0 || failures >= 2) return strong || main;
  if (['analyze', 'route', 'pick'].includes(phase)) return fast || main;
  return main;
}
export function validateToolRequest(name, args, tools) {
  const spec = tools.find(t => t?.function?.name === name)?.function;
  if (!spec) return 'Outil absent du catalogue autorisé.';
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'Arguments attendus sous forme objet.';
  const schema = spec.parameters || {};
  for (const key of schema.required || []) if (args[key] == null || args[key] === '') return `Paramètre requis : ${key}`;
  for (const [key, value] of Object.entries(args)) {
    const p = schema.properties?.[key];
    if (!p) { if (schema.additionalProperties === false) return `Paramètre inconnu : ${key}`; continue; }
    if (p.enum && !p.enum.includes(value)) return `Valeur interdite : ${key}`;
    const types = Array.isArray(p.type) ? p.type : [p.type];
    const valid = types.some(type => !type || (type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'integer' ? Number.isInteger(value) : type === 'object' ? !!value && typeof value === 'object' && !Array.isArray(value) : typeof value === type));
    if (!valid) return `Type incorrect : ${key}`;
  }
  return '';
}
export function toolSucceeded(result) {
  if (result && typeof result === 'object' && (result.success === false || result.error)) return false;
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  return !!text?.trim() && !/^(erreur|error|echec|échec|\[échec\]|résultat inconnu|permission refusée|annul)/i.test(text.trim());
}
