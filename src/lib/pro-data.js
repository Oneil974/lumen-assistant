// Pure helpers shared by the professional workspaces.
export function selectRows(rows, fields, { search = "", sort = "", direction = 1 } = {}, display = (_, value) => value) {
  const query = search.trim().toLocaleLowerCase("fr");
  const selected = rows.filter(row => !query || fields.some(field =>
    String(display(field, row.values[field.id]) ?? "").toLocaleLowerCase("fr").includes(query)));
  const field = fields.find(f => f.id === sort);
  if (!field) return selected;
  return selected.sort((a, b) => {
    const x = a.values[field.id], y = b.values[field.id];
    if (x == null || x === "") return y == null || y === "" ? 0 : 1;
    if (y == null || y === "") return -1;
    const numeric = ["number", "integer", "money", "bool"].includes(field.kind);
    return direction * (numeric ? Number(x) - Number(y) : String(display(field, x)).localeCompare(String(display(field, y)), "fr", { numeric: true }));
  });
}

export function csvText(headers, rows) {
  const cell = value => {
    let text = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? "");
    // Prevent spreadsheet formula execution when opening a data export.
    if (/^[\s]*[=+@-]/.test(text) && typeof value !== "number") text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  return "\uFEFF" + [headers, ...rows].map(row => row.map(cell).join(";")).join("\r\n");
}

export function downloadText(name, content, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function validPeriod({ from, to }) {
  const valid = value => /^\d{4}-\d{2}-\d{2}$/.test(value || "") && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  return valid(from) && valid(to) && from <= to;
}

export function periodPreset(preset, now = new Date()) {
  const date = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const end = new Date(date), start = new Date(date);
  if (preset === "month") start.setUTCDate(1);
  else if (preset === "last-month") { start.setUTCDate(1); end.setUTCDate(0); start.setUTCMonth(start.getUTCMonth() - 1); }
  else if (preset === "year") { start.setUTCMonth(0, 1); }
  else start.setUTCDate(start.getUTCDate() - 29);
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}
