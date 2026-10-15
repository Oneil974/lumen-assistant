// Écran de choix du mode : barre flottante, application, Lumen Desktop.
// Le choix est mémorisé (localStorage partagé avec la fenêtre principale) puis
// appliqué par Rust (`apply_shell_choice`) : bureau ouvert directement, ou
// évènement `shell-mode` vers la fenêtre principale (lib/shell-mode.js).

const invoke = window.__TAURI__?.core?.invoke;
const lang = (localStorage.getItem("lang") || navigator.language || "fr").toLowerCase().startsWith("en") ? "en" : "fr";

const T = {
  fr: {},
  en: {
    eyebrow: "Welcome", title: "How would you like to use Lumen?",
    lead: "Three ways to work, one assistant — your chats, agents and tools follow you everywhere.",
    bar_t: "Floating bar", bar_d: "Always at hand, above your apps. Discreet and instant.", bar_c1: "⌥ Space", bar_c2: "Living orb", bar_c3: "Lightweight",
    app_t: "Application", app_d: "A real work window, ChatGPT-style: chats, projects and tools side by side.", app_c1: "History", app_c2: "Projects", app_c3: "@ tools",
    desk_t: "Lumen Desktop", desk_d: "A complete full-screen desktop: windows, dock, files and every Lumen app.", desk_c1: "Full screen", desk_c2: "Apps", desk_c3: "Files",
    remember: "Always open this mode at startup", hint: "Change it anytime in Settings · keys 1 2 3", new: "New", quit: "Quit",
  },
};
const OPEN = {
  fr: { bar: "Ouvrir la barre", app: "Ouvrir l'application", desktop: "Ouvrir le bureau" },
  en: { bar: "Open the bar", app: "Open the app", desktop: "Open the desktop" },
};

document.documentElement.lang = lang;
if (lang === "en") {
  document.querySelectorAll("[data-i18n]").forEach((el) => { const v = T.en[el.dataset.i18n]; if (v) el.textContent = v; });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => { const v = T.en[el.dataset.i18nTitle]; if (v) el.title = v; });
}
document.title = "Lumen";
// Le raccourci global n'est ⌥ Espace que sur Mac (Super/Ctrl+Alt+Espace ailleurs).
if (!/Mac/i.test(navigator.platform || navigator.userAgent || "")) {
  const chip = document.querySelector('[data-i18n="bar_c1"]');
  if (chip) chip.textContent = lang === "en" ? "Global hotkey" : "Raccourci global";
}

const cards = [...document.querySelectorAll(".card")];
const MODES = cards.map((c) => c.dataset.mode);
const remember = document.getElementById("remember");
const goLabel = document.getElementById("go-label");
let mode = MODES.includes(localStorage.getItem("shellMode")) ? localStorage.getItem("shellMode") : "app";
remember.checked = localStorage.getItem("shellRemember") === "true";

function select(m, focus = false) {
  mode = m;
  cards.forEach((c) => {
    const on = c.dataset.mode === m;
    c.setAttribute("aria-checked", String(on));
    c.tabIndex = on ? 0 : -1;
    if (on && focus) c.focus();
  });
  goLabel.textContent = OPEN[lang][m];
}

let leaving = false;
async function confirm() {
  if (leaving) return;
  leaving = true;
  localStorage.setItem("shellMode", mode);
  localStorage.setItem("shellRemember", String(remember.checked));
  // L'ancien réglage du bureau au démarrage suit ce choix.
  localStorage.setItem("startupLumenOS", String(remember.checked && mode === "desktop"));
  document.getElementById("frame").classList.add("out");
  await new Promise((r) => setTimeout(r, 260));
  try { await invoke?.("apply_shell_choice", { mode }); }
  catch (e) { console.error(e); leaving = false; document.getElementById("frame").classList.remove("out"); }
}

cards.forEach((c) => {
  c.addEventListener("click", () => select(c.dataset.mode));
  c.addEventListener("dblclick", () => { select(c.dataset.mode); confirm(); });
});
document.getElementById("go").addEventListener("click", confirm);
document.getElementById("quit").addEventListener("click", () => invoke?.("close_window"));
document.addEventListener("keydown", (e) => {
  const i = MODES.indexOf(mode);
  if (["1", "2", "3"].includes(e.key)) { select(MODES[+e.key - 1], true); }
  else if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); select(MODES[(i + 1) % MODES.length], true); }
  else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); select(MODES[(i + MODES.length - 1) % MODES.length], true); }
  else if (e.key === "Enter" && !e.target.closest?.(".switch")) { e.preventDefault(); confirm(); }
});
// Fenêtre sans bordure : on la déplace par le haut.
document.getElementById("drag").addEventListener("mousedown", (e) => {
  if (e.button === 0 && !e.target.closest("button")) invoke?.("start_drag").catch(() => {});
});

select(mode);
requestAnimationFrame(() => cards.find((c) => c.dataset.mode === mode)?.focus());
