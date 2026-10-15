// Lumen XR — plus de Lumen dans le casque.
//
//   • VUES D'APPS : chaque app installée qui déclare des App Intents propose
//     ses vues de consultation (list_…, révisions du jour, couches…). Le
//     manifeste peut les préciser (`xr: { views, detail }`) ; sinon on les
//     déduit. L'intention s'exécute dans le BUREAU Lumen (qui héberge les
//     apps) et le casque affiche le résultat — aucun code XR par app.
//   • RECOPIE D'ÉCRAN : l'écran du Mac, ou sa fenêtre au premier plan (Opus,
//     Calc, navigateur…), en direct dans un panneau. Une image à la fois : la
//     suivante n'est demandée qu'à réception de la précédente.
//   • CLAVIER : AZERTY/QWERTY, accents, chiffres, dictée ; pensé pour l'appui
//     du bout du doigt. Envoie dans la conversation.
//   • GRAPHIQUES 3D : les barres d'une table (panneau Données) posées sur la
//     table réelle ; se déplacent, tournent (⟲ ⟳), s'agrandissent à deux mains.

export function createExtras(ctx) {
  const { THREE, Panel, THEME, wrap, plain, roundRect, drawIcon, addPanel, removePanel, send, T, toast, lang, openNear, onPanelsChanged, dictate, look, gazePoint, spatial, faceHead, setWorldPosition, settings } = ctx;
  const font = THEME.font;

  // ======================================================================
  // Vues d'apps (App Intents)
  // ======================================================================
  // Intentions de CONSULTATION reconnues sans déclaration : aucune n'a d'effet.
  const VIEW_RE = /^list_|_(list|due|exams|layers|status|summary)$|^(studies_due|studies_exams|carte_layers)$/;
  // Détail connu pour les manifestes installés avant le champ `xr`.
  const BUILTIN_DETAIL = { notes: { intent: "read_note", arg: "note" } };
  const av = { apps: [], loading: false, app: null, view: null, text: "", lines: null, page: 0, error: "", stack: [], seq: 0, pending: 0 };

  const viewsOf = (a) => {
    const declared = a.xr?.views;
    const ids = Array.isArray(declared) && declared.length ? declared
      : a.intents.filter((it) => !(it.required || []).length && VIEW_RE.test(it.id)).map((it) => it.id);
    return ids.map((id) => a.intents.find((it) => it.id === id)).filter(Boolean);
  };

  function runView(app, intent, args = {}, push = false) {
    if (push && av.view) av.stack.push({ view: av.view, text: av.text, page: av.page });
    av.app = app; av.view = { intent, args }; av.text = ""; av.lines = null; av.page = 0; av.error = ""; av.pending = ++av.seq;
    appsPanel.title = `${app.name} · ${intent.title || intent.id}`;
    send({ type: "xr-app-intent", id: av.pending, appId: app.id, intentId: intent.id, args });
    appsPanel.invalidate();
  }

  const appsPanel = addPanel(new Panel({
    width: 0.72, height: 0.9, title: T("Apps Lumen", "Lumen apps"), closable: true, onClose: onPanelsChanged,
    headerButtons: () => av.view
      ? [{ id: "av-back", icon: "chevron-left", onClick: () => {
            const prev = av.stack.pop();
            if (prev) { av.view = prev.view; av.text = prev.text; av.page = prev.page; av.lines = null; }
            else { av.view = null; av.app = null; appsPanel.title = T("Apps Lumen", "Lumen apps"); }
            appsPanel.invalidate();
          } },
         { id: "av-refresh", icon: "refresh-cw", onClick: () => runView(av.app, av.view.intent, av.view.args) }]
      : [{ id: "av-list", icon: "refresh-cw", onClick: () => { av.loading = true; send({ type: "xr-app-list" }); appsPanel.invalidate(); } }],
    draw(c, p) {
      const W = p.W, H = p.H - p.handleH, x = 30, w = W - 60, footer = 90;
      c.textAlign = "left"; c.textBaseline = "middle";
      if (!av.view) {
        // Liste des apps et de leurs vues.
        let y = 14;
        const apps = av.apps.map((a) => ({ a, views: viewsOf(a) })).filter((e) => e.views.length);
        if (!apps.length) {
          c.font = `400 27px ${font}`; c.fillStyle = THEME.dim; c.textAlign = "center";
          c.fillText(av.loading ? T("Chargement…", "Loading…") : T("Aucune app ne propose de vue", "No app offers a view"), W / 2, H / 2);
          return;
        }
        for (const { a, views } of apps) {
          if (y > H - 80) break;
          drawIcon(c, a.icon && !a.icon.startsWith("<") ? a.icon : "app-window", x, y + 6, 36, "#f4f5f8", 2);
          c.font = `600 28px ${font}`; c.fillStyle = THEME.text; c.textAlign = "left";
          c.fillText(a.name, x + 52, y + 24);
          y += 54;
          for (const v of views) {
            if (y > H - 80) break;
            const id = `v:${a.id}:${v.id}`;
            roundRect(c, x + 20, y, w - 20, 62, 20);
            c.fillStyle = p.hoverId === id ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.06)"; c.fill();
            c.font = `400 26px ${font}`; c.fillStyle = THEME.text;
            c.fillText(v.title || v.id, x + 44, y + 31);
            p.zones.push({ id, x: x + 20, y, w: w - 20, h: 62, _content: true, onClick: () => runView(a, v) });
            y += 72;
          }
          y += 10;
        }
        return;
      }
      if (av.pending || av.error) {
        c.font = `400 27px ${font}`; c.fillStyle = THEME.dim; c.textAlign = "center";
        const msg = av.error === "desktop-closed"
          ? T("Ouvrez le bureau Lumen sur l'ordinateur pour utiliser les apps depuis le casque.", "Open the Lumen desktop on the computer to use apps from the headset.")
          : av.error ? T("Erreur : ", "Error: ") + av.error : T("L'app répond…", "The app is answering…");
        wrap(c, msg, w).forEach((l, k) => c.fillText(l, W / 2, H / 2 - 20 + k * 38));
        return;
      }
      // Résultat : une ligne par élément ; cliquable si l'app déclare un détail.
      const detail = av.app?.xr?.detail || BUILTIN_DETAIL[av.app?.id];
      const detailIntent = detail && av.app.intents.find((it) => it.id === detail.intent);
      const clickable = !!detailIntent && av.view.intent.id !== detail.intent;
      c.font = `400 27px ${font}`;
      if (!av.lines) {
        av.lines = [];
        for (const raw of plain(av.text).split("\n")) {
          if (clickable && raw.trim()) av.lines.push({ text: raw.trim(), raw, item: true });
          else for (const l of wrap(c, raw, w - 20)) av.lines.push({ text: l });
        }
      }
      const rowH = clickable ? 70 : 38;
      const per = Math.max(1, Math.floor((H - 20 - footer) / rowH));
      const pages = Math.max(1, Math.ceil(av.lines.length / per));
      av.page = Math.min(av.page, pages - 1);
      av.lines.slice(av.page * per, av.page * per + per).forEach((ln, k) => {
        const y = 14 + k * rowH;
        if (ln.item) {
          const id = "row:" + (av.page * per + k);
          roundRect(c, x, y, w, rowH - 10, 18);
          c.fillStyle = p.hoverId === id ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.06)"; c.fill();
          let t = ln.text;
          while (t.length > 3 && c.measureText(t).width > w - 40) t = t.slice(0, -2);
          c.fillStyle = THEME.text; c.textAlign = "left"; c.textBaseline = "middle";
          c.fillText(t === ln.text ? t : t + "…", x + 20, y + (rowH - 10) / 2);
          // Argument du détail : l'identifiant en tête de ligne (« id · … »), sinon la ligne.
          const arg = ln.text.split(/\s+[·—–|-]\s+/)[0].replace(/^[-•*]\s*/, "").trim();
          p.zones.push({ id, x, y, w, h: rowH - 10, _content: true, onClick: () => runView(av.app, detailIntent, { [detail.arg]: arg }, true) });
        } else {
          c.fillStyle = THEME.text; c.textAlign = "left"; c.textBaseline = "top";
          c.fillText(ln.text, x, y);
        }
      });
      if (pages > 1) {
        const fy = H - footer + 10;
        p.iconButton("avp", 30, fy, 68, "", () => { av.page = Math.max(0, av.page - 1); appsPanel.invalidate(); }, { inContent: true, icon: "chevron-up" });
        p.iconButton("avn", 112, fy, 68, "", () => { av.page = Math.min(pages - 1, av.page + 1); appsPanel.invalidate(); }, { inContent: true, icon: "chevron-down" });
        c.font = `400 24px ${font}`; c.fillStyle = THEME.dim; c.textAlign = "right"; c.textBaseline = "middle";
        c.fillText(`${av.page + 1} / ${pages}`, W - 30, fy + 34);
      }
    },
  }), new THREE.Vector3(-0.78, 0.05, -1.0), 0.6, false, "lumen-apps");
  appsPanel.object.visible = false;

  // Exécution directe d'une intention (post-it → Notes) : promesse du texte.
  const intentWaiters = new Map();
  let intentSeq = 100000;
  function runIntent(appId, intentId, args) {
    const id = ++intentSeq;
    return new Promise((resolve, reject) => {
      intentWaiters.set(id, { resolve, reject });
      send({ type: "xr-app-intent", id, appId, intentId, args });
      setTimeout(() => { if (intentWaiters.delete(id)) reject(new Error("timeout")); }, 30000);
    });
  }

  // ======================================================================
  // Outils (appels d'outils à la demande)
  // ======================================================================
  // Les mêmes outils que le menu « @ » des barres de chat (liste envoyée par
  // le bureau, `list-mentions`). Choisir un outil puis dicter ou taper la
  // demande envoie « @outil demande » : le bureau FORCE alors cet outil,
  // quel que soit le mode, exactement comme dans la barre.
  const tl = { items: [], loading: false, page: 0, sel: null };
  const TOOL_ICONS = [
    // Du plus précis au plus général : « mail_search » est un mail avant d'être une recherche.
    [/mail|email/i, "mail"], [/weather|meteo|météo/i, "cloud-sun"], [/score|sport/i, "trophy"],
    [/^mcp_|__/, "plug"], [/web|search|browse|fetch|url/i, "globe"], [/calendar|agenda|event/i, "calendar"], [/image|photo|draw/i, "image"],
    [/domo|device|light|lamp/i, "house"], [/agent/i, "bot"], [/table|sql|base|db/i, "database"],
    [/doc|note|file|pdf|read|write/i, "file-text"], [/rag|corpus|knowledge|memory|recall/i, "book-open-text"],
    [/python|code|shell|terminal/i, "terminal"], [/music|audio|song/i, "music"], [/time|clock|remind|timer/i, "clock"],
    [/contact|people/i, "users"], [/^mcp_|__/, "plug"], [/flux|workflow/i, "workflow"],
  ];
  const toolIcon = (id) => (TOOL_ICONS.find(([re]) => re.test(id)) || [null, "zap"])[1];
  const toolLabel = (id) => id.replace(/^mcp_/, "").replace(/__/g, " · ").replace(/_/g, " ");
  function sendTool(text) {
    const t = tl.sel;
    if (!t) return;
    ctx.sendChat(`@${t.id}${text ? " " + text : ""}`);
    toast(T(`Outil « ${toolLabel(t.id)} » lancé`, `Tool “${toolLabel(t.id)}” started`), 2000);
    tl.sel = null;
    toolsPanel.invalidate();
  }
  const toolsPanel = addPanel(new Panel({
    width: 0.7, height: 0.86, title: T("Outils", "Tools"), closable: true, onClose: onPanelsChanged,
    headerButtons: () => tl.sel
      ? [{ id: "tl-back", icon: "chevron-left", onClick: () => { tl.sel = null; toolsPanel.invalidate(); } }]
      : [{ id: "tl-refresh", icon: "refresh-cw", onClick: () => { tl.loading = true; send({ type: "list-mentions" }); toolsPanel.invalidate(); } }],
    draw(c, p) {
      const W = p.W, H = p.H - p.handleH, x = 26, w = W - 52, footer = 90;
      if (tl.sel) {
        // Outil choisi : description + trois façons de le lancer.
        drawIcon(c, toolIcon(tl.sel.id), W / 2 - 40, 20, 80, "#f4f5f8", 2);
        c.font = `600 32px ${font}`; c.fillStyle = THEME.text; c.textAlign = "center"; c.textBaseline = "top";
        c.fillText(toolLabel(tl.sel.id), W / 2, 118);
        c.font = `400 25px ${font}`; c.fillStyle = THEME.dim;
        wrap(c, tl.sel.sub || "", w - 20).slice(0, 5).forEach((l, k) => c.fillText(l, W / 2, 168 + k * 34));
        const by = H - 3 * 88 - 10;
        p.pill("tl-dict", x, by, w, 74, T("Dicter la demande", "Dictate the request"), () => dictate(T("Votre demande…", "Your request…"), (txt) => txt && sendTool(txt)), { active: true });
        p.pill("tl-kb", x, by + 88, w, 74, T("Taper au clavier", "Type it"), () => { ctx.keyboardPrefill(`@${tl.sel.id} `); tl.sel = null; toolsPanel.invalidate(); });
        p.pill("tl-run", x, by + 176, w, 74, T("Lancer sans précision", "Run as is"), () => sendTool(""));
        return;
      }
      if (!tl.items.length) {
        c.font = `400 27px ${font}`; c.fillStyle = THEME.dim; c.textAlign = "center"; c.textBaseline = "middle";
        c.fillText(tl.loading ? T("Chargement…", "Loading…") : T("Aucun outil disponible", "No tool available"), W / 2, H / 2);
        return;
      }
      // Grille de tuiles : icône + nom.
      const cols = 3, gap = 14, th = 150, tw = (w - gap * (cols - 1)) / cols;
      const rows = Math.max(1, Math.floor((H - 10 - footer) / (th + gap)));
      const per = rows * cols, pages = Math.max(1, Math.ceil(tl.items.length / per));
      tl.page = Math.min(tl.page, pages - 1);
      tl.items.slice(tl.page * per, tl.page * per + per).forEach((it, i) => {
        const tx = x + (i % cols) * (tw + gap), ty = 10 + Math.floor(i / cols) * (th + gap), id = "tool:" + it.id;
        roundRect(c, tx, ty, tw, th, 24);
        c.fillStyle = p.hoverId === id ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.07)"; c.fill();
        drawIcon(c, toolIcon(it.id), tx + tw / 2 - 26, ty + 22, 52, "#f4f5f8", 2);
        c.font = `500 22px ${font}`; c.fillStyle = THEME.text; c.textAlign = "center"; c.textBaseline = "top";
        wrap(c, toolLabel(it.id), tw - 16).slice(0, 2).forEach((l, k) => c.fillText(l, tx + tw / 2, ty + 88 + k * 26));
        p.zones.push({ id, x: tx, y: ty, w: tw, h: th, _content: true, onClick: () => { tl.sel = it; toolsPanel.invalidate(); } });
      });
      if (pages > 1) {
        const fy = H - footer + 10;
        p.iconButton("tlp", 26, fy, 68, "", () => { tl.page = Math.max(0, tl.page - 1); toolsPanel.invalidate(); }, { inContent: true, icon: "chevron-up" });
        p.iconButton("tln", 108, fy, 68, "", () => { tl.page = Math.min(pages - 1, tl.page + 1); toolsPanel.invalidate(); }, { inContent: true, icon: "chevron-down" });
        c.font = `400 24px ${font}`; c.fillStyle = THEME.dim; c.textAlign = "right"; c.textBaseline = "middle";
        c.fillText(`${tl.page + 1} / ${pages}`, W - 26, fy + 34);
      }
    },
  }), new THREE.Vector3(0.78, 0.05, -1.0), -0.6, false, "tools");
  toolsPanel.object.visible = false;
  function openTools() {
    if (toolsPanel.visible) { toolsPanel.close(); return; }
    tl.sel = null;
    if (!tl.items.length) tl.loading = true;
    send({ type: "list-mentions" });
    openNear(toolsPanel);
  }

  // ======================================================================
  // Recopie d'écran
  // ======================================================================
  const mir = { mode: "front", paused: false, waiting: false, lastAt: 0, seq: 0, w: 16, h: 9, error: "", tex: null };
  const mirrorPanel = addPanel(new Panel({
    width: 1.1, height: 0.74, title: T("Écran de l'ordinateur", "Computer screen"), closable: true,
    onClose: () => { onPanelsChanged(); },
    headerButtons: () => [
      { id: "m-front", icon: "app-window", active: mir.mode === "front", onClick: () => { mir.mode = "front"; mirrorPanel.invalidate(); } },
      { id: "m-screen", icon: "monitor", active: mir.mode === "screen", onClick: () => { mir.mode = "screen"; mirrorPanel.invalidate(); } },
      { id: "m-pause", icon: mir.paused ? "play" : "pause", onClick: () => { mir.paused = !mir.paused; mirrorPanel.invalidate(); } },
    ],
    draw(c, p) {
      const W = p.W, H = p.H - p.handleH;
      if (!mir.tex || mir.error) {
        c.font = `400 28px ${font}`; c.fillStyle = THEME.dim; c.textAlign = "center"; c.textBaseline = "middle";
        const msg = mir.error
          ? T("Recopie impossible : autorisez « Enregistrement de l'écran » (et « Accessibilité » pour la fenêtre) pour Lumen dans les Réglages de macOS.", "Mirroring failed: allow Screen Recording (and Accessibility for window mode) for Lumen in macOS Settings.")
          : T("Connexion à l'écran…", "Connecting to the screen…");
        wrap(c, msg, W - 120).forEach((l, k) => c.fillText(l, W / 2, H / 2 - 20 + k * 40));
      }
      if (mir.paused) {
        c.font = `600 24px ${font}`; c.fillStyle = "rgba(255,255,255,0.8)"; c.textAlign = "right"; c.textBaseline = "bottom";
        c.fillText(T("En pause", "Paused"), W - 30, H - 12);
      }
    },
  }), new THREE.Vector3(0, 0.25, -1.3), 0, false, "mirror");
  mirrorPanel.object.visible = false;
  // L'image vit sur son propre plan, en pleine résolution (le canevas du
  // panneau, lui, n'a que la densité d'un panneau d'interface).
  const mirrorMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  const mirrorPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mirrorMat);
  mirrorPlane.position.z = 0.002;
  mirrorPlane.visible = false;
  mirrorPanel.object.add(mirrorPlane);
  function layoutMirror() {
    // Zone utile : sous l'en-tête, avec une marge.
    const headM = mirrorPanel.handleH / 900;
    const aw = mirrorPanel.width - 0.05, ah = mirrorPanel.height - headM - 0.04;
    const s = Math.min(aw / mir.w, ah / mir.h);
    mirrorPlane.scale.set(mir.w * s, mir.h * s, 1);
    mirrorPlane.position.y = -headM / 2 + 0.005;
  }
  function requestFrame() {
    if (mir.waiting || mir.paused || !mirrorPanel.visible) return;
    const interval = settings.perf ? 800 : 300;
    if (performance.now() - mir.lastAt < interval) return;
    mir.waiting = true;
    mir.lastAt = performance.now();
    send({ type: "xr-mirror-frame", id: ++mir.seq, mode: mir.mode, maxWidth: settings.perf ? 1280 : 1920 });
    // Filet de sécurité : une réponse perdue ne doit pas figer la recopie.
    const seq = mir.seq;
    setTimeout(() => { if (mir.seq === seq) mir.waiting = false; }, 6000);
  }
  async function onMirror(msg) {
    mir.waiting = false;
    if (msg.error) { mir.error = msg.error; mirrorPlane.visible = false; mirrorPanel.invalidate(); return; }
    try {
      const bytes = Uint8Array.from(atob(msg.image), (ch) => ch.charCodeAt(0));
      // WebGL ignore `flipY` pour une ImageBitmap : on la retourne au décodage.
      const bmp = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }), { imageOrientation: "flipY" });
      const tex = new THREE.Texture(bmp);
      tex.flipY = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      tex.needsUpdate = true;
      const old = mir.tex;
      mir.tex = tex;
      mirrorMat.map = tex;
      mirrorMat.needsUpdate = true;
      old?.image?.close?.();
      old?.dispose();
      const changed = mir.error || mir.w !== msg.width || mir.h !== msg.height;
      mir.w = msg.width; mir.h = msg.height; mir.error = "";
      layoutMirror();
      mirrorPlane.visible = true;
      if (changed) mirrorPanel.invalidate();
    } catch { /* image corrompue : la suivante la remplacera */ }
  }
  function openMirror() {
    if (mirrorPanel.visible) { mirrorPanel.close(); return; }
    mir.error = ""; mir.paused = false;
    openNear(mirrorPanel);
    layoutMirror();
    onPanelsChanged();
  }

  // ======================================================================
  // Clavier
  // ======================================================================
  const kb = { text: "", mode: "letters", shift: false };
  const LAYOUT = {
    letters: lang === "fr"
      ? ["azertyuiop", "qsdfghjklm", "⇧wxcvbn'⌫", "?123,␣.↵"]
      : ["qwertyuiop", "asdfghjkl'", "⇧zxcvbnm⌫", "?123,␣.↵"],
    accents: ["éèêëàâäç", "ùûüôöîïœ", "⇧«»-–…’⌫", "abc,␣.↵"],
    numbers: ["1234567890", "@#€%&()+=/", "éà:;!?\"*⌫", "abc,␣.↵"],
  };
  let keyboardSubmit=null;
  const keyboard = addPanel(new Panel({
    width: 1.0, height: 0.48, title: T("Clavier", "Keyboard"), closable: true, onClose: () => {keyboardSubmit=null;keyboard.title=T("Clavier","Keyboard");onPanelsChanged();},
    headerButtons: () => [
      { id: "kb-mic", icon: "mic", onClick: () => dictate(T("Dictée…", "Dictation…"), (t) => { if (t) { kb.text = (kb.text ? kb.text + " " : "") + t; keyboard.invalidate(); } },{field:true}) },
      { id: "kb-accent", icon: "sparkles", active: kb.mode === "accents", onClick: () => { kb.mode = kb.mode === "accents" ? "letters" : "accents"; keyboard.invalidate(); } },
    ],
    draw(c, p) {
      const W = p.W, H = p.H - p.handleH, pad = 20;
      // Champ de saisie.
      roundRect(c, pad, 6, W - pad * 2, 64, 18);
      c.fillStyle = "rgba(0,0,0,0.35)"; c.fill();
      c.font = `400 30px ${font}`; c.textAlign = "left"; c.textBaseline = "middle";
      let shown = kb.text;
      while (shown.length && c.measureText(shown).width > W - pad * 2 - 50) shown = shown.slice(1);
      c.fillStyle = kb.text ? THEME.text : THEME.dim;
      c.fillText((kb.text ? (shown !== kb.text ? "…" : "") + shown : T("Écrire à Lumen…", "Write to Lumen…")) + (Math.floor(Date.now() / 500) % 2 ? "▏" : ""), pad + 18, 38);
      // Touches.
      const rows = LAYOUT[kb.mode];
      const top = 84, rh = (H - top - 8) / rows.length;
      rows.forEach((row, r) => {
        const keys = [...row.replace(/\?123|abc/, "\u0001")];
        const unit = (W - pad * 2) / 10.5;
        const widths = keys.map((k) => (k === "␣" ? unit * 4.4 : k === "\u0001" || k === "↵" ? unit * 1.6 : k === "⇧" || k === "⌫" ? unit * 1.4 : unit));
        const total = widths.reduce((a, b) => a + b, 0);
        let x = (W - total) / 2;
        keys.forEach((k, i) => {
          const kw = widths[i] - 8, ky = top + r * rh + 4, kh = rh - 8;
          const label = k === "\u0001" ? (kb.mode === "letters" ? "?123" : "abc") : k === "␣" ? "" : kb.shift && k.length === 1 ? k.toUpperCase() : k;
          const id = `k:${r}:${i}`;
          const special = "⇧⌫↵\u0001".includes(k);
          roundRect(c, x, ky, kw, kh, 16);
          c.fillStyle = p.hoverId === id ? "rgba(255,255,255,0.34)"
            : k === "↵" ? "rgba(153,97,255,0.75)" : (k === "⇧" && kb.shift) ? "rgba(255,255,255,0.7)"
            : special ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.22)";
          c.fill();
          if (k === "⌫") drawIcon(c, "delete", x + kw / 2 - 18, ky + kh / 2 - 18, 36, "#f4f5f8", 2);
          else if (k === "↵") drawIcon(c, "corner-down-left", x + kw / 2 - 18, ky + kh / 2 - 18, 36, "#ffffff", 2.2);
          else if (k === "⇧") drawIcon(c, "arrow-big-up", x + kw / 2 - 18, ky + kh / 2 - 18, 36, kb.shift ? "#14161d" : "#f4f5f8", 2);
          else {
            c.font = `500 ${label.length > 2 ? 24 : 32}px ${font}`; c.fillStyle = THEME.text; c.textAlign = "center"; c.textBaseline = "middle";
            c.fillText(label, x + kw / 2, ky + kh / 2 + 1);
          }
          p.zones.push({ id, x, y: ky, w: kw, h: kh, _content: true, onClick: () => keyPress(k) });
          x += widths[i];
        });
      });
    },
  }), new THREE.Vector3(0, -0.3, -0.75), 0, false, "keyboard");
  keyboard.object.visible = false;
  keyboard.home.pitch = -0.6;
  function keyPress(k) {
    if (k === "⌫") kb.text = kb.text.slice(0, -1);
    else if (k === "⇧") kb.shift = !kb.shift;
    else if (k === "\u0001") kb.mode = kb.mode === "letters" ? "numbers" : "letters";
    else if (k === "↵") {
      const t = kb.text.trim();
      if(t) {const submit=keyboardSubmit;keyboardSubmit=null;kb.text="";if(submit){keyboard.close();submit(t);}else{ctx.sendChat(t);toast(T("Envoyé","Sent"),1200);}}
    } else {
      kb.text += k === "␣" ? " " : kb.shift ? k.toUpperCase() : k;
      if (kb.shift) kb.shift = false;
    }
    keyboard.invalidate();
  }
  function openKeyboard() {
    if (keyboard.visible) { keyboard.close(); return; }
    // Bas et incliné, à portée de doigts : un clavier se tape, il ne se pointe pas.
    const { pos, quat } = ctx.headPose();
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(quat); fwd.y = 0; fwd.normalize();
    setWorldPosition(keyboard.object, pos.clone().addScaledVector(fwd, 0.5).add(new THREE.Vector3(0, -0.38, 0)));
    faceHead(keyboard.object);
    keyboard.object.rotateX(-0.6);
    spatial.release(keyboard.key);
    keyboard.open();
    onPanelsChanged();
  }

  // ======================================================================
  // Graphiques 3D
  // ======================================================================
  let chart = null; // { panel, bars }
  function openChart3D({ title, labels, values, valueName }) {
    if (chart) closeChart();
    const n = Math.min(values.length, 12);
    const max = Math.max(1e-9, ...values.slice(0, n).map((v) => Math.abs(v)));
    const panel = new Panel({
      width: 0.58, height: 0.1, title: title || T("Graphique", "Chart"), closable: true, resizable: false, onClose: () => closeChart(),
      headerButtons: () => [
        { id: "c-l", icon: "rotate-ccw", onClick: () => { bars.rotation.y += Math.PI / 8; } },
        { id: "c-r", icon: "rotate-cw", onClick: () => { bars.rotation.y -= Math.PI / 8; } },
      ],
      draw() {},
    });
    addPanel(panel, new THREE.Vector3(), 0, false, "chart3d");
    // Socle + barres, posés derrière la plaque de titre (qui sert de poignée).
    const bars = new THREE.Group();
    const depth = 0.34, width = Math.min(0.7, 0.07 * n + 0.1);
    const base = new THREE.Mesh(new THREE.BoxGeometry(width + 0.06, 0.012, depth), new THREE.MeshBasicMaterial({ color: 0x1b1d26, transparent: true, opacity: 0.85 }));
    base.position.y = 0.006;
    bars.add(base);
    const colors = look().colors;
    for (let i = 0; i < n; i++) {
      const v = values[i];
      const h = Math.max(0.006, (Math.abs(v) / max) * 0.3);
      const col = new THREE.Color(colors[i % colors.length]);
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.05, h, 0.05), new THREE.MeshBasicMaterial({ color: col }));
      const x = -width / 2 + 0.05 + i * ((width - 0.1) / Math.max(1, n - 1));
      bar.position.set(n === 1 ? 0 : x, 0.012 + h / 2, 0);
      bars.add(bar);
      // Étiquette : valeur au-dessus, libellé devant.
      bars.add(textSprite(Number(v).toLocaleString(lang), bar.position.x, 0.012 + h + 0.025, 0, 0.018));
      bars.add(textSprite(String(labels[i] ?? "").slice(0, 10), bar.position.x, 0.02, depth / 2 - 0.02, 0.014, true));
    }
    bars.add(textSprite(valueName || "", 0, 0.37, 0, 0.02));
    // Le socle repose juste au-dessus de la plaque de titre, en retrait.
    bars.position.set(0, 0.05, -depth / 2 - 0.01);
    panel.object.add(bars);
    // Posé sur la table réelle si le casque en voit une devant, sinon à portée.
    const p = gazePoint(0.7);
    const hit = spatial.hasPlanes ? spatial.nearestPlane(p.clone(), "horizontal", 1.2) : null;
    const place = hit
      ? new THREE.Vector3(hit.local.x, 0, hit.local.z).applyMatrix4(hit.plane.matrix).add(new THREE.Vector3(0, 0.07, 0))
      : p.clone().add(new THREE.Vector3(0, -0.3, 0));
    setWorldPosition(panel.object, place);
    faceHead(panel.object);
    panel.open();
    chart = { panel, bars };
    onPanelsChanged();
    toast(hit ? T("Graphique posé sur la table", "Chart placed on the table") : T("Graphique 3D", "3D chart"));
  }
  function closeChart() {
    if (!chart) return;
    const c = chart;
    chart = null;
    c.bars.traverse((o) => { o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose(); });
    removePanel(c.panel);
    onPanelsChanged();
  }
  function textSprite(text, x, y, z, h, flat = false) {
    const cv = document.createElement("canvas");
    const g = cv.getContext("2d");
    g.font = `600 44px ${font}`;
    cv.width = Math.max(8, Math.ceil(g.measureText(text).width) + 16);
    cv.height = 60;
    g.font = `600 44px ${font}`;
    g.fillStyle = "#ffffff"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(text, cv.width / 2, 32);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const w = (h * cv.width) / cv.height;
    const o = flat
      ? new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }))
      : new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
    if (!flat) o.scale.set(w, h, 1);
    else o.rotation.x = -Math.PI / 2.6;
    o.position.set(x, y, z);
    return o;
  }

  // ======================================================================
  // Voix : « ouvre le clavier », « montre mon écran »…
  // ======================================================================
  function handleUtterance(text) {
    const t = text.toLowerCase();
    if (/\b(ouvre|affiche|montre)\b.*\bclavier\b|\b(open|show)\b.*\bkeyboard\b/.test(t)) { if (!keyboard.visible) openKeyboard(); return true; }
    if (/\b(montre|affiche|recopie)\b.*\b(mon |l')?(écran|ecran|ordinateur|mac|bureau)\b|\b(show|mirror)\b.*\b(my )?(screen|computer|desktop)\b/.test(t)) { if (!mirrorPanel.visible) openMirror(); return true; }
    return false;
  }

  let requestedApp=null;
  function openApp(id) {
    requestedApp=id; av.loading=true; av.error=""; av.app=null; av.view=null; openNear(appsPanel); send({type:"xr-app-list"});
  }
  function onMessage(msg) {
    switch (msg.type) {
      case "xr-app-list":
        av.apps = msg.apps || []; av.loading = false;
        if(requestedApp) {
          const app=av.apps.find(a=>a.id===requestedApp), view=app && viewsOf(app)[0];
          if(app && view) runView(app,view);
          else if(app) av.app=app;
          else av.error=T("Cette application n'est pas installée.","This application is not installed.");
          requestedApp=null;
        }
        appsPanel.invalidate(); return true;
      case "xr-app-result": {
        const w = intentWaiters.get(msg.id);
        if (w) { intentWaiters.delete(msg.id); msg.error ? w.resolve({ error: msg.error }) : w.resolve({ text: msg.text }); return true; }
        if (msg.id !== av.pending) return true;
        av.pending = 0;
        av.error = msg.error || "";
        av.text = msg.text || "";
        av.lines = null;
        appsPanel.invalidate();
        return true;
      }
      case "xr-mirror": onMirror(msg); return true;
      case "mentions": tl.items = msg.tools || []; tl.loading = false; toolsPanel.invalidate(); return true;
    }
    return false;
  }

  function tick() {
    if (mirrorPanel.visible) requestFrame();
    if (keyboard.visible && Math.floor(Date.now() / 500) !== kb.blink) { kb.blink = Math.floor(Date.now() / 500); keyboard.invalidate(); }
  }

  return {
    appsPanel, mirrorPanel, keyboard, toolsPanel, openTools, onMessage, tick, handleUtterance, runIntent, openChart3D,
    prefillKeyboard: (t) => { keyboardSubmit=null;keyboard.title=T("Clavier","Keyboard");kb.text = t; if (!keyboard.visible) openKeyboard(); keyboard.invalidate(); },
    openApps: () => { if (appsPanel.visible) { appsPanel.close(); return; } av.loading = true; send({ type: "xr-app-list" }); openNear(appsPanel); },
    openMirror, openKeyboard, openApp,
    inputText: (title,initial,onSubmit) => {
      if(keyboard.visible)keyboard.close();kb.text=String(initial || "");keyboard.title=title;openKeyboard();keyboardSubmit=onSubmit;keyboard.invalidate();
    },
  };
}
