// Niveau d'ouverture de la bouche de l'orbe (src/lib/voice-mouth.js).
import test from "node:test";
import assert from "node:assert/strict";
import { envelopeLevel, syntheticLevel, mouthScale, mouthOpacity, mouthSizeFromEye } from "../src/lib/voice-mouth.js";

test("l'enveloppe est lue à la bonne tranche", () => {
  const env = [0, 128, 255, 64];
  assert.equal(envelopeLevel(env, 40, 0), 0);
  assert.equal(envelopeLevel(env, 40, 45), 128 / 255);
  assert.equal(envelopeLevel(env, 40, 85), 1);
  assert.equal(envelopeLevel(env, 40, 130), 64 / 255);
});

test("une lecture terminée rend la main à l'enveloppe synthétique", () => {
  // null = « plus rien à jouer », l'appelant bascule sur le synthétique.
  assert.equal(envelopeLevel([10, 20], 40, 80), null);
  assert.equal(envelopeLevel([], 40, 0), null);
  assert.equal(envelopeLevel(null, 40, 0), null);
});

test("une enveloppe abîmée ne fait pas claquer la bouche", () => {
  assert.equal(envelopeLevel([NaN], 40, 0), 0);
  assert.equal(envelopeLevel([999], 40, 0), 1, "un niveau hors bornes est ramené à 1");
  assert.equal(envelopeLevel([-50], 40, 0), 0, "un niveau négatif est ramené à 0");
  assert.equal(envelopeLevel([255], 0, 0), 1, "une tranche nulle retombe sur 40 ms");
});

test("l'enveloppe synthétique reste dans les bornes et bouge vraiment", () => {
  let min = 1, max = 0;
  for (let t = 0; t < 6; t += 0.01) {
    const v = syntheticLevel(t);
    assert.ok(v >= 0 && v <= 1, `niveau hors bornes à t=${t} : ${v}`);
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  assert.ok(min < 0.1, "la bouche doit se refermer entre les syllabes");
  assert.ok(max > 0.6, "la bouche doit s'ouvrir franchement sur les syllabes");
});

test("la bouche fermée reste une barre à l'échelle 1", () => {
  assert.deepEqual(mouthScale(0), { x: 1, y: 1 });
  const open = mouthScale(1);
  assert.ok(open.y > 1.2, "grande ouverte, la barre s'étire en hauteur");
  assert.ok(open.x < 1 && open.x > 0.8, "et se resserre légèrement en largeur");
  assert.deepEqual(mouthScale(4), mouthScale(1), "un niveau hors bornes est borné");
});

test("la bouche reste discrète par rapport aux yeux", () => {
  // Les trois tailles d'yeux réellement utilisées : barre, bureau, Compagnon IA.
  for (const eye of [{ width: 7, height: 22 }, { width: 6, height: 20 }, { width: 5, height: 15 }]) {
    const m = mouthSizeFromEye(eye);
    const paire = eye.width * 2 + eye.width * 1.85;   // deux yeux + leur écart
    assert.ok(m.width < paire, `bouche trop large (${m.width}) face à la paire d'yeux (${paire})`);
    assert.ok(m.width > eye.width * 1.8, `bouche trop courte pour se lire : ${m.width}`);
    assert.ok(m.height < eye.width, "le trait doit rester plus fin qu'un œil n'est large");
    const ouverte = m.height * mouthScale(1).y;
    assert.ok(ouverte < eye.height, `ouverte (${ouverte}) elle dépasse la hauteur d'un œil (${eye.height})`);
    assert.ok(m.offsetY > eye.height * 0.5, "la bouche doit se placer sous les yeux");
  }
});

test("des yeux non mesurables ne cassent pas la bouche", () => {
  const m = mouthSizeFromEye(null);
  assert.ok(m.width > 0 && m.height > 0 && m.offsetY > 0);
  assert.deepEqual(m, mouthSizeFromEye({ width: 0, height: 0 }), "0 px = valeur par défaut");
});

test("la bouche n'existe que pendant la parole", () => {
  assert.equal(mouthOpacity(0), 0, "au silence, elle doit être totalement invisible");
  assert.ok(mouthOpacity(0.02) < 0.3, "un frémissement ne doit pas la faire apparaître");
  assert.equal(mouthOpacity(0.12), 1, "une ouverture franche la rend pleinement visible");
  assert.equal(mouthOpacity(1), 1);
  assert.equal(mouthOpacity(-5), 0, "un niveau négatif reste invisible");
});

test("la bouche est posée sous les yeux, sans les toucher", () => {
  for (const eye of [{ width: 7, height: 22 }, { width: 6, height: 20 }, { width: 5, height: 15 }]) {
    const m = mouthSizeFromEye(eye);
    // L'œil descend jusqu'à height/2 sous le centre ; le haut de la bouche est
    // à offsetY - height/2. On veut un vrai intervalle entre les deux.
    const basDesYeux = eye.height / 2;
    const hautDeLaBouche = m.offsetY - m.height / 2;
    assert.ok(hautDeLaBouche - basDesYeux > eye.width * 0.5,
      `bouche trop près des yeux (écart ${(hautDeLaBouche - basDesYeux).toFixed(1)} px)`);
  }
});
