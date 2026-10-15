// Composants monétaires communs à Budget (personnel) et Relia (commercial).
// Seuls les FORMATS sont partagés : les données, les règles (TVA, catégories
// de dépenses) et les parcours restent propres à chaque app.

const LOCALE = () => (globalThis.document?.documentElement?.lang === "en" ? "en-GB" : "fr-FR");
const cache = new Map();

/** « 1 234,50 € » — montant formaté dans la devise donnée (EUR par défaut). */
export function formatMoney(n, currency = "EUR") {
  const key = `${LOCALE()}|${currency}`;
  if (!cache.has(key)) cache.set(key, new Intl.NumberFormat(LOCALE(), { style: "currency", currency }));
  return cache.get(key).format(Number(n) || 0);
}

/** Arrondi au centime, en nombre (évite 0.1 + 0.2). */
export const roundCents = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Montant saisi (« 1 234,5 », « 12.30 € ») → nombre, ou NaN. */
export function parseMoney(s) {
  const t = String(s ?? "").replace(/[\s €$£]/g, "").replace(/,(?=\d{1,2}$)/, ".").replace(/,/g, "");
  return t === "" ? NaN : Number(t);
}
