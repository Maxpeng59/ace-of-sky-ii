import assert from 'node:assert/strict';
import { AIRFRAME_FINISHES, normalizeAirframeFinish } from '../js/parts.js';
import { newDesign, exportCode, importCode } from '../js/core.js';

assert.equal(AIRFRAME_FINISHES.length, 7);
assert.equal(newDesign().finish, 'operational');
for (const { key } of AIRFRAME_FINISHES){
  assert.equal(normalizeAirframeFinish(key), key);
  const design = newDesign('Finish test');
  design.finish = key;
  design.parts.push({ key: 'cockpit', gx: 0, gy: 0, gz: 0 });
  const restored = importCode(exportCode(design));
  assert.equal(restored.finish, key, `${key} survives design sharing`);
  assert.equal(restored.parts[0].key, 'cockpit');
}
assert.equal(normalizeAirframeFinish('unknown'), 'operational');

// Codes created before finishes existed still import as operational gray.
const legacy = 'ASK2.' + btoa(JSON.stringify({ n: 'Older aircraft', p: [] }));
assert.equal(importCode(legacy).finish, 'operational');

console.log('airframe finishes: pass');
