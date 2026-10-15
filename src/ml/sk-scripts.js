// Scripts Python générés par l'onglet scikit-learn de l'Atelier ML. Ils
// tournent dans l'interpréteur de Lumen (Pyodide) : /project est la sandbox
// recopiée, tout ce qui y est écrit revient dans la sandbox. Le résultat
// structuré part sur stdout derrière le marqueur RESULT_MARK.

export const RESULT_MARK = "__LUMEN_RESULT__ ";

/** Script d'entraînement. `cfg` = { csv, target, algo, params, testSize, name, cv, outDir }. */
export function trainingScript(cfg) {
  return `
import json, sys, os, time, warnings
warnings.filterwarnings("ignore")
import numpy as np, pandas as pd, joblib
from sklearn.model_selection import train_test_split, cross_val_score
from sklearn.pipeline import Pipeline
from sklearn.compose import ColumnTransformer
from sklearn.preprocessing import StandardScaler, OneHotEncoder
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn import metrics

CFG = json.loads(${JSON.stringify(JSON.stringify(cfg))})
t0 = time.time()
def log(*a): print(*a); sys.stdout.flush()

df = pd.read_csv(CFG["csv"])
target = CFG["target"]
if target not in df.columns:
    raise SystemExit(f"Colonne cible « {target} » absente. Colonnes : {list(df.columns)}")
df = df.dropna(subset=[target])
y = df[target]
X = df.drop(columns=[target])
log(f"Dataset : {len(df)} lignes, {X.shape[1]} colonne(s) de features, cible « {target} »")

algo = CFG["algo"]; P = CFG.get("params", {})
regression = algo in ("linear_regression", "random_forest_regressor")
if not regression:
    y = y.astype(str)
    classes = sorted(y.unique().tolist())
    log(f"Classes ({len(classes)}) : {', '.join(classes)}")
else:
    y = pd.to_numeric(y, errors="coerce")
    keep = y.notna(); X, y = X[keep], y[keep]
    classes = []

obj_cols = [c for c in X.columns if X[c].dtype == object]
num_cols = [c for c in X.columns if c not in obj_cols]
text_mode = len(X.columns) == 1 and len(obj_cols) == 1
if text_mode:
    text_col = obj_cols[0]
    X = X[text_col].astype(str)
    pre = TfidfVectorizer(ngram_range=(1, 2), min_df=1, sublinear_tf=True, strip_accents="unicode", lowercase=True)
    log(f"Mode texte : TF-IDF (1-2 grammes) sur « {text_col} »")
else:
    text_col = None
    X[num_cols] = X[num_cols].apply(pd.to_numeric, errors="coerce").fillna(0)
    parts = []
    if num_cols: parts.append(("num", StandardScaler(), num_cols))
    if obj_cols: parts.append(("cat", OneHotEncoder(handle_unknown="ignore"), obj_cols))
    pre = ColumnTransformer(parts)
    log(f"Mode tabulaire : {len(num_cols)} numérique(s) standardisée(s), {len(obj_cols)} catégorielle(s) encodée(s)")

depth = int(P.get("max_depth") or 0) or None
if algo == "logistic_regression":
    from sklearn.linear_model import LogisticRegression
    model = LogisticRegression(C=float(P.get("C", 1.0)), max_iter=2000)
elif algo == "decision_tree":
    from sklearn.tree import DecisionTreeClassifier
    model = DecisionTreeClassifier(max_depth=depth, random_state=42)
elif algo == "random_forest":
    from sklearn.ensemble import RandomForestClassifier
    model = RandomForestClassifier(n_estimators=int(P.get("n_estimators", 100)), max_depth=depth, random_state=42)
elif algo == "gradient_boosting":
    from sklearn.ensemble import GradientBoostingClassifier
    model = GradientBoostingClassifier(n_estimators=int(P.get("n_estimators", 100)), learning_rate=float(P.get("lr", 0.1)), max_depth=depth or 3, random_state=42)
elif algo == "svm":
    from sklearn.svm import SVC
    model = SVC(C=float(P.get("C", 1.0)), kernel=P.get("kernel", "rbf"), probability=True, random_state=42)
elif algo == "knn":
    from sklearn.neighbors import KNeighborsClassifier
    model = KNeighborsClassifier(n_neighbors=int(P.get("k", 5)))
elif algo == "naive_bayes":
    if text_mode:
        from sklearn.naive_bayes import MultinomialNB; model = MultinomialNB()
    else:
        from sklearn.naive_bayes import GaussianNB; model = GaussianNB()
        if obj_cols: raise SystemExit("Naive Bayes gaussien : uniquement des features numériques.")
elif algo == "linear_regression":
    from sklearn.linear_model import LinearRegression; model = LinearRegression()
elif algo == "random_forest_regressor":
    from sklearn.ensemble import RandomForestRegressor
    model = RandomForestRegressor(n_estimators=int(P.get("n_estimators", 100)), max_depth=depth, random_state=42)
else:
    raise SystemExit(f"Algorithme inconnu : {algo}")

pipe = Pipeline([("pre", pre), ("model", model)])
test_size = float(CFG.get("testSize", 0.2))
strat = y if (not regression and y.value_counts().min() >= 2) else None
Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=test_size, random_state=42, stratify=strat)
log(f"Entraînement de {algo} sur {len(Xtr)} exemples, test sur {len(Xte)}…")
pipe.fit(Xtr, ytr)
log(f"Entraîné en {time.time() - t0:.1f} s")

res = {"algo": algo, "task": "regression" if regression else "classification", "n_train": int(len(Xtr)), "n_test": int(len(Xte)),
       "features": list(X.columns) if not text_mode else [], "text_column": text_col, "classes": classes,
       "numeric_columns": num_cols if not text_mode else [], "categorical_columns": obj_cols if not text_mode else [], "params": P}
pred = pipe.predict(Xte)
if regression:
    res["metrics"] = {"r2": float(metrics.r2_score(yte, pred)), "rmse": float(np.sqrt(metrics.mean_squared_error(yte, pred))), "mae": float(metrics.mean_absolute_error(yte, pred))}
    log(f"R² = {res['metrics']['r2']:.3f} · RMSE = {res['metrics']['rmse']:.3f}")
else:
    acc = metrics.accuracy_score(yte, pred)
    res["metrics"] = {"accuracy": float(acc),
        "precision": float(metrics.precision_score(yte, pred, average="weighted", zero_division=0)),
        "recall": float(metrics.recall_score(yte, pred, average="weighted", zero_division=0)),
        "f1": float(metrics.f1_score(yte, pred, average="weighted", zero_division=0))}
    res["confusion"] = metrics.confusion_matrix(yte, pred, labels=classes).tolist()
    res["report"] = metrics.classification_report(yte, pred, labels=classes, zero_division=0)
    log(f"Exactitude = {acc*100:.1f} % · F1 pondéré = {res['metrics']['f1']:.3f}")
    log(res["report"])
if CFG.get("cv"):
    try:
        scoring = "r2" if regression else "accuracy"
        scores = cross_val_score(pipe, X, y, cv=min(5, max(2, int(y.value_counts().min()) if not regression else 5)), scoring=scoring)
        res["cv"] = {"mean": float(scores.mean()), "std": float(scores.std()), "scores": [float(s) for s in scores]}
        log(f"Validation croisée ({scoring}) : {scores.mean():.3f} ± {scores.std():.3f}")
    except Exception as e:
        log("Validation croisée impossible :", e)

# Modèle linéaire sur features numériques seules : coefficients exportables
# (ONNX / Fluxo) sans dépendre de scikit-learn côté Pi.
if not text_mode and not obj_cols and algo in ("logistic_regression", "linear_regression") or (algo == "svm" and P.get("kernel") == "linear" and not text_mode and not obj_cols):
    sc = pipe.named_steps["pre"].named_transformers_["num"]
    m = pipe.named_steps["model"]
    coef = np.atleast_2d(m.coef_).tolist(); inter = np.atleast_1d(m.intercept_).tolist()
    res["linear"] = {"coef": coef, "intercept": inter, "mean": sc.mean_.tolist(), "scale": sc.scale_.tolist()}

out = CFG["outDir"]; os.makedirs(out, exist_ok=True)
joblib.dump(pipe, os.path.join(out, "model.joblib"))
res.update({"name": CFG["name"], "created": int(time.time()), "sklearn": __import__("sklearn").__version__, "python": sys.version.split()[0], "seconds": round(time.time() - t0, 1)})
with open(os.path.join(out, "model.json"), "w") as f: json.dump(res, f, ensure_ascii=False, indent=1)
for fname, body in CFG.get("extraFiles", {}).items():
    with open(os.path.join(out, fname), "w") as f: f.write(body)
log(f"Enregistré dans {out}")
print(${JSON.stringify(RESULT_MARK)} + json.dumps(res, ensure_ascii=False))
`;
}

/** Prédiction locale : `sample` = texte ou dict de features. */
export function predictScript(modelDir, sample) {
  return `
import json, warnings; warnings.filterwarnings("ignore")
import joblib, pandas as pd, numpy as np
meta = json.load(open(${JSON.stringify(modelDir + "/model.json")}))
pipe = joblib.load(${JSON.stringify(modelDir + "/model.joblib")})
sample = json.loads(${JSON.stringify(JSON.stringify(sample))})
if meta.get("text_column"):
    X = pd.Series([str(sample if isinstance(sample, str) else sample.get(meta["text_column"], ""))])
else:
    row = {c: sample.get(c, 0) for c in meta["features"]}
    for c in meta.get("numeric_columns", []):
        try: row[c] = float(row[c])
        except Exception: row[c] = 0.0
    X = pd.DataFrame([row])
pred = pipe.predict(X)[0]
out = {"prediction": pred.item() if hasattr(pred, "item") else pred}
if hasattr(pipe, "predict_proba"):
    try:
        proba = pipe.predict_proba(X)[0]
        out["probs"] = {str(c): float(p) for c, p in zip(pipe.classes_, proba)}
        out["proba"] = float(max(proba))
    except Exception: pass
print(${JSON.stringify(RESULT_MARK)} + json.dumps(out, ensure_ascii=False, default=str))
`;
}

/** Archive zip d'un dossier de modèle, renvoyée en base64. */
export function zipScript(modelDir) {
  return `
import io, os, zipfile, base64, json
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk(${JSON.stringify(modelDir)}):
        for f in files:
            p = os.path.join(root, f); z.write(p, os.path.relpath(p, ${JSON.stringify(modelDir)}))
print(${JSON.stringify(RESULT_MARK)} + json.dumps({"b64": base64.b64encode(buf.getvalue()).decode()}))
`;
}

/** Fichiers livrés avec chaque modèle : inférence en ligne de commande, serveur HTTP, dépendances. */
export function kitFiles(name) {
  return {
    "predict.py": `#!/usr/bin/env python3
"""Inférence avec le modèle « ${name} » entraîné dans l'Atelier ML de Lumen.

  python predict.py "allume la caméra"              # modèle texte
  python predict.py '{"x1": 1.5, "x2": 0.2}'        # modèle tabulaire (JSON)
"""
import json, os, sys, warnings
warnings.filterwarnings("ignore")
import joblib, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
META = json.load(open(os.path.join(HERE, "model.json")))
PIPE = joblib.load(os.path.join(HERE, "model.joblib"))

def predict(sample):
    """sample : texte (modèle texte) ou dict de features (tabulaire). Renvoie (label, proba)."""
    if META.get("text_column"):
        X = pd.Series([str(sample)])
    else:
        if isinstance(sample, str):
            try: sample = json.loads(sample)
            except ValueError:
                vals = [float(v) for v in sample.split(",")]
                sample = dict(zip(META["features"], vals))
        row = {c: sample.get(c, 0) for c in META["features"]}
        for c in META.get("numeric_columns", []):
            try: row[c] = float(row[c])
            except Exception: row[c] = 0.0
        X = pd.DataFrame([row])
    pred = PIPE.predict(X)[0]
    pred = pred.item() if hasattr(pred, "item") else pred
    proba = None
    if hasattr(PIPE, "predict_proba"):
        try: proba = float(max(PIPE.predict_proba(X)[0]))
        except Exception: pass
    return pred, proba

if __name__ == "__main__":
    arg = " ".join(sys.argv[1:]) or sys.stdin.read().strip()
    label, proba = predict(arg)
    print(json.dumps({"prediction": label, "proba": proba}, ensure_ascii=False))
`,
    "pi_server.py": `#!/usr/bin/env python3
"""Serveur d'inférence léger (stdlib seulement) pour « ${name} ».

  python pi_server.py --port 8010
  curl -X POST http://<pi>:8010/ -H 'Content-Type: application/json' -d '{"sample": "allume la led"}'

Le modèle reste en mémoire entre les requêtes. GET / renvoie l'état.
"""
import argparse, json, os, sys, time
from http.server import BaseHTTPRequestHandler, HTTPServer
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from predict import predict, META

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8010)
    ap.add_argument("--timeout", type=int, default=0, help="quitte après N s d'inactivité (0 = jamais)")
    args = ap.parse_args()
    state = {"last": time.time(), "count": 0}

    class Handler(BaseHTTPRequestHandler):
        def _send(self, obj, code=200):
            out = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(code); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out))); self.end_headers(); self.wfile.write(out)
        def do_GET(self):
            self._send({"status": "running", "model": META.get("name"), "algo": META.get("algo"), "requests": state["count"]})
        def do_POST(self):
            n = int(self.headers.get("Content-Length", 0)); raw = self.rfile.read(n)
            try:
                payload = json.loads(raw); sample = payload.get("sample", payload.get("features", ""))
            except Exception:
                sample = raw.decode()
            t = time.perf_counter()
            try:
                label, proba = predict(sample)
                self._send({"prediction": label, "proba": proba, "time": time.perf_counter() - t})
            except Exception as e:
                self._send({"error": str(e)}, 400)
            state["last"] = time.time(); state["count"] += 1
        def log_message(self, *a): pass

    srv = HTTPServer(("", args.port), Handler)
    print(f"Serveur « {META.get('name')} » sur le port {args.port}", flush=True)
    if args.timeout:
        import threading
        def watch():
            while True:
                time.sleep(1)
                if time.time() - state["last"] > args.timeout: os._exit(0)
        threading.Thread(target=watch, daemon=True).start()
    srv.serve_forever()

if __name__ == "__main__":
    main()
`,
    "requirements.txt": "scikit-learn\njoblib\npandas\nnumpy\n",
    "README.txt": `Modèle « ${name} » — Atelier ML de Lumen (scikit-learn)

Sur le Raspberry Pi :
  python3 -m venv ~/ml-env && ~/ml-env/bin/pip install -r requirements.txt
  ~/ml-env/bin/python predict.py "un exemple"
  ~/ml-env/bin/python pi_server.py --port 8010

model.joblib  : pipeline scikit-learn complet (prétraitement + modèle)
model.json    : métadonnées, métriques, colonnes attendues
`,
  };
}
