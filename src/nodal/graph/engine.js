// Exécution d'un graphe de nœuds, comme la file de ComfyUI :
//   • ordre topologique (un cycle est une erreur, nommée) ;
//   • CACHE : un nœud dont les widgets et les entrées n'ont pas changé depuis
//     la dernière exécution n'est pas relancé — seule la partie modifiée du
//     graphe recalcule (une image déjà générée ne se régénère pas parce qu'on
//     a retouché un texte en aval) ;
//   • « contourner » (bypass) passe l'entrée du même type telle quelle ;
//     « sourdine » (mute) n'exécute rien et ne rend rien ;
//   • après exécution, les graines en mode « incrémenter / aléatoire »
//     avancent pour la prochaine file, comme `control_after_generate`.
//
// Graphe : { nodes: [{ id, type, mode, widgets }], links: [{ id, from, out, to, in }] }.

import { nodeDef, compatible } from "./nodes.js";

const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
const valueKey = (v) => {
  if (v == null) return "∅";
  if (typeof v === "object") { if (v.url) return `img:${v.path || hash(String(v.url).slice(0, 4096) + v.url.length)}`; return hash(JSON.stringify(v)); }
  return hash(String(v));
};

export function topoOrder(graph, nodes = graph.nodes) {
  const ids = new Set(nodes.map((n) => n.id));
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  const next = new Map(nodes.map((n) => [n.id, []]));
  for (const l of graph.links) {
    if (!ids.has(l.from) || !ids.has(l.to)) continue;
    indeg.set(l.to, indeg.get(l.to) + 1);
    next.get(l.from).push(l.to);
  }
  const q = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order = [];
  while (q.length) {
    const id = q.shift();
    order.push(id);
    for (const t of next.get(id)) { indeg.set(t, indeg.get(t) - 1); if (indeg.get(t) === 0) q.push(t); }
  }
  if (order.length !== nodes.length) {
    const stuck = nodes.filter((n) => !order.includes(n.id)).map((n) => nodeDef(n.type)?.title || n.type);
    throw new Error(`Boucle dans le graphe : ${stuck.slice(0, 3).join(", ")}`);
  }
  return order;
}

/** Ancêtres d'un nœud (lui compris) : pour « exécuter jusqu'ici ». */
export function upstream(graph, id) {
  const seen = new Set([id]);
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    for (const l of graph.links) if (l.to === cur && !seen.has(l.from)) { seen.add(l.from); stack.push(l.from); }
  }
  return seen;
}

/**
 * Exécute. `cache` : Map persistante id → { key, outputs }.
 * hooks : { onNode(id, state, info), signal, ctx, only: Set|null }
 * Rend { ran, cached, errors }.
 */
export async function runGraph(graph, cache, { onNode = () => {}, signal = null, ctx = {}, only = null } = {}) {
  const nodes = graph.nodes.filter((n) => (!only || only.has(n.id)) && !nodeDef(n.type)?.noRun);
  const order = topoOrder(graph, nodes);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const results = new Map(); // id → { outputs, key }
  let ran = 0, cachedCount = 0;
  const errors = [];
  for (const id of order) {
    if (signal?.aborted) throw new Error("Exécution interrompue.");
    const node = byId.get(id);
    const d = nodeDef(node.type);
    if (!d) { errors.push({ id, error: `Type inconnu : ${node.type}` }); onNode(id, "error", { error: `Type inconnu : ${node.type}` }); continue; }
    if (node.mode === "mute") { results.set(id, { outputs: [], key: "mute" }); onNode(id, "muted"); continue; }
    // Entrées : lien > widget jumeau > rien.
    const inputs = {};
    const keys = [];
    let missing = "";
    let blocked = false;
    d.inputs.forEach((inp, k) => {
      const l = graph.links.find((x) => x.to === id && x.in === k);
      if (l) {
        const src = results.get(l.from);
        if (!src) { blocked = true; return; }
        const v = src.outputs?.[l.out];
        inputs[inp.name] = v;
        keys.push(`${k}:${src.key}:${l.out}:${valueKey(v)}`);
      } else if (inp.widget) {
        inputs[inp.name] = node.widgets?.[inp.widget];
        keys.push(`${k}:w`);
      } else {
        inputs[inp.name] = undefined;
        if (!inp.optional && !missing) missing = inp.name || "entrée";
      }
    });
    if (blocked) { onNode(id, "skipped"); continue; }
    const wKey = JSON.stringify(Object.fromEntries(Object.entries(node.widgets || {}).filter(([k]) => !k.endsWith("__ctl"))));
    const key = hash(`${node.type}|${node.mode || ""}|${wKey}|${keys.join(",")}`);
    if (node.mode === "bypass") {
      const vals = d.inputs.map((inp) => inputs[inp.name]);
      const outputs = d.outputs.map((o) => { const k = d.inputs.findIndex((inp, j) => compatible(inp.type, o.type) && vals[j] != null); return k >= 0 ? vals[k] : undefined; });
      results.set(id, { outputs, key });
      onNode(id, "bypassed", { outputs });
      continue;
    }
    if (missing) { const e = `Entrée « ${missing} » non reliée.`; errors.push({ id, error: e }); onNode(id, "error", { error: e }); continue; }
    const hit = cache.get(id);
    if (!d.volatile && hit && hit.key === key) {
      results.set(id, hit);
      cachedCount++;
      onNode(id, "cached", { outputs: hit.outputs, preview: d.preview ? d.preview(inputs) : undefined });
      continue;
    }
    onNode(id, "running");
    const t0 = performance.now();
    try {
      let outputs = await d.run(inputs, { ...(node.widgets || {}) }, { ...ctx, node, signal });
      if (!Array.isArray(outputs)) outputs = d.outputs.map((o) => outputs?.[o.name]);
      const r = { outputs, key };
      results.set(id, r);
      cache.set(id, r);
      ran++;
      onNode(id, "done", { outputs, preview: d.preview ? d.preview(inputs) : undefined, ms: Math.round(performance.now() - t0) });
    } catch (e) {
      const msg = String(e?.message || e);
      errors.push({ id, error: msg });
      onNode(id, "error", { error: msg });
    }
  }
  return { ran, cached: cachedCount, errors };
}

/** Graines et index « à contrôler » : avancent après une exécution réussie. */
export function advanceControls(graph) {
  let changed = false;
  for (const n of graph.nodes) {
    const d = nodeDef(n.type);
    for (const w of d?.widgets || []) {
      if (w.kind !== "seed" && !w.control) continue;
      const ctl = n.widgets?.[`${w.name}__ctl`] || (w.kind === "seed" ? "randomize" : "fixed");
      if (ctl === "increment") { n.widgets[w.name] = (Number(n.widgets[w.name]) || 0) + 1; changed = true; }
      else if (ctl === "decrement") { n.widgets[w.name] = Math.max(0, (Number(n.widgets[w.name]) || 0) - 1); changed = true; }
      else if (ctl === "randomize") { n.widgets[w.name] = Math.floor(Math.random() * 2 ** 31); changed = true; }
    }
  }
  return changed;
}
