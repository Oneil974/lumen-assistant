// Avatar du héro : Robot Head (par défaut) ou orbe coloré, au choix.
//
// Le robot est le rendu Canvas de l'application (assets/robot/, copie de
// src/lib/robot-head.js + robot-heads/, MIT Fayazara) avec la livrée de Lumen :
// coque rouge, écran aux yeux violets. L'orbe est le personnage « soft-sky » en
// CSS (assets/soft-orb.css). Le choix est mémorisé (localStorage).
//
// Les puces sous la barre font une petite démonstration : la question se tape
// dans la barre, l'avatar réfléchit, puis « parle ».
import { mountRobotHead } from "./robot/robot-head.js?v=20261015";

const stage = document.getElementById("avatar-stage");
const host = document.getElementById("robot-host");
const soft = stage?.querySelector(".hero-soft");
const KEY = "lumenSiteAvatar";

let robot = null;
try {
  robot = mountRobotHead(host);
  robot.settings({ shape: "rectangle", color: "#d6223f", trimColor: "#e9e9ec", screenColor: "#c45cff", antenna: true, floorShadow: true, interactive: true });
} catch (e) {
  // Canvas indisponible : l'orbe CSS prend le relais.
  console.warn("Robot Head indisponible", e);
}

function pick(kind) {
  const k = kind === "orb" || !robot ? "orb" : "robot";
  stage.dataset.avatar = k;
  robot?.setActive(k === "robot");
  if (soft) soft.hidden = k !== "orb";
  document.querySelectorAll("[data-avatar-pick]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.avatarPick === k)));
  try { localStorage.setItem(KEY, k); } catch {}
}
let saved = "robot";
try { saved = localStorage.getItem(KEY) || "robot"; } catch {}
pick(saved);
document.querySelectorAll("[data-avatar-pick]").forEach((b) => b.addEventListener("click", () => pick(b.dataset.avatarPick)));

// ── Démonstration : puce → frappe dans la barre → réflexion → parole ──────────
const text = document.getElementById("composer-text");
const composer = document.getElementById("hero-composer");
let run = 0;
function setState(s) {
  host.dataset.state = s;
  soft?.setAttribute("data-state", s);
}
function placeholder() {
  return document.documentElement.lang === "en" ? text.dataset.enPlaceholder : text.dataset.placeholder;
}
document.querySelectorAll("#hero-chips .chip").forEach((chip) => {
  chip.addEventListener("click", async () => {
    const id = ++run;
    const q = document.documentElement.lang === "en" ? chip.dataset.enQ : chip.dataset.q;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    composer.classList.add("typing");
    setState("listening");
    text.textContent = "";
    for (const ch of q) {
      if (id !== run) return;
      text.textContent += ch;
      await wait(28);
    }
    await wait(300);
    if (id !== run) return;
    setState("thinking");
    await wait(1400);
    if (id !== run) return;
    setState("speaking");
    await wait(1800);
    if (id !== run) return;
    setState("idle");
    composer.classList.remove("typing");
    text.textContent = placeholder();
  });
});
// La langue change : le texte d'invite suit.
new MutationObserver(() => { if (!composer.classList.contains("typing")) text.textContent = placeholder(); })
  .observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
