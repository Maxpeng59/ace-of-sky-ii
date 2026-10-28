// Run with: node tests/campaign-access.test.mjs
// Exercise the campaign UI/config without loading the browser-only renderer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { State, STOCK_DESIGNS, stockGet, cloneDesign, libGet } from '../js/core.js';

function element(tag, cls = '', text = ''){
  const classes = new Set(cls.split(' '));
  return {
    tag, textContent: text, children: [], style: {},
    classList: { add: c => classes.add(c), remove: c => classes.delete(c) },
    appendChild(child){ this.children.push(child); return child; },
  };
}
const walk = node => [node, ...node.children.flatMap(walk)];
const source = fs.readFileSync(new URL('../js/campaign.js', import.meta.url), 'utf8');
const context = vm.createContext({
  console, State, STOCK_DESIGNS, stockGet, cloneDesign, libGet, el: element,
  statsOf: () => ({ ok: true, cost: 100 }), fmtCr: String,
  clamp: (n, a, b) => Math.min(b, Math.max(a, n)), save: () => {}, sfx: () => {},
  toast: message => { throw new Error(message); },
  Battle: { start: config => { context.config = config; } },
});
// Replace imports with the dependency doubles above, keeping real mission,
// deploy-picker and battle-config logic. Only modal plumbing is stubbed.
vm.runInContext(source.replace(/^import[\s\S]*?from ['"][^'"]+['"];\n/gm, '')
  .replace(/export const /g, 'const ') + `
    this.api = { MISSIONS, carrierForMission, openDeploy, contractRow, missionCard, onboardPanel };
    openModal = () => ({ body: this.modalBody = el('div') });
    closeModal = () => {};
  `, context);

const plane = cloneDesign(STOCK_DESIGNS.find(d => d.id === 'stock_falcon'), '');
State.library = [plane];
State.campaign.hangar = [plane.id];
State.campaign.completed = [];
State.campaign.carrierId = null;
State.campaign.wingmen = [{ id: 'wingman', name: 'Test Wingman', designId: plane.id, skill: 0.7 }];

assert.equal(context.api.MISSIONS.length, 14);
for (const mission of context.api.MISSIONS){
  assert.ok(!('requires' in mission) && !('needsCarrier' in mission) && !('soloOnly' in mission));
  for (const card of [context.api.missionCard(mission), context.api.contractRow({ id: 'test' }, mission, false)]){
    const deploy = walk(card).find(n => n.tag === 'button');
    assert.ok(deploy && !deploy.disabled && typeof deploy.onclick === 'function');
    assert.ok(!walk(card).some(n => /locked|requires:|complete first:/i.test(n.textContent)));
  }
  context.api.openDeploy(mission);
  const nodes = walk(context.modalBody);
  nodes.find(n => n.textContent === 'Test Wingman').onclick();
  nodes.find(n => n.textContent === '🚀 Launch Sortie').onclick();
  assert.equal(context.config.allies.length, 1, mission.id + ' must allow wingmen');
  assert.equal(Boolean(context.config.carrier), Boolean(mission.friendlyCarrier));
  assert.equal(State.campaign.carrierId, null, 'support carrier must not alter ownership');
  assert.equal(JSON.stringify(context.config.objective), JSON.stringify(mission.objective));
}

const capitalMission = context.api.MISSIONS.find(m => m.friendlyCarrier);
State.campaign.carrierId = 'missing';
assert.ok(context.api.carrierForMission(capitalMission), 'stale carrier id must fall back');
const carrier = stockGet('stock_carrier');
State.library.push(carrier); State.campaign.carrierId = carrier.id;
assert.equal(context.api.carrierForMission(capitalMission), carrier, 'owned carrier must still deploy');
assert.equal(context.api.carrierForMission(context.api.MISSIONS[0]), null);

const guidance = context.api.onboardPanel('Training', 'Optional setup', 'Guide', 'Continue', () => {});
assert.ok(walk(guidance).some(n => n.tag === 'button' && n.textContent === 'Go to World Map'));
console.log('PASS: all 14 missions are unrestricted; support carriers, wingmen and optional setup work.');
