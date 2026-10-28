import{State,stockGet,libGet,cloneDesign,statsOf,exportCode,importCode}from'./core.js';
import{$,el,clear,show,hide,toast,sfx}from'./util.js';
import{Battle}from'./battle.js';
import{Menu}from'./menu.js';
import{PLANNER_MAX_BLUEPRINTS,generateMissionPlan,randomMissionSeed,encodeMissionPlan,decodeMissionPlan,plannerMap,plannerTask}from'./mission-planner-data.js';

let root=null,keyHandler=null,plan=null,playerId=null,selectionReady=false;
const selected=new Set();

function hideOthers(){for(const id of['screen-menu','screen-creative','screen-campaign','screen-pvp','screen-hangar']){const n=$(id);if(n)hide(n);}const h=$('hud');if(h)hide(h);}
function eligibleDesigns(){return(State.library||[]).filter(d=>d&&d.id&&d.role!=='ship'&&d.role!=='carrier'&&statsOf(d).ok);}
function syncSelection(){
  const designs=eligibleDesigns(),ids=new Set(designs.map(d=>d.id));
  for(const id of selected)if(!ids.has(id))selected.delete(id);
  if(!selectionReady){designs.slice(0,PLANNER_MAX_BLUEPRINTS).forEach(d=>selected.add(d.id));selectionReady=true;}
  if(!playerId||!libGet(playerId))playerId=(designs[0]||State.library[0]||{}).id||null;
}
function designCodes(){return eligibleDesigns().filter(d=>selected.has(d.id)).map(exportCode);}
function folderName(design){const f=(State.designFolders||[]).find(x=>x.id===design.folderId);return f?f.name:'Unfiled';}
function canonicalCode(design){const p=generateMissionPlan(1,[exportCode(design)]);return p.blueprints[0].code;}
function planDesigns(value=plan){
  if(!value||!Array.isArray(value.blueprints))return null;
  const out=value.blueprints.map(bp=>importCode(bp.code));
  return out.every((d,i)=>d&&statsOf(d).ok&&value.blueprints[i].key)?out:null;
}

export const MissionPlanner={
  show(){root=$('screen-mission-planner');if(!root)return;hideOthers();show(root);syncSelection();render();if(keyHandler)removeEventListener('keydown',keyHandler);keyHandler=e=>{if(e.key==='Escape')back();};addEventListener('keydown',keyHandler);},
  close(){if(keyHandler){removeEventListener('keydown',keyHandler);keyHandler=null;}if(root){hide(root);clear(root);}},
};

function render(){
  clear(root);root.classList.add('mission-planner-screen');
  const head=el('div','topbar planner-topbar'),backBtn=el('button','btn small','◂ BACK');backBtn.onclick=back;head.appendChild(backBtn);
  const title=el('div');title.innerHTML='<span class="eyebrow">Random Operation Generator</span><div class="planner-title">MISSION PLANNER</div>';head.appendChild(title);head.appendChild(el('div','spacer'));head.appendChild(el('div','planner-rank','WORLD THREAT RANK #2'));root.appendChild(head);
  const hero=el('div','planner-hero');hero.innerHTML='<div><span class="eyebrow">Your creations become the enemy pool</span><h2>SELECT YOUR DESIGNS. THE PLANNER BUILDS THE WAR.</h2><p>Choose flight-ready aircraft from your saved creation library. Every selected design is guaranteed to appear; its complete blueprint is sealed into the reproducible play code.</p></div><div class="planner-danger">SECOND-HARDEST<br><small>EXTREME ENDGAME MISSION</small></div>';root.appendChild(hero);
  const grid=el('div','planner-grid');grid.appendChild(enemyPanel());grid.appendChild(playerPanel());root.appendChild(grid);root.appendChild(codePanel());if(plan)root.appendChild(resultPanel());
}
function titleRow(n,t){const r=el('div','planner-section-title');r.appendChild(el('span','',n));r.appendChild(el('h2','',t));return r;}

function enemyPanel(){
  const designs=eligibleDesigns(),p=el('section','panel');p.appendChild(titleRow('01','Enemy Designs From Your Library'));p.appendChild(el('p','muted small',`Choose up to ${PLANNER_MAX_BLUEPRINTS} saved, flight-ready creations. Every selected design will appear with a randomized quantity.`));
  const g=el('div','planner-aircraft-grid');
  for(const d of designs){
    const isSelected=selected.has(d.id),b=el('button','planner-aircraft-card'+(isSelected?' sel':''));b.setAttribute('aria-pressed',String(isSelected));
    b.appendChild(el('b','',d.name||'Unnamed Aircraft'));b.appendChild(el('span','',`${folderName(d)} · ${d.role||'aircraft'}`));b.appendChild(el('i','',isSelected?'ALLOWED':'BLOCKED'));
    b.onclick=()=>{if(!isSelected&&selected.size>=PLANNER_MAX_BLUEPRINTS){toast(`Choose no more than ${PLANNER_MAX_BLUEPRINTS} enemy designs`,'warn');return;}selected.has(d.id)?selected.delete(d.id):selected.add(d.id);plan=null;sfx('click');render();};g.appendChild(b);
  }
  if(!designs.length)g.appendChild(el('div','warns err','No flight-ready aircraft creations found. Build or import an aircraft in My Creations first.'));
  p.appendChild(g);
  const row=el('div','row');row.style.marginTop='12px';const all=el('button','btn ghost small','SELECT ALL'),none=el('button','btn ghost small','CLEAR');
  all.disabled=!designs.length;all.onclick=()=>{designs.slice(0,PLANNER_MAX_BLUEPRINTS).forEach(d=>selected.add(d.id));plan=null;render();};none.onclick=()=>{selected.clear();plan=null;render();};row.appendChild(all);row.appendChild(none);p.appendChild(row);return p;
}

function playerPanel(){
  const p=el('section','panel');p.appendChild(titleRow('02','Your Aircraft'));const sel=el('select');sel.setAttribute('aria-label','Player aircraft');sel.style.width='100%';
  for(const d of eligibleDesigns()){const o=el('option','',d.name);o.value=d.id;o.selected=d.id===playerId;sel.appendChild(o);}sel.onchange=()=>{playerId=sel.value;render();};p.appendChild(sel);
  const d=libGet(playerId);if(d){const s=statsOf(d),box=el('div','planner-player-stats');box.appendChild(el('b','',d.name));box.appendChild(el('span','',`${Math.round(s.durability)} HP`));box.appendChild(el('span','',`${(s.mass/1000).toFixed(1)} t`));box.appendChild(el('span','',`${(s.weapons||[]).length} weapons`));p.appendChild(box);if(!s.ok)p.appendChild(el('div','warns err','⚠ This aircraft is not flight-ready.'));}else p.appendChild(el('div','warns err','No saved flight-ready aircraft available.'));
  p.appendChild(el('div','planner-warning','Enemy strength is deliberately overwhelming: elite AI and at least 18 hostiles when only one creation is selected.'));return p;
}

function codePanel(){
  const p=el('section','panel planner-code-panel');p.appendChild(titleRow('03','Generate or Load a Play Code'));const row=el('div','row'),gen=el('button','btn danger big','⚠ GENERATE EXTREME MISSION');gen.disabled=!selected.size;
  gen.onclick=()=>{try{plan=generateMissionPlan(randomMissionSeed(),designCodes());sfx('lockfull');toast('Extreme operation generated from your creations','good');render();}catch(e){toast(e.message,'warn');}};row.appendChild(gen);
  if(plan){const rr=el('button','btn','↻ REROLL');rr.onclick=gen.onclick;row.appendChild(rr);}p.appendChild(row);
  const lab=el('label','field');lab.textContent=plan?'Generated play code — includes the enemy blueprints':'Paste a Mission Planner play code';const input=el('textarea');input.id='mission-play-code';input.rows=4;input.placeholder='AOS2-MP2-…';input.value=plan?encodeMissionPlan(plan):'';lab.appendChild(input);p.appendChild(lab);
  const acts=el('div','row'),load=el('button','btn accent','LOAD CODE');load.onclick=()=>{const value=decodeMissionPlan(input.value);if(!value||!planDesigns(value)){toast('Invalid or unusable Mission Planner code','bad');return;}plan=value;const wanted=new Set(value.blueprints.map(bp=>bp.code));selected.clear();for(const d of eligibleDesigns()){try{if(wanted.has(canonicalCode(d)))selected.add(d.id);}catch(_e){}}toast('Play code and custom enemy blueprints loaded','good');render();};acts.appendChild(load);
  if(plan){const copy=el('button','btn gold','COPY CODE');copy.onclick=async()=>{try{await navigator.clipboard.writeText(encodeMissionPlan(plan));}catch(_e){input.focus();input.select();document.execCommand('copy');}toast('Play code copied','good');};acts.appendChild(copy);}p.appendChild(acts);return p;
}

function resultPanel(){
  const map=plannerMap(plan.mapId),task=plannerTask(plan.taskId),p=el('section','panel planner-result'),banner=el('div','planner-operation-banner'),left=el('div');left.appendChild(el('span','eyebrow',plan.codename));left.appendChild(el('h2','',task.name));left.appendChild(el('p','',`${map.name} · ${map.theatre}`));banner.appendChild(left);const threat=el('div');threat.appendChild(el('strong','',String(plan.threat)));threat.appendChild(el('small','','HOSTILES'));banner.appendChild(threat);p.appendChild(banner);
  const facts=el('div','planner-facts');for(const [small,big,sub] of[['THEATRE',map.name,map.env.toUpperCase()],['OBJECTIVE',plan.objective.label,`${Math.round(plan.timeLimit/60)} MIN LIMIT`],['DEPLOYMENT',`${Math.round(Math.hypot(plan.deployment.enemy.x-plan.deployment.ally.x,plan.deployment.enemy.z-plan.deployment.ally.z))} M`,'INITIAL SEPARATION']]){const box=el('div');box.appendChild(el('small','',small));box.appendChild(el('b','',big));box.appendChild(el('span','',sub));facts.appendChild(box);}p.appendChild(facts);p.appendChild(el('h3','','Enemy Task Groups'));
  const groups=el('div','planner-task-groups'),bpByKey=new Map(plan.blueprints.map(bp=>[bp.key,bp]));for(const row of plan.forces){const bp=bpByKey.get(row.blueprintKey),c=el('div','planner-task-card');c.appendChild(el('span','',row.group));c.appendChild(el('b','',`${row.count} × ${bp?bp.name:'Unknown creation'}`));c.appendChild(el('small','',`${row.assignment} · ${Math.round(row.skill*100)}% AI skill`));groups.appendChild(c);}p.appendChild(groups);
  const mods=[];if(plan.friendlyCarrier)mods.push('Friendly carrier');if(plan.enemyCarrier)mods.push('Enemy carrier');if(plan.modifiers.lowFuel)mods.push('25% starting fuel');if(plan.modifiers.noBoost)mods.push('Afterburner disabled');const mr=el('div','planner-mods');for(const x of mods.length?mods:['No relief modifiers'])mr.appendChild(el('span','tag',x));p.appendChild(mr);const launch=el('button','btn danger big planner-launch','▶ PLAY GENERATED MISSION');launch.onclick=launchPlan;p.appendChild(launch);return p;
}

function launchPlan(){
  const player=libGet(playerId),designs=planDesigns();if(!player||!statsOf(player).ok){toast('Choose a flight-ready saved aircraft','bad');return;}if(!designs){toast('The enemy blueprints in this code cannot be flown','bad');return;}
  const map=plannerMap(plan.mapId),byKey=new Map(plan.blueprints.map((bp,i)=>[bp.key,designs[i]])),cfg={player:cloneDesign(player,''),allies:[],enemies:plan.forces.map(r=>({design:cloneDesign(byKey.get(r.blueprintKey),''),count:r.count,skill:r.skill})),env:map.env,objective:{...plan.objective},timeLimit:plan.timeLimit,carrier:plan.friendlyCarrier?stockGet('stock_carrier'):null,enemyCarrier:plan.enemyCarrier?stockGet('stock_carrier'):null,deployment:{ally:{...plan.deployment.ally},enemy:{...plan.deployment.enemy}},lowFuel:!!plan.modifiers.lowFuel,noBoost:!!plan.modifiers.noBoost,startAirborne:true,net:null,missionPlanner:{code:encodeMissionPlan(plan),codename:plan.codename,mapName:map.name},onEnd};
  if(keyHandler){removeEventListener('keydown',keyHandler);keyHandler=null;}hide(root);try{Battle.start(cfg);}catch(e){console.error(e);toast('Could not launch generated mission','bad');show(root);}
}
function onEnd(r){toast((r&&r.win?'PLANNER VICTORY':'PLANNER DEFEAT')+' · '+(r&&r.reason||'operation ended'),r&&r.win?'good':'warn');MissionPlanner.show();}
function back(){sfx('click');MissionPlanner.close();Menu.show();}
