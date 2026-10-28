import assert from 'node:assert/strict';
import {
  PLANNER_AIRCRAFT_IDS, PLANNER_MAPS, PLANNER_TASKS,
  generateMissionPlan, encodeMissionPlan, decodeMissionPlan,
} from '../js/mission-planner-data.js';

const maps = new Set(), tasks = new Set();
for (let seed = 1; seed <= 1200; seed++){
  const allowed = seed % 3 === 0 ? [PLANNER_AIRCRAFT_IDS[seed % PLANNER_AIRCRAFT_IDS.length]] : PLANNER_AIRCRAFT_IDS;
  const plan = generateMissionPlan(seed, allowed);
  assert.deepEqual(generateMissionPlan(seed, allowed), plan, 'same seed must reproduce exactly');
  assert.deepEqual(plan.allowed, allowed);
  assert.deepEqual(plan.forces.map(f => f.designId), allowed, 'every allowed aircraft must appear');
  assert.ok(plan.forces.every(f => f.count >= 1 && f.skill >= 0.86 && f.skill <= 1));
  assert.ok(plan.threat >= (allowed.length === 1 ? 18 : allowed.length * 5));
  assert.ok(plan.timeLimit >= 420 && plan.timeLimit <= 900);
  assert.deepEqual(decodeMissionPlan(encodeMissionPlan(plan)), plan, 'play code must round-trip');
  maps.add(plan.mapId); tasks.add(plan.taskId);
}
assert.equal(maps.size, PLANNER_MAPS.length, 'all theatre maps must be reachable');
assert.equal(tasks.size, PLANNER_TASKS.length, 'all task templates must be reachable');
assert.throws(() => generateMissionPlan(1, []), /Select at least one/);
assert.equal(decodeMissionPlan('AOS2-MP1-not-valid'), null);
assert.equal(decodeMissionPlan('ASK2.old-design-code'), null);
const original = generateMissionPlan(77, PLANNER_AIRCRAFT_IDS);
const tampered = JSON.parse(JSON.stringify(original)); tampered.codename = '<img src=x onerror=alert(1)>';
const tamperedPayload = btoa(JSON.stringify(tampered)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
assert.equal(decodeMissionPlan('AOS2-MP1-' + tamperedPayload), null, 'tampered shared codes must be rejected');
console.log(`PASS: ${PLANNER_MAPS.length} maps, ${PLANNER_TASKS.length} task templates, deterministic elite forces and share-code round trips.`);
