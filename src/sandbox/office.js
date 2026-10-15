// Monte l'éditeur créatif (Documents / Présentations) en pleine page : le
// mode application l'ouvre en iframe. Une seule « fenêtre » : le cadre lui-même.
const { invoke } = window.__TAURI__.core;
import { setCreativeContext, openCreativeApp, openCreativeFile } from "./creative-editor.js";
import { tt } from "../apps-i18n.js";

const root = document.getElementById("office-root");
const params = new URLSearchParams(location.search);
const kind = params.get("kind") === "presentation" ? "presentation" : "document";
document.title = `Lumen — ${tt(kind === "presentation" ? "Présentations" : "Documents")}`;

let sandboxes = [];
const SB_KEY = "officeSandbox";
const current = () => {
  let id = ""; try { id = localStorage.getItem(SB_KEY) || ""; } catch {}
  return sandboxes.find((s) => s.id === id) || sandboxes[0] || null;
};

// La première fenêtre (l'éditeur) occupe le cadre ; les suivantes (ouvrir,
// images, rapports…) deviennent des boîtes de dialogue superposées.
const wins = new Map();
let mainId = null;
function createWindow({ id, title, w = 640, h = 480 }) {
  if (wins.has(id)) return wins.get(id);
  let el, body;
  if (!mainId || id === mainId) {
    mainId = id;
    root.innerHTML = '<div class="dt-win-body"></div>';
    el = root; body = root.firstElementChild;
    document.title = `Lumen — ${title || ""}`;
  } else {
    el = document.createElement("div");
    el.style.cssText = "position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:rgb(0 0 0 / .35)";
    el.innerHTML = `<div class="dt-win" style="position:relative;width:min(${w}px,94vw);height:min(${h}px,90vh);display:flex;flex-direction:column">
      <div class="dt-win-bar"><button class="dt-traffic" title="${tt("Fermer")}"></button><span class="dt-win-title"></span></div>
      <div class="dt-win-body"></div></div>`;
    el.querySelector(".dt-win-title").textContent = title || "";
    el.querySelector(".dt-traffic").addEventListener("click", () => closeWindow(id));
    el.addEventListener("pointerdown", (e) => { if (e.target === el) closeWindow(id); });
    document.body.appendChild(el);
    body = el.querySelector(".dt-win-body");
  }
  const win = { id, body, el, setTitle: (t) => { if (id === mainId) document.title = `Lumen — ${t}`; else el.querySelector(".dt-win-title").textContent = t; } };
  wins.set(id, win);
  return win;
}
function closeWindow(id) {
  const win = wins.get(id);
  if (!win) return;
  wins.delete(id);
  if (id !== mainId) { win.el.remove(); return; }
  // L'éditeur se ferme (ou se rouvre sur un autre fichier) : cadre vidé.
  root.innerHTML = "";
  mainId = null;
  // Fermé pour de bon (pas rouvert dans la foulée) : on repart d'une page vierge.
  setTimeout(() => { if (!mainId) openCreativeApp(kind); }, 0);
}

sandboxes = await invoke("sandbox_list").catch(() => []);
setCreativeContext({
  createWindow, closeWindow,
  getCurrent: current,
  listSandboxes: async () => (sandboxes = await invoke("sandbox_list").catch(() => sandboxes)),
  requestSandboxRefresh: () => {},
  listSandboxImages: async () => {
    const sb = current();
    return sb ? await invoke("sandbox_list_images", { id: sb.id }).catch(() => []) : [];
  },
  toast: (m) => console.warn("[office]", m),
});

const file = params.get("path");
if (file) await openCreativeFile(file, kind, params.get("sandbox") || "");
else openCreativeApp(kind);
if (!root.firstElementChild) root.innerHTML = `<div id="office-empty">${tt("Aucune sandbox active")}</div>`;
