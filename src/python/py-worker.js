// Interpréteur Python de Lumen — côté worker.
//
// Pyodide (CPython compilé en WebAssembly) tourne ICI, dans un Web Worker :
// pas de processus système, pas de disque, pas de sockets. Le seul monde que
// voit le script est un système de fichiers en mémoire (/project) que le
// thread principal remplit depuis la sandbox avant l'exécution et relit après.
// Une boucle infinie se règle en tuant le worker — c'est le thread principal
// qui décide, ce fichier n'a rien à savoir.
//
// Protocole (postMessage) :
//   → { type:"init", indexURL, packageBaseUrl }
//   → { type:"run",  id, code, files, stdin, fresh }   script complet
//   → { type:"repl", id, code }                         une ligne dans l'espace du dernier run
//   → { type:"install", id, packages:[…] }              micropip / loadPackage
//   ← { type:"status", state:"loading"|"ready"|"error", version, detail }
//   ← { type:"stdout"|"stderr", id, text }
//   ← { type:"done", id, ok, error, result, figures:[b64], files:{…}, ms }
/* global loadPyodide, importScripts */

let pyodide = null;
let ready = false;
let currentId = null;
let namespace = null;          // globals du dernier « run » (pour le REPL)
let stdinLines = [];
const PROJECT = "/project";

const post = (m) => self.postMessage(m);

/* ---- Helpers Python installés une fois ---------------------------------- */
const BOOTSTRAP = `
import sys, os, io, base64, json, builtins
os.environ.setdefault("MPLBACKEND", "AGG")
os.makedirs("${PROJECT}", exist_ok=True)
os.chdir("${PROJECT}")
if "${PROJECT}" not in sys.path:
    sys.path.insert(0, "${PROJECT}")

def _lumen_figures():
    figs = []
    if "matplotlib" in sys.modules:
        try:
            import matplotlib.pyplot as plt
            for n in plt.get_fignums():
                buf = io.BytesIO()
                plt.figure(n).savefig(buf, format="png", dpi=110, bbox_inches="tight")
                figs.append(base64.b64encode(buf.getvalue()).decode())
            plt.close("all")
        except Exception as e:
            print("[figures]", e, file=sys.stderr)
    return figs

def _lumen_repl(src, ns):
    # Une expression est évaluée et son repr renvoyé ; sinon on exécute.
    try:
        code = compile(src, "<console>", "eval")
    except SyntaxError:
        exec(compile(src, "<console>", "exec"), ns)
        return None
    val = eval(code, ns)
    if val is None:
        return None
    ns["_"] = val
    return repr(val)

def _lumen_snapshot(root):
    out = {}
    for dp, dn, fn in os.walk(root):
        dn[:] = [d for d in dn if d != "__pycache__"]
        for f in fn:
            p = os.path.join(dp, f)
            try:
                st = os.stat(p)
                out[os.path.relpath(p, root)] = (st.st_size, int(st.st_mtime * 1000))
            except OSError:
                pass
    return out

def _lumen_changed(root, before):
    after = _lumen_snapshot(root)
    files = {}
    for rel, sig in after.items():
        if before.get(rel) == sig:
            continue
        p = os.path.join(root, rel)
        try:
            data = open(p, "rb").read()
        except OSError:
            continue
        if len(data) > 8 * 1024 * 1024:
            continue
        try:
            files[rel] = {"text": data.decode("utf-8")}
        except UnicodeDecodeError:
            files[rel] = {"b64": base64.b64encode(data).decode()}
    return json.dumps(files)
`;

/* ---- Démarrage ----------------------------------------------------------- */
async function init(msg) {
  try {
    post({ type: "status", state: "loading", detail: "runtime" });
    importScripts(msg.indexURL + "pyodide.js");
    pyodide = await loadPyodide({
      indexURL: msg.indexURL,
      // Le cœur est embarqué dans le paquet (hors ligne) ; les bibliothèques
      // scientifiques, trop lourdes pour l'être, viennent du CDN à la demande.
      packageBaseUrl: msg.packageBaseUrl,
      stdout: (t) => post({ type: "stdout", id: currentId, text: t + "\n" }),
      stderr: (t) => post({ type: "stderr", id: currentId, text: t + "\n" }),
    });
    pyodide.setStdin({ stdin: () => (stdinLines.length ? stdinLines.shift() + "\n" : null) });
    pyodide.FS.mkdirTree(PROJECT);
    pyodide.runPython(BOOTSTRAP);
    ready = true;
    post({ type: "status", state: "ready", version: pyodide.runPython("import sys; sys.version.split()[0]") });
  } catch (e) {
    post({ type: "status", state: "error", detail: String((e && e.message) || e) });
  }
}

/* ---- Fichiers du projet ------------------------------------------------- */
function clearProject() {
  const FS = pyodide.FS;
  const rm = (dir) => {
    for (const name of FS.readdir(dir)) {
      if (name === "." || name === "..") continue;
      const p = dir + "/" + name;
      if (FS.isDir(FS.stat(p).mode)) { rm(p); FS.rmdir(p); } else FS.unlink(p);
    }
  };
  rm(PROJECT);
}

function writeProject(files) {
  const FS = pyodide.FS;
  for (const [rel, f] of Object.entries(files || {})) {
    const abs = PROJECT + "/" + rel;
    const dir = abs.slice(0, abs.lastIndexOf("/"));
    if (dir) FS.mkdirTree(dir);
    if (f && typeof f.text === "string") FS.writeFile(abs, f.text);
    else if (f && f.b64) FS.writeFile(abs, Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)));
  }
}

function snapshot() { return pyodide.runPython(`_lumen_snapshot("${PROJECT}")`); }
function changedSince(before) {
  pyodide.globals.set("__lumen_before__", before);
  const json = pyodide.runPython(`_lumen_changed("${PROJECT}", __lumen_before__)`);
  pyodide.globals.delete("__lumen_before__");
  return JSON.parse(json);
}

/* ---- Exécution ----------------------------------------------------------- */
function freshNamespace(file) {
  const ns = pyodide.globals.get("dict")();
  ns.set("__name__", "__main__");
  ns.set("__file__", PROJECT + "/" + (file || "main.py"));
  ns.set("__builtins__", pyodide.globals.get("__builtins__"));
  return ns;
}

function cleanTraceback(msg) {
  // Les cadres internes de Pyodide n'aident personne : on garde le script.
  const lines = String(msg || "").split("\n");
  const out = [];
  let skip = false;
  for (const l of lines) {
    if (/^  File "\/lib\/python[\w.]+\/(site-packages\/)?(_pyodide|pyodide)\//.test(l)) { skip = true; continue; }
    if (skip && /^    /.test(l)) continue;
    skip = false;
    out.push(l);
  }
  return out.join("\n").trim();
}

async function run(msg) {
  const t0 = Date.now();
  currentId = msg.id;
  stdinLines = String(msg.stdin || "").split("\n").filter((_, i, a) => !(i === a.length - 1 && a[i] === ""));
  let ok = true, error = null, result = null, figures = [], files = {};
  try {
    if (msg.files) { clearProject(); writeProject(msg.files); }
    const before = snapshot();
    try {
      await pyodide.loadPackagesFromImports(msg.code, {
        messageCallback: (t) => post({ type: "stderr", id: msg.id, text: "[paquets] " + t + "\n" }),
      });
    } catch (e) {
      post({ type: "stderr", id: msg.id, text: "[paquets] " + String((e && e.message) || e) + "\n" });
    }
    if (msg.fresh || !namespace) namespace = freshNamespace(msg.file);
    try {
      const r = await pyodide.runPythonAsync(msg.code, { globals: namespace, filename: msg.file || "main.py" });
      if (r !== undefined && r !== null && msg.echo) result = String(r);
      if (r && typeof r.destroy === "function") r.destroy();
    } catch (e) {
      ok = false; error = cleanTraceback(e && e.message);
    }
    figures = pyodide.runPython("_lumen_figures()").toJs();
    files = changedSince(before);
    if (before && before.destroy) before.destroy();
  } catch (e) {
    ok = false; error = String((e && e.message) || e);
  }
  currentId = null;
  post({ type: "done", id: msg.id, ok, error, result, figures, files, ms: Date.now() - t0 });
}

async function repl(msg) {
  const t0 = Date.now();
  currentId = msg.id;
  let ok = true, error = null, result = null, figures = [];
  try {
    if (!namespace) namespace = freshNamespace();
    try { await pyodide.loadPackagesFromImports(msg.code); } catch {}
    const fn = pyodide.globals.get("_lumen_repl");
    const r = fn(msg.code, namespace);
    result = r == null ? null : String(r);
    figures = pyodide.runPython("_lumen_figures()").toJs();
  } catch (e) {
    ok = false; error = cleanTraceback(e && e.message);
  }
  currentId = null;
  post({ type: "done", id: msg.id, ok, error, result, figures, files: {}, ms: Date.now() - t0 });
}

async function install(msg) {
  currentId = msg.id;
  let ok = true, error = null;
  try {
    await pyodide.loadPackage("micropip", { messageCallback: () => {} });
    const micropip = pyodide.pyimport("micropip");
    for (const p of msg.packages) {
      post({ type: "stdout", id: msg.id, text: "Installation de " + p + "…\n" });
      await micropip.install(p);
    }
  } catch (e) {
    ok = false; error = cleanTraceback(e && e.message);
  }
  currentId = null;
  post({ type: "done", id: msg.id, ok, error, result: null, figures: [], files: {}, ms: 0 });
}

self.onmessage = (e) => {
  const msg = e.data || {};
  if (msg.type === "init") return init(msg);
  if (!ready) return post({ type: "done", id: msg.id, ok: false, error: "Interpréteur pas encore prêt." });
  if (msg.type === "run") return run(msg);
  if (msg.type === "repl") return repl(msg);
  if (msg.type === "install") return install(msg);
};
