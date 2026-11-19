import { attitude, localDirection, FLIGHT_ACTIONS, canManeuver } from './flight-controls.js';

// Independent of radar range/locks: every living hostile contributes a bearing.
// Forward contacts live on the sphere; aft contacts point outwards on its rim.
export function navballContacts(player, craft = [], carriers = [], frame = attitude(player.group.quaternion)){
  const contacts = [], seen = new Set();
  for (const group of [craft, carriers]) for (const enemy of group){
    if (!enemy?.alive || enemy === player || enemy.team === player.team || seen.has(enemy) || !enemy.pos) continue;
    seen.add(enemy);
    const dx=enemy.pos.x-player.pos.x, dy=enemy.pos.y-player.pos.y, dz=enemy.pos.z-player.pos.z;
    const distance=Math.hypot(dx,dy,dz);
    if (!Number.isFinite(distance) || distance<.01) continue;
    const v=localDirection({x:dx/distance,y:dy/distance,z:dz/distance},frame);
    const behind=v.z<0, radial=Math.hypot(v.x,v.y);
    contacts.push({ x:behind ? (radial>.0001 ? v.x/radial : 0) : v.x,
      y:behind ? (radial>.0001 ? -v.y/radial : 1) : -v.y, behind, distance });
  }
  // Draw the closest contact last so distant formations cannot cover it.
  return contacts.sort((a,b)=>b.distance-a.distance);
}

export function weaponReadout(w){
  if (!w) return { name: 'No manual weapons', ammo: 0, reserve: 0, count: 0, reload: 0, kind: 'none', model: 'none' };
  const members = w.linkedWeapons?.length ? w.linkedWeapons : [w];
  const key = `${w.key || ''} ${w.weapon || ''} ${w.partKey || ''} ${w.name || ''}`.toLowerCase();
  const kind = w.torpedo || /torpedo/.test(key) ? 'torpedo' : w.type === 'bomb' || /bomb|napalm/.test(key) ? 'bomb' : w.type !== 'gun' ? 'missile'
    : /gatling|vulcan|minigun/.test(key) ? 'gatling' : /cannon|flak|railgun/.test(key) ? 'cannon' : 'gun';
  const model = /rocketpod|rocket/.test(key) ? 'rocketpod' : /cluster/.test(key) ? 'clusterbomb' : /guided/.test(key) ? 'guidedbomb' : /heavy|aam/.test(key) ? `heavy-${kind}` : kind;
  return { name: w.name || 'Weapon', count: members.length, kind, model,
    ammo: members.reduce((n, m) => n + Math.max(0, m.ammo || 0), 0),
    reserve: members.reduce((n, m) => n + Math.max(0, m.reserve || 0), 0),
    reload: Math.max(0, ...members.map(m => m.reloading || 0)) };
}

// Original lightweight wireframe silhouettes; no image downloads or WebGL pass.
const OUTLINES = {
  gun: 'M16 29H60L69 24H115V32H69L60 39H17ZM24 39V47H39L44 39M27 29V21H47V29M70 27H113M47 31V37M54 30V36',
  cannon: 'M14 26H59L69 21H116V34H69L59 40H14ZM24 40V47H45V40M73 25H114M73 30H114M51 26V40',
  gatling: 'M14 25H48L57 19H70V44H57L48 38H14ZM70 22H113V27H70M70 30H117V35H70M70 38H113V43H70M26 38V47H42V38',
  missile: 'M16 28H98L118 33L98 38H16ZM45 28L67 11H74L65 28M45 38L67 55H74L65 38M20 28L10 19H30L38 28M20 38L10 47H30L38 38M96 28V38',
  bomb: 'M33 23Q72 15 94 25Q116 33 94 41Q72 51 33 43ZM33 23L16 13V53L33 43M16 33H33M62 21V45M91 24V42',
  torpedo: 'M22 25H101Q122 33 101 41H22ZM26 25L15 16V50L26 41M42 25V41M92 25V41M10 26V40M7 33H22',
  none: 'M44 33H88M66 11V55',
  rocketpod: 'M23 17H109V49H23ZM29 22V44M43 22V44M57 22V44M71 22V44M85 22V44M99 22V44M18 25H23M18 41H23',
  'heavy-missile': 'M13 29H94L119 33L94 37H13ZM34 29L54 13H64L57 29M34 37L54 53H64L57 37M16 29L7 20H25L32 29M16 37L7 46H25L32 37M87 29V37',
  'heavy-bomb': 'M39 18Q75 11 101 25Q120 33 101 41Q75 55 39 48ZM39 18L21 9V57L39 48M21 33H39M61 17V49M91 22V44M49 20L43 12M49 46L43 54',
  clusterbomb: 'M35 21Q69 13 96 25Q117 33 96 41Q69 53 35 45ZM35 21L18 13V53L35 45M61 19V47M92 23V43M76 22L83 15M76 44L83 51',
  guidedbomb: 'M35 21Q69 13 96 25Q117 33 96 41Q69 53 35 45ZM35 21L18 13V53L35 45M61 19V47M92 23V43M49 19L45 10M49 47L45 56',
};
const silhouette = model => `<svg viewBox="0 0 132 66" aria-hidden="true"><path d="${OUTLINES[model] || OUTLINES[model.replace(/^heavy-/, '')] || OUTLINES.none}"/></svg>`;
const SKY = [43,126,183], GROUND = [155,86,48];

class Navball {
  constructor(canvas){
    this.ctx = canvas.getContext('2d'); canvas.width = canvas.height = 180;
    this.surface = this.ctx.createImageData(180, 180);
    this.pixels = [];
    for (let y=0; y<180; y++) for (let x=0; x<180; x++){
      const nx=(x-89.5)/73, ny=(89.5-y)/73, r=nx*nx+ny*ny;
      if (r>1) continue;
      const nz=Math.sqrt(1-r), i=(y*180+x)*4;
      this.surface.data[i+3] = Math.min(255, (1-r)*9000);
      this.pixels.push([i,nx,ny,nz,.44+.54*nz+.10*ny]);
    }
  }
  draw(q, velocity, contacts = []){
    const f=attitude(q), ctx=this.ctx, data=this.surface.data;
    for (const [i,x,y,z,light] of this.pixels){
      const sky = x*f.right.y+y*f.up.y+z*f.forward.y >= 0;
      const c=sky ? SKY : GROUND;
      data[i]=c[0]*light; data[i+1]=c[1]*light; data[i+2]=c[2]*light;
    }
    ctx.clearRect(0,0,180,180); ctx.putImageData(this.surface,0,0);
    const point = (lat,lon) => {
      const c=Math.cos(lat), v=localDirection({ x:Math.sin(lon)*c,y:Math.sin(lat),z:Math.cos(lon)*c },f);
      return { x:90+v.x*73,y:90-v.y*73,front:v.z>0.025 };
    };
    const line = (fn, horizon=false) => {
      ctx.beginPath(); let started=false;
      for(let i=0;i<=120;i++){
        const p=fn(i/120);
        if (!p.front){ started=false; continue; }
        if (started) ctx.lineTo(p.x,p.y); else ctx.moveTo(p.x,p.y);
        started=true;
      }
      ctx.strokeStyle=horizon?'#e7f2ed':'rgba(222,239,249,.3)'; ctx.lineWidth=horizon?1.6:.7; ctx.stroke();
    };
    for(const deg of [-60,-30,0,30,60]) line(t=>point(deg*Math.PI/180,t*Math.PI*2),deg===0);
    for(let deg=0;deg<360;deg+=30) line(t=>point(-Math.PI/2+t*Math.PI,deg*Math.PI/180));
    ctx.font='bold 11px monospace'; ctx.textAlign='center'; ctx.textBaseline='middle';
    for(const [label,deg] of [['N',0],['E',90],['S',180],['W',270]]){
      const p=point(.15,deg*Math.PI/180);
      if(p.front){ ctx.fillStyle='#fff3d4'; ctx.fillText(label,p.x,p.y); }
    }
    for(const deg of [-60,-30,30,60]){
      const p=point(deg*Math.PI/180,f.yaw);
      if(p.front){ ctx.fillStyle='#dbeafa'; ctx.font='9px monospace'; ctx.fillText(`${deg>0?'+':''}${deg}`,p.x,p.y-5); }
    }
    const speed=Math.hypot(velocity.x,velocity.y,velocity.z);
    if(speed>1){
      const v=localDirection({x:velocity.x/speed,y:velocity.y/speed,z:velocity.z/speed},f);
      if(v.z>0){
        const x=90+v.x*73,y=90-v.y*73;
        ctx.strokeStyle='#a6ff8b'; ctx.lineWidth=1.6; ctx.beginPath();ctx.arc(x,y,5,0,Math.PI*2);
        ctx.moveTo(x-10,y);ctx.lineTo(x-5,y);ctx.moveTo(x+5,y);ctx.lineTo(x+10,y);ctx.moveTo(x,y-5);ctx.lineTo(x,y-10);ctx.stroke();
      }
    }
    // Fixed aircraft reference; the sphere rotates underneath it, including inverted flight.
    ctx.strokeStyle='#ffce6a'; ctx.lineWidth=2.4;ctx.beginPath();
    ctx.moveTo(64,90);ctx.lineTo(79,90);ctx.lineTo(84,95);ctx.moveTo(96,95);ctx.lineTo(101,90);ctx.lineTo(116,90);ctx.stroke();
    ctx.beginPath();ctx.arc(90,90,2,0,Math.PI*2);ctx.stroke();
    ctx.strokeStyle='#728998';ctx.lineWidth=3;ctx.beginPath();ctx.arc(90,90,75,0,Math.PI*2);ctx.stroke();
    for(const deg of [-60,-30,0,30,60]){
      const a=deg*Math.PI/180;
      ctx.strokeStyle=deg===0?'#ffce6a':'#a2b8c7';ctx.lineWidth=1.6;ctx.beginPath();
      ctx.moveTo(90+Math.sin(a)*78,90-Math.cos(a)*78);ctx.lineTo(90+Math.sin(a)*84,90-Math.cos(a)*84);ctx.stroke();
    }
    for (let i=0;i<contacts.length;i++){
      const c=contacts[i], radius=c.behind?82:70, nearest=i===contacts.length-1;
      const x=90+c.x*radius,y=90+c.y*radius,size=nearest?5:3.7;
      ctx.save();ctx.translate(x,y);ctx.beginPath();
      if(c.behind){
        ctx.rotate(Math.atan2(c.y,c.x));
        ctx.moveTo(-size,-size);ctx.lineTo(size*.5,0);ctx.lineTo(-size,size);
      } else {
        ctx.moveTo(0,-size);ctx.lineTo(size,0);ctx.lineTo(0,size);ctx.lineTo(-size,0);ctx.closePath();
        ctx.fillStyle=nearest?'#ffb1b9':'#ff637e';ctx.fill();
      }
      ctx.strokeStyle='#070e17';ctx.lineWidth=4;ctx.stroke();
      ctx.strokeStyle=nearest?'#ffd3d7':'#ff718b';ctx.lineWidth=1.7;ctx.stroke();ctx.restore();
    }
    return f;
  }
}

export class FlightDeck {
  constructor(host, onAction, onWeapon){
    const root=document.createElement('section'); root.className='flight-deck';root.setAttribute('aria-label','Flight instruments');
    root.innerHTML=`<div class="maneuver-panel"><div class="instrument-label">FLIGHT DIRECTOR</div><div class="maneuver-buttons"></div><div class="director-status">MANUAL CONTROL</div></div>
      <div class="navball-shell" title="Enemy bearings: solid diamonds ahead, hollow rim arrows behind. Brightest marker is nearest. Independent of radar."><div class="navball-heading">HDG <b>000°</b></div><canvas aria-label="Attitude navball"></canvas><div class="navball-readout">PITCH +00° · BANK 00°</div><div class="navball-threats">NO HOSTILES</div></div>
      <div class="weapon-panel"><div class="instrument-label">ACTIVE WEAPON <span class="weapon-slot"></span></div><div class="weapon-ghost"></div><div class="weapon-name"></div><div class="weapon-ammo"><b>0</b><span>ROUNDS</span></div><div class="weapon-reserve"></div></div>`;
    host.appendChild(root);this.root=root;
    // A HUD click must never also fire a weapon or capture the mouse.
    root.addEventListener('mousedown',e=>e.stopPropagation());
    root.addEventListener('click',e=>e.stopPropagation());
    this.buttons=FLIGHT_ACTIONS.map(([id,label,key])=>{
      const b=document.createElement('button');b.type='button';b.dataset.action=id;b.title=`${label} (${key})`;
      b.innerHTML=`<kbd>${key}</kbd><span>${label}</span>`;
      b.addEventListener('click',()=>{ onAction(id);b.blur(); });root.querySelector('.maneuver-buttons').appendChild(b);return b;
    });
    this.canvas=root.querySelector('canvas');this.navball=new Navball(this.canvas);
    this.heading=root.querySelector('.navball-heading b');this.readout=root.querySelector('.navball-readout');
    this.threats=root.querySelector('.navball-threats');this.contacts=[];
    this.status=root.querySelector('.director-status');this.ghost=root.querySelector('.weapon-ghost');
    this.name=root.querySelector('.weapon-name');this.ammo=root.querySelector('.weapon-ammo b');
    this.units=root.querySelector('.weapon-ammo span');this.reserve=root.querySelector('.weapon-reserve');
    this.slot=root.querySelector('.weapon-slot');this.lastDraw=-1;this.lastKind='';
  }
  draw(p, time, craft = [], carriers = []){
    if (!p || time-this.lastDraw < 1/30) return;
    this.lastDraw=time;this.contacts=navballContacts(p,craft,carriers);
    this.navball.draw(p.group.quaternion,p.vel,this.contacts);
  }
  update(p, director, paused){
    const a=attitude(p.group.quaternion), deg=180/Math.PI;
    const heading=(Math.round(a.yaw*deg)+360)%360,pitch=Math.round(a.pitch*deg),bank=Math.round(a.bank*deg);
    this.heading.textContent=String(heading).padStart(3,'0')+'°';
    this.readout.textContent=`PITCH ${pitch>=0?'+':''}${pitch}° · BANK ${bank}°`;
    const aft=this.contacts.filter(c=>c.behind).length;
    this.threats.textContent=this.contacts.length?`◆ ${this.contacts.length} HOSTILE${this.contacts.length===1?'':'S'} · ${aft} AFT`:'NO HOSTILES';
    this.canvas.setAttribute('aria-label',`Attitude navball: heading ${heading} degrees, pitch ${pitch} degrees, bank ${bank} degrees; ${this.contacts.length} hostiles, ${aft} behind`);
    for(const b of this.buttons){
      b.disabled=paused || (b.dataset.action!=='manual' && !canManeuver(p));
      b.setAttribute('aria-pressed',String(b.dataset.action===director.mode));
    }
    this.status.textContent=paused?'SIMULATION PAUSED':!canManeuver(p)?'FIXED-WING ASSISTS':director.mode==='manual'?'MANUAL CONTROL':'STEER TO CANCEL';
    const w=weaponReadout(p.weapons[p.curWeapon]);
    if (this.lastKind!==w.model){this.lastKind=w.model;this.ghost.innerHTML=silhouette(w.model);}
    this.name.textContent=w.name+(w.count>1?` ×${w.count}`:'');
    this.ammo.textContent=String(w.ammo);this.units.textContent=w.count>1?'TOTAL READY':w.kind==='gun'||w.kind==='gatling'||w.kind==='cannon'?'ROUNDS':'READY';
    this.reserve.textContent=w.reload>0?`RELOADING · ${w.reload.toFixed(1)}s`:`${w.reserve} RESERVE · ${p.flares || 0} FLARES`;
    this.root.classList.toggle('reloading',w.reload>0);
    this.slot.textContent=p.weapons.length?`${p.curWeapon+1}/${p.weapons.length}`:'—';
  }
}
