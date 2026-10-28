import assert from 'node:assert/strict';
import {
  PLANNER_MAPS, PLANNER_TASKS,
  generateMissionPlan, encodeMissionPlan, decodeMissionPlan,
} from '../js/mission-planner-data.js';

function designCode(name,role,offset=0){
  const lean={n:name,a:'Test Builder',r:role,c:'#cfd8e3',p:[['fuselage_s',offset,0,0,0,0,0,0,0,0],['jet_basic',offset,0,-2,0,0,0,0,0,0],['wing_straight',offset,0,0,0,0,0,0,0,0]]};
  return'ASK2.'+btoa(unescape(encodeURIComponent(JSON.stringify(lean))));
}

const CUSTOM_CODES=[
  designCode('Needle Mk IV','interceptor'),
  designCode('Brick Bomber','bomber',1),
  designCode('Cloud Whale','balloon',-1),
];
const maps=new Set(),tasks=new Set();
for(let seed=1;seed<=1200;seed++){
  const selected=seed%3===0?[CUSTOM_CODES[seed%CUSTOM_CODES.length]]:CUSTOM_CODES;
  const plan=generateMissionPlan(seed,selected);
  assert.deepEqual(generateMissionPlan(seed,selected),plan,'same seed and custom designs must reproduce exactly');
  assert.equal(plan.v,2);
  assert.equal(plan.blueprints.length,selected.length);
  assert.deepEqual(plan.forces.map(f=>f.blueprintKey),plan.blueprints.map(bp=>bp.key),'every selected creation must appear');
  assert.ok(plan.forces.every(f=>f.count>=1&&f.skill>=0.86&&f.skill<=1));
  assert.ok(plan.threat>=(selected.length===1?18:selected.length*5));
  assert.ok(plan.timeLimit>=420&&plan.timeLimit<=900);
  assert.deepEqual(decodeMissionPlan(encodeMissionPlan(plan)),plan,'portable play code must round-trip with embedded blueprints');
  maps.add(plan.mapId);tasks.add(plan.taskId);
}
assert.equal(maps.size,PLANNER_MAPS.length,'all theatre maps must be reachable');
assert.equal(tasks.size,PLANNER_TASKS.length,'all task templates must be reachable');
assert.throws(()=>generateMissionPlan(1,[]),/Select at least one/);
assert.equal(decodeMissionPlan('AOS2-MP2-not-valid'),null);
assert.equal(decodeMissionPlan('AOS2-MP1-old-stock-code'),null);
const original=generateMissionPlan(77,CUSTOM_CODES);
const tampered=JSON.parse(JSON.stringify(original));tampered.blueprints[0].name='<img src=x onerror=alert(1)>';
const tamperedPayload=btoa(JSON.stringify(tampered)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
assert.equal(decodeMissionPlan('AOS2-MP2-'+tamperedPayload),null,'tampered shared codes must be rejected');
const evil=designCode('<img src=x onerror=alert(1)>','fighter');
const sanitized=generateMissionPlan(2,[evil]);
assert.equal(sanitized.blueprints[0].name,'<img src=x onerror=alert(1)>','names remain data and must be rendered with textContent');
const manyCodes=Array.from({length:40},(_,i)=>designCode(`Library Aircraft ${i+1}`,'fighter',i%8));
const capped=generateMissionPlan(99,manyCodes);
assert.equal(capped.blueprints.length,32,'the picker must safely cap oversized libraries');
assert.equal(capped.forces.length,32,'every accepted library selection must become a task group');
assert.ok(capped.forces.every(f=>f.count>=1&&f.count<=3),'large custom pools must keep the battle spawn count bounded');
assert.deepEqual(decodeMissionPlan(encodeMissionPlan(capped)),capped,'maximum custom pool must remain portable');
console.log(`PASS: ${PLANNER_MAPS.length} maps, ${PLANNER_TASKS.length} tasks, custom-library blueprints and portable MP2 codes.`);
