// Diff ligne à ligne (LCS) pour l'édition IA assistée. Regroupe le résultat en
// blocs : `eq` (contexte inchangé) ou `change` (suppressions + ajouts contigus),
// chaque `change` étant accepté/refusé indépendamment par l'utilisateur.

export function diffLines(a, b) {
  const A = a.split("\n"), B = b.split("\n");
  const n = A.length, m = B.length;
  // Garde-fou mémoire : au-delà, on renvoie un unique bloc de remplacement.
  if (n * m > 4_000_000) {
    return [{ type: "change", del: A, ins: B, accepted: true }];
  }
  // Table LCS (longueurs), calcul à rebours.
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { ops.push({ t: "eq", line: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: "del", line: A[i] }); i++; }
    else { ops.push({ t: "ins", line: B[j] }); j++; }
  }
  while (i < n) ops.push({ t: "del", line: A[i++] });
  while (j < m) ops.push({ t: "ins", line: B[j++] });
  return groupHunks(ops);
}

function groupHunks(ops) {
  const blocks = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].t === "eq") {
      const lines = [];
      while (i < ops.length && ops[i].t === "eq") lines.push(ops[i++].line);
      blocks.push({ type: "eq", lines });
    } else {
      const del = [], ins = [];
      while (i < ops.length && ops[i].t !== "eq") {
        (ops[i].t === "del" ? del : ins).push(ops[i].line); i++;
      }
      blocks.push({ type: "change", del, ins, accepted: true });
    }
  }
  return blocks;
}

// Reconstitue le texte final selon les blocs acceptés (champ `accepted`).
export function applyDiff(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.type === "eq") out.push(...b.lines);
    else out.push(...(b.accepted ? b.ins : b.del));
  }
  return out.join("\n");
}

export function countChanges(blocks) {
  return blocks.filter((b) => b.type === "change").length;
}
