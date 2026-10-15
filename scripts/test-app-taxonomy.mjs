import test from 'node:test';
import assert from 'node:assert/strict';
import { PACKAGES } from './app-packages.mjs';
import { APP_SPACES, appSpace } from '../src/lib/app-taxonomy.js';
import { CATS } from '../src/lib/app-navigation.js';
import { platformCapabilities, appOrigin } from '../src/lib/platform-capabilities.js';
import { conversationGroups } from '../src/lib/conversation-groups.js';

test('every catalogue package has exactly one Application destination, shared with Desktop', () => {
  for (const pkg of PACKAGES) {
    const space = appSpace(pkg);
    assert.ok(APP_SPACES.includes(space), pkg.id);
    assert.equal(CATS.filter(cat => cat.cats?.includes(space)).length, 1, pkg.id);
    assert.equal(appSpace({ ...pkg, category: 'obsolete' }), space, pkg.id);
  }
  assert.equal(appSpace({ id: 'external', category: 'custom' }), 'lab');
});
test('specific platform extensions stay explicit and unknown never grants Apple or GPIO', () => {
  assert.equal(platformCapabilities({ flavor: 'default' }).appleIntegration, false);
  assert.equal(platformCapabilities({ flavor: 'default', platform: 'MacIntel' }).appleIntegration, true);
  assert.equal(platformCapabilities({ flavor: 'windows', platform: 'MacIntel' }).appleIntegration, false);
  assert.equal(platformCapabilities({ flavor: 'rpi', platform: 'Linux aarch64' }).gpio, true);
  assert.equal(platformCapabilities({ flavor: 'linux-standard' }).gpio, false);
  assert.equal(appOrigin('notes', 'Windows NT 10.0'), 'http://lumenapp.localhost/notes');
  assert.equal(appOrigin('notes', 'Macintosh'), 'lumenapp://notes');
  assert.equal(appOrigin('notes', 'Linux Android'), 'http://lumenapp.localhost/notes');
  assert.throws(() => appOrigin('../notes'));
});
test('sidebar groups keep every conversation once, pinned first and orphan folders in recents', () => {
  const conversations = [{ id: 'a', folder: 'project', pinned: true }, { id: 'b', folder: 'project' }, { id: 'c', folder: 'deleted' }, { id: 'd' }];
  const groups = conversationGroups(conversations, [{ id: 'project', name: 'Lumen' }]);
  assert.deepEqual(groups.map(g => g.kind), ['pinned', 'project', 'recent']);
  assert.deepEqual(groups.flatMap(g => g.conversations.map(c => c.id)), ['a', 'b', 'c', 'd']);
  assert.equal(groups[1].label, 'Lumen');
  assert.deepEqual(conversationGroups([], []), []);
});
