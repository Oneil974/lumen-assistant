// Tests des fonctions pures de l'app Études (src/studies/srs.js).
import test from "node:test";
import assert from "node:assert/strict";
import { newCard, review, revisionPlan, score20, startOfDay } from "../src/studies/srs.js";

const DAY = 86_400_000;
const NOW = new Date(2026, 8, 23, 10, 0).getTime();

test("une fiche réussie s'espace de plus en plus", () => {
  let c = newCard("Q", "R");
  const intervals = [];
  for (let i = 0; i < 5; i++) { c = review(c, 2, NOW + i * 30 * DAY); intervals.push(c.interval); }
  assert.deepEqual(intervals.slice(0, 2), [1, 6]);
  for (let i = 1; i < intervals.length; i++) assert.ok(intervals[i] > intervals[i - 1], `${intervals}`);
});

test("une fiche oubliée revient dans la séance et perd en facilité", () => {
  let c = review(newCard("Q", "R"), 2, NOW);
  c = review(c, 2, NOW);
  const before = c.ease;
  c = review(c, 0, NOW);
  assert.equal(c.reps, 0);
  assert.equal(c.lapses, 1);
  assert.ok(c.ease < before);
  assert.ok(c.due - NOW <= 10 * 60 * 1000);
});

test("la facilité ne descend jamais sous 1,3", () => {
  let c = newCard("Q", "R");
  for (let i = 0; i < 20; i++) c = review(c, 0, NOW);
  assert.equal(c.ease, 1.3);
});

test("planning : séances avant l'examen, examen blanc la veille", () => {
  const exam = NOW + 15 * DAY;
  const plan = revisionPlan(exam, ["Chap. 1", "Chap. 2"], NOW);
  assert.ok(plan.length >= 5);
  assert.ok(plan.every((s) => s.at < startOfDay(exam) && s.at > NOW));
  assert.equal(plan.at(-1).kind, "mock");
  assert.ok(plan.some((s) => s.chapter === "Chap. 2"));
});

test("planning : rien si l'examen est aujourd'hui", () => {
  assert.deepEqual(revisionPlan(NOW + 3600_000, [], NOW), []);
});

test("note sur 20", () => {
  assert.equal(score20(7, 10), 14);
  assert.equal(score20(0, 0), 0);
});
