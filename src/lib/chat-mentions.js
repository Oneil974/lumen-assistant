/**
 * Menus « @ » (outils) et « # » (documents) des barres de chat.
 *
 * Un seul module pour les deux surfaces de discussion (barre principale et
 * barre du bureau) : le déclencheur, la navigation clavier et le rendu de la
 * liste sont identiques, seules les SOURCES de données et l'action de sélection
 * changent — elles sont injectées par l'appelant.
 *
 * Le menu est volontairement indépendant du mode de discussion : mentionner un
 * outil avec « @ » doit marcher en discussion simple comme en mode Outils, et
 * joindre un document avec « # » ne dépend pas du mode Documents.
 */

/// Jeton en cours de frappe, juste avant le curseur. On n'ouvre le menu que si
/// le « @ » / « # » démarre un mot (début de texte ou après une espace) : une
/// adresse e-mail ou un « #1 » collé à un mot ne doit rien déclencher.
export function tokenAtCaret(text, caret) {
  const before = text.slice(0, caret);
  const m = /(^|\s)([@#])([^\s@#]*)$/.exec(before);
  if (!m) return null;
  return { sigil: m[2], query: m[3], start: caret - m[3].length - 1, end: caret };
}

/// Filtre + classe les entrées : préfixe d'abord, puis sous-chaîne.
export function filterItems(items, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return items.slice(0, 40);
  const scored = [];
  for (const it of items) {
    const hay = `${it.label} ${it.sub || ''}`.toLowerCase();
    const label = it.label.toLowerCase();
    let score = -1;
    if (label.startsWith(q)) score = 0;
    else if (label.includes(q)) score = 1;
    else if (hay.includes(q)) score = 2;
    if (score >= 0) scored.push([score, it]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].label.localeCompare(b[1].label));
  return scored.slice(0, 40).map(([, it]) => it);
}

/**
 * Branche les menus sur un champ de saisie.
 *
 * @param {object} o
 * @param {HTMLInputElement|HTMLTextAreaElement} o.input champ de la barre
 * @param {HTMLElement} [o.anchor] élément sous/au-dessus duquel poser le menu
 * @param {() => Promise<Array>} o.listTools entrées « @ » : { id, label, sub, avatar? }
 * @param {() => Promise<Array>} o.listFiles entrées « # » : { id, label, sub }
 * @param {(item) => void} o.onTool sélection d'un outil
 * @param {(item) => void} o.onFile sélection d'un document
 * @param {{tools?: string, files?: string}} [o.labels] en-têtes des deux menus
 * @returns {{ close: () => void, destroy: () => void }}
 */
export function initChatMentions(o) {
  const { input } = o;
  const labels = o.labels || {};
  const menu = document.createElement('div');
  menu.className = 'mention-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'listbox');
  document.body.appendChild(menu);

  let items = [];      // entrées affichées
  let active = 0;      // index surligné
  let token = null;    // jeton en cours
  let seq = 0;         // anti-course : seule la dernière requête peut rendre

  const isOpen = () => !menu.hidden;

  function close() {
    menu.hidden = true;
    menu.innerHTML = '';
    items = [];
    token = null;
  }

  function place() {
    const r = (o.anchor || input).getBoundingClientRect();
    const width = Math.min(Math.max(r.width, 260), 460);
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - width - 8))}px`;
    // Au-dessus de la barre si la place manque en dessous (la barre principale
    // est souvent collée en bas de l'écran).
    const below = window.innerHeight - r.bottom;
    const h = menu.offsetHeight || 240;
    if (below < h + 16 && r.top > h + 16) {
      menu.style.top = `${r.top - h - 8}px`;
    } else {
      menu.style.top = `${r.bottom + 8}px`;
    }
  }

  function render() {
    if (!items.length) { close(); return; }
    active = Math.max(0, Math.min(active, items.length - 1));
    menu.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'mention-head';
    head.textContent = token?.sigil === '@'
      ? (labels.tools || 'Outils — ↑↓ pour choisir, Entrée pour insérer')
      : (labels.files || 'Documents — ↑↓ pour choisir, Entrée pour joindre');
    menu.appendChild(head);
    items.forEach((it, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'mention-item' + (i === active ? ' is-active' : '');
      row.setAttribute('role', 'option');
      row.innerHTML = '';
      // Agents : leur avatar précède le nom (HTML produit par lib/agent-avatar.js).
      if (it.avatar) {
        const av = document.createElement('span');
        av.className = 'mention-av';
        av.style.cssText = 'flex:none;display:inline-grid;place-items:center;margin-right:2px';
        av.innerHTML = it.avatar;
        row.appendChild(av);
      }
      const label = document.createElement('span');
      label.className = 'mention-label';
      label.textContent = it.label;
      row.appendChild(label);
      if (it.sub) {
        const sub = document.createElement('span');
        sub.className = 'mention-sub';
        sub.textContent = it.sub;
        row.appendChild(sub);
      }
      // `mousedown` et non `click` : le champ ne doit pas perdre le focus avant
      // qu'on réécrive sa valeur (sinon le curseur saute à la fin sous WebKit).
      row.addEventListener('mousedown', (e) => { e.preventDefault(); choose(i); });
      menu.appendChild(row);
    });
    menu.hidden = false;
    place();
    menu.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }

  /// Retire le jeton « @xxx » / « #xxx » du champ et remet le curseur en place.
  function replaceToken(text) {
    if (!token) return;
    const v = input.value;
    const next = v.slice(0, token.start) + text + v.slice(token.end);
    input.value = next;
    const pos = token.start + text.length;
    input.setSelectionRange(pos, pos);
    // La barre principale redimensionne son textarea sur `input` : il faut donc
    // notifier l'écriture programmatique, qui n'émet rien d'elle-même.
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  }

  function choose(i) {
    const it = items[i];
    if (!it) return;
    const sigil = token?.sigil;
    if (sigil === '@') {
      // La mention reste visible dans le texte : elle dit au modèle (et à
      // l'utilisateur) quel outil a été demandé.
      replaceToken(`@${it.label} `);
      close();
      o.onTool?.(it);
    } else {
      // Le document devient une pastille de pièce jointe : garder « #nom » dans
      // le texte ferait doublon avec elle.
      replaceToken('');
      close();
      o.onFile?.(it);
    }
  }

  async function refresh() {
    const caret = input.selectionStart ?? input.value.length;
    const tok = tokenAtCaret(input.value, caret);
    if (!tok) { close(); return; }
    token = tok;
    const mine = ++seq;
    let all = [];
    try {
      all = (tok.sigil === '@' ? await o.listTools?.() : await o.listFiles?.()) || [];
    } catch { all = []; }
    if (mine !== seq) return;           // frappe plus récente : on abandonne
    const still = tokenAtCaret(input.value, input.selectionStart ?? 0);
    if (!still || still.sigil !== tok.sigil) { close(); return; }
    token = still;
    items = filterItems(all, still.query);
    if (!items.length) {
      // Rien ne correspond : on ferme plutôt que d'afficher une liste vide, la
      // frappe suivante rouvrira le menu si elle redevient pertinente.
      close();
      return;
    }
    active = 0;
    render();
  }

  const onInput = () => { refresh(); };
  const onKeyDown = (e) => {
    if (!isOpen()) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; render(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); choose(active); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  };
  const onBlur = () => setTimeout(close, 120);
  const onDocDown = (e) => { if (!menu.contains(e.target) && e.target !== input) close(); };

  // `keydown` en capture : la barre envoie le message sur Entrée, il faut lui
  // passer devant tant que le menu est ouvert.
  input.addEventListener('keydown', onKeyDown, true);
  input.addEventListener('input', onInput);
  input.addEventListener('click', onInput);
  input.addEventListener('blur', onBlur);
  document.addEventListener('mousedown', onDocDown);
  window.addEventListener('resize', () => { if (isOpen()) place(); });

  return {
    close,
    destroy() {
      input.removeEventListener('keydown', onKeyDown, true);
      input.removeEventListener('input', onInput);
      input.removeEventListener('click', onInput);
      input.removeEventListener('blur', onBlur);
      document.removeEventListener('mousedown', onDocDown);
      menu.remove();
    },
  };
}

// ===== Affichage des mentions en pastilles =====

/// Une mention d'outil : « @nom_outil » en début de mot. Même forme que le
/// résolveur d'outils côté barre — ce qui s'affiche en pastille est exactement
/// ce qui sera reconnu à l'envoi.
const MENTION_RE = /(^|[\s(\[])@([A-Za-z0-9_.-]{2,64})/g;

/// Noms d'outils mentionnés dans un texte, sans doublon et dans l'ordre.
export function mentionNames(text) {
  const out = [];
  for (const m of String(text || '').matchAll(MENTION_RE)) {
    if (!out.includes(m[2])) out.push(m[2]);
  }
  return out;
}

/// Remplace les mentions par des pastilles dans du HTML DÉJÀ rendu.
///
/// Le remplacement ne touche que le texte hors balises, et saute le contenu des
/// blocs `<code>`/`<pre>` : une adresse ou un décorateur Python cité dans un
/// extrait de code n'est pas un appel d'outil.
export function decorateMentions(html) {
  const parts = String(html ?? '').split(/(<[^>]*>)/);
  let skip = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i % 2 === 1) {
      // Balise : on suit seulement l'ouverture/fermeture des zones de code.
      if (/^<(code|pre)[\s>]/i.test(part)) skip++;
      else if (/^<\/(code|pre)>/i.test(part)) skip = Math.max(0, skip - 1);
      continue;
    }
    if (skip || part.indexOf('@') < 0) continue;
    parts[i] = part.replace(MENTION_RE, (_all, before, name) =>
      `${before}<span class="mention-chip">@${name}</span>`);
  }
  return parts.join('');
}

// ===== Mentions en pastilles DANS le champ de saisie =====
//
// Le champ reste un `<textarea>`/`<input>` : c'est ce qui garde intacts
// l'auto-dimensionnement, le placeholder, la dictée, le collage, la sélection
// native et tout le code qui lit `input.value`. Un contenteditable aurait
// remplacé tout cela par une réimplémentation fragile.
//
// À la place, on peint un calque JUMEAU sous le champ : même police, mêmes
// marges intérieures, même retour à la ligne, donc mêmes positions de
// caractères. Le champ, lui, passe son texte en transparent (le curseur reste
// visible). La pastille est un fond arrondi posé avec `padding` compensé par une
// `margin` négative de même valeur : elle ne décale AUCUN caractère, sans quoi
// le calque et le texte réel se désaligneraient.

/// Propriétés qui déterminent la position des caractères : toutes doivent être
/// recopiées du champ vers le calque.
const MIRRORED_STYLES = [
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontVariant",
  "letterSpacing", "wordSpacing", "lineHeight", "textAlign", "textIndent",
  "textTransform", "direction",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
];

function escapeText(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Affiche les « @outil » du champ sous forme de pastilles, en place.
 *
 * @param {HTMLTextAreaElement|HTMLInputElement} input
 * @param {{ known?: () => string[] }} [o] `known` restreint aux outils réellement
 *   disponibles : un « @ » suivi d'un mot quelconque reste du texte normal.
 * @returns {{ refresh: () => void, destroy: () => void }}
 */
export function initMentionHighlight(input, o = {}) {
  const layer = document.createElement("div");
  layer.className = "mention-layer";
  layer.setAttribute("aria-hidden", "true");
  layer.hidden = true;
  const host = input.parentElement || document.body;
  if (getComputedStyle(host).position === "static") host.style.position = "relative";
  host.insertBefore(layer, input);

  const isTextarea = input.tagName === "TEXTAREA";
  let raf = 0;
  let timer = 0;
  // Couleur du texte à l'état NORMAL, mémorisée pour le curseur. Elle doit être
  // lue pendant que le champ est encore encré : relire `color` alors que
  // `mention-lit` l'a déjà rendu transparent renvoie « transparent », et le
  // curseur disparaît pour de bon — c'est ce qui arrivait dès la deuxième
  // frappe après un « @outil ».
  let inkColor = "";

  function paint() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (timer) { clearTimeout(timer); timer = 0; }
    const known = o.known?.() || [];
    const names = mentionNames(input.value).filter((n) => !known.length || known.includes(n));
    if (!names.length) {
      layer.hidden = true;
      input.classList.remove("mention-lit");
      // Le champ redevient encré : plus de couleur de curseur en ligne, c'est
      // la feuille de style qui reprend la main.
      input.style.caretColor = "";
      return;
    }
    const cs = getComputedStyle(input);
    // Le curseur doit rester visible alors que le texte devient transparent :
    // on fige sa couleur AVANT de retirer celle du texte, et on ne la relit pas
    // tant que le champ reste peint par le calque.
    if (!input.classList.contains("mention-lit")) inkColor = cs.color;
    input.style.caretColor = inkColor || cs.color;
    input.classList.add("mention-lit");

    for (const prop of MIRRORED_STYLES) layer.style[prop] = cs[prop];
    layer.style.whiteSpace = isTextarea ? "pre-wrap" : "pre";
    layer.style.overflowWrap = cs.overflowWrap;
    layer.style.wordBreak = cs.wordBreak;
    layer.style.borderStyle = "solid";
    layer.style.borderColor = "transparent";

    const hostRect = host.getBoundingClientRect();
    const rect = input.getBoundingClientRect();
    layer.style.left = `${rect.left - hostRect.left + host.scrollLeft}px`;
    layer.style.top = `${rect.top - hostRect.top + host.scrollTop}px`;
    layer.style.width = `${rect.width}px`;
    layer.style.height = `${rect.height}px`;

    const marked = escapeText(input.value).replace(MENTION_RE, (all, before, name) =>
      names.includes(name) ? `${before}<span class="mention-mark">@${name}</span>` : all);
    // Le `\n` final d'un textarea ne crée pas de ligne dans un div : on ajoute
    // une espace insécable pour que la hauteur peinte suive celle du champ.
    // Le texte peint vit dans un enfant DÉPLACÉ par transform, pas dans un
    // calque qu'on ferait défiler : un div n'accepte un scrollLeft que jusqu'à
    // la largeur de son propre contenu, et un <input> défile un peu plus loin
    // (il garde le curseur visible en fin de texte). Le calque restait alors
    // en retrait de quelques pixels et le curseur semblait décalé du texte.
    layer.innerHTML = `<div class="mention-layer-inner">${marked}${isTextarea && input.value.endsWith("\n") ? "&nbsp;" : ""}</div>`;
    layer.hidden = false;
    syncScroll();
    // Le champ ne défile qu'APRÈS avoir traité la frappe : on resynchronise au
    // rendu suivant, une fois sa position de défilement définitive.
    requestAnimationFrame(syncScroll);
  }

  function syncScroll() {
    const inner = layer.firstElementChild;
    if (!inner) return;
    inner.style.transform = `translate(${-input.scrollLeft}px, ${-input.scrollTop}px)`;
  }

  /// Peinture au prochain rendu, avec un filet de sécurité : dans une fenêtre
  /// masquée (barre repliée, onglet en arrière-plan) `requestAnimationFrame` ne
  /// se déclenche pas, et sans ce délai le calque restait figé — définitivement —
  /// sur l'état d'avant le masquage.
  function refresh() {
    if (raf) cancelAnimationFrame(raf);
    if (timer) clearTimeout(timer);
    raf = requestAnimationFrame(paint);
    timer = setTimeout(paint, 80);
  }

  const onScroll = () => syncScroll();
  input.addEventListener("input", refresh);
  input.addEventListener("scroll", onScroll);
  // Un <input> défile quand le curseur se déplace (flèches, clic, fin de
  // ligne) sans toujours émettre `scroll` : on suit aussi la sélection.
  input.addEventListener("keyup", onScroll);
  input.addEventListener("click", onScroll);
  const onSelection = () => { if (document.activeElement === input) onScroll(); };
  document.addEventListener("selectionchange", onSelection);
  window.addEventListener("resize", refresh);
  // L'auto-dimensionnement du champ (barre principale) change sa hauteur sans
  // qu'aucun évènement ne parte : on observe la boîte elle-même.
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(refresh) : null;
  ro?.observe(input);
  refresh();

  return {
    refresh,
    destroy() {
      input.removeEventListener("input", refresh);
      input.removeEventListener("scroll", onScroll);
      input.removeEventListener("keyup", onScroll);
      input.removeEventListener("click", onScroll);
      document.removeEventListener("selectionchange", onSelection);
      if (raf) cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
      window.removeEventListener("resize", refresh);
      ro?.disconnect();
      input.classList.remove("mention-lit");
      input.style.caretColor = "";
      layer.remove();
    },
  };
}
