export const PLANNER_VERSION = 1;
export const PLANNER_AIRCRAFT_IDS = Object.freeze(['stock_falcon','stock_fortress','stock_goliath','stock_balloon']);
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
const GROUPS=['Razor','Anvil','Reaper','Vortex','Hammer','Wraith','Tempest','Cerberus','Nightmare','Titan'];
const ROLES={stock_falcon:'Air-superiority screen',stock_fortress:'Heavy bomber formation',stock_goliath:'Armored attack wing',stock_balloon:'High-altitude bomb group'};
function rng32(seed){let a=seed>>>0;return()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
const pick=(r,a)=>a[Math.floor(r()*a.length)], int=(r,a,b)=>a+Math.floor(r()*(b-a+1)), coord=n=>Math.max(-3000,Math.min(3000,Math.round(n)));
export function randomMissionSeed(){if(globalThis.crypto&&crypto.getRandomValues){const a=new Uint32Array(1);crypto.getRandomValues(a);return a[0]||1;}return(Date.now()^Math.floor(Math.random()*0xffffffff))>>>0||1;}
export function generateMissionPlan(seed,ids){
  seed=Number(seed)>>>0||1;const allowed=[...new Set((ids||[]).filter(id=>PLANNER_AIRCRAFT_IDS.includes(id)))];if(!allowed.length)throw new Error('Select at least one enemy aircraft');
  const r=rng32(seed),map=pick(r,PLANNER_MAPS),task=pick(r,PLANNER_TASKS),names=[...GROUPS].sort(()=>r()-.5);
  const forces=allowed.map((designId,i)=>({designId,count:allowed.length===1?int(r,18,28):int(r,5,13),skill:Math.round((.86+r()*.14)*100)/100,group:(names[i]||GROUPS[i%GROUPS.length])+' Group',assignment:ROLES[designId]}));
  const j=()=>int(r,-420,420),deployment={ally:{x:coord(map.ally.x+j()),z:coord(map.ally.z+j())},enemy:{x:coord(map.enemy.x+j()),z:coord(map.enemy.z+j())}},minutes=task.type==='survive'?int(r,7,11):int(r,10,15);
  return{v:1,seed,allowed,mapId:map.id,taskId:task.id,codename:'OPERATION '+pick(r,['NIGHT SPEAR','BLACK CROWN','IRON COMET','DEAD RECKONING','FINAL ECLIPSE','BROKEN SKY']),forces,deployment,timeLimit:minutes*60,objective:{type:task.type,label:task.label},friendlyCarrier:!!task.friendlyCarrier,enemyCarrier:!!task.enemyCarrier,modifiers:{lowFuel:r()<.55,noBoost:r()<.42,startAirborne:true},threat:forces.reduce((s,x)=>s+x.count,0)};
}
function enc(s){return btoa(unescape(encodeURIComponent(s))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');}
function dec(s){s=s.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-s.length%4)%4);return decodeURIComponent(escape(atob(s)));}
export function encodeMissionPlan(p){return'AOS2-MP1-'+enc(JSON.stringify(p));}
export function decodeMissionPlan(code){try{code=String(code||'').trim();if(!code.startsWith('AOS2-MP1-'))return null;const p=JSON.parse(dec(code.slice(9)));if(p.v!==1||!Number.isInteger(p.seed)||!Array.isArray(p.allowed)||!p.allowed.length||p.allowed.some(id=>!PLANNER_AIRCRAFT_IDS.includes(id)))return null;const canonical=generateMissionPlan(p.seed,p.allowed);return JSON.stringify(p)===JSON.stringify(canonical)?canonical:null;}catch(_e){return null;}}
export const plannerMap=id=>PLANNER_MAPS.find(m=>m.id===id),plannerTask=id=>PLANNER_TASKS.find(t=>t.id===id);
