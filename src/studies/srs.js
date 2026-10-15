// Répétition espacée et planning de révision — fonctions pures, testées par
// scripts/test-studies.mjs.
//
// Fiches : algorithme SM-2 (celui d'Anki, simplifié). Chaque fiche porte
//   { ease: facilité (≥ 1,3), interval: jours, reps: réussites d'affilée,
//     due: échéance (ms), lapses: oublis }.
// Notes de révision : 0 = « à revoir » (oubliée), 1 = difficile, 2 = bien,
// 3 = facile.

const DAY = 86_400_000;

export function newCard(front, back, extra = {}) {
  return { id: `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, front, back, ease: 2.5, interval: 0, reps: 0, lapses: 0, due: Date.now(), created: Date.now(), ...extra };
}

/** Nouvelle échéance après une révision notée `grade` (0–3) à l'instant `now`. */
export function review(card, grade, now = Date.now()) {
  const c = { ...card };
  if (grade === 0) {
    c.reps = 0;
    c.lapses = (c.lapses || 0) + 1;
    c.interval = 0;
    c.ease = Math.max(1.3, c.ease - 0.2);
    c.due = now + 10 * 60 * 1000; // revue dans la séance
  } else {
    const q = grade + 2; // 3..5 sur l'échelle SM-2
    c.ease = Math.max(1.3, c.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
    c.reps = (c.reps || 0) + 1;
    if (c.reps === 1) c.interval = grade === 3 ? 3 : 1;
    else if (c.reps === 2) c.interval = grade === 1 ? 3 : 6;
    else c.interval = Math.round(c.interval * c.ease * (grade === 1 ? 0.8 : grade === 3 ? 1.3 : 1));
    c.interval = Math.max(1, Math.min(365, c.interval));
    c.due = startOfDay(now) + c.interval * DAY + 6 * 3600 * 1000;
  }
  c.last = now;
  return c;
}

export function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }

export const isDue = (card, now = Date.now()) => card.due <= now;

/** Libellé de l'intervalle proposé pour chaque note (affiché sur les boutons). */
export function preview(card, now = Date.now()) {
  return [0, 1, 2, 3].map((g) => {
    const next = review(card, g, now);
    const ms = next.due - now;
    return ms < DAY ? "< 1 j" : `${Math.round(ms / DAY)} j`;
  });
}

/**
 * Séances de révision avant un examen : espacées de plus en plus serrées à
 * l'approche (J-21, J-14, J-10, J-7, J-5, J-3, J-2, J-1), limitées aux jours
 * restants, avec une séance par chapitre répartie en tourniquet.
 * @returns {{ at: number, chapter: string, kind: "learn"|"review"|"mock" }[]}
 */
export function revisionPlan(examAt, chapters = [], now = Date.now(), hour = 18) {
  const offsets = [21, 14, 10, 7, 5, 3, 2, 1];
  const days = Math.floor((startOfDay(examAt) - startOfDay(now)) / DAY);
  if (days < 1) return [];
  const usable = offsets.filter((o) => o <= days);
  const list = chapters.length ? chapters : ["Tout le programme"];
  const out = [];
  usable.forEach((o, i) => {
    const d = new Date(startOfDay(examAt) - o * DAY);
    d.setHours(hour, 0, 0, 0);
    const kind = o === 1 ? "mock" : i < Math.ceil(usable.length / 2) ? "learn" : "review";
    out.push({ at: d.getTime(), chapter: kind === "mock" ? "Examen blanc" : list[i % list.length], kind });
  });
  return out;
}

/** Note sur 20 d'un quiz. */
export function score20(correct, total) {
  return total ? Math.round((correct / total) * 200) / 10 : 0;
}
