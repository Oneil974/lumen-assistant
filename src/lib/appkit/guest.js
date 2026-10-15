/*
 * AppKit — le SDK que voit une application Lumen.
 *
 * Ce fichier est INJECTÉ tel quel dans le document de l'app (cf. host.js) : il
 * ne s'importe pas, il n'a pas de dépendance, et il ne suppose rien de la page
 * qui l'accueille. C'est la seule porte par laquelle une app packagée touche
 * Lumen — tout le reste (Tauri, le système de fichiers, les autres apps) lui est
 * hors d'atteinte.
 *
 * Rien ici ne décide de rien : chaque appel part en RPC vers l'hôte, qui vérifie
 * la permission correspondante et, si personne n'a encore tranché, pose la
 * question à l'utilisateur. Une app ne peut donc pas contourner un refus en
 * appelant « plus bas » : il n'y a pas de plus bas.
 *
 * Les erreurs de permission arrivent comme des exceptions portant
 * `err.code === "denied"`, pour qu'une app puisse dégrader proprement au lieu de
 * planter (« la synthèse IA est indisponible » plutôt qu'un écran blanc).
 */
(function () {
  if (window.lumen && window.lumen.__appkit) return;

  /* ---- Réglages de Lumen ---------------------------------------------------
   * Cette page vit sur sa propre origine : son localStorage est vide, alors que
   * ses bibliothèques (llm.js, apps-i18n.js…) y lisent la source d'IA, le
   * modèle, la langue. L'hôte injecte un instantané (`__LUMEN_SETTINGS__`) au
   * chargement et pousse ensuite l'événement `settings` à chaque changement.
   * Posé AVANT que le code de l'app ne tourne : c'est tout l'intérêt.
   */
  function applySettings(st) {
    if (!st || typeof st !== "object") return;
    for (var k in st) {
      if (!Object.prototype.hasOwnProperty.call(st, k)) continue;
      try {
        if (st[k] == null || st[k] === "") localStorage.removeItem(k);
        else localStorage.setItem(k, String(st[k]));
      } catch (e) {}
    }
  }
  applySettings(window.__LUMEN_SETTINGS__);

  /* ---- Pages imbriquées (hubs) --------------------------------------------
   * Une page d'un hub packagé vit dans une iframe DU HUB, lui-même iframe du
   * bureau. Son `parent` est donc le hub (même origine), pas Lumen : un
   * postMessage direct n'atteindrait jamais l'hôte, et l'hôte, qui vérifie la
   * source de chaque message, ignorerait de toute façon une fenêtre qu'il ne
   * connaît pas. On remonte donc jusqu'à la fenêtre même origine la plus haute
   * (celle dont le parent est l'hôte) et on passe par SON pont : appels,
   * réponses et événements transitent par elle.
   */
  function bridgeRoot() {
    var w = window;
    try {
      while (w.parent && w.parent !== w) {
        var p = w.parent;
        void p.document; // jette si l'origine diffère : p est l'hôte
        w = p;
      }
    } catch (e) {}
    return w;
  }
  var root = bridgeRoot();
  var nested = root !== window && !!(root.lumen && root.lumen.__appkit);
  var subscribers = []; // pages imbriquées abonnées aux événements (côté racine)

  function send(msg) {
    if (nested) root.lumen.__post(msg);
    else parent.postMessage(msg, "*");
  }

  var seq = 0;
  var pending = Object.create(null);
  var receivers = [];
  var toolHandlers = Object.create(null);
  var intentHandlers = Object.create(null);

  // Le timeout n'est pas une politesse : sans lui, une réponse perdue (hôte
  // rechargé, fenêtre fermée pendant l'appel) laisserait la promesse en
  // suspens pour toujours, et l'app figée sur un écran de chargement.
  var TIMEOUT_MS = 60000;

  function call(method, params, timeout) {
    if (nested) return root.lumen.__call(method, params, timeout);
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending[id] = { resolve: resolve, reject: reject };
      parent.postMessage({ __lumenAppkit: 1, id: id, method: method, params: params || {} }, "*");
      setTimeout(function () {
        if (pending[id]) {
          delete pending[id];
          reject(new Error("Lumen n'a pas répondu (" + method + ")"));
        }
      }, timeout || TIMEOUT_MS);
    });
  }

  // Réponses en flux de `lumen.ai.chat({ onDelta })`, par identifiant de flux.
  var streams = Object.create(null);

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (d && d.__lumenAppkitStream) {
      var fn = streams[d.stream];
      if (fn) { try { fn(d.text || "", { reasoning: d.reasoning || "", thinking: !!d.thinking }); } catch (err) {} }
      return;
    }
    if (!d || !d.__lumenAppkitReply) {
      if (d && d.__lumenAppkitEvent) {
        dispatch(d);
        // Les pages imbriquées reçoivent aussi l'événement (thème, interop,
        // intentions…) : chacune ne traite que ce qui la concerne.
        for (var si = 0; si < subscribers.length; si++) { try { subscribers[si](d); } catch (err) {} }
      }
      return;
    }
    var p = pending[d.id];
    if (!p) return;
    delete pending[d.id];
    if (d.ok) {
      p.resolve(d.data);
    } else {
      var err = new Error(d.error || "Erreur Lumen");
      err.code = d.code || "error";
      p.reject(err);
    }
  });

  // Événements poussés par l'hôte : un objet reçu par interop, l'appel d'un
  // outil publié par l'app, un changement de thème.
  function dispatch(msg) {
    if (msg.event === "interop" ) {
      receivers.forEach(function (fn) { try { fn(msg.object); } catch (e) {} });
      return;
    }
    // App Intent demandé par l'assistant : même mécanique que les outils
    // (promesse, réponse par callId), mais déclaré au manifeste et donc
    // connu du modèle avant même que l'app soit ouverte.
    if (msg.event === "intent") {
      var ih = intentHandlers[msg.intent];
      // Sans handler ici, une autre page du hub l'a peut-être : on se tait,
      // seule la page qui sait répondre répond.
      if (!ih && (nested || subscribers.length)) return;
      Promise.resolve()
        .then(function () {
          if (!ih) throw new Error("intention non prise en charge : " + msg.intent);
          return ih(msg.args || {});
        })
        .then(
          function (result) { reply(msg.callId, true, result == null ? "OK" : result); },
          function (err) { reply(msg.callId, false, String(err && err.message || err)); }
        );
      return;
    }
    if (msg.event === "tool") {
      var handler = toolHandlers[msg.tool];
      if (!handler && (nested || subscribers.length)) return;
      Promise.resolve()
        .then(function () {
          if (!handler) throw new Error("outil inconnu : " + msg.tool);
          return handler(msg.args || {});
        })
        .then(
          function (result) { reply(msg.callId, true, result); },
          function (err) { reply(msg.callId, false, String((err && err.message) || err)); }
        );
      return;
    }
    // Le thème arrive par le pont, faute d'origine commune avec le bureau : on
    // le pose ici, sur le <html> de l'app, avec les MÊMES attributs que
    // lib/theme-init.js — une app packagée doit être stylée exactement comme
    // une page du noyau, sans avoir une ligne à écrire pour ça.
    if (msg.event === "theme" && msg.detail) {
      var root = document.documentElement;
      var d = msg.detail;
      if (d.theme) { root.setAttribute("data-theme", d.theme); root.setAttribute("data-dt-theme", d.theme); }
      root.setAttribute("data-ui-base", d.base || "neutral");
      if (d.accent) root.setAttribute("data-ui-accent", d.accent); else root.removeAttribute("data-ui-accent");
      if (d.icons) root.setAttribute("data-ui-icons", d.icons); else root.removeAttribute("data-ui-icons");
      if (d.radius) root.style.setProperty("--radius", d.radius + "px");
    }
    // Outils d'écriture : l'hôte renvoie le texte à poser sur la sélection
    // qu'on lui avait signalée (cf. « Sélection » plus bas).
    if (msg.event === "settings") {
      applySettings(msg.detail);
      window.dispatchEvent(new CustomEvent("lumen:settings", { detail: msg.detail }));
      return;
    }
    if (msg.event === "selection.replace" && msg.detail) {
      applySelection(msg.detail.text, msg.detail.mode);
      return;
    }
    // « Résumer cette fenêtre » : l'hôte demande le texte visible de la page.
    if (msg.event === "page.text") {
      if (nested) return; // la racine du hub répond pour tout le monde
      var main = document.querySelector("main, [role=main], article") || document.body;
      reply(msg.callId, true, { title: document.title || "", text: (main.innerText || "").slice(0, 60000) });
      return;
    }
    window.dispatchEvent(new CustomEvent("lumen:" + msg.event, { detail: msg.detail }));
  }

  /* ---- Sélection : outils d'écriture -------------------------------------
   * Le menu (Relire, Réécrire, Résumer, Traduire, Demander à Lumen…) est
   * dessiné par l'HÔTE, par-dessus la fenêtre de l'app : ici on ne fait que
   * lui dire ce qui est sélectionné et où, puis appliquer ce qu'il renvoie.
   * L'app n'a rien à écrire ; une app qui gère déjà son clic droit peut
   * poser `data-lumen-no-writing-tools` sur la zone concernée.
   */
  var lastSel = null;

  function editable(el) {
    if (!el) return false;
    if (el.tagName === "TEXTAREA") return !el.readOnly && !el.disabled;
    if (el.tagName === "INPUT") return /^(text|search|url|email|tel)$/i.test(el.type || "text") && !el.readOnly && !el.disabled;
    return !!el.isContentEditable;
  }


  /* Rect du TEXTE sélectionné dans un champ (textarea/input), et non du champ
     entier : on reproduit le champ dans un div miroir (mêmes styles, même
     largeur, même défilement) et on mesure la portée du texte sélectionné.
     Sans cela, l'étincelle atterrissait au bas d'un long éditeur. */
  var MIRROR_PROPS = ["boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontVariant", "letterSpacing", "lineHeight",
    "textTransform", "textIndent", "wordSpacing", "whiteSpace", "wordBreak", "overflowWrap", "tabSize", "direction"];
  function fieldSelectionRect(el, start, end) {
    var box = el.getBoundingClientRect();
    try {
      var cs = window.getComputedStyle(el);
      var mirror = document.createElement("div");
      for (var i = 0; i < MIRROR_PROPS.length; i++) mirror.style[MIRROR_PROPS[i]] = cs[MIRROR_PROPS[i]];
      mirror.style.position = "fixed"; mirror.style.left = box.left + "px"; mirror.style.top = box.top + "px";
      mirror.style.height = box.height + "px"; mirror.style.overflow = "hidden";
      mirror.style.visibility = "hidden"; mirror.style.pointerEvents = "none"; mirror.style.zIndex = "-1";
      if (el.tagName === "TEXTAREA") { mirror.style.whiteSpace = "pre-wrap"; mirror.style.overflowWrap = "break-word"; }
      else { mirror.style.whiteSpace = "pre"; }
      var v = el.value;
      mirror.appendChild(document.createTextNode(v.slice(0, start)));
      var span = document.createElement("span");
      span.appendChild(document.createTextNode(v.slice(start, end) || "\u200b"));
      mirror.appendChild(span);
      mirror.appendChild(document.createTextNode(v.slice(end) + "\u200b"));
      document.body.appendChild(mirror);
      mirror.scrollTop = el.scrollTop; mirror.scrollLeft = el.scrollLeft;
      var rects = span.getClientRects();
      var r = rects.length ? rects[rects.length - 1] : span.getBoundingClientRect();
      var first = rects.length ? rects[0] : r;
      mirror.parentNode.removeChild(mirror);
      // Portée visible du champ : une sélection qui a défilé hors de vue est
      // ramenée au bord, plutôt que projetée hors de la fenêtre.
      var top = Math.max(box.top, Math.min(first.top, box.bottom));
      var bottom = Math.max(box.top, Math.min(r.bottom, box.bottom));
      var left = Math.max(box.left, Math.min(rects.length > 1 ? box.left : first.left, box.right));
      var right = Math.max(box.left, Math.min(rects.length > 1 ? box.right : r.right, box.right));
      return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
    } catch (e) {
      return { x: box.left, y: box.top, w: box.width, h: box.height };
    }
  }

  function readSel() {
    var active = document.activeElement;
    var fieldSel = active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT")
      && (active.selectionEnd || 0) - (active.selectionStart || 0) >= 1
      && active.value.slice(active.selectionStart, active.selectionEnd).trim();
    if (fieldSel) {
      var start = active.selectionStart || 0, end = active.selectionEnd || 0;
      var text = active.value.slice(start, end);
      return { text: text, editable: editable(active), rect: fieldSelectionRect(active, start, end), el: active, start: start, end: end };
    }
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    var t = sel.toString();
    if (!t.trim()) return null;
    var range = sel.getRangeAt(0).cloneRange();
    var node = range.commonAncestorContainer;
    if (node.nodeType !== 1) node = node.parentElement;
    var host = node && node.closest ? node.closest("[contenteditable]") : null;
    var rr = range.getBoundingClientRect();
    return { text: t, editable: editable(host || node), rect: { x: rr.left, y: rr.top, w: rr.width, h: rr.height }, range: range, host: host || node };
  }

  /* Décalage de cette page dans la fenêtre racine (iframes imbriquées d'un hub). */
  function frameOffset() {
    var x = 0, y = 0, w = window;
    try {
      while (w !== root && w.frameElement) {
        var r = w.frameElement.getBoundingClientRect();
        x += r.left; y += r.top;
        w = w.parent;
      }
    } catch (e) {}
    return { x: x, y: y };
  }

  function report(kind, s, point) {
    // On garde la DERNIÈRE vraie sélection : cliquer dans le popover de
    // l'hôte fait perdre le focus à la page, qui signale alors « clear » —
    // et « Remplacer » arrivait après, sur une sélection oubliée.
    if (s) lastSel = s;
    var off = frameOffset();
    var rect = s ? { x: s.rect.x + off.x, y: s.rect.y + off.y, w: s.rect.w, h: s.rect.h } : null;
    var pt = point ? { x: point.x + off.x, y: point.y + off.y } : null;
    send({ __lumenAppkitSelection: 1, kind: kind, text: s ? s.text : "", editable: !!(s && s.editable), rect: rect, point: pt });
  }

  function applySelection(text, mode) {
    var s = lastSel;
    if (!s) return;
    if (s.el) {
      s.el.focus();
      if (mode === "after") {
        var sep = s.el.tagName === "TEXTAREA" ? "\n\n" : " ";
        s.el.setRangeText(sep + text, s.end, s.end, "end");
      } else {
        s.el.setRangeText(text, s.start, s.end, "end");
      }
      s.el.dispatchEvent(new Event("input", { bubbles: true }));
      s.el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    var sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(s.range);
    if (mode === "after") sel.collapseToEnd();
    if (s.host && s.host.focus) s.host.focus();
    var payload = mode === "after" ? "\n" + text : text;
    var ok = false;
    try { ok = payload === "" ? document.execCommand("delete") : document.execCommand("insertText", false, payload); } catch (e) {}
    if (!ok) { var rg = sel.getRangeAt(0); if (mode !== "after") rg.deleteContents(); if (payload) rg.insertNode(document.createTextNode(payload)); }
  }

  function imageDataUrl(img) {
    try {
      if (img.src.indexOf("data:") === 0) return Promise.resolve(img.src);
      var c = document.createElement("canvas");
      c.width = img.naturalWidth || img.width; c.height = img.naturalHeight || img.height;
      c.getContext("2d").drawImage(img, 0, 0);
      return Promise.resolve(c.toDataURL("image/png"));
    } catch (e) {
      return fetch(img.src).then(function (r) { return r.blob(); }).then(function (b) {
        return new Promise(function (res) { var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.onerror = function () { res(""); }; fr.readAsDataURL(b); });
      }).catch(function () { return ""; });
    }
  }

  var noWt = "[data-lumen-no-writing-tools]";
  document.addEventListener("contextmenu", function (e) {
    if (e.target && e.target.closest && e.target.closest(noWt)) return;
    var pt = { x: e.clientX, y: e.clientY };
    var img = e.target && e.target.closest ? e.target.closest("img") : null;
    var s = readSel();
    if (img && img.naturalWidth > 32 && img.naturalHeight > 32) {
      e.preventDefault();
      var r = img.getBoundingClientRect();
      imageDataUrl(img).then(function (dataUrl) {
        if (!dataUrl) return;
        var off = frameOffset();
        send({ __lumenAppkitSelection: 1, kind: "image", dataUrl: dataUrl, rect: { x: r.left + off.x, y: r.top + off.y, w: r.width, h: r.height }, point: { x: pt.x + off.x, y: pt.y + off.y } });
      });
      return;
    }
    if (!s || s.text.trim().length < 2) return;
    // Le clic doit tomber sur la sélection, pas ailleurs dans l'app.
    var hit = false;
    try {
      if (s.el) hit = s.el === e.target || s.el.contains(e.target);
      else { var ws = window.getSelection(); hit = ws.containsNode(e.target, true) || (s.host && s.host.contains(e.target)); }
    } catch (err) {}
    if (!hit) return;
    e.preventDefault();
    report("contextmenu", s, pt);
  }, true);

  // Un clic dans la page ferme le menu dessiné par l'hôte (il ne voit pas nos
  // clics) ; on n'envoie que le signal, jamais la position.
  document.addEventListener("pointerdown", function () {
    send({ __lumenAppkitSelection: 1, kind: "pointerdown" });
  }, true);

  var sparkTimer = 0;
  document.addEventListener("mouseup", function (e) {
    if (e.button !== 0) return;
    if (e.target && e.target.closest && e.target.closest(noWt)) return;
    clearTimeout(sparkTimer);
    sparkTimer = setTimeout(function () {
      var s = readSel();
      if (s && s.text.trim().length >= 3) report("spark", s, null);
      else report("clear", null, null);
    }, 120);
  });
  var clearTimer = 0;
  document.addEventListener("selectionchange", function () {
    clearTimeout(clearTimer);
    clearTimer = setTimeout(function () { if (!readSel()) report("clear", null, null); }, 150);
  });
  document.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "e" || e.key === "E")) {
      var s = readSel();
      if (!s) return;
      e.preventDefault();
      report("shortcut", s, null);
    }
  }, true);

  function reply(callId, ok, payload) {
    send({ __lumenAppkitToolReply: 1, callId: callId, ok: ok, data: ok ? payload : undefined, error: ok ? undefined : payload });
  }

  // Diagnostic : les erreurs de l'app remontent à l'hôte, qui les écrit dans
  // window-diagnostics.log. Dans une iframe d'app installée, il n'y a ni
  // console ni stderr : sans ça, une app qui plante au démarrage est muette.
  function relayError(message) {
    try { send({ __lumenAppkitLog: 1, level: "error", message: String(message || "").slice(0, 2000) }); } catch (e) {}
  }
  window.addEventListener("error", function (e) {
    relayError((e.message || "erreur") + " @ " + (e.filename || "?") + ":" + (e.lineno || 0));
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    relayError("promesse rejetée : " + (r && r.stack ? r.stack.split("\n").slice(0, 3).join(" | ") : String(r && r.message || r)));
  });

  var lumen = window.lumen || {};
  lumen.__appkit = true;

  /** Identité de l'app, telle que son manifeste la déclare. */
  lumen.app = window.__LUMEN_APP__ || { id: "unknown", name: "Application", version: "0" };

  /* ---- Permissions -------------------------------------------------------
   * Une app n'a pas besoin d'appeler ceci : la première utilisation d'une
   * capacité déclenche la demande toute seule. C'est utile pour DEMANDER AU BON
   * MOMENT — au clic sur « Résumer », pas au chargement de la page, où
   * l'utilisateur n'a aucun contexte pour répondre.
   */
  lumen.permissions = {
    query: function (cap) { return call("perm.query", { cap: cap }); },
    request: function (cap) { return call("perm.request", { cap: cap }, 0x7fffffff); },
  };

  /* ---- IA ---------------------------------------------------------------- */
  lumen.ai = {
    /** Conversation complète. `messages` suit la forme OpenAI. */
    /** `opts.onDelta(texte, { reasoning, thinking })` : réponse EN FLUX. */
    chat: function (opts) {
      opts = opts || {};
      var onDelta = typeof opts.onDelta === "function" ? opts.onDelta : null;
      var params = Object.assign({}, opts);
      delete params.onDelta;
      if (!onDelta || nested) {
        return call("ai.chat", params, 300000).then(function (text) {
          if (onDelta) { try { onDelta(String(text || ""), { reasoning: "", thinking: false }); } catch (err) {} }
          return text;
        });
      }
      var sid = "st" + (++seq) + "-" + Date.now().toString(36);
      streams[sid] = onDelta;
      params.stream = sid;
      return call("ai.chat", params, 300000).then(
        function (text) { delete streams[sid]; return text; },
        function (err) { delete streams[sid]; throw err; }
      );
    },
    /** Raccourci une-question-une-réponse. */
    ask: function (prompt, opts) {
      return lumen.ai.chat(Object.assign({ messages: [{ role: "user", content: String(prompt) }] }, opts || {}));
    },
    /** Décrit une image (base64 sans préfixe data:). */
    vision: function (imageB64, prompt) { return call("ai.vision", { image: imageB64, prompt: prompt || "" }, 300000); },
    /** Vecteurs d'embedding pour une liste de textes. */
    embed: function (texts) { return call("ai.embed", { texts: [].concat(texts) }, 120000); },
    /** Modèle et backend actifs, pour afficher « propulsé par… ». */
    info: function () { return call("ai.info"); },
  };

  /* ---- Mode assistant ----------------------------------------------------
   * Une app « assistable » expose ses actions ; l'assistant de Lumen peut alors
   * les proposer et les déclencher en langage naturel, sans que l'app ait à
   * écrire le moindre bout de parseur.
   */
  lumen.assistant = {
    register: function (spec) { return call("assistant.register", spec || {}); },
    ask: function (question, context) { return call("assistant.ask", { question: question, context: context || null }, 300000); },
  };

  /* ---- App Intents --------------------------------------------------------
   * Les intentions sont DÉCLARÉES dans le manifeste (id, titre, paramètres) :
   * l'assistant les connaît sans ouvrir l'app. Ici l'app dit simplement
   * comment les exécuter. Une intention reçue avant `on()` attend chez l'hôte
   * jusqu'à ce que l'app se déclare prête — d'où l'appel `intents.ready`.
   *
   *   lumen.intents.on("notes.create", async ({ title, body }) => { …; return "Note créée"; });
   */
  lumen.intents = {
    on: function (id, handler) {
      intentHandlers[id] = handler;
      return call("intents.ready", { id: String(id) });
    },
  };

  /* ---- Outils appelables par les agents ---------------------------------- */
  lumen.tools = {
    /**
     * Publie un outil. `spec` : { name, description, parameters } (JSON Schema).
     * `handler(args)` peut rendre une promesse. L'outil disparaît quand la
     * fenêtre se ferme — un outil fantôme, dont personne ne peut plus répondre,
     * serait pire que pas d'outil du tout.
     */
    register: function (spec, handler) {
      toolHandlers[spec && spec.name] = handler;
      return call("tools.register", { spec: spec });
    },
    unregister: function (name) {
      delete toolHandlers[name];
      return call("tools.unregister", { name: name });
    },
  };

  /* ---- Stockage ----------------------------------------------------------
   * Chaque app a son propre espace, isolé des autres : `storage` pour des
   * valeurs, `files` pour des fichiers. Une app ne voit jamais l'espace d'une
   * autre — c'est une garantie de l'hôte, pas une convention de nommage.
   */
  lumen.storage = {
    get: function (key) { return call("storage.get", { key: key }); },
    set: function (key, value) { return call("storage.set", { key: key, value: value }); },
    remove: function (key) { return call("storage.remove", { key: key }); },
    keys: function () { return call("storage.keys"); },
    files: {
      list: function (dir) { return call("storage.files.list", { dir: dir || "" }); },
      read: function (path) { return call("storage.files.read", { path: path }); },
      readBytes: function (path) { return call("storage.files.readBytes", { path: path }); },
      write: function (path, content) { return call("storage.files.write", { path: path, content: content }); },
      remove: function (path) { return call("storage.files.remove", { path: path }); },
    },
  };

  /**
   * Fichier choisi par l'UTILISATEUR hors de l'espace de l'app. C'est le seul
   * chemin par lequel une app touche aux fichiers de quelqu'un : elle ne peut
   * pas lister, deviner ni parcourir — elle reçoit ce qu'on lui donne.
   */
  lumen.files = {
    pick: function (opts) { return call("files.pick", opts || {}, 0x7fffffff); },
    save: function (name, content) { return call("files.save", { name: name, content: content }, 0x7fffffff); },
  };

  /* ---- Bases de données locales ------------------------------------------ */
  lumen.tables = {
    listBases: function () { return call("tables.baseList"); },
    listTables: function (baseId) { return call("tables.list", { baseId: baseId }); },
    schema: function (tableId) { return call("tables.schema", { tableId: tableId }); },
    rows: function (tableId, limit, offset) { return call("tables.rows", { tableId: tableId, limit: limit, offset: offset }); },
    query: function (baseId, sql) { return call("tables.query", { baseId: baseId, sql: sql }); },
    insertRow: function (tableId, values) { return call("tables.rowInsert", { tableId: tableId, values: values }); },
    updateRow: function (tableId, rowId, values) { return call("tables.rowUpdate", { tableId: tableId, rowId: rowId, values: values }); },
    deleteRow: function (tableId, rowId) { return call("tables.rowDelete", { tableId: tableId, rowId: rowId }); },
  };

  /* ---- Mémoire cognitive -------------------------------------------------- */
  lumen.memory = {
    recall: function (query, limit) { return call("memory.recall", { query: query, limit: limit || 5 }); },
    remember: function (text, kind) { return call("memory.remember", { text: text, kind: kind || "note" }); },
  };

  /* ---- Interop entre apps -------------------------------------------------
   * `share` ouvre le sélecteur : c'est l'utilisateur qui choisit la
   * destination, donc aucune permission n'est requise. `send` vise une app
   * précise sans passer par lui : celui-là demande `interop:<appId>`.
   */
  /** Ouvrir une autre app du bureau (ou le Catalogue si elle manque). */
  lumen.apps = {
    open: function (appId) { return call("apps.open", { appId: appId }); },
    openFile: function (sandboxId, path) { return call("apps.openFile", { sandboxId: sandboxId, path: path }); },
  };
  lumen.interop = {
    share: function (kind, payload) { return call("interop.share", { kind: kind, payload: payload || {} }, 0x7fffffff); },
    send: function (appId, kind, payload) { return call("interop.send", { appId: appId, kind: kind, payload: payload || {} }, 0x7fffffff); },
    /** `appId` optionnel : identifiant d'onglet (ex. « notes » dans le paquet Muse). */
    receive: function (handler, appId) { receivers.push(handler); return call("interop.receive", { appId: appId || "" }); },
    shelf: function () { return call("interop.shelf"); },
  };

  /* ---- Réseau, notifications, presse-papier ------------------------------- */
  lumen.net = {
    /** Requête HTTP sortante, relayée par Lumen (donc sans blocage CORS). */
    fetch: function (url, opts) { return call("net.fetch", { url: url, options: opts || {} }, 120000); },
  };
  lumen.notify = function (opts) {
    return call("notify", typeof opts === "string" ? { title: opts } : opts || {});
  };
  lumen.clipboard = {
    read: function () { return call("clipboard.read"); },
    write: function (text) { return call("clipboard.write", { text: String(text) }); },
  };

  /* ---- Interface ---------------------------------------------------------
   * Les dialogues sont rendus par l'HÔTE, pas par l'app : c'est ce qui rend une
   * demande de confirmation crédible. Une app ne peut pas dessiner une fausse
   * feuille système, puisqu'elle ne dessine pas celle-là.
   */
  lumen.ui = {
    confirm: function (opts) { return call("ui.confirm", typeof opts === "string" ? { title: opts } : opts || {}, 0x7fffffff); },
    prompt: function (opts) { return call("ui.prompt", typeof opts === "string" ? { title: opts } : opts || {}, 0x7fffffff); },
    toast: function (message) { return call("ui.toast", { message: String(message) }); },
    theme: function () { return call("ui.theme"); },
    setTitle: function (title) { return call("ui.setTitle", { title: String(title) }); },
    /**
     * Feuille IA flottante de Lumen, posée au-dessus de la fenêtre de l'app :
     * { title, question, context, images: [dataUrl], anchor: {x,y,w,h} (coordonnées de l'app) }.
     * La réponse s'affiche dans la feuille ; la promesse rend le texte de la première réponse.
     */
    askSheet: function (opts) { return call("ui.askSheet", opts || {}, 300000); },
  };

  // Pont interne pour les pages imbriquées du même paquet (cf. bridgeRoot).
  lumen.__call = call;
  lumen.__post = function (msg) { parent.postMessage(msg, "*"); };
  lumen.__subscribe = function (fn) { subscribers.push(fn); };
  if (nested) root.lumen.__subscribe(dispatch);

  window.lumen = lumen;
  window.dispatchEvent(new Event("lumen:ready"));
})();
