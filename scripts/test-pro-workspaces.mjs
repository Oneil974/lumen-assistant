import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { selectRows, csvText, validPeriod, periodPreset } from '../src/lib/pro-data.js';
import { computeSources, previousPeriod, applyParams } from '../src/data-analysis/run.js';

const fields = [{ id: 'name', kind: 'text' }, { id: 'amount', kind: 'money' }];
const rows = [{ _id: 1, values: { name: 'Client 10', amount: 100 } }, { _id: 2, values: { name: 'Client 2', amount: 9 } }, { _id: 3, values: { name: 'Équipe', amount: null } }];
test('data explorer sorts numbers, keeps empty values last, and preserves source order', () => {
  assert.deepEqual(selectRows(rows, fields, { sort: 'amount' }).map(r => r._id), [2, 1, 3]);
  assert.deepEqual(selectRows(rows, fields, { sort: 'amount', direction: -1 }).map(r => r._id), [1, 2, 3]);
  assert.deepEqual(selectRows(rows, fields, { search: 'CLIENT', sort: 'name' }).map(r => r._id), [2, 1]);
  assert.deepEqual(rows.map(r => r._id), [1, 2, 3]);
});
test('CSV handles separators, quotes, line breaks and spreadsheet formulas', () => {
  assert.equal(csvText(['Nom', 'Valeur'], [['A;"B\nC', '=1+1'], ['ok', -12]]), '\uFEFF"Nom";"Valeur"\r\n"A;""B\nC";"\'=1+1"\r\n"ok";"-12"');
});
test('periods handle leap years, January rollover and invalid dates', () => {
  assert.deepEqual(periodPreset('last-month', new Date(2026, 0, 15)), { from: '2025-12-01', to: '2025-12-31' });
  assert.deepEqual(periodPreset('last-month', new Date(2024, 2, 31)), { from: '2024-02-01', to: '2024-02-29' });
  assert.equal(validPeriod({ from: '2026-02-30', to: '2026-03-10' }), false);
  assert.equal(validPeriod({ from: '2026-09-15', to: '2026-09-01' }), false);
  assert.equal(validPeriod({ from: "2026-01-01'", to: '2026-09-01' }), false);
});

// Run the real controller with a minimal DOM and injected IPC; no production data.
async function controller(name, additions = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', innerHTML: '', dataset: {}, hidden: false, addEventListener() {} });
    return elements.get(id);
  };
  const scope = {
    console, performance, Date, Map, Set, structuredClone, setTimeout: () => 1, clearTimeout() {},
    window: {}, document: { getElementById: element, querySelector: element, querySelectorAll: () => [] },
    tool: () => ({}), T: new Proxy({}, { get: () => () => ({}) }),
    AGGREGATES: {}, CHART_TYPES: {}, KIND_IDS: [], CARDINALITIES: {},
    readEngineConfig: () => ({}), selectRows, csvText, validPeriod, periodPreset,
    // Coquille Pro (lib/app-shell.js) : icônes et fragments HTML, sans DOM ici.
    mountShell() {}, avatar: () => '', kpi: () => '', emptyState: () => '', progress: () => '',
    ...additions,
  };
  const source = (await readFile(new URL(`../src/${name}/main.js`, import.meta.url), 'utf8'))
    .replace(/^import[\s\S]*?;\n/gm, '').replace(/\ninit\(\);\s*$/, '');
  const context = vm.createContext(scope);
  vm.runInContext(source, context);
  return { run: code => vm.runInContext(code, context), element, context };
}
// Reporting (fusionné dans Analyse de données) : le calcul des sources vit dans src/data-analysis/run.js, sans DOM
// ni IPC — on teste la vraie fonction, pas un contrôleur amputé par regex.
const report = (params) => ({ baseId: 'b', params, sources: [{ id: 's', sql: 'SELECT total WHERE d BETWEEN :debut AND :fin' }] });
test('report calculation keeps current data if previous period fails', async () => {
  let calls = 0;
  const out = await computeSources({ ...report({ from: '2026-09-01', to: '2026-09-15', compare: true }),
    query: async () => { if (++calls === 2) throw new Error('comparison failed'); return { columns: ['total'], rows: [[42]] }; } });
  assert.equal(out.results.get('s').rows[0][0], 42);
  assert.equal(out.previous.get('s').error, 'comparison failed');
  assert.equal(out.failures, 1);
});
test('the comparison queries the previous period of the same length', async () => {
  const seen = [];
  await computeSources({ ...report({ from: '2026-09-01', to: '2026-09-15', compare: true }), query: async (_, sql) => { seen.push(sql); return { rows: [] }; } });
  assert.match(seen[0], /'2026-09-01' AND '2026-09-15'/);
  assert.match(seen[1], /'2026-08-17' AND '2026-08-31'/);
  assert.deepEqual(previousPeriod({ from: '2026-03-01', to: '2026-03-31' }), { from: '2026-01-29', to: '2026-02-28' });
  assert.equal(applyParams('x :debut :fin :debutant', { from: 'a', to: 'b' }), "x 'a' 'b' :debutant");
});
test('a late calculation never overwrites the new period', async () => {
  let resolveOld, sequence = 0;
  const start = (query) => { const mine = ++sequence; return computeSources({ ...report({ from: '2026-09-01', to: '2026-09-15' }), query, isCurrent: () => mine === sequence }); };
  const old = start(() => new Promise(resolve => { resolveOld = resolve; }));
  const fresh = await start(() => Promise.resolve({ rows: [[99]] }));
  resolveOld({ rows: [[1]] });
  assert.equal(await old, null);
  assert.equal(fresh.results.get('s').rows[0][0], 99);
});
test('invalid periods do not execute SQL', async () => {
  let calls = 0;
  const out = await computeSources({ ...report({ from: 'bad', to: '' }), query: async () => { calls++; } });
  assert.equal(calls, 0);
  assert.match(out.results.get('s').error, /période valide/);
  assert.match(out.invalid, /période valide/);
});
test('Analyse de données wires the tested period calculation', async () => {
  const src = await readFile(new URL('../src/data-analysis/main.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ previousPeriod \} from "\.\/run\.js"/);
  const model = await readFile(new URL('../src/data-analysis/model.js', import.meta.url), 'utf8');
  assert.match(model, /import \{ applyParams, previousPeriod \} from "\.\/run\.js"/);
});
test('DB Studio reads the next batch at offset 500 and renders 25 rows per page', async () => {
  const calls = [];
  const c = await controller('dbstudio');
  c.context.engineRows = async (model, limit, offset) => {
    calls.push(offset);
    return Array.from({ length: offset ? 20 : 500 }, (_, i) => ({ _id: offset + i + 1, values: { name: `Client ${offset + i + 1}` } }));
  };
  c.run(`state.engine={rows:engineRows}; state.models=[{id:'m',name:'Clients',fields:[{id:'name',name:'Nom',kind:'text'}]}]; state.dataModel='m';`);
  await c.run('loadRows(state.models[0])');
  await c.run('loadRows(state.models[0], true)');
  c.run('renderData()');
  assert.deepEqual(calls, [0, 500]);
  assert.equal(c.run('state.rows.length'), 520);
  assert.equal(c.run('state.hasMore'), false);
  assert.equal((c.element('data-table').innerHTML.match(/data-act="edit-record"/g) || []).length, 25);
  c.element('data-search').value = 'Client 520'; c.run('renderData()');
  assert.match(c.element('data-count').textContent, /^1 résultat/);
});
