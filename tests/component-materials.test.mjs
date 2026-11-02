import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const source = async (path) => readFile(new URL(path, root), 'utf8');

test('aircraft components use distinct physical surface treatments', async () => {
  const parts = await source('js/parts.js');
  for (const surface of ['painted', 'brushed', 'cast', 'rubber', 'glass']) {
    assert.match(parts, new RegExp(`['\"]${surface}['\"]`), `missing ${surface} surface`);
  }
  assert.match(parts, /MeshPhysicalMaterial/);
  assert.match(parts, /roughnessMap/);
  assert.match(parts, /bumpMap/);
  assert.match(parts, /aosSharedSurface/);
});

test('shared component textures survive hangar and battle teardown', async () => {
  const [hangar, battle] = await Promise.all([
    source('js/hangar.js'),
    source('js/battle.js'),
  ]);
  for (const file of [hangar, battle]) {
    assert.match(file, /!v\.userData\?\.aosSharedSurface/);
  }
});
