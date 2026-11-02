import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import * as T from '../vendor/three.module.js';
import { attitude, localDirection, FlightDirector, canManeuver } from '../js/flight-controls.js';
import { FlightTutorial } from '../js/flight-tutorial.js';
import { weaponReadout } from '../js/flight-deck.js';

const near = (a,b) => assert.ok(Math.abs(a-b)<1e-6, `${a} != ${b}`);
const craft = () => ({ alive:true, group:{ quaternion:new T.Quaternion() }, weapons:[] });

test('navball reports real yaw, pitch and bank, including inverted flight', () => {
  const q = new T.Quaternion();
  let a = attitude(q); near(a.yaw,0);near(a.pitch,0);near(a.bank,0);
  q.setFromAxisAngle(new T.Vector3(0,1,0),Math.PI/2);a=attitude(q);near(a.yaw,Math.PI/2);
  q.setFromAxisAngle(new T.Vector3(1,0,0),-Math.PI/6);a=attitude(q);near(a.pitch,Math.PI/6);
  const north=localDirection({x:0,y:0,z:1},a);assert.ok(north.y<0,'horizon falls below the nose when pitching up');
  q.setFromAxisAngle(new T.Vector3(0,0,1),Math.PI);a=attitude(q);near(Math.abs(a.bank),Math.PI);
  assert.ok(localDirection({x:0,y:1,z:0},a).y<0,'sky is below the reference when inverted');
});

test('navball transforms agree with the aircraft quaternion for arbitrary attitudes', () => {
  for(let i=0;i<30;i++){
    const q=new T.Quaternion().setFromEuler(new T.Euler(i*.13,i*.21,i*.31));
    const v=new T.Vector3(.3,.6,.8).normalize();const actual=localDirection(v,attitude(q));
    const expected=v.clone().applyQuaternion(q.clone().invert());
    near(actual.x,expected.x);near(actual.y,expected.y);near(actual.z,expected.z);
  }
});

test('tutorial begins flying, then pauses until an actual weapon change and resume', () => {
  const t=new FlightTutorial(true);assert.equal(t.paused,false);
  assert.equal(t.advance(6.9),false);assert.equal(t.advance(.2),true);assert.equal(t.paused,true);
  t.advance(100);assert.equal(t.stage,'weapon','waiting must not resume combat');
  assert.equal(t.resume(3),false);t.weaponChanged(0,0);assert.equal(t.resume(3),false);
  t.weaponChanged(0,1);assert.equal(t.resume(3),true);assert.equal(t.paused,false);
  t.advance(6);assert.equal(t.stage,'done');
});

test('skipping, unarmed / single-weapon craft and disabled multiplayer tutorial cannot trap the player', () => {
  for(const count of [0,1]){const t=new FlightTutorial(true);t.advance(7);assert.equal(t.resume(count),true);}
  const t=new FlightTutorial(true);t.skip();assert.equal(t.advance(60),false);assert.equal(t.paused,false);
  const online=new FlightTutorial(false);assert.equal(online.advance(1000),false);assert.equal(online.stage,'off');
});

test('flight assists capture orientation and level flight sets a horizontal target', () => {
  const p=craft(),d=new FlightDirector();p.group.quaternion.setFromEuler(new T.Euler(-.2,.6,0,'YXZ'));
  const a=attitude(p.group.quaternion);assert.equal(d.select('hold',p),true);
  let cmd=d.update(.1,p);near(cmd.yaw,a.yaw);near(cmd.pitch,a.pitch);
  d.select('level',p);cmd=d.update(.1,p);near(cmd.pitch,0);near(cmd.yaw,a.yaw);
  d.cancel();assert.equal(d.update(.1,p),null);
});

test('both roll directions stop at exactly one rotation without teleporting orientation', () => {
  for(const [mode,sign] of [['roll-left',1],['roll-right',-1]]){
    const p=craft(),d=new FlightDirector(),q=p.group.quaternion.clone();d.select(mode,p);
    near(d.update(.1,p).roll,sign);assert.deepEqual(p.group.quaternion,q);
    let total=0;for(let i=0;i<100;i++) total+=d.consumeRoll(sign*.1);
    near(total,sign*Math.PI*2);d.update(.5,p);assert.equal(d.mode,'level');
  }
});

test('break turn requests the opposite heading and levels out on arrival', () => {
  const p=craft(),d=new FlightDirector();d.select('break',p);near(d.update(.1,p).yaw,Math.PI);
  p.group.quaternion.setFromAxisAngle(new T.Vector3(0,1,0),Math.PI);d.update(.5,p);assert.equal(d.mode,'level');
  d.select('hold',p);p.stalled=true;assert.equal(d.update(.1,p),null);assert.equal(d.mode,'manual');
});

test('ships, balloons, grounded and stalled craft cannot run fixed-wing tricks', () => {
  for(const flag of ['isShipCraft','isBalloon','grounded','stalled']){
    const p={...craft(),[flag]:true},d=new FlightDirector();assert.equal(canManeuver(p),false);
    assert.equal(d.select('roll-left',p),false);assert.equal(d.select('hold',p),false);assert.equal(d.select('manual',p),true);
  }
});

test('weapon display counts every grouped gun, tracks reloads and changes silhouette by type', () => {
  const a={type:'gun',name:'Machine Gun',ammo:80,reserve:100,reloading:0};
  const b={...a,ammo:32,reserve:70,reloading:1.4};
  assert.deepEqual(weaponReadout({...a,linkedWeapons:[a,b]}),{name:'Machine Gun',ammo:112,reserve:170,reload:1.4,count:2,kind:'gun'});
  assert.equal(weaponReadout({...a,type:'bomb'}).kind,'bomb');
  assert.equal(weaponReadout({...a,type:'radar'}).kind,'missile');
  assert.equal(weaponReadout({...a,name:'Gatling'}).kind,'gatling');
  assert.equal(weaponReadout({...a,torpedo:true}).kind,'torpedo');
  assert.equal(weaponReadout(null).ammo,0);
});

// Load the real battle class through the same vendored Three.js as the browser.
const hooks=registerHooks({resolve(specifier,context,next){
  return specifier==='three' ? {url:new URL('../vendor/three.module.js',import.meta.url).href,shortCircuit:true} : next(specifier,context);
}});
const { Sim }=await import('../js/battle.js');hooks.deregister();
const { stockGet, statsOf }=await import('../js/core.js');
globalThis.window={};
globalThis.document={fullscreenElement:null,pointerLockElement:null};

test('paused lesson freezes the actual battle frame, including AI, projectiles and networking', () => {
  const s=new Sim({showGuide:true});s.guideOpen=true;s.time=7;
  let rendered=0;s.renderHUD=()=>rendered++;s.readPlayerInput=()=>assert.fail('physics/input advanced');
  s.frame(.05);s.frame(.05);assert.equal(s.time,7);assert.equal(rendered,2);
});

test('lesson pauses SDK gameplay and clears held fire before exposing controls', () => {
  const s=new Sim({showGuide:true});s.player={wantGun:true,wantBomb:true};s.keys={' ':true};s.mouseFire=true;
  s.gameplayActive=true;s.buildFlightGuide=()=>{};s.pauseWeaponLesson();
  assert.equal(s.guideOpen,true);assert.equal(s.gameplayActive,false);assert.deepEqual(Object.keys(s.keys),[]);
  assert.equal(s.mouseFire,false);assert.equal(s.player.wantGun,false);
});

test('Tab changes the actual selected weapon while paused without firing or resuming', () => {
  const s=new Sim({showGuide:true});s.player={weapons:[{name:'Gun'},{name:'Missile'}],curWeapon:0};
  s.tutorial.advance(7);s.guideOpen=true;s.updateWeaponLesson=()=>{};
  let prevented=false;s.onKeyDown({key:'Tab',preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.equal(s.player.curWeapon,1);assert.equal(s.tutorial.switched,true);
  assert.equal(s.guideOpen,true);assert.equal(s.firePulse,undefined);
});

test('multiplayer bypasses onboarding even when a guide was requested', () => {
  const s=new Sim({showGuide:true,net:{}});assert.equal(s.tutorial.stage,'off');assert.equal(s.guideOpen,false);
});

test('actual Falcon physics completes rolls and a break turn without a stall or ground impact', () => {
  for(const mode of ['roll-left','roll-right','break']){
    const s=new Sim({env:'day'}),stats=statsOf(stockGet('stock_falcon')),group=new T.Group();group.position.y=360;
    const p={group,pos:group.position,stats,vel:new T.Vector3(),fuel:stats.fuelMass,maxFuel:stats.fuelMass,
      throttle:.82,temp:15,alive:true,isPlayer:true,engineOn:true,weapons:[],curWeapon:-1};
    s.player=p;s.primeAirborneCraft(p);s.killCraft=()=>assert.fail(`${mode} crashed`);s.flashMsg=()=>{};
    s.director.select(mode,p);let lowest=360;
    for(let i=0;i<2400;i++){
      s.time+=1/60;s.readPlayerInput(1/60);s.integrate(p,1/60);lowest=Math.min(lowest,p.pos.y);
      assert.equal(p.stalled,false,`${mode} stalled`);
    }
    assert.equal(s.director.mode,'level');assert.ok(lowest>300,`${mode} lost too much altitude`);
    assert.ok(Math.abs(p.pos.y-360)<10,`${mode} did not recover altitude`);
    assert.ok(Math.abs(p.vel.y)<1,`${mode} left the aircraft descending`);
    if(mode==='break') assert.ok(Math.abs(attitude(p.group.quaternion).yaw)>3,'turn failed to reverse heading');
  }
});

test('manual roll input cancels the director; clicking HUD controls cannot fire', () => {
  const s=new Sim({net:{}});s.player=craft();s.director.select('hold',s.player);
  s.onKeyDown({key:'a',preventDefault(){}});assert.equal(s.director.mode,'manual');
  s.onMouseDown({button:0,target:{closest:()=>true}});assert.equal(s.mouseFire,false);assert.equal(s.firePulse,undefined);
});
