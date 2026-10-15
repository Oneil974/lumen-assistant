// Visionneuses dédiées : tableau interactif (CSV/TSV) et explorateur JSON.
// Modules autonomes (DOM + écouteurs), sans dépendance externe.

function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}
function cmp(a, b) {
  const na = parseFloat(a), nb = parseFloat(b);
  if (!isNaN(na) && !isNaN(nb) && /^-?[\d.,\s]+$/.test(a) && /^-?[\d.,\s]+$/.test(b)) return na - nb;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

// ===== CSV / TSV =====
function detectDelim(text) {
  const line = (text.split("\n").find((l) => l.trim()) || "");
  const counts = { ",": 0, ";": 0, "\t": 0 };
  for (const c of line) if (c in counts) counts[c]++;
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || ",";
}
function parseCsv(text, delim) {
  const rows = []; let row = [], field = "", i = 0, inQ = false;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === delim) { row.push(field); field = ""; i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function mountCsv(container, text, forcedDelim) {
  container.innerHTML = "";
  const delim = forcedDelim || detectDelim(text);
  const rows = parseCsv(text, delim).filter((r) => r.length > 1 || (r[0] || "").trim() !== "");
  if (!rows.length) { container.textContent = "Fichier vide."; return; }
  const header = rows[0];
  const data = rows.slice(1);

  const bar = el("div", "tv-bar");
  const search = el("input", "tv-search"); search.placeholder = "Filtrer…"; search.spellcheck = false;
  const count = el("span", "tv-count");
  bar.append(search, count);
  const wrap = el("div", "tv-wrap");
  container.append(bar, wrap);

  let sortCol = -1, sortDir = 1, filter = "";
  const CAP = 3000;
  function render() {
    let view = data;
    if (filter) view = data.filter((r) => r.some((c) => (c || "").toLowerCase().includes(filter)));
    if (sortCol >= 0) view = view.slice().sort((a, b) => cmp(a[sortCol] || "", b[sortCol] || "") * sortDir);
    count.textContent = `${view.length} ligne${view.length > 1 ? "s" : ""}${view.length > CAP ? ` · affiche ${CAP}` : ""} · ${header.length} col.`;
    const t = el("table", "tv-table");
    const thead = el("thead"); const htr = el("tr");
    header.forEach((h, j) => {
      const th = el("th", j === sortCol ? "sorted" : "", h);
      const arrow = el("span", "tv-arrow", j === sortCol ? (sortDir > 0 ? " ↑" : " ↓") : "");
      th.appendChild(arrow);
      th.addEventListener("click", () => { if (sortCol === j) sortDir = -sortDir; else { sortCol = j; sortDir = 1; } render(); });
      htr.appendChild(th);
    });
    thead.appendChild(htr); t.appendChild(thead);
    const tbody = el("tbody");
    for (const r of view.slice(0, CAP)) {
      const tr = el("tr");
      for (let j = 0; j < header.length; j++) tr.appendChild(el("td", "", r[j] ?? ""));
      tbody.appendChild(tr);
    }
    t.appendChild(tbody);
    wrap.innerHTML = ""; wrap.appendChild(t);
  }
  search.addEventListener("input", () => { filter = search.value.trim().toLowerCase(); render(); });
  render();
}

// ===== JSON (arbre repliable + tableau si liste d'objets) =====
export function mountJson(container, text) {
  container.innerHTML = "";
  let data;
  try { data = JSON.parse(text); }
  catch (e) {
    container.appendChild(el("div", "json-error", "JSON invalide : " + e.message));
    const pre = el("pre", "json-raw"); pre.textContent = text; container.appendChild(pre);
    return;
  }
  const isObjArray = Array.isArray(data) && data.length > 0 && data.every((x) => x && typeof x === "object" && !Array.isArray(x));
  const view = el("div", "json-body");
  if (isObjArray) {
    const bar = el("div", "tv-bar");
    const bTable = el("button", "diff-mini", "Tableau");
    const bTree = el("button", "diff-mini", "Arbre");
    bar.append(bTable, bTree);
    container.append(bar, view);
    const showTable = () => { bTable.classList.add("on"); bTree.classList.remove("on"); view.innerHTML = ""; view.appendChild(jsonTable(data)); };
    const showTree = () => { bTree.classList.add("on"); bTable.classList.remove("on"); view.innerHTML = ""; view.appendChild(jsonNode("racine", data, true)); };
    bTable.addEventListener("click", showTable);
    bTree.addEventListener("click", showTree);
    showTable();
  } else {
    container.appendChild(view);
    view.appendChild(jsonNode("racine", data, true));
  }
}

function jsonTable(arr) {
  const cols = [];
  for (const o of arr) for (const k of Object.keys(o)) if (!cols.includes(k)) cols.push(k);
  const t = el("table", "tv-table");
  const thead = el("thead"); const htr = el("tr");
  cols.forEach((c) => htr.appendChild(el("th", "", c)));
  thead.appendChild(htr); t.appendChild(thead);
  const tbody = el("tbody");
  for (const o of arr) {
    const tr = el("tr");
    for (const c of cols) {
      const v = o[c];
      tr.appendChild(el("td", "", v == null ? "" : (typeof v === "object" ? JSON.stringify(v) : String(v))));
    }
    tbody.appendChild(tr);
  }
  t.appendChild(tbody); return t;
}

function jsonNode(key, val, open) {
  if (val !== null && typeof val === "object") {
    const det = el("details", "json-node"); if (open) det.open = true;
    const sum = el("summary");
    const isArr = Array.isArray(val);
    const n = isArr ? val.length : Object.keys(val).length;
    sum.innerHTML = `<span class="json-key">${escapeAttr(key)}</span><span class="json-meta">${isArr ? `[${n}]` : `{${n}}`}</span>`;
    det.appendChild(sum);
    const entries = isArr ? val.map((v, i) => [i, v]) : Object.entries(val);
    for (const [k, v] of entries) det.appendChild(jsonNode(k, v, false));
    return det;
  }
  const row = el("div", "json-leaf");
  const t = val === null ? "null" : typeof val;
  row.innerHTML = `<span class="json-key">${escapeAttr(key)}</span><span class="json-val json-${t}">${escapeAttr(val === null ? "null" : (t === "string" ? `"${val}"` : String(val)))}</span>`;
  return row;
}
function escapeAttr(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
