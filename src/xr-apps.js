// Lumen XR — les apps de Lumen en panneaux spatiaux.
//
// Pas l'app entière dans le casque : chaque app renvoie une VUE SIMPLIFIÉE
// (données + actions) que le casque dessine à sa façon. Cinq surfaces :
//
//   • Apps          — le lanceur (tuiles) ;
//   • Agents        — approbations à décider, étapes en direct, runs récents
//                     (routes REST du compagnon + `agent-step` du WebSocket) ;
//   • Documents     — Corpus et fichiers des sandboxes (`xr-docs-list`,
//                     `xr-doc-read`), lecture paginée, « Envoyer à Lumen » ;
//   • Données       — bases et tables (`xr-data-list`, `xr-data-read`) en
//                     graphique à barres ou en tableau ;
//   • Notifications — le centre de notifications, et la capsule Halo qui
//                     flotte au-dessus de l'orbe (`halo-notify`).

import { markdownLines, drawMarkdownLine } from "/xr-panels.js";
import * as THREE from "/lib/three.module.js";
import { humanStep } from "/lib/agent-steps.js";
import { avatarLayers, avatarColor } from "/lib/agent-avatar.js";

export function createApps(ctx) {
  const { Panel, THEME, wrap, plain, roundRect, drawIcon, addPanel, send, api, T, openNear, onPanelsChanged, toast, lang } = ctx;
  // Tuiles venues des autres modules (Espace, Apps Lumen, Écran, Clavier).
  const extraTiles = () => ctx.extraTiles?.() || [];
  const font = THEME.font;
  const esc = (s) => String(s ?? "");

  // ---- Avatars d'agents (personnages Kenney, comme sur le bureau) ----------
  // Les calques viennent de lib/agent-avatar.js ; les images sont mises en
  // cache, et le panneau se redessine quand elles finissent de charger.
  const avatarImgs = new Map();
  const avatarWaiters = new Set();
  function avatarImg(src) {
    let img = avatarImgs.get(src);
    if (!img) {
      img = new Image();
      img.onload = () => { for (const p of avatarWaiters) p.invalidate(); };
      img.src = src;
      avatarImgs.set(src, img);
    }
    return img.complete && img.naturalWidth ? img : null;
  }
  /// Dessine l'avatar d'un agent dans un carré (x, y, size). `state` :
  /// idle | work | done | fail (visage et mains changent comme sur le bureau).
  function drawAvatar(c, panel, agent, x, y, size, state = "idle") {
    avatarWaiters.add(panel);
    // Halo de la couleur de l'agent, pour le repérer d'un coup d'œil.
    c.beginPath();
    c.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    c.fillStyle = `${avatarColor(agent || {})}33`;
    c.fill();
    for (const l of avatarLayers(agent || {}, { state, hands: size >= 44 })) {
      const img = avatarImg(l.src);
      if (!img) continue;
      const w = l.w * size, h = (l.h ?? (l.w * img.naturalHeight / img.naturalWidth)) * size;
      c.save();
      c.translate(x + l.x * size + w / 2, y + l.y * size + h / 2);
      if (l.rot) c.rotate((l.rot * Math.PI) / 180);
      if (l.flip) c.scale(-1, 1);
      c.drawImage(img, -w / 2, -h / 2, w, h);
      c.restore();
    }
  }
  const agentById = (id) => ag.team.find((a) => a.id === id || a.name === id) || { id };

  // ---- Petits outils de dessin partagés -----------------------------------
  function sectionLabel(c, text, x, y) {
    c.font = `600 24px ${font}`;
    c.fillStyle = THEME.dim;
    c.textAlign = "left";
    c.textBaseline = "middle";
    c.fillText(text.toUpperCase(), x, y);
  }
  function fitText(c, text, maxW) {
    let t = esc(text);
    if (c.measureText(t).width <= maxW) return t;
    while (t.length > 2 && c.measureText(t + "…").width > maxW) t = t.slice(0, -1);
    return t + "…";
  }
  /// Ligne cliquable : fond, icône, titre, sous-titre.
  function row(p, id, x, y, w, h, { icon, avatar, avatarState = "idle", title, sub, onClick, active = false, iconColor = "#f4f5f8" }) {
    const c = p.ctx;
    const hover = p.hoverId === id;
    roundRect(c, x, y, w, h, 22);
    c.fillStyle = active ? "rgba(153,97,255,0.35)" : hover ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.06)";
    c.fill();
    let tx = x + 24;
    if (avatar) { drawAvatar(c, p, avatar, x + 10, y + (h - Math.min(56, h - 12)) / 2, Math.min(56, h - 12), avatarState); tx = x + 76; }
    else if (icon) { drawIcon(c, icon, x + 20, y + h / 2 - 18, 36, iconColor, 2); tx = x + 72; }
    c.textAlign = "left";
    c.textBaseline = "middle";
    c.fillStyle = THEME.text;
    c.font = `500 28px ${font}`;
    c.fillText(fitText(c, title, w - (tx - x) - 20), tx, sub ? y + h / 2 - 15 : y + h / 2);
    if (sub) {
      c.font = `400 22px ${font}`;
      c.fillStyle = THEME.dim;
      c.fillText(fitText(c, sub, w - (tx - x) - 20), tx, y + h / 2 + 18);
    }
    if (onClick) p.zones.push({ id, x, y, w, h, onClick, _content: true });
  }
  /// Pied de page : précédent / suivant + libellé de page.
  function pager(p, y, page, pages, onPrev, onNext) {
    if (pages <= 1) return;
    p.iconButton("pg-prev", 30, y, 68, "", onPrev, { inContent: true, icon: "chevron-up" });
    p.iconButton("pg-next", 112, y, 68, "", onNext, { inContent: true, icon: "chevron-down" });
    const c = p.ctx;
    c.font = `400 24px ${font}`;
    c.fillStyle = THEME.dim;
    c.textAlign = "right";
    c.textBaseline = "middle";
    c.fillText(`${page + 1} / ${pages}`, p.W - 30, y + 34);
  }
  function timeAgo(ts) {
    const s = Math.max(0, (Date.now() - Number(ts || 0)) / 1000);
    if (s < 60) return T("à l'instant", "just now");
    if (s < 3600) return T(`il y a ${Math.round(s / 60)} min`, `${Math.round(s / 60)} min ago`);
    if (s < 86400) return T(`il y a ${Math.round(s / 3600)} h`, `${Math.round(s / 3600)} h ago`);
    return new Date(Number(ts)).toLocaleDateString(lang);
  }

  const panels = {};
  const closeCb = () => onPanelsChanged();
  function toggle(p, refresh) {
    if (p.visible) { p.close(); return; }
    openNear(p);
    refresh?.();
    onPanelsChanged();
  }

  // ======================================================================
  // Agents
  // ======================================================================
  const ag = { data: { approvals: [], runs: [], tasks: [] }, team: [], steps: [], done: new Map(), error: "", busy: new Set(), timer: null };
  async function refreshAgents() {
    try { ag.data = (await api("/agents/activity")) || ag.data; ag.error = ""; }
    catch { ag.error = T("Activité indisponible", "Activity unavailable"); }
    try { ag.team = (await api("/agents/list"))?.items || ag.team; } catch { /* l'équipe reste celle d'avant */ }
    panels.agents.invalidate();
    launcher.invalidate();
    onPanelsChanged(); // pastille du dock (approbations en attente)
  }
  async function decide(a, approve) {
    ag.busy.add(a.approval_id);
    panels.agents.invalidate();
    try {
      const out = await api("/agents/approve", { method: "POST", body: JSON.stringify({ approval_id: a.approval_id, approve }) });
      toast(out?.ok ? (approve ? T("Approuvé", "Approved") : T("Refusé", "Rejected")) : T("Demande déjà traitée", "Already handled"));
    } catch { toast(T("Décision impossible", "Decision failed")); }
    ag.busy.delete(a.approval_id);
    refreshAgents();
  }
  /// Confie une tâche à un agent : elle rejoint sa liste et il se lance tout de
  /// suite (ses étapes arrivent ensuite en direct, sa réponse dans Halo).
  async function giveTask(agent, text) {
    const t = String(text || "").trim();
    if (!t) { toast(T("Rien entendu", "Nothing heard")); return; }
    try {
      await api("/agents/task", { method: "POST", body: JSON.stringify({ id: agent.id, text: t }) });
      toast(T(`Confié à ${agent.name}`, `Given to ${agent.name}`));
    } catch { toast(T("Impossible de confier la tâche", "Could not give the task")); }
    refreshAgents();
  }
  function askAgent(agent) {
    if (!ctx.dictate) { toast(T("Dictée indisponible", "Dictation unavailable")); return; }
    ctx.dictate(T(`Que doit faire ${agent.name} ?`, `What should ${agent.name} do?`), (text) => giveTask(agent, text));
  }
  /// « Demande à Veilleur de surveiller le prix… », « Veilleur, fais… »,
  /// « ask Veilleur to … » : la phrase part à l'agent nommé. Vrai si traitée.
  function delegateUtterance(text) {
    const t = String(text || "").trim();
    if (!ag.team.length || !t) return false;
    const norm = (x) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const nt = norm(t);
    for (const a of [...ag.team].sort((x, y) => (y.name || "").length - (x.name || "").length)) {
      const n = norm(a.name || "");
      if (n.length < 3) continue;
      // Formes acceptées (accents ignorés) : « Majordome, … », « Majordome
      // peux-tu … », « Lumen, demande au Majordome de … », « dis à l'agent
      // Majordome que … », « ask the Butler to … ». Avant, « au », « le » ou
      // un « Lumen, » devant le nom faisaient partir la phrase à Lumen.
      const name = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const m = nt.match(new RegExp(
        `^(?:lumen[\\s,.!]*)?(?:(?:demande|dis|confie|transmets|ask|tell)\\s+(?:a|au|aux|a l'|to)?\\s*)?(?:(?:le|la|l'|the)\\s*)?(?:agent\\s+)?${name}\\b[\\s,:.!]*(?:de |d'|qu'?il |que |to |peux-tu |pourrais-tu |tu peux |can you |please )?\\s*(.{3,})$`));
      if (m) { giveTask(a, t.slice(t.length - m[1].length)); return true; }
    }
    return false;
  }
  /// État d'un agent pour son avatar : au travail si une étape est récente.
  function agentState(a) {
    const last = [...ag.steps].reverse().find((s) => s.agent === a.name || s.agent === a.id);
    if (last && Date.now() - last.ts < 20000) return "work";
    const done = ag.done.get(a.id);
    if (done && Date.now() - done.ts < 60000) return done.success ? "done" : "fail";
    return "idle";
  }
  const statusLabel = (s) => ({
    running: T("en cours", "running"), succeeded: T("terminé", "done"), blocked: T("bloqué", "blocked"),
    cancelled: T("annulé", "cancelled"), waiting_approval: T("en attente", "waiting"), queued: T("en file", "queued"),
    interrupted: T("interrompu", "interrupted"), retry_scheduled: T("nouvel essai", "retry"),
  })[s] || s;

  panels.agents = addPanel(new Panel({
    width: 0.6, height: 0.86, title: T("Agents", "Agents"), closable: true, onClose: () => { clearInterval(ag.timer); closeCb(); },
    headerButtons: () => [{ id: "ag-refresh", icon: "refresh-cw", onClick: refreshAgents }],
    draw(c, p) {
      const W = p.W, H = p.H - p.handleH, x = 30, w = W - 60;
      let y = 20;
      const { approvals = [], tasks = [], runs = [] } = ag.data;
      if (ag.error) { sectionLabel(c, ag.error, x, y + 10); y += 40; }
      // Équipe : toucher un agent = lui dicter une tâche.
      if (ag.team.length) {
        sectionLabel(c, T("Équipe — touchez pour confier une tâche", "Team — tap to give a task"), x, y + 10); y += 34;
        const cw = (w - 12) / 2, ch = 96;
        ag.team.slice(0, 6).forEach((a, k) => {
          const cx = x + (k % 2) * (cw + 12), cy = y + Math.floor(k / 2) * (ch + 10);
          const id = "team:" + a.id, st = agentState(a);
          roundRect(c, cx, cy, cw, ch, 24);
          c.fillStyle = p.hoverId === id ? "rgba(255,255,255,0.16)" : st === "work" ? `${avatarColor(a)}40` : "rgba(255,255,255,0.06)";
          c.fill();
          drawAvatar(c, p, a, cx + 10, cy + 8, ch - 16, st);
          c.textAlign = "left"; c.textBaseline = "middle";
          c.fillStyle = THEME.text; c.font = `600 27px ${font}`;
          c.fillText(fitText(c, a.name || a.id, cw - ch - 16), cx + ch + 4, cy + ch / 2 - 14);
          c.fillStyle = THEME.dim; c.font = `400 21px ${font}`;
          c.fillText(fitText(c, st === "work" ? T("au travail…", "working…") : st === "done" ? T("a terminé", "done") : st === "fail" ? T("en échec", "failed") : T("disponible", "available"), cw - ch - 16), cx + ch + 4, cy + ch / 2 + 18);
          p.zones.push({ id, x: cx, y: cy, w: cw, h: ch, onClick: () => askAgent(a), _content: true });
        });
        y += Math.ceil(Math.min(6, ag.team.length) / 2) * (ch + 10) + 10;
      }
      if (approvals.length) {
        sectionLabel(c, T("À décider", "Needs your decision"), x, y + 10); y += 34;
        for (const a of approvals.slice(0, 3)) {
          roundRect(c, x, y, w, 150, 24);
          c.fillStyle = "rgba(255,158,107,0.16)"; c.fill();
          c.strokeStyle = "rgba(255,158,107,0.55)"; c.lineWidth = 2; c.stroke();
          const who = agentById(a.agent_id);
          drawAvatar(c, p, who, x + 14, y + 10, 70, "work");
          c.fillStyle = THEME.text; c.font = `600 28px ${font}`; c.textAlign = "left"; c.textBaseline = "middle";
          c.fillText(fitText(c, `${who.name || a.agent_id} → ${a.tool}`, w - 120), x + 96, y + 32);
          c.font = `400 22px ${font}`; c.fillStyle = THEME.dim;
          c.fillText(fitText(c, a.reason || T(`Risque : ${a.risk}`, `Risk: ${a.risk}`), w - 120), x + 96, y + 66);
          const busy = ag.busy.has(a.approval_id);
          p.pill("rej:" + a.approval_id, x + 22, y + 90, (w - 66) / 2, 48, T("Refuser", "Reject"), busy ? null : () => decide(a, false));
          p.pill("ok:" + a.approval_id, x + 44 + (w - 66) / 2, y + 90, (w - 66) / 2, 48, busy ? "…" : T("Approuver", "Approve"), busy ? null : () => decide(a, true), { active: true, color: "#2f9e6e" });
          y += 166;
        }
      }
      if (ag.steps.length) {
        sectionLabel(c, T("En direct", "Live"), x, y + 10); y += 30;
        for (const s of ag.steps.slice(-4).reverse()) {
          const hs = humanStep(s.step, lang);
          drawAvatar(c, p, agentById(s.agent), x, y, 36, hs.tone === "fail" ? "fail" : "work");
          c.font = `400 24px ${font}`; c.fillStyle = hs.tone === "fail" ? "#ff8095" : THEME.text; c.textAlign = "left";
          c.fillText(fitText(c, `${s.agent || "Agent"} · ${hs.text}`, w - 56), x + 46, y + 18);
          y += 38;
        }
        y += 10;
      }
      const list = [...tasks.map((t) => ({ k: "t", ...t })), ...runs.slice(0, 6).map((r) => ({ k: "r", ...r }))];
      if (list.length) {
        sectionLabel(c, T("Activité", "Activity"), x, y + 10); y += 30;
        for (const [k, it] of list.entries()) {
          if (y + 80 > H - 10) break;
          const who = agentById(it.agent_id);
          row(p, "ag:" + k, x, y, w, 72, {
            avatar: who,
            avatarState: it.status === "succeeded" ? "done" : it.status === "blocked" || it.error ? "fail" : it.status === "running" ? "work" : "idle",
            title: `${who.name || it.agent_id} · ${statusLabel(it.status)}`, sub: it.text || it.error || "",
          });
          y += 80;
        }
      }
      if (!approvals.length && !list.length && !ag.steps.length && !ag.team.length) {
        c.font = `400 28px ${font}`; c.fillStyle = THEME.dim; c.textAlign = "center";
        c.fillText(T("Aucune activité pour l'instant.", "No activity yet."), W / 2, H / 2);
      }
    },
  }), new THREE.Vector3(0.75, 0.05, -1.0), -0.6, false);
  panels.agents.object.visible = false;

  // ---- Réponse d'un agent : près de l'orbe, lue avec la voix de l'agent ----
  const reply = { agent: null, task: "", report: "", success: true, scroll: 0 };
  panels.agentReply = addPanel(new Panel({
    width: 0.62, height: 0.7, title: T("Réponse d'agent", "Agent reply"), closable: true, onClose: () => { ctx.stopSpeaking?.(); closeCb(); },
    draw(c, p) {
      const W = p.W, H = p.H - p.handleH, x = 30, w = W - 60;
      if (!reply.agent) return;
      drawAvatar(c, p, reply.agent, x, 16, 120, reply.success ? "done" : "fail");
      c.textAlign = "left"; c.textBaseline = "middle";
      c.fillStyle = THEME.text; c.font = `700 34px ${font}`;
      c.fillText(fitText(c, reply.agent.name || reply.agent.id, w - 150), x + 140, 52);
      c.fillStyle = THEME.dim; c.font = `400 23px ${font}`;
      c.fillText(fitText(c, reply.task, w - 150), x + 140, 92);
      c.font = `400 27px ${font}`; c.fillStyle = THEME.text;
      const lines = markdownLines(c, reply.report, w);
      const top = 156, lh = 36, room = Math.max(1, Math.floor((H - top - 100) / lh));
      p.onScroll = (delta) => { reply.scroll = Math.max(0, Math.min(lines.length - room, reply.scroll + delta)); p.invalidate(); };
      reply.scroll = Math.max(0, Math.min(reply.scroll, lines.length - room));
      lines.slice(reply.scroll, reply.scroll + room).forEach((l, k) => drawMarkdownLine(c, l, x, top + k * lh));
      const by = H - 82, bw = (w - 24) / 3;
      p.pill("rep:say", x, by, bw, 64, T("Relire", "Replay"), () => speakReply());
      p.pill("rep:more", x + bw + 12, by, bw, 64, lines.length > room ? T("Suite", "More") : T("Début", "Top"), () => { reply.scroll = lines.length > room && reply.scroll + room < lines.length ? reply.scroll + room : 0; p.invalidate(); });
      p.pill("rep:ask", x + 2 * (bw + 12), by, bw, 64, T("Répondre", "Reply"), () => askAgent(reply.agent), { active: true });
    },
  }), new THREE.Vector3(-0.55, 0.15, -0.9), 0.45, false);
  panels.agentReply.object.visible = false;
  function speakReply() {
    if (!reply.agent) return;
    // `agentId` : si l'agent a sa figurine dans la pièce, il parle depuis elle.
    ctx.speak?.(`${reply.agent.name || ""}. ${plain(reply.report)}`, { voice: reply.agent.voice || "", agentId: reply.agent.id });
  }
  /// Fin de tâche d'un agent : panneau près de l'orbe + lecture à sa voix.
  function onAgentDone(msg) {
    const known = agentById(msg.agent_id);
    reply.agent = { ...known, id: msg.agent_id, name: msg.agent || known.name, avatar: msg.avatar || known.avatar, voice: msg.voice || known.voice || "" };
    reply.task = msg.task || "";
    reply.report = msg.report || "";
    reply.success = msg.success !== false;
    reply.scroll = 0;
    ag.done.set(msg.agent_id, { success: reply.success, ts: Date.now() });
    if (ctx.placeNearOrb) ctx.placeNearOrb(panels.agentReply);
    else if (!panels.agentReply.visible) openNear(panels.agentReply);
    panels.agentReply.invalidate();
    onPanelsChanged();
    speakReply();
    refreshAgents();
  }

  /// « Approuve » / « refuse » à la voix : tranche la plus ancienne demande en
  /// attente (le panneau Agents montre laquelle). Vrai si traitée.
  const APPROVE_RE = /^\s*(?:lumen[, ]*)?(?:j'?)?(approuve|autorise|valide|accepte|approve|allow|accept)\b/i;
  const REJECT_RE = /^\s*(?:lumen[, ]*)?(?:je\s+)?(refuse|rejette|bloque|interdis|reject|deny|block)\b/i;
  function approvalUtterance(text) {
    const pending = ag.data.approvals || [];
    if (!pending.length) return false;
    const yes = APPROVE_RE.test(text), no = REJECT_RE.test(text);
    if (!yes && !no) return false;
    decide(pending[0], yes);
    return true;
  }

  // ======================================================================
  // Documents
  // ======================================================================
  const dc = { items: [], page: 0, open: null, lines: null, docPage: 0, loading: false, reqId: 0 };
  panels.docs = addPanel(new Panel({
    width: 0.7, height: 0.9, title: T("Documents", "Documents"), closable: true, onClose: closeCb,
    headerButtons: () => dc.open
      ? [{ id: "dc-back", icon: "chevron-left", onClick: () => { dc.open = null; dc.lines = null; panels.docs.title = T("Documents", "Documents"); panels.docs.invalidate(); } },
         { id: "dc-send", icon: "send", onClick: () => { send({ type: "attach-doc-ref", item: dc.open.item }); toast(T("Document joint à la conversation", "Document attached to the chat")); } }]
      : [{ id: "dc-refresh", icon: "refresh-cw", onClick: () => { dc.loading = true; send({ type: "xr-docs-list" }); panels.docs.invalidate(); } }],
    draw(c, p) {
      const W = p.W, H = p.H - p.handleH, x = 30, w = W - 60, footer = 90;
      if (dc.open) {
        // Lecture paginée.
        c.font = `400 29px ${font}`;
        if (!dc.lines) dc.lines = dc.open.text ? wrap(c, plain(dc.open.text), w) : [];
        const lineH = 40, per = Math.floor((H - 30 - footer) / lineH);
        const pages = Math.max(1, Math.ceil(dc.lines.length / per));
        dc.docPage = Math.min(dc.docPage, pages - 1);
        c.fillStyle = THEME.text; c.textAlign = "left"; c.textBaseline = "top";
        if (dc.open.loading) { c.fillStyle = THEME.dim; c.fillText(T("Chargement…", "Loading…"), x, 30); }
        else if (!dc.lines.length) { c.fillStyle = THEME.dim; c.fillText(dc.open.error ? T("Lecture impossible", "Cannot read") : T("Document vide", "Empty document"), x, 30); }
        dc.lines.slice(dc.docPage * per, dc.docPage * per + per).forEach((l, k) => c.fillText(l, x, 24 + k * lineH));
        pager(p, H - footer + 10, dc.docPage, pages,
          () => { dc.docPage = Math.max(0, dc.docPage - 1); panels.docs.invalidate(); },
          () => { dc.docPage = Math.min(pages - 1, dc.docPage + 1); panels.docs.invalidate(); });
        return;
      }
      const rowH = 84, per = Math.floor((H - 20 - footer) / rowH);
      const pages = Math.max(1, Math.ceil(dc.items.length / per));
      dc.page = Math.min(dc.page, pages - 1);
      if (!dc.items.length) {
        c.font = `400 28px ${font}`; c.fillStyle = THEME.dim; c.textAlign = "center";
        c.fillText(dc.loading ? T("Chargement…", "Loading…") : T("Aucun document", "No document"), W / 2, H / 2);
      }
      dc.items.slice(dc.page * per, dc.page * per + per).forEach((it, k) => {
        row(p, "doc:" + it.id, x, 16 + k * rowH, w, rowH - 10, {
          icon: it.docId ? "book-open-text" : "file-text", title: it.label, sub: it.sub,
          onClick: () => {
            const id = ++dc.reqId;
            dc.open = { item: it, id, loading: true, text: "" };
            dc.lines = null; dc.docPage = 0;
            panels.docs.title = it.label;
            send({ type: "xr-doc-read", id, item: it });
            panels.docs.invalidate();
          },
        });
      });
      pager(p, H - footer + 10, dc.page, pages,
        () => { dc.page = Math.max(0, dc.page - 1); panels.docs.invalidate(); },
        () => { dc.page = Math.min(pages - 1, dc.page + 1); panels.docs.invalidate(); });
    },
  }), new THREE.Vector3(-0.78, 0.05, -1.0), 0.6, false);
  panels.docs.object.visible = false;

  // ======================================================================
  // Données (Tables / Prisme)
  // ======================================================================
  const dt = { bases: [], loading: false, open: null, view: "chart", page: 0, reqId: 0 };
  const NUMERIC = /^(number|integer|int|float|decimal|currency|percent|rating|real)$/i;
  function numericColumn(t) {
    const byType = t.columns.find((col) => NUMERIC.test(col.type || ""));
    if (byType) return byType;
    return t.columns.find((col) => t.rows.length && t.rows.slice(0, 20).every((r) => r[col.id] == null || r[col.id] === "" || Number.isFinite(Number(r[col.id]))));
  }
  panels.data = addPanel(new Panel({
    width: 0.72, height: 0.8, title: T("Données", "Data"), closable: true, onClose: closeCb,
    headerButtons: () => dt.open
      ? [{ id: "dt-back", icon: "chevron-left", onClick: () => { dt.open = null; panels.data.title = T("Données", "Data"); panels.data.invalidate(); } },
         { id: "dt-chart", icon: "chart-column", active: dt.view === "chart", onClick: () => { dt.view = "chart"; panels.data.invalidate(); } },
         { id: "dt-table", icon: "table", active: dt.view === "table", onClick: () => { dt.view = "table"; dt.page = 0; panels.data.invalidate(); } },
         // Graphique 3D posé sur la table réelle.
         ...(dt.open.rows?.length && numericColumn(dt.open) ? [{ id: "dt-3d", icon: "box", onClick: () => {
           const t = dt.open, vc = numericColumn(t), lc = t.columns.find((col) => col !== vc) || t.columns[0];
           ctx.openChart3D?.({ title: t.name, valueName: vc.name, labels: t.rows.map((r) => r[lc?.id] ?? ""), values: t.rows.map((r) => Number(r[vc.id]) || 0) });
         } }] : [])]
      : [{ id: "dt-refresh", icon: "refresh-cw", onClick: () => { dt.loading = true; send({ type: "xr-data-list" }); panels.data.invalidate(); } }],
    draw(c, p) {
      const W = p.W, H = p.H - p.handleH, x = 30, w = W - 60, footer = 90;
      const t = dt.open;
      if (!t) {
        const flat = dt.bases.flatMap((b) => b.tables.map((tb) => ({ ...tb, base: b.name })));
        if (!flat.length) {
          c.font = `400 28px ${font}`; c.fillStyle = THEME.dim; c.textAlign = "center";
          c.fillText(dt.loading ? T("Chargement…", "Loading…") : T("Aucune table", "No table"), W / 2, H / 2);
        }
        flat.slice(0, Math.floor((H - 20) / 84)).forEach((tb, k) => row(p, "tb:" + tb.id, x, 16 + k * 84, w, 74, {
          icon: "database", title: tb.name, sub: `${tb.base} · ${tb.rows ?? 0} ${T("lignes", "rows")}`,
          onClick: () => {
            dt.open = { id: tb.id, name: tb.name, loading: true, columns: [], rows: [] };
            dt.page = 0;
            panels.data.title = tb.name;
            send({ type: "xr-data-read", id: ++dt.reqId, tableId: tb.id, name: tb.name });
            panels.data.invalidate();
          },
        }));
        return;
      }
      if (t.loading || t.error) {
        c.font = `400 28px ${font}`; c.fillStyle = THEME.dim; c.textAlign = "center";
        c.fillText(t.error ? T("Lecture impossible", "Cannot read") : T("Chargement…", "Loading…"), W / 2, H / 2);
        return;
      }
      const valueCol = numericColumn(t);
      const labelCol = t.columns.find((col) => col !== valueCol) || t.columns[0];
      if (dt.view === "chart" && valueCol) {
        // Barres horizontales : les 12 premières lignes, valeur à droite.
        const data = t.rows.slice(0, 12).map((r) => ({ label: String(r[labelCol?.id] ?? ""), v: Number(r[valueCol.id]) || 0 }));
        const max = Math.max(1e-9, ...data.map((d) => Math.abs(d.v)));
        sectionLabel(c, `${valueCol.name}${labelCol ? " · " + labelCol.name : ""}`, x, 26);
        const top = 56, barH = Math.min(46, (H - top - 20) / Math.max(1, data.length) - 8), labelW = w * 0.32;
        data.forEach((d, k) => {
          const y = top + k * (barH + 8);
          c.font = `400 22px ${font}`; c.fillStyle = THEME.dim; c.textAlign = "right"; c.textBaseline = "middle";
          c.fillText(fitText(c, d.label, labelW - 12), x + labelW - 12, y + barH / 2);
          const bw = (w - labelW - 110) * Math.abs(d.v) / max;
          roundRect(c, x + labelW, y, Math.max(6, bw), barH, 8);
          const g = c.createLinearGradient(x + labelW, 0, x + labelW + bw, 0);
          g.addColorStop(0, "#47a3ff"); g.addColorStop(1, "#9961ff");
          c.fillStyle = g; c.fill();
          c.fillStyle = THEME.text; c.textAlign = "left";
          c.fillText(d.v.toLocaleString(lang), x + labelW + Math.max(6, bw) + 10, y + barH / 2);
        });
        return;
      }
      // Tableau : 4 colonnes au plus, paginé.
      const cols = t.columns.slice(0, 4);
      const colW = w / Math.max(1, cols.length), rowH = 50;
      const per = Math.floor((H - 70 - footer) / rowH);
      const pages = Math.max(1, Math.ceil(t.rows.length / per));
      dt.page = Math.min(dt.page, pages - 1);
      c.textBaseline = "middle"; c.textAlign = "left";
      cols.forEach((col, i) => { c.font = `600 24px ${font}`; c.fillStyle = THEME.dim; c.fillText(fitText(c, col.name, colW - 14), x + i * colW, 30); });
      t.rows.slice(dt.page * per, dt.page * per + per).forEach((r, k) => {
        const y = 60 + k * rowH;
        if (k % 2 === 0) { c.fillStyle = "rgba(255,255,255,0.05)"; c.fillRect(x - 10, y, w + 20, rowH); }
        cols.forEach((col, i) => { c.font = `400 24px ${font}`; c.fillStyle = THEME.text; c.fillText(fitText(c, r[col.id] ?? "", colW - 14), x + i * colW, y + rowH / 2); });
      });
      pager(p, H - footer + 10, dt.page, pages,
        () => { dt.page = Math.max(0, dt.page - 1); panels.data.invalidate(); },
        () => { dt.page = Math.min(pages - 1, dt.page + 1); panels.data.invalidate(); });
    },
  }), new THREE.Vector3(0, 0.45, -1.2), 0, false);
  panels.data.object.visible = false;

  // ======================================================================
  // Notifications + capsule Halo
  // ======================================================================
  // Capsule, par priorité : demande en attente (reste affichée), notification,
  // activité du chat (étape de la réponse), étape d'agent.
  const nt = { desk: [], halo: [], current: null, currentUntil: 0, step: null, stepUntil: 0, activity: "", activityUntil: 0, waiting: null };
  const KIND_ICON = { success: "circle-check", error: "circle-x", warning: "bell", info: "bell" };
  panels.notifs = addPanel(new Panel({
    width: 0.56, height: 0.8, title: T("Notifications", "Notifications"), closable: true, onClose: closeCb,
    headerButtons: () => [{ id: "nt-clear", icon: "trash-2", onClick: () => { send({ type: "clear-notifications" }); nt.halo = []; panels.notifs.invalidate(); } }],
    draw(c, p) {
      const W = p.W, H = p.H - p.handleH, x = 30, w = W - 60;
      const items = [
        ...nt.halo.map((n) => ({ icon: n.icon || KIND_ICON[n.kind] || "bell", title: n.title, sub: n.body, ts: n.ts })),
        ...nt.desk.map((n) => ({ icon: n.success === false ? "circle-x" : "circle-check", title: n.shortcut, sub: plain(n.output || ""), ts: n.timestamp })),
      ].sort((a, b) => (b.ts || 0) - (a.ts || 0));
      if (!items.length) {
        c.font = `400 28px ${font}`; c.fillStyle = THEME.dim; c.textAlign = "center";
        c.fillText(T("Aucune notification", "No notifications"), W / 2, H / 2);
      }
      items.slice(0, Math.floor((H - 20) / 88)).forEach((n, k) => row(p, "nt:" + k, x, 16 + k * 88, w, 78, {
        icon: n.icon, title: n.title || "Lumen", sub: `${timeAgo(n.ts)}${n.sub ? " · " + n.sub : ""}`,
      }));
    },
  }), new THREE.Vector3(0.78, 0.05, -1.0), -0.6, false);
  panels.notifs.object.visible = false;

  // Capsule : sans poignée, placée par xr.js au-dessus de l'orbe.
  const halo = new Panel({
    width: 0.5, height: 0.09, bare: true,
    draw(c, p) {
      const now = Date.now();
      const w = nt.waiting;
      const n = !w && now < nt.currentUntil ? nt.current : null;
      const a = !w && !n && now < nt.activityUntil ? nt.activity : "";
      const s = !w && !n && !a && now < nt.stepUntil ? nt.step : null;
      if (!w && !n && !a && !s) return;
      const W = p.W, H = p.H;
      const title = w ? T("En attente", "Waiting") : n ? (n.title || "Lumen") : a ? "Lumen" : (s.agent || "Agent");
      const sub = w ? w : n ? (n.body || "") : a ? a : humanStep(s.step, lang).text;
      c.font = `600 28px ${font}`;
      const tw = c.measureText(title).width;
      c.font = `400 24px ${font}`;
      const sw = Math.min(W - 200, c.measureText(sub).width);
      const cw = Math.min(W - 8, 90 + tw + (sub ? sw + 24 : 0) + 30);
      // Même verre léger que les panneaux (la pièce reste visible à travers) ;
      // liseré ambré tant que Lumen attend une réponse.
      roundRect(c, (W - cw) / 2, 4, cw, H - 8, (H - 8) / 2);
      const g = c.createLinearGradient(0, 4, 0, H - 4);
      g.addColorStop(0, THEME.glassTop);
      g.addColorStop(0.35, THEME.glass);
      g.addColorStop(1, THEME.glass);
      c.fillStyle = g; c.fill();
      c.strokeStyle = w ? "rgba(255,207,107,0.75)" : THEME.stroke; c.lineWidth = w ? 3 : 2; c.stroke();
      const x0 = (W - cw) / 2 + 22;
      drawIcon(c, w ? "bell" : n ? (n.icon || KIND_ICON[n.kind] || "bell") : a ? "sparkles" : "zap", x0, H / 2 - 18, 36,
        w ? "#ffcf6b" : n?.kind === "error" ? "#ff8095" : "#f4f5f8", 2);
      c.textAlign = "left"; c.textBaseline = "middle";
      c.font = `600 28px ${font}`; c.fillStyle = THEME.text;
      c.fillText(title, x0 + 50, H / 2);
      if (sub) {
        c.font = `400 24px ${font}`; c.fillStyle = THEME.dim;
        c.fillText(fitText(c, sub, cw - tw - 110), x0 + 50 + tw + 18, H / 2);
      }
    },
  });

  // ======================================================================
  // Lanceur
  // ======================================================================
  const TILES = () => [...BASE_TILES(), ...extraTiles()];
  const BASE_TILES = () => [
    { id: "agents", icon: "bot", label: T("Agents", "Agents"), badge: (ag.data.approvals || []).length, open: () => { toggle(panels.agents, refreshAgents); clearInterval(ag.timer); if (panels.agents.visible) ag.timer = setInterval(refreshAgents, 5000); } },
    { id: "docs", icon: "book-open-text", label: T("Documents", "Documents"), open: () => toggle(panels.docs, () => { dc.loading = true; send({ type: "xr-docs-list" }); }) },
    { id: "data", icon: "chart-column", label: T("Données", "Data"), open: () => toggle(panels.data, () => { dt.loading = true; send({ type: "xr-data-list" }); }) },
    { id: "notifs", icon: "bell", label: T("Notifications", "Notifications"), badge: nt.halo.filter((n) => !n.seen).length, open: () => { nt.halo.forEach((n) => { n.seen = true; }); toggle(panels.notifs, () => send({ type: "list-notifications" })); } },
  ];
  const launcher = addPanel(new Panel({
    width: 0.66, height: 0.66, title: T("Apps", "Apps"), closable: true, onClose: closeCb,
    draw(c, p) {
      const W = p.W, H = p.H - p.handleH, gap = 18, pad = 26;
      const tiles = TILES();
      const cols = tiles.length > 4 ? 3 : 2, rows = Math.ceil(tiles.length / cols);
      const tw = (W - pad * 2 - gap * (cols - 1)) / cols, th = (H - pad - gap * (rows - 1) - 10) / rows;
      tiles.forEach((t, i) => {
        const x = pad + (i % cols) * (tw + gap), y = 10 + Math.floor(i / cols) * (th + gap);
        const hover = p.hoverId === "tile:" + t.id;
        const on = t.panel ? t.panel.visible : panels[t.id]?.visible;
        roundRect(c, x, y, tw, th, 30);
        c.fillStyle = on ? "rgba(255,255,255,0.86)" : hover ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.08)";
        c.fill();
        // A sculpted Three.js icon floats in front of this tile (xr-light-desk.js).
        c.font = `600 26px ${font}`; c.fillStyle = on ? "#14161d" : THEME.text; c.textAlign = "center"; c.textBaseline = "middle";
        c.fillText(t.label, x + tw / 2, y + th / 2 + 36);
        if (t.badge) {
          c.beginPath(); c.arc(x + tw - 30, y + 30, 20, 0, Math.PI * 2); c.fillStyle = "#ff4d6d"; c.fill();
          c.font = `700 22px ${font}`; c.fillStyle = "#fff"; c.fillText(String(t.badge), x + tw - 30, y + 31);
        }
        p.zones.push({ id: "tile:" + t.id, x, y, w: tw, h: th, onClick: () => { t.open(); launcher.invalidate(); }, _content: true });
      });
    },
  }), new THREE.Vector3(0.62, -0.1, -0.95), -0.5, false);
  launcher.object.visible = false;

  // ======================================================================
  // Messages du WebSocket
  // ======================================================================
  function onMessage(msg) {
    switch (msg.type) {
      case "xr-docs": dc.items = msg.items || []; dc.loading = false; panels.docs.invalidate(); return true;
      case "xr-doc":
        if (dc.open && dc.open.id === msg.id) {
          dc.open = { ...dc.open, loading: false, text: msg.text || "", error: msg.error };
          dc.lines = null;
          panels.docs.invalidate();
        }
        return true;
      case "xr-tables": dt.bases = msg.bases || []; dt.loading = false; panels.data.invalidate(); return true;
      case "xr-table":
        if (dt.open) {
          dt.open = msg.error ? { ...dt.open, loading: false, error: msg.error }
            : { ...dt.open, loading: false, columns: msg.columns || [], rows: msg.rows || [] };
          panels.data.invalidate();
        }
        return true;
      case "agent-done":
        onAgentDone(msg);
        ctx.onAgentEvent?.("agent-done", msg);
        return true;
      case "agent-step":
        ag.steps.push({ agent: msg.agent, step: msg.step || {}, ts: Date.now() });
        if (ag.steps.length > 30) ag.steps.shift();
        nt.step = ag.steps[ag.steps.length - 1];
        nt.stepUntil = Date.now() + 8000;
        halo.invalidate();
        if (panels.agents.visible) panels.agents.invalidate();
        ctx.onAgentEvent?.("agent-step", msg);
        return true;
      case "halo-notify": {
        const n = msg.notification || {};
        const item = { kind: String(n.kind || "info"), title: String(n.title || n.shortcut || "Lumen"), body: plain(String(n.body || n.message || n.output || "")), icon: n.icon, ts: Date.now() };
        nt.halo.unshift(item);
        ctx.onNotification?.(item);
        nt.halo.length = Math.min(nt.halo.length, 40);
        nt.current = item;
        nt.currentUntil = Date.now() + 6000;
        halo.invalidate();
        panels.notifs.invalidate();
        launcher.invalidate();
        onPanelsChanged();
        return true;
      }
      case "notifications": nt.desk = msg.items || []; panels.notifs.invalidate(); return true;
    }
    return false;
  }

  /// À chaque image : la capsule s'efface d'elle-même une fois son délai écoulé.
  let haloShown = false;
  function tick() {
    const now = Date.now();
    const show = !!nt.waiting || now < nt.currentUntil || now < nt.stepUntil || now < nt.activityUntil;
    if (show !== haloShown) { haloShown = show; halo.object.visible = show; halo.invalidate(); }
    if (show) halo.render();
  }
  halo.object.visible = false;

  return {
    launcher, halo, panels, onMessage, tick,
    /** Étape du chat en cours (annonces, réponse orchestrée) — quelques secondes. */
    activity(text, ms = 7000) { nt.activity = String(text || ""); nt.activityUntil = text ? Date.now() + ms : 0; halo.invalidate(); },
    /** Demande en attente : affichée jusqu'à la réponse (null pour effacer). */
    waiting(title) { nt.waiting = title ? String(title) : null; halo.invalidate(); },
    tiles: TILES,
    openTile: (id) => TILES().find(t=>t.id===id)?.open(),
    toggleLauncher: () => toggle(launcher, () => refreshAgents()),
    delegateUtterance,
    approvalUtterance,
    refreshTeam: refreshAgents,
    pendingApprovals: () => (ag.data.approvals || []).length,
    // Pour les figurines d'agents (xr-props.js).
    team: () => ag.team,
    approvals: () => ag.data.approvals || [],
    decide: (a, yes) => decide(a, yes),
    giveTask: (agent, text) => giveTask(agent, text),
    unseen: () => nt.halo.filter((n) => !n.seen).length,
  };
}
