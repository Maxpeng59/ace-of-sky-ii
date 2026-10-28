export const PLANNER_VERSION = 2;
export const PLANNER_MAX_BLUEPRINTS = 32;

export const PLANNER_MAPS = Object.freeze([
  {id:'alpine',name:'Alpine Knife Edge',env:'day',theatre:'High mountain valleys',ally:{x:-1100,z:-2100},enemy:{x:900,z:1900}},
  {id:'black_sea',name:'Black Sea Crossfire',env:'sea',theatre:'Open water strike corridor',ally:{x:-1800,z:-1700},enemy:{x:1600,z:1700}},
  {id:'sahara',name:'Sahara Furnace',env:'dusk',theatre:'Dust-choked desert front',ally:{x:-2100,z:-700},enemy:{x:1900,z:900}},
  {id:'arctic',name:'Arctic Whiteout',env:'day',theatre:'Polar interception lane',ally:{x:0,z:-2600},enemy:{x:0,z:2100}},
  {id:'midnight',name:'Midnight Corridor',env:'night',theatre:'Blackout combat zone',ally:{x:-900,z:-1900},enemy:{x:1200,z:1900}},
  {id:'pacific',name:'Pacific Graveyard',env:'sea',theatre:'Carrier hunting grounds',ally:{x:-2400,z:-1200},enemy:{x:2100,z:1300}},
  {id:'jungle',name:'Emerald Front',env:'day',theatre:'Low-altitude jungle war',ally:{x:-1900,z:-1500},enemy:{x:1800,z:1500}},
  {id:'red_dawn',name:'Red Dawn Basin',env:'dusk',theatre:'Sunset industrial basin',ally:{x:1700,z:-1800},enemy:{x:-1600,z:1800}},
  {id:'storm_sea',name:'Typhoon Expanse',env:'sea',theatre:'Violent ocean approach',ally:{x:0,z:-2500},enemy:{x:600,z:2100}},
  {id:'moonfall',name:'Moonfall Ridge',env:'night',theatre:'Mountain radar shadow',ally:{x:-2300,z:-600},enemy:{x:2100,z:800}},
  {id:'equator',name:'Equator Thunderline',env:'dusk',theatre:'Tropical storm boundary',ally:{x:1300,z:-2200},enemy:{x:-1100,z:1900}},
  {id:'last_ocean',name:'The Last Ocean',env:'sea',theatre:'No-return fleet sector',ally:{x:-2500,z:0},enemy:{x:2300,z:300}},
]);

export const PLANNER_TASKS = Object.freeze([
  {id:'air_supremacy',name:'Total Air Supremacy',type:'deathmatch',label:'Erase every hostile task group'},
  {id:'bomber_break',name:'Bomber Breaker',type:'deathmatch',label:'Break the entire strike armada'},
  {id:'iron_escort',name:'Iron Escort',type:'escort',label:'Keep the command carrier alive',friendlyCarrier:true},
  {id:'fleet_execution',name:'Fleet Execution',type:'sink',label:'Sink the enemy command carrier',enemyCarrier:true},
  {id:'last_stand',name:'Last Stand',type:'survive',label:'Survive the overwhelming assault'},
  {id:'blackout_hunt',name:'Blackout Hunt',type:'deathmatch',label:'Hunt every contact in the dark'},
  {id:'double_carrier',name:'Two-Fleet Collision',type:'escort',label:'Defend your carrier and destroy the attackers',friendlyCarrier:true,enemyCarrier:true},
  {id:'gauntlet',name:'The Impossible Gauntlet',type:'survive',label:'Outlast the elite task groups'},
  {id:'fortress_wall',name:'Fortress Wall',type:'deathmatch',label:'Shatter the airborne wall'},
  {id:'decapitation',name:'Decapitation Strike',type:'sink',label:'Punch through and eliminate the flagship',enemyCarrier:true},
]);

const GROUPS = ['Razor','Anvil','Reaper','Vortex','Hammer','Wraith','Tempest','Cerberus','Nightmare','Titan'];
const MAX_DESIGN_CODE = 120000;
const MAX_PARTS = 300;
const pick = (r,a) => a[Math.floor(r()*a.length)];
const int = (r,a,b) => a + Math.floor(r()*(b-a+1));
const coord = n => Math.max(-3000,Math.min(3000,Math.round(n)));

function rng32(seed){
  let a=seed>>>0;
  return()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};
}
function enc(s){return btoa(unescape(encodeURIComponent(s))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');}
function dec(s){s=s.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-s.length%4)%4);return decodeURIComponent(escape(atob(s)));}
function askEnc(s){return btoa(unescape(encodeURIComponent(s)));}
function askDec(s){return decodeURIComponent(escape(atob(s)));}
function cleanText(value,fallback,max){
  const out=String(value||fallback).replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max);
  return out||fallback;
}
function cleanNum(value,min,max){
  const n=Number(value);
  if(!Number.isFinite(n)||n<min||n>max)throw new Error('Invalid aircraft blueprint');
  return n;
}
function canonicalBlueprint(code){
  code=String(code||'').trim();
  if(!code.startsWith('ASK2.')||code.length>MAX_DESIGN_CODE)throw new Error('Invalid aircraft blueprint');
  const lean=JSON.parse(askDec(code.slice(5)));
  if(!lean||typeof lean!=='object'||!Array.isArray(lean.p)||!lean.p.length||lean.p.length>MAX_PARTS)throw new Error('Invalid aircraft blueprint');
  const parts=lean.p.map(row=>{
    if(!Array.isArray(row)||row.length<4||typeof row[0]!=='string'||!row[0]||row[0].length>120)throw new Error('Invalid aircraft blueprint');
    const p=[row[0],cleanNum(row[1],-128,128),cleanNum(row[2],-128,128),cleanNum(row[3],-128,128)];
    for(let i=4;i<=9;i++)p.push(cleanNum(row[i]||0,-16,16));
    const fire=cleanText(row[10],'',16);
    if(fire)p.push(fire);
    return p;
  });
  const safe={
    n:cleanText(lean.n,'Unnamed Aircraft',80),
    a:cleanText(lean.a,'Unknown',60),
    r:cleanText(lean.r,'fighter',40),
    c:/^#[0-9a-f]{6}$/i.test(String(lean.c||''))?String(lean.c):'#cfd8e3',
    p:parts,
  };
  return{code:'ASK2.'+askEnc(JSON.stringify(safe)),name:safe.n,role:safe.r};
}
function normalizeBlueprints(codes){
  const out=[],seen=new Set();
  for(const code of codes||[]){
    const bp=canonicalBlueprint(code);
    if(seen.has(bp.code))continue;
    seen.add(bp.code);out.push({...bp,key:'bp'+out.length});
    if(out.length>=PLANNER_MAX_BLUEPRINTS)break;
  }
  return out;
}
function assignment(role){
  role=String(role||'').toLowerCase();
  if(role.includes('balloon'))return'High-altitude bomb group';
  if(role.includes('bomb'))return'Heavy bomber formation';
  if(role.includes('attack')||role.includes('heavy'))return'Armored attack wing';
  if(role.includes('intercept'))return'Air-superiority screen';
  return'Custom combat squadron';
}
function countRange(total){
  if(total===1)return[18,28];
  if(total<=4)return[5,13];
  if(total<=8)return[3,8];
  if(total<=16)return[2,5];
  return[1,3];
}

export function randomMissionSeed(){
  if(globalThis.crypto&&crypto.getRandomValues){const a=new Uint32Array(1);crypto.getRandomValues(a);return a[0]||1;}
  return(Date.now()^Math.floor(Math.random()*0xffffffff))>>>0||1;
}

export function generateMissionPlan(seed,codes){
  seed=Number(seed)>>>0||1;
  const blueprints=normalizeBlueprints(codes);
  if(!blueprints.length)throw new Error('Select at least one saved aircraft');
  const r=rng32(seed),map=pick(r,PLANNER_MAPS),task=pick(r,PLANNER_TASKS),names=[...GROUPS].sort(()=>r()-.5),range=countRange(blueprints.length);
  const forces=blueprints.map((bp,i)=>({blueprintKey:bp.key,count:int(r,range[0],range[1]),skill:Math.round((.86+r()*.14)*100)/100,group:(names[i]||GROUPS[i%GROUPS.length])+' Group',assignment:assignment(bp.role)}));
  const j=()=>int(r,-420,420),deployment={ally:{x:coord(map.ally.x+j()),z:coord(map.ally.z+j())},enemy:{x:coord(map.enemy.x+j()),z:coord(map.enemy.z+j())}},minutes=task.type==='survive'?int(r,7,11):int(r,10,15);
  return{v:PLANNER_VERSION,seed,blueprints,mapId:map.id,taskId:task.id,codename:'OPERATION '+pick(r,['NIGHT SPEAR','BLACK CROWN','IRON COMET','DEAD RECKONING','FINAL ECLIPSE','BROKEN SKY']),forces,deployment,timeLimit:minutes*60,objective:{type:task.type,label:task.label},friendlyCarrier:!!task.friendlyCarrier,enemyCarrier:!!task.enemyCarrier,modifiers:{lowFuel:r()<.55,noBoost:r()<.42,startAirborne:true},threat:forces.reduce((s,x)=>s+x.count,0)};
}

export function encodeMissionPlan(plan){return'AOS2-MP2-'+enc(JSON.stringify(plan));}
export function decodeMissionPlan(code){
  try{
    code=String(code||'').trim();
    if(!code.startsWith('AOS2-MP2-')||code.length>4000000)return null;
    const plan=JSON.parse(dec(code.slice(9)));
    if(plan.v!==PLANNER_VERSION||!Number.isInteger(plan.seed)||!Array.isArray(plan.blueprints)||!plan.blueprints.length)return null;
    const canonical=generateMissionPlan(plan.seed,plan.blueprints.map(bp=>bp&&bp.code));
    return JSON.stringify(plan)===JSON.stringify(canonical)?canonical:null;
  }catch(_e){return null;}
}

export const plannerMap=id=>PLANNER_MAPS.find(m=>m.id===id);
export const plannerTask=id=>PLANNER_TASKS.find(t=>t.id===id);
