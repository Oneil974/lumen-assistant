// Lumen XR — voir Lumen réfléchir.
//
// Chaque outil utilisé pendant une réponse devient une petite CARTE (icône de
// sa famille + ce qui a été cherché) qui sort de son icône dans la ceinture,
// vole vers l'orbe en arc, puis tourne autour d'elle tant que la réponse est
// à l'écran. Toucher une carte montre ce que l'outil a renvoyé : on voit d'où
// vient la réponse, sans lire une ligne de journal.

import * as THREE from "/lib/three.module.js";
import { toolFamily } from "/xr-belt.js";

const FAMILY = {
  files: { icon: "file-text", color: "#ffb84d", fr: "Fichiers", en: "Files" },
  notes: { icon: "notes", color: "#ffe066", fr: "Notes", en: "Notes" },
  calendar: { icon: "calendar", color: "#4da3ff", fr: "Agenda", en: "Calendar" },
  kanban: { icon: "kanban", color: "#b58cff", fr: "Kanban", en: "Kanban" },
  weather: { icon: "cloud-sun", color: "#5fe0ff", fr: "Météo", en: "Weather" },
  web: { icon: "globe", color: "#61f2a0", fr: "Web", en: "Web" },
  data: { icon: "database", color: "#ff8f5a", fr: "Données", en: "Data" },
  memory: { icon: "brain", color: "#ff7eb6", fr: "Mémoire", en: "Memory" },
  apps: { icon: "layout-grid", color: "#3fe0c5", fr: "Apps", en: "Apps" },
  people: { icon: "users", color: "#9fd4ff", fr: "Personnes", en: "People" },
  other: { icon: "sparkles", color: "#d0d4e4", fr: "Outil", en: "Tool" },
};
const MAX = 6;

export function createThoughts(ctx) {
  const { scene, roundRect, drawIcon, THEME, T, wrap } = ctx;
  const font = THEME.font;
  const group = new THREE.Group();
  scene.add(group);
  const cards = [];
  const pickables = [];
  let spin = 0;
  let fadeAfter = Infinity;

  /// Ce que l'outil a cherché, en quelques mots (premier argument utile).
  function subject(args) {
    let a = args;
    if (typeof a === "string") { try { a = JSON.parse(a); } catch { return a.slice(0, 40); } }
    if (!a || typeof a !== "object") return "";
    const v = a.place ?? a.query ?? a.q ?? a.text ?? a.app ?? a.path ?? a.name ?? Object.values(a).find((x) => typeof x === "string");
    return String(v || "").replace(/\s+/g, " ").slice(0, 42);
  }
  function makeCard(tool) {
    const fam = FAMILY[toolFamily(tool.name)] || FAMILY.other;
    const c = document.createElement("canvas");
    c.width = 360; c.height = 120;
    const g = c.getContext("2d");
    roundRect(g, 4, 4, 352, 112, 34);
    g.fillStyle = "rgba(18,20,28,0.9)"; g.fill();
    g.lineWidth = 4; g.strokeStyle = fam.color; g.stroke();
    g.beginPath(); g.arc(62, 60, 38, 0, Math.PI * 2); g.fillStyle = fam.color; g.fill();
    drawIcon(g, fam.icon, 38, 36, 48, "#14161d", 2.4);
    g.textAlign = "left"; g.textBaseline = "middle";
    g.font = `700 30px ${font}`; g.fillStyle = "#f4f5f8";
    g.fillText(T(fam.fr, fam.en), 116, 40);
    g.font = `400 25px ${font}`; g.fillStyle = "rgba(244,245,248,0.7)";
    g.fillText((wrap(g, subject(tool.args) || tool.name, 220)[0] || "").slice(0, 30), 116, 80);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.04), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    mesh.renderOrder = 7;
    return { mesh, fam, label: `${T(fam.fr, fam.en)}${subject(tool.args) ? ` · ${subject(tool.args)}` : ""}` };
  }

  return {
    /** Un outil vient d'être utilisé : sa carte part de `from` (monde) vers l'orbe. */
    spawn(tool, from) {
      const { mesh, label } = makeCard(tool);
      mesh.position.copy(from);
      mesh.scale.setScalar(0.2);
      group.add(mesh);
      const card = { mesh, tool, label, born: performance.now(), from: from.clone(), slot: cards.length, opacity: 1 };
      mesh.userData.thought = card;
      cards.push(card);
      pickables.push(mesh);
      while (cards.length > MAX) this.remove(cards[0]);
      cards.forEach((c, i) => { c.slot = i; });
      fadeAfter = Infinity;
      ctx.sfx?.("pop", from);
    },
    /** Résultat arrivé après coup (l'outil a fini) : la carte le garde. */
    update(tool) {
      const c = [...cards].reverse().find((x) => x.tool.name === tool.name && !x.tool.result);
      if (c && tool.result) c.tool = tool;
    },
    remove(card) {
      group.remove(card.mesh);
      card.mesh.material.map?.dispose(); card.mesh.material.dispose(); card.mesh.geometry.dispose();
      cards.splice(cards.indexOf(card), 1);
      pickables.splice(pickables.indexOf(card.mesh), 1);
    },
    /** Nouvelle question : les cartes de la réponse précédente s'en vont. */
    clear() { for (const c of [...cards]) this.remove(c); },
    /** Réponse terminée : les cartes restent un moment, puis s'effacent. */
    settle(ms = 30000) { fadeAfter = performance.now() + ms; },
    pickables: () => pickables,
    open(card) {
      const res = String(card.tool.result || "").trim();
      ctx.showDetail?.(`**${card.label}**\n\n${res ? res.slice(0, 3000) : T("_Résultat non transmis au casque._", "_Result not sent to the headset._")}`, card.label);
    },
    tick(now, dt, orbPos, radius, headPos) {
      spin += dt * 0.5;
      const n = cards.length;
      for (const c of [...cards]) {
        const a = spin + (c.slot / Math.max(1, n)) * Math.PI * 2;
        const ring = radius * 1.9 + 0.06;
        const target = orbPos.clone().add(new THREE.Vector3(Math.cos(a) * ring, radius * 0.55 + Math.sin(a * 2) * 0.015, Math.sin(a) * ring));
        const k = Math.min(1, (now - c.born) / 700);
        if (k < 1) {
          // Vol en arc depuis l'icône de la ceinture.
          const mid = c.from.clone().lerp(target, 0.5).add(new THREE.Vector3(0, 0.12, 0));
          const e = 1 - Math.pow(1 - k, 3);
          const p1 = c.from.clone().lerp(mid, e), p2 = mid.clone().lerp(target, e);
          c.mesh.position.copy(p1.lerp(p2, e));
          c.mesh.scale.setScalar(0.2 + 0.8 * e);
        } else {
          c.mesh.position.lerp(target, Math.min(1, dt * 6));
          c.mesh.scale.setScalar(1 + (c.hover || 0) * 0.15);
          c.hover = (c.hover || 0) * 0.8;
        }
        c.mesh.lookAt(headPos);
        if (now > fadeAfter) {
          c.opacity -= dt * 0.8;
          c.mesh.material.opacity = Math.max(0, c.opacity);
          if (c.opacity <= 0) this.remove(c);
        } else c.mesh.material.opacity = 1;
      }
    },
  };
}
