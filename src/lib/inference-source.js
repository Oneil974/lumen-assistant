// An explicit per-block engine never silently falls back to the active engine.
export function explicitInferenceSource(backend) {
  return ({ cloud: 'api', ollama: 'ollama', applefm: 'applefm' })[backend] || null;
}
export function assertAppleModel(state, model) {
  const available = (state?.models || []).filter(m => m.available);
  if (!state?.available || !available.length) throw new Error('Apple Foundation Models indisponible sur ce Mac.');
  const selected = model || available[0].id;
  if (!available.some(m => m.id === selected)) throw new Error(`Modèle Apple indisponible : ${selected}`);
  return selected;
}
