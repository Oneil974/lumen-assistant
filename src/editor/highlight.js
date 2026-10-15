// Coloration syntaxique légère (Monokai). Produit du HTML avec des classes
// `tok-*` ; les couleurs (claires/sombres) sont définies dans styles.css. Volon-
// tairement simple — pas un vrai parseur — mais couvre HTML/CSS/JS/JSON/Python,
// soit l'essentiel des mini-apps HTML créées par App Studio.

const KEYWORDS = {
  js: new Set("const let var function return if else for while do switch case break continue new class extends super this typeof instanceof in of try catch finally throw await async yield import export from default delete void null true false undefined NaN".split(" ")),
  css: new Set("important inherit initial unset none auto flex grid block inline absolute relative fixed static sticky".split(" ")),
  python: new Set("def class return if elif else for while break continue import from as try except finally raise with lambda yield global nonlocal pass and or not in is None True False print self async await".split(" ")),
  json: new Set("true false null".split(" ")),
};

function esc(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

export function langFromName(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (["html", "htm", "xhtml"].includes(ext)) return "html";
  if (["css"].includes(ext)) return "css";
  if (["js", "mjs", "jsx", "ts", "tsx"].includes(ext)) return "js";
  if (["json"].includes(ext)) return "json";
  if (["py"].includes(ext)) return "python";
  if (["md", "markdown"].includes(ext)) return "md";
  return "text";
}

// ----- Tokeniseur générique (langages « à accolades » + python) -----
function highlightGeneric(code, lang) {
  const kw = KEYWORDS[lang] || KEYWORDS.js;
  const re = /(\/\*[\s\S]*?\*\/)|(\/\/[^\n]*)|(#[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b0x[\da-fA-F]+\b|\b\d[\d.]*\b)|([A-Za-z_$][\w$]*)|(\s+)|([\s\S])/g;
  let out = "", m;
  while ((m = re.exec(code))) {
    if (m[1] || m[2] || (m[3] && lang === "python")) out += `<span class="tok-comment">${esc(m[1] || m[2] || m[3])}</span>`;
    else if (m[3] && lang !== "python") out += esc(m[3]); // # hors python = ponctuation
    else if (m[4]) out += `<span class="tok-string">${esc(m[4])}</span>`;
    else if (m[5]) out += `<span class="tok-number">${esc(m[5])}</span>`;
    else if (m[6]) {
      const w = m[6];
      const after = code[re.lastIndex];
      if (kw.has(w)) out += `<span class="tok-keyword">${esc(w)}</span>`;
      else if (after === "(") out += `<span class="tok-fn">${esc(w)}</span>`;
      else if (/^[A-Z]/.test(w)) out += `<span class="tok-type">${esc(w)}</span>`;
      else out += esc(w);
    } else out += esc(m[0]);
  }
  return out;
}

// ----- HTML (avec délégation aux blocs <script>/<style>) -----
function highlightHtml(code) {
  const re = /<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>|<\/?[A-Za-z!][^>]*?>|[^<]+/g;
  let out = "", m;
  while ((m = re.exec(code))) {
    const t = m[0];
    if (t.startsWith("<!--")) out += `<span class="tok-comment">${esc(t)}</span>`;
    else if (/^<script\b/i.test(t)) out += embed(t, "script", "js");
    else if (/^<style\b/i.test(t)) out += embed(t, "style", "css");
    else if (t[0] === "<") out += highlightTag(t);
    else out += esc(t);
  }
  return out;
}
function embed(block, tag, lang) {
  const open = block.match(new RegExp(`^<${tag}\\b[^>]*>`, "i"))[0];
  const close = block.match(new RegExp(`</${tag}>$`, "i"));
  const inner = block.slice(open.length, close ? block.length - close[0].length : block.length);
  return highlightTag(open) + highlightGeneric(inner, lang) + (close ? highlightTag(close[0]) : "");
}
function highlightTag(t) {
  // <tag attr="val" ...>  →  ponctuation + nom + attributs + chaînes
  return t.replace(/("(?:\\.|[^"\\])*"|'(?:[^'\\]|\\.)*')|(&|<\/?|\/?>)|([A-Za-z][\w-]*)(=)?/g,
    (whole, str, punct, word, eq) => {
      if (str) return `<span class="tok-string">${esc(str)}</span>`;
      if (punct) return `<span class="tok-punct">${esc(punct)}</span>`;
      if (word) {
        const cls = eq ? "tok-attr" : "tok-tag";
        return `<span class="${cls}">${esc(word)}</span>` + (eq ? `<span class="tok-punct">=</span>` : "");
      }
      return esc(whole);
    });
}

// ----- Markdown (titres, gras, code) -----
function highlightMd(code) {
  return esc(code)
    .replace(/^(#{1,6} .*)$/gm, '<span class="tok-keyword">$1</span>')
    .replace(/(\*\*[^*]+\*\*|`[^`]+`)/g, '<span class="tok-string">$1</span>');
}

export function highlight(code, lang) {
  if (lang === "html") return highlightHtml(code);
  if (lang === "md") return highlightMd(code);
  if (lang === "text") return esc(code);
  return highlightGeneric(code, lang);
}
