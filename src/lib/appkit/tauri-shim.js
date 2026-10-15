/*
 * Pont IPC des applications packagées — injecté dans le document de l'app.
 *
 * Une app installée ne vit plus dans le bundle : elle est servie depuis le
 * dossier de données, sur un schéma d'URL à elle (`lumenapp://`). C'est une
 * ORIGINE DIFFÉRENTE de celle du bureau, et c'est voulu : le navigateur refuse
 * dès lors qu'elle touche au DOM, au stockage ou aux variables du shell.
 *
 * Mais les applications historiques de Lumen appellent `window.__TAURI__` en
 * direct, et il n'y a aucune raison de réécrire trente applications pour un
 * déménagement de fichiers. Ce module leur rend donc un `__TAURI__` d'apparence
 * identique, dont chaque appel part en postMessage vers le bureau — qui décide.
 *
 * C'est là qu'est la frontière, et elle est nette :
 *
 *   - app **first-party** (signée par Lumen) : le bureau relaie les commandes
 *     telles quelles. Même pouvoir qu'avant, même code, sans confinement — ce
 *     que le manifeste annonce sans détour.
 *   - app **tierce** : le bureau REFUSE toute commande brute. Il ne reste que
 *     `window.lumen` (cf. guest.js), c'est-à-dire des capacités nommées, que
 *     l'utilisateur accorde une par une.
 *
 * Le pont ne décide de rien lui-même. Une app qui modifierait ce fichier chez
 * elle n'y gagnerait rien : la vérification est de l'autre côté du postMessage.
 */
(function () {
  if (window.__TAURI__ && window.__TAURI__.__bridged) return;

  // Page imbriquée d'un hub packagé : son parent est le hub (même origine),
  // pas Lumen. On réutilise le pont de la fenêtre même origine la plus haute,
  // dont le parent est bien l'hôte — c'est elle que l'hôte reconnaît.
  var rootWin = window;
  try {
    while (rootWin.parent && rootWin.parent !== rootWin) {
      var up = rootWin.parent;
      void up.document; // jette si l'origine diffère : `up` est l'hôte
      rootWin = up;
    }
  } catch (e) { /* on s'arrête à la dernière fenêtre même origine */ }
  if (rootWin !== window && rootWin.__TAURI__ && rootWin.__TAURI__.__bridged) {
    window.__TAURI__ = rootWin.__TAURI__;
    return;
  }

  var seq = 0;
  var pending = Object.create(null);
  var eventHandlers = Object.create(null);
  // Canaux (`Channel` Tauri) : la réponse en flux d'une génération. L'objet
  // reste ici ; seul son identifiant traverse le postMessage, et le bureau
  // renvoie chaque message sous `__lumenIpcChannel`.
  var channels = Object.create(null);
  var channelSeq = 0;
  function Channel() {
    this.id = "c" + (++channelSeq) + "-" + Date.now().toString(36);
    this.onmessage = function () {};
    channels[this.id] = this;
  }
  Channel.prototype.toJSON = function () { return { __lumenChannel: this.id }; };

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (d && d.__lumenIpcReply) {
      var p = pending[d.id];
      if (!p) return;
      delete pending[d.id];
      (p.channels || []).forEach(function (cid) { delete channels[cid]; });
      if (d.ok) p.resolve(d.data);
      else p.reject(new Error(d.error || "Erreur IPC"));
      return;
    }
    if (d && d.__lumenIpcChannel) {
      var ch = channels[d.channel];
      if (ch) { try { ch.onmessage(d.message); } catch (err) {} }
      return;
    }
    if (d && d.__lumenIpcEvent) {
      var list = eventHandlers[d.event] || [];
      for (var i = 0; i < list.length; i++) {
        try { list[i]({ event: d.event, payload: d.payload }); } catch (err) {}
      }
    }
  });

  function invoke(cmd, args) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      var used = [];
      var plain = {};
      var src = args || {};
      for (var k in src) {
        if (src[k] instanceof Channel) { used.push(src[k].id); plain[k] = { __lumenChannel: src[k].id }; }
        else plain[k] = src[k];
      }
      pending[id] = { resolve: resolve, reject: reject, channels: used };
      parent.postMessage({ __lumenIpc: 1, id: id, cmd: cmd, args: plain }, "*");
      // Sans plafond, une commande dont la réponse se perd (fenêtre du bureau
      // rechargée en plein appel) laisserait l'app figée sans rien afficher.
      setTimeout(function () {
        if (pending[id]) {
          delete pending[id];
          reject(new Error("Lumen n'a pas répondu (" + cmd + ")"));
        }
      }, 300000);
    });
  }

  function listen(event, handler) {
    (eventHandlers[event] = eventHandlers[event] || []).push(handler);
    parent.postMessage({ __lumenIpc: 1, id: 0, cmd: "__subscribe", args: { event: event } }, "*");
    return Promise.resolve(function unlisten() {
      eventHandlers[event] = (eventHandlers[event] || []).filter(function (h) { return h !== handler; });
    });
  }

  function emit(event, payload) {
    parent.postMessage({ __lumenIpcEmit: 1, event: event, payload: payload }, "*");
    return Promise.resolve();
  }

  window.__TAURI__ = {
    __bridged: true,
    core: { invoke: invoke, Channel: Channel },
    event: { listen: listen, emit: emit, once: function (e, h) { return listen(e, h); } },
    // Les apps qui testent `window.__TAURI__.window` pour savoir si elles
    // tournent dans Lumen doivent trouver quelque chose ; celles qui essaient
    // vraiment de piloter une fenêtre passent par lumen.ui.
    window: {},
  };
  window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || { invoke: invoke };
})();
