// Calcul des sources d'un rapport, sans DOM ni IPC : testable tel quel
// (scripts/test-pro-workspaces.mjs). Le contrôleur (main.js) n'y ajoute que
// l'état et l'affichage.
import { validPeriod } from "../lib/pro-data.js";

/**
 * Période précédente : la même durée, juste avant. C'est la comparaison que
 * l'on attend d'un rapport mensuel comme d'un rapport de semaine, sans avoir à
 * la paramétrer.
 */
export function previousPeriod({ from, to }) {
  const a = new Date(from), b = new Date(to);
  const days = Math.max(1, Math.round((b - a) / 86400000) + 1);
  const prevTo = new Date(a); prevTo.setDate(prevTo.getDate() - 1);
  const prevFrom = new Date(prevTo); prevFrom.setDate(prevFrom.getDate() - days + 1);
  return { from: prevFrom.toISOString().slice(0, 10), to: prevTo.toISOString().slice(0, 10) };
}

/** Injecte la période dans une requête. Les dates sont écrites par nous. */
export function applyParams(sql, period) {
  return String(sql || "")
    .replace(/:debut\b/g, `'${period.from}'`)
    .replace(/:fin\b/g, `'${period.to}'`);
}

/**
 * Exécute les requêtes d'un rapport pour sa période (et la précédente si
 * `params.compare`). Une comparaison en échec n'efface pas les données de la
 * période courante. Renvoie null si `isCurrent()` devient faux en cours de
 * route (un calcul plus récent a pris la main).
 * @param {{sources:Array<{id:string,sql:string}>, params:object, baseId:string,
 *   query:(baseId:string, sql:string)=>Promise<{columns?:string[],rows?:any[][]}>,
 *   isCurrent?:()=>boolean}} o
 */
export async function computeSources({ sources, params, baseId, query, isCurrent = () => true }) {
  params = { ...params };
  sources = sources.map((s) => ({ ...s }));
  const results = new Map(), previous = new Map();
  const invalid = !validPeriod(params) ? "Choisissez une période valide : début antérieur ou égal à la fin."
    : !baseId ? "Aucune base sélectionnée (onglet Sources)." : "";
  for (const source of sources) {
    if (!isCurrent()) return null;
    if (invalid) { results.set(source.id, { error: invalid, columns: [], rows: [] }); continue; }
    try {
      const res = await query(baseId, applyParams(source.sql, params));
      results.set(source.id, { columns: res?.columns || [], rows: res?.rows || [] });
    } catch (error) {
      results.set(source.id, { error: String(error?.message || error), columns: [], rows: [] });
      continue;
    }
    if (params.compare) {
      try {
        const res = await query(baseId, applyParams(source.sql, previousPeriod(params)));
        previous.set(source.id, { columns: res?.columns || [], rows: res?.rows || [] });
      } catch (error) {
        previous.set(source.id, { error: String(error?.message || error), columns: [], rows: [] });
      }
    }
  }
  if (!isCurrent()) return null;
  const failures = [...results.values(), ...previous.values()].filter((r) => r.error).length;
  return { results, previous, invalid, failures };
}
