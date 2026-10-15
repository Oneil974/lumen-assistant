// Affichage SANS RISQUE du HTML d'un e-mail.
//
// Un e-mail HTML est du contenu hostile par défaut : scripts, formulaires qui
// imitent une page de connexion, pixels espions, feuilles de style qui
// chargent des images distantes (`url(…)`), balises `<base>` qui détournent
// les liens… Trois barrières indépendantes, chacune suffisante à elle seule
// contre les scripts :
//
//   1. **Assainissement** (`sanitizeMailHtml`) : liste BLANCHE de balises et
//      d'attributs. Tout le reste disparaît — scripts, iframes, formulaires,
//      images, SVG, médias, gestionnaires `on*`, `url(…)` dans les styles,
//      liens autres que http(s)/mailto.
//   2. **CSP propre au document** : `default-src 'none'` — aucune requête
//      réseau possible, même si quelque chose passait le filtre.
//   3. **iframe `sandbox`** sans `allow-scripts` : le moteur refuse d'exécuter
//      le moindre script dans ce document. `allow-same-origin` sert seulement
//      à ce que la page mesure sa hauteur et intercepte les clics sur liens,
//      qui s'ouvrent alors dans le navigateur du système.
//
// Par défaut les images ne sont PAS affichées (elles servent surtout au
// pistage de lecture) : une image porteuse d'un texte alternatif devient
// « [image : …] ». Sur demande de l'utilisateur, MESSAGE PAR MESSAGE (comme
// Outlook), `allowImages` garde les <img> en https:/data:image et ouvre
// `img-src` à ces seuls schémas — toujours sans referrer, sans script, et les
// `url(…)` des styles restent neutralisées.

const DROP = new Set([
  "script", "noscript", "iframe", "frame", "frameset", "object", "embed", "applet",
  "form", "input", "button", "select", "option", "textarea", "label", "fieldset",
  "link", "meta", "base", "title", "head", "svg", "math", "video", "audio", "source",
  "track", "picture", "canvas", "template", "portal", "dialog", "slot",
]);

const KEEP = new Set([
  "a", "abbr", "b", "blockquote", "br", "caption", "center", "cite", "code", "col",
  "colgroup", "dd", "del", "details", "div", "dl", "dt", "em", "font", "h1", "h2", "h3",
  "h4", "h5", "h6", "hr", "i", "ins", "kbd", "li", "mark", "ol", "p", "pre", "q", "s",
  "small", "span", "strike", "strong", "sub", "summary", "sup", "table", "tbody", "td",
  "tfoot", "th", "thead", "tr", "tt", "u", "ul", "style", "section", "article", "header",
  "footer", "main", "nav", "aside", "figure", "figcaption", "address", "time", "wbr",
]);

const ATTRS = new Set([
  "href", "title", "alt", "colspan", "rowspan", "align", "valign", "width", "height",
  "cellpadding", "cellspacing", "border", "bgcolor", "color", "face", "size", "dir",
  "lang", "style", "class", "start", "type", "open", "datetime", "cite", "span", "nowrap",
]);

/// Nettoie une déclaration CSS : plus aucune ressource externe ni
/// comportement actif, plus d'élément qui recouvre la page.
export function cleanCss(css) {
  return String(css || "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@import[^;]*;?/gi, "")
    .replace(/@font-face\s*\{[^}]*\}/gi, "")
    .replace(/url\s*\([^)]*\)/gi, "none")
    .replace(/image-set\s*\([^)]*\)/gi, "none")
    .replace(/expression\s*\(/gi, "(")
    .replace(/-moz-binding[^;}]*/gi, "")
    .replace(/behavior\s*:[^;}]*/gi, "")
    .replace(/position\s*:\s*(fixed|sticky)/gi, "position:static");
}

function safeHref(v) {
  const s = String(v || "").trim().replace(/[\u0000-\u001f\s]+/g, "");
  return /^(https?:|mailto:)/i.test(s) ? String(v).trim() : "";
}

/**
 * HTML d'e-mail → fragment HTML sûr (chaîne).
 * @param {string} html
 * @returns {{ html: string, blockedImages: number }}
 */
const IMG_SRC = /^(https:|data:image\/(png|jpe?g|gif|webp|bmp);)/i;

export function sanitizeMailHtml(html, { allowImages = false } = {}) {
  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  let blockedImages = 0;

  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 8) { child.remove(); continue; }          // commentaires (dont <!--[if mso]>)
      if (child.nodeType !== 1) continue;
      const tag = child.tagName.toLowerCase();
      if (tag === "img" || tag === "image") {
        const src = String(child.getAttribute("src") || "").trim();
        if (allowImages && tag === "img" && IMG_SRC.test(src)) {
          for (const a of [...child.attributes]) {
            if (!["src", "alt", "width", "height", "style", "align", "border", "title"].includes(a.name.toLowerCase())) child.removeAttribute(a.name);
          }
          if (child.hasAttribute("style")) child.setAttribute("style", cleanCss(child.getAttribute("style")));
          child.setAttribute("referrerpolicy", "no-referrer");
          child.setAttribute("loading", "lazy");
          continue;
        }
        blockedImages++;
        const alt = (child.getAttribute("alt") || "").trim();
        if (alt) {
          const ph = doc.createElement("span");
          ph.className = "lm-img";
          ph.textContent = `[image : ${alt.slice(0, 80)}]`;
          child.replaceWith(ph);
        } else {
          child.remove();
        }
        continue;
      }
      if (DROP.has(tag)) { child.remove(); continue; }
      if (!KEEP.has(tag)) {
        // Balise inconnue (o:p, custom elements…) : on garde son contenu.
        walk(child);
        child.replaceWith(...child.childNodes);
        continue;
      }
      if (tag === "style") {
        child.textContent = cleanCss(child.textContent);
        for (const a of [...child.attributes]) child.removeAttribute(a.name);
        continue;
      }
      for (const a of [...child.attributes]) {
        const name = a.name.toLowerCase();
        if (!ATTRS.has(name)) { child.removeAttribute(a.name); continue; }
        if (name === "href") {
          const h = safeHref(a.value);
          if (h) child.setAttribute("href", h); else child.removeAttribute("href");
        } else if (name === "style") {
          child.setAttribute("style", cleanCss(a.value));
        }
      }
      if (tag === "a" && child.hasAttribute("href")) child.setAttribute("rel", "noopener noreferrer");
      walk(child);
    }
  };

  // Les <style> du <head> portent souvent toute la mise en page : on les
  // récupère avant de jeter le <head>.
  const headStyles = [...doc.head.querySelectorAll("style")].map((s) => `<style>${cleanCss(s.textContent)}</style>`).join("");
  walk(doc.body);
  return { html: headStyles + doc.body.innerHTML, blockedImages };
}

const FRAME_CSP = (allowImages) => `default-src 'none'; style-src 'unsafe-inline'; img-src ${allowImages ? "https: data:" : "'none'"}; font-src 'none'; media-src 'none'; frame-src 'none'; form-action 'none'`;

/**
 * Monte le HTML assaini dans une iframe isolée à l'intérieur de `host`.
 * @param {HTMLElement} host
 * @param {string} rawHtml
 * @param {{ openLink?: (url: string) => void, allowImages?: boolean }} [opts]
 * @returns {{ blockedImages: number }}
 */
export function renderMailHtml(host, rawHtml, opts = {}) {
  const allowImages = Boolean(opts.allowImages);
  const { html, blockedImages } = sanitizeMailHtml(rawHtml, { allowImages });
  host.replaceChildren();
  const frame = document.createElement("iframe");
  frame.className = "mail-html-frame";
  // PAS de allow-scripts : c'est la barrière décisive. Ni allow-forms, ni
  // allow-popups, ni allow-top-navigation.
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("title", "Message");
  frame.style.width = "100%";
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP(allowImages)}">
<style>
  html,body{margin:0;padding:0;background:#fff;color:#1a1a1a}
  body{padding:16px 18px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;overflow-wrap:anywhere}
  table{max-width:100%!important}
  img{max-width:100%;height:auto}
  a{color:#2563eb}
  .lm-img{display:inline-block;padding:1px 6px;border-radius:4px;background:#f1f1f1;color:#777;font-size:12px}
  blockquote{margin:6px 0 6px 4px;padding-left:10px;border-left:3px solid #ddd;color:#555}
</style></head><body>${html}</body></html>`;

  const fit = () => {
    try {
      const d = frame.contentDocument;
      if (!d?.documentElement) return;
      frame.style.height = `${Math.max(80, d.documentElement.scrollHeight)}px`;
    } catch {}
  };
  frame.addEventListener("load", () => {
    fit();
    try {
      const d = frame.contentDocument;
      // Tous les liens partent dans le navigateur du système : rien ne navigue
      // à l'intérieur de l'iframe.
      d.addEventListener("click", (e) => {
        const a = e.target.closest?.("a[href]");
        if (!a) return;
        e.preventDefault();
        const href = safeHref(a.getAttribute("href"));
        if (href) opts.openLink?.(href);
      });
      new ResizeObserver(fit).observe(d.documentElement);
      // Les images arrivent après « load » : chacune réajuste la hauteur.
      for (const img of d.images) img.addEventListener("load", fit);
    } catch {}
  });
  host.appendChild(frame);
  return { blockedImages };
}
