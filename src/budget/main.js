import { llmChat } from "../llm.js";
import { PROMPTS } from "./prompts.js";
import { translatePage, observeTranslations } from "../apps-i18n.js";
import { mountAiPrompt, tool, T } from "../lib/ai-prompt.js?v=5";
import { formatMoney } from "../lib/money.js";

const tauri = window.__TAURI__ || window.parent?.__TAURI__ || {};
const invoke = tauri.core?.invoke;
const $ = s => document.querySelector(s);
const euro = (n) => formatMoney(n);
const today = () => new Date().toISOString().slice(0, 10);
const STORE = "lumen.budget.v1";
// L'app s'appelait « Finance » : on récupère une fois les données de l'ancienne
// clé pour que le renommage ne fasse perdre aucune transaction.
const LEGACY_STORE = "lumen.finance.v1";
const COLORS = ["#0a84ff", "#6b6ff0", "#16b8a6", "#ff9f0a", "#ff6482", "#30d158", "#af52de", "#8e8e93"];
const uid = () => globalThis.crypto?.randomUUID?.() || `budget-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let state = normalizeState(loadState()), activeView = "overview";

function loadState() {
  for (const key of [STORE, LEGACY_STORE]) {
    try {
      const saved = JSON.parse(localStorage.getItem(key));
      if (saved?.transactions && saved?.budgets && saved?.goals) {
        if (key === LEGACY_STORE) localStorage.setItem(STORE, JSON.stringify(saved));
        return saved;
      }
    } catch {}
  }
  const d = new Date(); const date = n => new Date(d.getFullYear(), d.getMonth(), n).toISOString().slice(0, 10);
  return { transactions: [{ id: uid(), date: date(2), type: "income", category: "Revenu", merchant: "Salaire", amount: 2450, note: "Exemple" }, { id: uid(), date: date(5), type: "expense", category: "Logement", merchant: "Loyer", amount: 780, note: "Exemple" }, { id: uid(), date: date(8), type: "expense", category: "Alimentation", merchant: "Courses", amount: 94.3, note: "Exemple" }, { id: uid(), date: date(12), type: "expense", category: "Transport", merchant: "Abonnement", amount: 45, note: "Exemple" }], budgets: { Alimentation: 400, Loisirs: 180, Transport: 100, Abonnements: 90 }, goals: [{ id: uid(), name: "Épargne de précaution", target: 3000, saved: 850 }] };
}
function normalizeState(raw) { const value = raw || {}; const now = today(); const budgets = value.budgets && !Array.isArray(value.budgets) ? value.budgets : {}; const budgetDates = value.budgetDates || Object.fromEntries(Object.keys(budgets).map(k => [k, now])); const transactions = Array.isArray(value.transactions) ? value.transactions.map(t => ({ ...t, id: t.id || uid(), date: t.date || now })) : []; const goals = Array.isArray(value.goals) ? value.goals.map(g => ({ ...g, id: g.id || uid(), createdAt: g.createdAt || now })) : []; return { transactions, budgets, budgetDates, goals }; }
function save() { localStorage.setItem(STORE, JSON.stringify(state)); }
function monthTransactions() { const now = new Date(); return state.transactions.filter(t => { const d = new Date(t.date || today()); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); }); }
function monthBudgets() { const now = new Date(); return Object.fromEntries(Object.entries(state.budgets).filter(([category]) => { const d = new Date(state.budgetDates?.[category] || today()); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); })); }
function calc() { const tx = monthTransactions(), income = tx.filter(t => t.type === "income").reduce((s, t) => s + Number(t.amount), 0), expenses = tx.filter(t => t.type === "expense").reduce((s, t) => s + Number(t.amount), 0), byCategory = {}; tx.filter(t => t.type === "expense").forEach(t => byCategory[t.category] = (byCategory[t.category] || 0) + Number(t.amount)); return { tx, income, expenses, balance: income - expenses, savingsRate: income ? ((income - expenses) / income) * 100 : 0, byCategory }; }
function esc(v = "") { const d = document.createElement("div"); d.textContent = String(v); return d.innerHTML; }
function fmtDate(value) { return new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" }).format(new Date(value)); }
function render() { const m = calc(); renderMetrics(m); renderChart(m); renderCategories(m); renderRecent(m); renderTransactions(); renderBudgets(m); renderGoals(); }
function renderMetrics(m) { $("#metrics").innerHTML = `<article class="metric-card"><small>Solde disponible</small><strong>${euro(m.balance)}</strong><span class="delta ${m.balance >= 0 ? "positive" : "negative"}">${m.balance >= 0 ? "Dans le vert" : "À surveiller"}</span></article><article class="metric-card"><small>Revenus du mois</small><strong>${euro(m.income)}</strong><span class="delta">${m.tx.filter(t => t.type === "income").length} opération(s)</span></article><article class="metric-card"><small>Dépenses du mois</small><strong>${euro(m.expenses)}</strong><span class="delta">${Object.keys(m.byCategory).length} catégories</span></article><article class="metric-card"><small>Taux d’épargne</small><strong>${Math.round(m.savingsRate)} %</strong><span class="delta ${m.savingsRate >= 20 ? "positive" : ""}">${m.savingsRate >= 20 ? "Bon rythme" : "Objectif conseillé : 20 %"}</span></article>`; }
function renderChart(m) { const days = Array.from({ length: 6 }, (_, i) => i * 5 + 1), max = Math.max(1, ...days.map(day => { const end = new Date(); end.setDate(day + 4); return m.tx.filter(t => new Date(t.date).getDate() >= day && new Date(t.date).getDate() <= day + 4).reduce((s, t) => s + Number(t.amount), 0); })); $("#cashflow-chart").innerHTML = days.map(day => { const part = m.tx.filter(t => { const n = new Date(t.date).getDate(); return n >= day && n <= day + 4; }); const income = part.filter(t => t.type === "income").reduce((s, t) => s + Number(t.amount), 0), expense = part.filter(t => t.type === "expense").reduce((s, t) => s + Number(t.amount), 0); return `<div class="chart-day"><div class="chart-bars"><i class="bar income" style="height:${Math.max(4, income / max * 140)}px" title="${euro(income)}"></i><i class="bar expense" style="height:${Math.max(4, expense / max * 140)}px" title="${euro(expense)}"></i></div><small>${day} ${new Intl.DateTimeFormat("fr-FR", { month: "short" }).format(new Date())}</small></div>`; }).join(""); }
function renderCategories(m) { const entries = Object.entries(m.byCategory).sort((a, b) => b[1] - a[1]), max = Math.max(1, ...entries.map(e => e[1])); $("#category-list").innerHTML = entries.length ? entries.slice(0, 6).map(([name, amount], i) => `<div class="category-row"><span>${esc(name)}</span><div class="progress"><i style="width:${amount / max * 100}%;background:${COLORS[i % COLORS.length]}"></i></div><strong>${euro(amount)}</strong></div>`).join("") : `<span class="ai-placeholder">Aucune dépense ce mois-ci.</span>`; }
function renderRecent(m) { const entries = [...m.tx].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5); $("#recent-list").innerHTML = entries.length ? entries.map(t => `<div class="recent-row"><span class="recent-icon">${t.type === "income" ? "↗" : "↘"}</span><div><strong>${esc(t.merchant)}</strong><small>${esc(t.category)} · ${fmtDate(t.date)}</small></div><strong class="amount ${t.type}">${t.type === "income" ? "+" : "−"}${euro(t.amount)}</strong></div>`).join("") : `<span class="ai-placeholder">Ajoutez votre première transaction.</span>`; }
function renderTransactions() { const query = $("#transaction-search")?.value.toLowerCase() || "", filter = $("#transaction-filter")?.value || "all", entries = [...state.transactions].filter(t => (filter === "all" || t.type === filter) && `${t.merchant} ${t.category} ${t.note}`.toLowerCase().includes(query)).sort((a, b) => b.date.localeCompare(a.date)); $("#transactions-list").innerHTML = entries.length ? entries.map(t => `<div class="transaction-row"><span class="transaction-icon">${t.type === "income" ? "↗" : "↘"}</span><div><strong>${esc(t.merchant)}</strong><small>${fmtDate(t.date)}${t.note ? ` · ${esc(t.note)}` : ""}</small></div><span class="transaction-category">${esc(t.category)}</span><strong class="amount ${t.type}">${t.type === "income" ? "+" : "−"}${euro(t.amount)}</strong><button class="delete-transaction" data-delete-tx="${t.id}" title="Supprimer">×</button></div>`).join("") : `<div class="ai-placeholder">Aucune transaction.</div>`; document.querySelectorAll("[data-delete-tx]").forEach(b => b.onclick = () => { state.transactions = state.transactions.filter(t => t.id !== b.dataset.deleteTx); save(); render(); }); }
function renderBudgets(m) { const now = new Date(), entries = Object.entries(state.budgets).filter(([category]) => { const d = new Date(state.budgetDates?.[category] || today()); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); }); $("#budgets-list").innerHTML = entries.length ? entries.map(([category, limit], i) => { const spent = m.byCategory[category] || 0, pct = Math.min(100, spent / Math.max(1, Number(limit) || 1) * 100), date = state.budgetDates?.[category] || today(); return `<article class="budget-card"><header><h3>${esc(category)}</h3><button class="delete-budget" data-delete-budget="${esc(category)}" title="Supprimer">×</button></header><div class="budget-date">${fmtDate(date)} · ${euro(limit)} / mois</div><div class="budget-amount"><strong>${euro(spent)}</strong><span>${Math.round(pct)} %</span></div><div class="progress"><i style="width:${pct}%;background:${pct >= 100 ? "var(--red)" : COLORS[i % COLORS.length]}"></i></div>${pct >= 100 ? `<small class="budget-warning">Budget dépassé</small>` : ""}</article>`; }).join("") : `<div class="panel ai-placeholder">Aucun budget pour ce mois.</div>`; document.querySelectorAll("[data-delete-budget]").forEach(b => b.onclick = () => { const category = b.dataset.deleteBudget; delete state.budgets[category]; if (state.budgetDates) delete state.budgetDates[category]; save(); render(); }); }
function renderGoals() { $("#goals-list").innerHTML = state.goals.length ? state.goals.map(g => { const pct = Math.min(100, Number(g.saved) / Math.max(1, Number(g.target)) * 100), date = g.createdAt || today(); return `<article class="goal-card"><header><h3>${esc(g.name)}</h3><button class="delete-goal" data-delete-goal="${esc(g.id)}" title="Supprimer">×</button></header><div class="goal-date">Créé le ${fmtDate(date)}</div><p>${euro(g.target - g.saved)} restant à épargner</p><div class="progress"><i style="width:${pct}%;background:linear-gradient(90deg,var(--accent),var(--accent2))"></i></div><div class="goal-meta"><span>${euro(g.saved)} épargné</span><strong>${euro(g.target)}</strong></div></article>`; }).join("") : `<div class="panel ai-placeholder">Ajoutez un objectif pour donner une direction à votre épargne.</div>`; document.querySelectorAll("[data-delete-goal]").forEach(b => b.onclick = () => { state.goals = state.goals.filter(g => g.id !== b.dataset.deleteGoal); save(); render(); }); }
function showView(view) { activeView = view; document.querySelectorAll(".budget-view").forEach(el => el.classList.toggle("active", el.id === `view-${view}`)); document.querySelectorAll(".budget-nav button").forEach(b => b.classList.toggle("active", b.dataset.view === view)); const labels = { overview: "Vue d’ensemble", transactions: "Transactions", budgets: "Budgets", goals: "Objectifs" }; $("#view-title").textContent = labels[view]; }
async function askAI() { const target = $("#ai-insight"), m = calc(); target.innerHTML = `<div class="ai-loading">Lumen analyse les indicateurs calculés…</div>`; const context = { periode: "mois courant", revenus: Number(m.income.toFixed(2)), depenses: Number(m.expenses.toFixed(2)), solde: Number(m.balance.toFixed(2)), taux_epargne: Number(m.savingsRate.toFixed(1)), depenses_par_categorie: Object.fromEntries(Object.entries(m.byCategory).map(([k, v]) => [k, Number(v.toFixed(2))])), budgets: monthBudgets(), objectifs: state.goals.map(g => ({ nom: g.name, cible: g.target, epargne: g.saved, reste: Number((g.target - g.saved).toFixed(2)) })) }; if (!invoke) return target.innerHTML = `<p>Le backend IA est indisponible. Les calculs de Lumen restent disponibles.</p>`; try { const { content } = await llmChat(PROMPTS["app.budget.insight"].build({ indicators: context, lang: "fr" }).messages, { rawSystem: true, onDelta: (txt) => { if (txt) target.innerHTML = `<div>${simpleMarkdown(txt)}</div>`; } }); const text = content || "Aucune analyse reçue."; target.innerHTML = `<div>${simpleMarkdown(text)}</div>`; } catch (e) { target.innerHTML = `<p>Impossible de joindre le modèle IA pour le moment.</p><small>${esc(String(e))}</small>`; } }
function simpleMarkdown(text) { return esc(text).replace(/^### (.*)$/gm, "<h3>$1</h3>").replace(/^## (.*)$/gm, "<h3>$1</h3>").replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>").replace(/\n[-*] (.*)/g, "<br>• $1").replace(/\n/g, "<br>"); }
function openModal(id) { $("#" + id).hidden = false; }
function closeModal(id) { $("#" + id).hidden = true; }
async function openExportModal() { const select = $("#export-sandbox"), status = $("#export-status"); openModal("export-modal"); select.innerHTML = `<option value="">Chargement…</option>`; status.textContent = "Le fichier restera dans la sandbox choisie et ne sera pas écrit directement sur l’ordinateur."; if (!invoke) { select.innerHTML = `<option value="">Backend indisponible</option>`; return; } try { const sandboxes = await invoke("sandbox_list"); const remembered = localStorage.getItem("budgetExportSandbox"); const available = Array.isArray(sandboxes) ? sandboxes : []; select.innerHTML = available.length ? available.map(sb => `<option value="${esc(sb.id)}" ${sb.id === remembered ? "selected" : ""}>${esc(sb.name || sb.id)}</option>`).join("") : `<option value="">Aucune sandbox disponible</option>`; } catch (e) { select.innerHTML = `<option value="">Impossible de charger les sandboxes</option>`; status.textContent = String(e); } }
// ===== Assistant IA (boîte de prompt partagée) =====
// Toute la gestion au prompt : saisir des dépenses, poser des budgets, créer et
// alimenter des objectifs, analyser le mois.
const BUDGET_TOOLS = [
  tool("summary", "Chiffres du mois : revenus, dépenses, solde, taux d'épargne, dépenses par catégorie, budgets et objectifs.", {}),
  tool("list_transactions", "Liste les transactions (filtres optionnels).",
    { type: T.enum(["income", "expense"], "Type"), category: T.str("Catégorie"), month: T.str("Mois AAAA-MM"), query: T.str("Texte libre") }),
  tool("add_transaction", "Enregistre une transaction.",
    { type: T.enum(["income", "expense"], "Revenu ou dépense"), amount: T.num("Montant en euros"),
      merchant: T.str("Libellé"), category: T.str("Catégorie"), date: T.str("AAAA-MM-JJ, défaut aujourd'hui"), note: T.str("") },
    ["type", "amount", "merchant"]),
  tool("add_transactions", "Enregistre plusieurs transactions d'un coup.",
    { items: { type: "array", items: { type: "object", properties: { type: T.enum(["income", "expense"], ""), amount: T.num(""), merchant: T.str(""), category: T.str(""), date: T.str(""), note: T.str("") }, required: ["type", "amount", "merchant"] } } },
    ["items"]),
  tool("delete_transaction", "Supprime une transaction par identifiant ou libellé.", { transaction: T.str("") }, ["transaction"]),
  tool("set_budget", "Pose (ou modifie) un budget mensuel sur une catégorie.", { category: T.str(""), limit: T.num("Limite en euros") }, ["category", "limit"]),
  tool("remove_budget", "Retire le budget d'une catégorie.", { category: T.str("") }, ["category"]),
  tool("add_goal", "Crée un objectif d'épargne.", { name: T.str(""), target: T.num("Cible en euros"), saved: T.num("Déjà épargné") }, ["name", "target"]),
  tool("fund_goal", "Ajoute (ou retire, avec un montant négatif) de l'épargne sur un objectif.", { goal: T.str("Nom de l'objectif"), amount: T.num("Montant en euros") }, ["goal", "amount"]),
  tool("delete_goal", "Supprime un objectif.", { goal: T.str("") }, ["goal"]),
  tool("budget_check", "Compare les dépenses du mois aux budgets : dépassements et marge restante.", {}),
  tool("forecast", "Projette le solde et l'atteinte des objectifs sur N mois au rythme actuel.", { months: T.int("Nombre de mois (défaut 6)") }),
];

async function runBudgetTool(name, a) {
  const m = calc();
  const findTx = (ref) => state.transactions.find(t => t.id === ref)
    || state.transactions.find(t => String(t.merchant || "").toLowerCase().includes(String(ref).toLowerCase()));
  const findGoal = (ref) => state.goals.find(g => g.id === ref)
    || state.goals.find(g => String(g.name || "").toLowerCase().includes(String(ref).toLowerCase()));
  const pushTx = (t) => {
    const tx = { id: uid(), date: t.date || today(), type: t.type === "income" ? "income" : "expense",
      category: t.category || (t.type === "income" ? "Revenu" : "Autre"), merchant: String(t.merchant || ""),
      amount: Math.abs(Number(t.amount) || 0), note: String(t.note || "") };
    state.transactions.push(tx);
    return tx;
  };
  switch (name) {
    case "summary":
      return `Mois en cours — revenus ${euro(m.income)}, dépenses ${euro(m.expenses)}, solde ${euro(m.balance)}, épargne ${m.savingsRate.toFixed(1)} %.\n`
        + `Par catégorie : ${Object.entries(m.byCategory).map(([c, v]) => `${c} ${euro(v)}`).join(", ") || "aucune"}\n`
        + `Budgets : ${Object.entries(state.budgets).map(([c, v]) => `${c} ${euro(v)}`).join(", ") || "aucun"}\n`
        + `Objectifs : ${state.goals.map(g => `${g.name} ${euro(g.saved)}/${euro(g.target)}`).join(", ") || "aucun"}`;
    case "list_transactions": {
      const q = String(a.query || "").toLowerCase();
      const items = state.transactions.filter(t =>
        (!a.type || t.type === a.type) && (!a.category || t.category === a.category)
        && (!a.month || String(t.date).startsWith(a.month))
        && (!q || `${t.merchant} ${t.category} ${t.note}`.toLowerCase().includes(q)));
      return items.length ? items.map(t => `${t.id} · ${t.date} · ${t.type === "income" ? "+" : "-"}${euro(t.amount)} · ${t.merchant} [${t.category}]`).join("\n") : "Aucune transaction.";
    }
    case "add_transaction": { const t = pushTx(a); return `Enregistré : ${t.date} ${t.type === "income" ? "+" : "-"}${euro(t.amount)} ${t.merchant} [${t.category}]`; }
    case "add_transactions": {
      const made = (a.items || []).map(pushTx);
      return `${made.length} opération(s) enregistrée(s) : ` + made.map(t => `${t.merchant} ${euro(t.amount)}`).join(", ");
    }
    case "delete_transaction": {
      const t = findTx(a.transaction);
      if (!t) throw new Error("transaction introuvable ; appelle list_transactions.");
      state.transactions = state.transactions.filter(x => x.id !== t.id);
      return `Supprimé : ${t.merchant} ${euro(t.amount)}`;
    }
    case "set_budget": {
      state.budgets[a.category] = Number(a.limit) || 0;
      state.budgetDates ||= {};
      state.budgetDates[a.category] = today();
      return `Budget ${a.category} : ${euro(a.limit)} par mois.`;
    }
    case "remove_budget": { delete state.budgets[a.category]; return `Budget ${a.category} retiré.`; }
    case "add_goal": {
      const g = { id: uid(), name: String(a.name), target: Number(a.target) || 0, saved: Number(a.saved) || 0, createdAt: today() };
      state.goals.push(g);
      return `Objectif « ${g.name} » : ${euro(g.saved)}/${euro(g.target)}`;
    }
    case "fund_goal": {
      const g = findGoal(a.goal);
      if (!g) throw new Error("objectif introuvable.");
      g.saved = Math.max(0, Number(g.saved) + Number(a.amount || 0));
      return `« ${g.name} » : ${euro(g.saved)}/${euro(g.target)}`;
    }
    case "delete_goal": {
      const g = findGoal(a.goal);
      if (!g) throw new Error("objectif introuvable.");
      state.goals = state.goals.filter(x => x.id !== g.id);
      return `Objectif « ${g.name} » supprimé.`;
    }
    case "budget_check": {
      const budgets = monthBudgets();
      const lines = Object.entries(budgets).map(([cat, limit]) => {
        const spent = m.byCategory[cat] || 0;
        return `${cat} : ${euro(spent)} / ${euro(limit)}${spent > limit ? ` ⚠ dépassement de ${euro(spent - limit)}` : ` (reste ${euro(limit - spent)})`}`;
      });
      return lines.join("\n") || "Aucun budget posé ce mois-ci.";
    }
    case "forecast": {
      const months = Math.max(1, Number(a.months) || 6);
      const lines = [`Au rythme actuel (${euro(m.balance)} par mois) : ${euro(m.balance * months)} en ${months} mois.`];
      for (const g of state.goals) {
        const missing = g.target - g.saved;
        if (missing <= 0) { lines.push(`${g.name} : déjà atteint.`); continue; }
        lines.push(m.balance > 0
          ? `${g.name} : ${Math.ceil(missing / m.balance)} mois au rythme actuel.`
          : `${g.name} : inatteignable tant que le solde mensuel est négatif.`);
      }
      return lines.join("\n");
    }
    default: return `Outil inconnu : ${name}`;
  }
}

function mountBudgetAI() {
  mountAiPrompt(null, {
    app: "Budget",
    intro: "Tu tiens le budget personnel : transactions, budgets, objectifs d'épargne, analyse.",
    rules: "- Les montants sont en euros. Une dépense a type=expense et un montant POSITIF.\n- Appelle summary ou list_transactions avant d'analyser ou de supprimer.\n- Tu peux saisir plusieurs opérations d'un coup avec add_transactions.",
    placeholder: "Ex. : note 34 € de courses hier, et pose un budget Loisirs à 150 €…",
    suggestions: [
      { label: "Analyser le mois", prompt: "Analyse mon budget du mois et donne-moi trois conseils concrets et chiffrés." },
      { label: "Où ça fuit ?", prompt: "Compare mes dépenses aux budgets, dis-moi ce qui dérape et de combien." },
      { label: "Proposer des budgets", prompt: "Propose et pose des budgets réalistes par catégorie à partir de mes trois derniers mois." },
      { label: "Projeter", prompt: "Projette mon solde et mes objectifs sur 6 mois au rythme actuel." },
    ],
    tools: BUDGET_TOOLS,
    context: () => {
      const m = calc();
      return `Revenus ${euro(m.income)} · dépenses ${euro(m.expenses)} · solde ${euro(m.balance)} · ${state.transactions.length} transactions enregistrées.`;
    },
    execute: runBudgetTool,
    onApplied: () => { save(); render(); },
  });
}

function bind() { document.querySelectorAll("[data-view]").forEach(b => b.onclick = () => showView(b.dataset.view)); document.querySelectorAll("[data-view-link]").forEach(b => b.onclick = () => showView(b.dataset.viewLink)); $("#add-btn").onclick = () => openModal("transaction-modal"); $("#add-btn-secondary").onclick = () => openModal("transaction-modal"); $("#budget-btn").onclick = () => openModal("budget-modal"); $("#goal-btn").onclick = () => openModal("goal-modal"); $("#ai-btn").onclick = askAI; $("#ai-expand-btn").onclick = () => { $("#ai-modal-content").innerHTML = $("#ai-insight").innerHTML; openModal("ai-modal"); }; $("#export-btn").onclick = openExportModal; document.querySelectorAll("[data-close]").forEach(b => b.onclick = () => closeModal(b.dataset.close)); document.querySelectorAll(".modal").forEach(m => m.onclick = e => { if (e.target === m) m.hidden = true; }); $("#export-form").onsubmit = async e => { e.preventDefault(); const f = new FormData(e.target), id = f.get("sandbox"), filename = String(f.get("filename") || "lumen-budget.json").replace(/[^A-Za-z0-9._-]/g, "-"); if (!id || !invoke) return; const status = $("#export-status"); status.textContent = "Export en cours…"; try { await invoke("sandbox_write_file", { id, path: filename, content: JSON.stringify(state, null, 2) }); localStorage.setItem("budgetExportSandbox", id); status.textContent = `Exporté dans ${$("#export-sandbox").selectedOptions[0]?.textContent || "la sandbox"} ✓`; } catch (err) { status.textContent = `Échec de l’export : ${String(err)}`; } }; $("#transaction-form").onsubmit = e => { e.preventDefault(); const f = new FormData(e.target); state.transactions.push({ id: uid(), date: f.get("date") || today(), type: f.get("type"), category: f.get("category"), merchant: f.get("merchant"), amount: Number(f.get("amount")), note: f.get("note") }); save(); e.target.reset(); e.target.date.value = today(); closeModal("transaction-modal"); render(); }; $("#budget-form").onsubmit = e => { e.preventDefault(); const f = new FormData(e.target); const category = f.get("category"); state.budgets[category] = Number(f.get("limit")); state.budgetDates ||= {}; state.budgetDates[category] = f.get("date") || today(); save(); closeModal("budget-modal"); render(); showView("budgets"); }; $("#goal-form").onsubmit = e => { e.preventDefault(); const f = new FormData(e.target); state.goals.push({ id: uid(), name: f.get("name"), target: Number(f.get("target")), saved: Number(f.get("saved")), createdAt: f.get("date") || today() }); save(); closeModal("goal-modal"); render(); showView("goals"); }; $("#transaction-search").oninput = renderTransactions; $("#transaction-filter").onchange = renderTransactions; $("#transaction-form").date.value = today(); $("#budget-form").date.value = today(); $("#goal-form").date.value = today(); }
bind(); mountBudgetAI(); render(); translatePage(document); observeTranslations(document.body);
