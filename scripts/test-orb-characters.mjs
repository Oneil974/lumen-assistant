import test from 'node:test';
import assert from 'node:assert/strict';
import { characterId, character, ORB_CHARACTERS } from '../src/lib/orb-characters.js';
import { defaultOrbColors, ORB_DEFAULT } from '../src/lib/orb-palette.js';
test('legacy preferences map to a character without changing UI tokens; unknown values preserve original', () => {
  for (const [old, id] of [['ice','soft-white'],['navy','soft-sky'],['emeraude','soft-mint'],['rubis','soft-coral'],['violet','soft-violet'],['gold','soft-amber'],['accent','default'],['raspberry','soft-raspberry'],['framboise','soft-raspberry']]) assert.equal(characterId(old), id);
  assert.equal(characterId('unknown'), 'default');
  for (const id of Object.keys(ORB_CHARACTERS)) assert.equal(characterId(characterId(id)), id);
  assert.equal(character('default').renderer, 'original');
  assert.equal(new Set(Object.values(ORB_CHARACTERS).filter(x => x.color).map(x => x.color)).size, 7);
  for (const preset of Object.values(ORB_CHARACTERS)) assert.equal(preset.bodyClass, undefined);
});
test('original palette remains independent of UI skin and safe to mutate by caller', () => {
  const result = defaultOrbColors(); result[0] = '#000000';
  assert.deepEqual(defaultOrbColors(), ORB_DEFAULT);
});
