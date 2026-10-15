// Capture les erreurs JS de la fenêtre et les renvoie au backend (frontend_log).
// Préfixe de fenêtre optionnel via l'attribut data-prefix du <script>
// (ex. data-prefix="settings" → "settings:error"). Sans préfixe : "error"/"promise".
// Externalisé des HTML pour permettre une CSP stricte (script-src 'self').
(function () {
  var prefix = (document.currentScript && document.currentScript.dataset.prefix) || "";
  var p = prefix ? prefix + ":" : "";
  function send(level, message) {
    try {
      var invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
      if (invoke) invoke("frontend_log", { level: level, message: String(message || "") });
    } catch (_) {}
  }
  window.addEventListener("error", function (event) {
    var err = event.error;
    send(p + "error", (event.message || "error") + " @ " + (event.filename || "") + ":" + (event.lineno || "") + ":" + (event.colno || "") + (err && err.stack ? "\n" + err.stack : ""));
  });
  window.addEventListener("unhandledrejection", function (event) {
    var reason = event.reason;
    send(p + "promise", reason && (reason.stack || reason.message) || reason);
  });
})();
