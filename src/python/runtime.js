// Pilote de l'interpréteur Python (thread principal).
//
// Tient UN worker Pyodide, le relance quand on l'arrête (une boucle infinie
// n'a pas d'autre remède que `terminate()`), et sérialise les exécutions :
// un seul script à la fois, le suivant attend. Les sorties arrivent en flux
// (`onOutput`), le reste à la fin (`run()` rend une promesse).

const PYODIDE_VERSION = "0.29.5";
const CDN_PACKAGES = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

export class PythonRuntime {
  constructor({ onStatus, onOutput } = {}) {
    this.onStatus = onStatus || (() => {});
    this.onOutput = onOutput || (() => {});
    this.worker = null;
    this.state = "stopped";      // stopped | loading | ready | error
    this.version = "";
    this.pending = new Map();    // id → { resolve }
    this.seq = 0;
    this.readyPromise = null;
    this.busy = false;
  }

  /** Démarre (ou redémarre) le worker. Idempotent tant qu'il tourne. */
  start() {
    if (this.worker) return this.readyPromise;
    this.setState("loading");
    try {
      this.worker = new Worker(new URL("./py-worker.js", import.meta.url));
    } catch (e) {
      this.setState("error", String(e && e.message || e));
      return Promise.reject(e);
    }
    this.readyPromise = new Promise((resolve, reject) => {
      this._readyResolve = resolve; this._readyReject = reject;
    });
    this.worker.onmessage = (e) => this.handle(e.data || {});
    this.worker.onerror = (e) => {
      const msg = e && e.message ? e.message : "worker en erreur";
      if (this.state === "loading") { this.setState("error", msg); this._readyReject?.(new Error(msg)); }
      else this.onOutput({ kind: "stderr", text: msg + "\n" });
    };
    const indexURL = new URL("./vendor/pyodide/", import.meta.url).href;
    this.worker.postMessage({ type: "init", indexURL, packageBaseUrl: CDN_PACKAGES });
    return this.readyPromise;
  }

  /** Tue le worker : toute exécution en cours est abandonnée. */
  stop(reason = "Interrompu.") {
    if (!this.worker) return;
    this.worker.terminate();
    this.worker = null;
    this.busy = false;
    for (const [, p] of this.pending) p.resolve({ ok: false, error: reason, figures: [], files: {}, ms: 0, interrupted: true });
    this.pending.clear();
    this.setState("stopped");
  }

  /** Redémarre : espace de noms vierge, paquets à recharger. */
  async restart() { this.stop("Redémarré."); return this.start(); }

  setState(state, detail) {
    this.state = state;
    this.onStatus({ state, version: this.version, detail });
  }

  handle(msg) {
    if (msg.type === "status") {
      if (msg.state === "ready") { this.version = msg.version || ""; this.setState("ready"); this._readyResolve?.(); }
      else if (msg.state === "error") { this.setState("error", msg.detail); this._readyReject?.(new Error(msg.detail)); }
      else this.setState("loading", msg.detail);
      return;
    }
    if (msg.type === "stdout" || msg.type === "stderr") {
      this.onOutput({ kind: msg.type, text: msg.text, id: msg.id });
      return;
    }
    if (msg.type === "done") {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      this.busy = this.pending.size > 0;
      p?.resolve(msg);
    }
  }

  async send(payload) {
    await this.start();
    const id = ++this.seq;
    this.busy = true;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve });
      this.worker.postMessage({ ...payload, id });
    });
  }

  /**
   * Exécute un script. `files` = { "chemin/relatif": {text}|{b64} } : le
   * contenu du projet, recopié dans /project avant l'exécution. La réponse
   * porte les fichiers créés ou modifiés par le script.
   */
  run(code, { files, stdin, file, fresh = true, echo = false } = {}) {
    return this.send({ type: "run", code, files, stdin, file, fresh, echo });
  }

  /** Une ligne de console, dans l'espace de noms du dernier script. */
  repl(code) { return this.send({ type: "repl", code }); }

  /** Installe des paquets (pur Python via micropip, ou compilés du catalogue Pyodide). */
  install(packages) { return this.send({ type: "install", packages: [].concat(packages) }); }
}
