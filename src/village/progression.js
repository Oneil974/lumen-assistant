// Progression des agents — niveaux, XP, séries, badges, titres. Pur et dérivé
// de l'historique d'activité (`agent_activity`) : aucun stockage, toujours exact.
// Importé par le Village et par l'éditeur d'agents.

// XP par compte rendu : un succès vaut plus qu'un échec (mais un échec compte un
// peu — l'agent a tenté et produit de la matière à apprentissage).
const XP_SUCCESS = 12;
const XP_FAIL = 3;
const STREAK_BONUS = 4; // bonus par tâche au sein d'une série de succès

export const TITLES = [
  "Apprenti", "Compagnon", "Artisan", "Expert", "Vétéran",
  "Maître", "Grand Maître", "Légende",
];

// XP cumulée requise pour atteindre le niveau n (1-indexé). Croissance douce.
function xpForLevel(n) { return Math.round(40 * Math.pow(n - 1, 1.6)); }

export function levelFromXp(xp) {
  let lvl = 1;
  while (lvl < 99 && xp >= xpForLevel(lvl + 1)) lvl++;
  return lvl;
}

export function titleForLevel(level) {
  const idx = Math.min(TITLES.length - 1, Math.floor((level - 1) / 2));
  return TITLES[idx];
}

// activity : tableau d'ActivityEntry ({ ts, kind, task, output, skill, success }).
export function computeProgress(activity) {
  const reports = (activity || []).filter((e) => e.kind === "report");
  const steps = (activity || []).filter((e) => e.kind === "step");

  let xp = 0, streak = 0, bestStreak = 0, successes = 0, failures = 0;
  for (const e of reports) {
    if (e.success) {
      successes++; streak++; bestStreak = Math.max(bestStreak, streak);
      xp += XP_SUCCESS + streak * STREAK_BONUS;
    } else {
      failures++; streak = 0; xp += XP_FAIL;
    }
  }
  const total = successes + failures;
  const successRate = total ? Math.round((successes / total) * 100) : 0;
  const level = levelFromXp(xp);
  const curBase = xpForLevel(level);
  const nextBase = xpForLevel(level + 1);
  const intoLevel = xp - curBase;
  const span = Math.max(1, nextBase - curBase);
  const levelPct = Math.max(0, Math.min(1, intoLevel / span));

  // Skill dominant (depuis les steps)
  const skillCounts = {};
  for (const s of steps) if (s.skill) skillCounts[s.skill] = (skillCounts[s.skill] || 0) + 1;
  let topSkill = null, topSkillN = 0;
  for (const [k, v] of Object.entries(skillCounts)) if (v > topSkillN) { topSkill = k; topSkillN = v; }

  const badges = computeBadges({ successes, failures, total, bestStreak, streak, successRate, topSkill, topSkillN });

  return {
    xp, level, title: titleForLevel(level), levelPct,
    xpIntoLevel: intoLevel, xpForNext: span,
    successRate, successes, failures, total,
    streak, bestStreak, topSkill, badges,
    counts: { reports: reports.length, steps: steps.length },
  };
}

function computeBadges(s) {
  const out = [];
  if (s.bestStreak >= 5) out.push({ key: "flawless", icon: "✨", label: "Sans faute", desc: `Série de ${s.bestStreak} réussites` });
  if (s.total >= 25) out.push({ key: "workhorse", icon: "💪", label: "Increvable", desc: `${s.total} tâches accomplies` });
  if (s.total >= 5 && s.successRate >= 90) out.push({ key: "reliable", icon: "🎯", label: "Fiable", desc: `${s.successRate}% de réussite` });
  if (s.topSkillN >= 5) out.push({ key: "specialist", icon: "🛠️", label: "Spécialiste", desc: `Maîtrise « ${s.topSkill} »` });
  if (s.failures >= 3 && s.successRate < 50 && s.total >= 5) out.push({ key: "learning", icon: "📚", label: "En apprentissage", desc: "Marge de progression" });
  if (s.total === 0) out.push({ key: "rookie", icon: "🌱", label: "Nouveau", desc: "Aucune tâche encore" });
  return out;
}

// Palier de logement selon le niveau (pour l'évolution visuelle dans le Village).
// 0 tente, 1 cabane, 2 maison, 3 manoir.
export function houseTier(level) {
  if (level >= 11) return 3;
  if (level >= 6) return 2;
  if (level >= 3) return 1;
  return 0;
}
