// Notes × documents vivants : blocs `:::live` tenus à jour par un agent,
// délégation par « @Agent demande » + Entrée, menu « / » des blocs façon
// Notion et fichiers de la suite (pastille ou aperçu). Branché par main.js.

import { tt } from "../apps-i18n.js";
import { attachSlashMenu, toggleTaskInSource } from "../lib/rich-blocks.js";
import { pickOfficeFile, hydrateFiles } from "../lib/lumen-files.js";
import {
  listAgents, matchAgentMention, delegateToAgent, attachAgentMenu,
  openLivingDialog, listLiving, livingCardHTML, wireLivingCards, onLivingUpdated, runLiving, ensureLivingStyles,
} from "../lib/living-docs.js";
import { agentAvatarHTML } from "../lib/agent-avatar.js";

let api = null;

/**
 * @param {object} o
 * @param {(id:string)=>HTMLElement} o.$
 * @param {()=>object|null} o.current  note courante
 * @param {()=>void} o.onEdit  à appeler après modification du champ
 * @param {()=>void} o.repaint  redessine l'aperçu
 * @param {(msg:string)=>void} o.toast
 */
export function mountNotesLiving(o) {
  api = o;
  ensureLivingStyles();
  const body = o.$("body");
  attachSlashMenu(body, { onAction: (action, at) => runAction(action, at) });
  attachAgentMenu(body);
  // « @Agent demande » puis Entrée : l'agent écrit la suite, à cet endroit.
  body.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    const pos = body.selectionStart ?? 0;
    const lineStart = body.value.lastIndexOf("\n", pos - 1) + 1;
    const lineEnd = body.value.indexOf("\n", pos) < 0 ? body.value.length : body.value.indexOf("\n", pos);
    const line = body.value.slice(lineStart, lineEnd);
    if (!line.trim().startsWith("@")) return;
    const hit = matchAgentMention(line, await listAgents());
    if (!hit) return;
    e.preventDefault();
    delegateLine(lineStart, lineEnd, hit);
  });
  o.$("btn-insert-file")?.addEventListener("click", () => runAction("file-embed", body.selectionStart ?? body.value.length));
  o.$("btn-live")?.addEventListener("click", () => runAction("live", body.selectionStart ?? body.value.length));
  // Mise à jour d'un bloc (planifiée ou manuelle) : la note elle-même est
  // relue par app-state ; ici on rafraîchit les en-têtes (statut, fraîcheur).
  onLivingUpdated(() => o.repaint());
  // Cases à cocher de l'aperçu : elles modifient le texte source.
  o.$("preview").addEventListener("change", (e) => {
    const box = e.target.closest?.(".nb-task");
    const n = o.current();
    if (!box || !n) return;
    body.value = toggleTaskInSource(body.value, Number(box.dataset.task));
    o.onEdit();
  });
}

function insertAt(pos, text) {
  const body = api.$("body");
  body.value = body.value.slice(0, pos) + text + body.value.slice(pos);
  const caret = pos + text.length;
  body.setSelectionRange(caret, caret);
  body.focus();
  api.onEdit();
}

async function runAction(action, at) {
  if (!api.current()) return;
  if (action === "file-chip" || action === "file-embed") {
    const pick = await pickOfficeFile();
    if (!pick) return;
    insertAt(at, pick.mode === "embed" ? `\n![[${pick.ref}]]\n` : `[[${pick.ref}]] `);
    api.repaint();
    return;
  }
  if (action === "live") {
    const n = api.current();
    const block = await openLivingDialog({ kind: "note", note_id: n.id }).catch((e) => { api.toast(String(e?.message || e)); return null; });
    if (!block?.id) return;
    insertAt(at, `\n:::live ${block.id}\n${tt("En attente de la première mise à jour…")}\n:::\n`);
    // La note doit être sur disque avant que le moteur n'écrive dedans.
    await api.flush?.();
    if (block.runNow) runLiving(block.id).catch((e) => api.toast(String(e?.message || e)));
  }
}

async function delegateLine(lineStart, lineEnd, { agent, request }) {
  const body = api.$("body");
  const n = api.current();
  const context = body.value.slice(0, lineStart) + "⟦ICI⟧" + body.value.slice(lineEnd);
  // Repère unique : l'utilisateur peut continuer d'écrire pendant que l'agent
  // travaille, on retrouve la ligne par ce marqueur et non par sa position.
  const mark = `:::working ${agent.name}\n${request.replace(/\n/g, " ")}\n:::`;
  body.value = body.value.slice(0, lineStart) + mark + body.value.slice(lineEnd);
  api.onEdit();
  // Rendu tout de suite : on voit l'agent (avatar + nom) travailler en place.
  api.showRendered?.();
  api.repaint();
  showWorking(agent, request);
  // Le marqueur n'est touché ici QUE s'il est dans la note affichée : Lumen
  // l'a déjà remplacé dans le fichier (living_delegate), y compris quand on a
  // changé de note ou que la vue a été rechargée pendant le travail.
  const sameNote = () => api.current()?.id === n?.id && body.value.includes(mark);
  try {
    const out = await delegateToAgent({ agent, request, title: n?.title || "", context, noteId: n?.id, mark });
    if (sameNote()) body.value = body.value.replace(mark, `:::agent ${agent.name}\n${out.trim()}\n:::`);
  } catch (e) {
    if (sameNote()) body.value = body.value.replace(mark, `@${agent.name} ${request}`);
    api.toast(`${agent.name} : ${String(e?.message || e)}`);
  } finally {
    hideWorking();
    api.onEdit();
    api.repaint();
  }
}

// Bandeau « l'agent écrit… » au-dessus de l'éditeur.
function showWorking(agent, request) {
  hideWorking();
  const bar = document.createElement("div");
  bar.className = "lv-working";
  bar.id = "lv-working";
  bar.innerHTML = `${agentAvatarHTML(agent, { size: 30, hands: false, state: "work" })}<span><b></b> — <i></i></span>`;
  bar.querySelector("b").textContent = tt("{name} écrit la suite…", { name: agent.name });
  bar.querySelector("i").textContent = request;
  // Au-dessus des volets (et non dedans) : en « côte à côte » le bandeau
  // prenait la place de l'éditeur dans la grille.
  const panes = api.$("panes");
  panes.parentElement.insertBefore(bar, panes);
}
function hideWorking() { document.getElementById("lv-working")?.remove(); }

/** Après rendu de l'aperçu : en-têtes des blocs vivants + fichiers intégrés. */
export async function decoratePreview(root) {
  if (!root) return;
  hydrateFiles(root);
  const slots = [...root.querySelectorAll(".nb-live-slot")];
  if (!slots.length) return;
  const [blocks, agents] = await Promise.all([listLiving(), listAgents()]);
  for (const slot of slots) {
    const block = blocks.find((b) => b.id === slot.dataset.liveId);
    slot.outerHTML = livingCardHTML(block, agents);
  }
  wireLivingCards(root, {
    onEdit: async (block) => {
      const saved = await openLivingDialog({ kind: "note", note_id: block.note_id }, block).catch(() => null);
      if (saved?.deleted) {
        // Bloc supprimé : son contenu reste, figé, dans la note.
        const body = api.$("body");
        body.value = body.value.replace(new RegExp(`^:::live ${saved.deleted}\\s*$`, "m"), ":::note");
        api.onEdit();
      } else if (saved?.runNow) {
        runLiving(saved.id).catch((e) => api.toast(String(e?.message || e)));
      }
      api.repaint();
    },
    onDone: (_, ok, err) => { if (!ok) api.toast(String(err?.message || err)); },
  });
}
