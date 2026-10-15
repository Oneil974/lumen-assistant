// GPL information, readable from Settings. Running Lumen requires no EULA acceptance.
export const LICENSE_VERSION = "GPL-3.0-or-later";
export const LICENSE_TEXT = {
  fr: {
    title: "Licence libre de Lumen",
    subtitle: "GPL-3.0-or-later · © 2026 Mickael Hoarau",
    lead: "Vous pouvez utiliser, étudier, modifier et redistribuer Lumen, y compris commercialement.",
    sections: [
      ["Vos libertés", "Le code original de Lumen est sous GNU GPL version 3 ou ultérieure, à votre choix. Les versions dérivées distribuées doivent respecter la GPL et fournir leur code source correspondant."],
      ["Sans garantie", "Lumen est fourni en l’état, sans garantie, notamment de qualité marchande ou d’adéquation à un usage particulier. Les résultats de l’IA doivent être vérifiés."],
      ["Composants tiers", "Les bibliothèques, modèles, voix et ressources tierces gardent leurs licences. Consultez THIRD_PARTY_NOTICES.md dans les sources."],
      ["Texte complet", "Le texte intégral officiel de la GPLv3 est disponible dans COPYING à la racine des sources et dans le fichier COPYING livré avec cette application (legal/COPYING.txt)."],
      ["Confidentialité", "L’inférence peut fonctionner localement. Les fonctions web, messagerie, synchronisation et fournisseurs distants utilisent le réseau lorsqu’ils sont activés."],
    ],
    close: "Fermer", acceptedOn: () => "Aucune acceptation supplémentaire requise.",
  },
  en: {
    title: "Lumen free software license",
    subtitle: "GPL-3.0-or-later · © 2026 Mickael Hoarau",
    lead: "You may use, study, modify and redistribute Lumen, including commercially.",
    sections: [
      ["Your freedoms", "Original Lumen code is licensed under GNU GPL version 3 or, at your option, any later version. Distributed derived versions must comply with the GPL and provide their corresponding source."],
      ["No warranty", "Lumen is provided as is, without warranty, including merchantability or fitness for a particular purpose. Verify AI output."],
      ["Third-party components", "Libraries, models, voices and third-party assets retain their own licenses. See THIRD_PARTY_NOTICES.md in the sources."],
      ["Full license", "The complete official GPLv3 text is in COPYING at the source root and legal/COPYING.txt shipped with this application."],
      ["Privacy", "Inference can run locally. Web, messaging, synchronisation and remote provider features use the network when enabled."],
    ],
    close: "Close", acceptedOn: () => "No additional acceptance required.",
  },
};

function lang() {
  let saved = "";
  try { saved = localStorage.getItem("lang") || ""; } catch {}
  return (saved || navigator.language || "fr").toLowerCase().startsWith("en") ? "en" : "fr";
}

// Retained exports for callers from older interfaces. GPL execution needs no EULA.
export function acceptedVersion() { return LICENSE_VERSION; }
export function licenseAcceptedAt() { return ""; }
export function hasAcceptedLicense() { return true; }
export async function ensureLicenseAccepted() { return true; }

function esc(s) {
  const element = document.createElement("div");
  element.textContent = String(s ?? "");
  return element.innerHTML;
}

export function showLicense() {
  return new Promise(resolve => {
    const L = LICENSE_TEXT[lang()];
    const el = document.createElement("div");
    el.className = "lumen-eula readonly";
    el.innerHTML = `
      <div class="lumen-eula-card" role="dialog" aria-modal="true" aria-labelledby="lumen-eula-title">
        <header class="lumen-eula-head"><div class="lumen-eula-logo">L</div><div>
          <h1 id="lumen-eula-title">${esc(L.title)}</h1>
          <p class="lumen-eula-sub">${esc(L.subtitle)}</p>
        </div></header>
        <p class="lumen-eula-lead">${esc(L.lead)}</p>
        <div class="lumen-eula-body" tabindex="0">
          ${L.sections.map(([h, body]) => `<h2>${esc(h)}</h2><p>${esc(body)}</p>`).join("")}
          <p><a href="/legal/COPYING.txt" target="_blank" rel="noopener">GNU General Public License v3 — full text</a></p>
        </div>
        <footer class="lumen-eula-foot"><span class="lumen-eula-sp"></span>
          <button type="button" class="lumen-eula-btn primary">${esc(L.close)}</button>
        </footer>
      </div>`;
    const previous = document.activeElement;
    const close = () => {
      document.removeEventListener("keydown", onKey);
      el.remove(); previous?.focus?.(); resolve(false);
    };
    const onKey = event => { if (event.key === "Escape") close(); };
    el.querySelector("button").addEventListener("click", close);
    el.addEventListener("click", event => { if (event.target === el) close(); });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(el);
    el.querySelector("button").focus();
  });
}
