// ============================================================================
//  Ace of Sky II — ai.js
//  Combat AI for every non-player aircraft (enemy fighters, allied wingmen,
//  bombers, and carrier point-defence). The battle sim owns the world and the
//  flight integrator; this module only DECIDES — it reads a craft + the world
//  and writes an intent block (throttle / boost / desired heading / fire flags)
//  back onto the craft, which the integrator then turns into motion.
//
//  Design philosophy (so battle.js stays readable):
//    - A "craft" is the live actor object the sim maintains. AI never moves it
//      directly; it sets craft.ai.* intents and craft.want* flags.
//    - leadPoint() (prediction.js) gives the aim solution; skill (0..1) scales
//      how tight that solution is, how fast the AI reacts, and how aggressive
//      it gets about closing range vs. extending/evading.
//    - Behaviour is a small state machine: SEEK → PURSUE → ATTACK → EXTEND →
//      EVADE. Hysteresis (range bands + a reaction clock) keeps it from
//      twitching between states every frame.
//
//  Public API used by battle.js:
//    initAI(craft, skill)             — seed craft.ai once at spawn
//    updateAI(craft, world, dt)       — per-frame brain for a fighter/wingman
//    updateBomber(craft, world, dt)   — bomber brain (runs on carrier targets)
//    updateCarrierPD(carrier, world, dt) — point-defence target selection
//    pickTarget(craft, world)         — nearest hostile in sensor range
// ============================================================================
import * as THREE from 'three';
import { clamp, lerp } from './util.js';
import { leadPoint, interceptTime } from './prediction.js';

// scratch vectors (module-local, never escape a call) ------------------------
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _d = new THREE.Vector3(), _e = new THREE.Vector3();
const _fwd = new THREE.Vector3(), _to = new THREE.Vector3(), _lead = new THREE.Vector3();

// ---------------------------------------------------------------------------
//  Per-craft AI memory. Called once when the sim spawns a non-player craft.
// ---------------------------------------------------------------------------
export function initAI(craft, skill = 0.5){
  skill = clamp(skill, 0, 1);

  // Combat DOCTRINE — a dogfighting personality derived from the airframe:
  //  • 'energy' (boom & zoom): fast/heavy jets that refuse the turning fight — they
  //    slash in from above, take one firing pass, then extend and re-climb to do it
  //    again, trading altitude for speed and back.
  //  • 'angles' (turn & burn): nimble jets that knife into the turn and fight for the
  //    target's six o'clock.
  //  • 'balanced': the original all-rounder (also the fallback).
  const agi = craft.stats?.agility?.yaw ?? 30;       // deg/s of yaw authority
  const vmax = craft.stats?.vMax ?? 300;             // top speed
  const energyBias = clamp((vmax - 260) / 200, 0, 1) - clamp((agi - 40) / 45, 0, 1) + 0.45;
  let doctrine = 'balanced';
  if (Math.random() > 0.15) doctrine = (Math.random() < energyBias) ? 'energy' : 'angles';

  craft.ai = {
    skill,
    doctrine,
    state: 'seek',
    target: null,
    assignedTarget: null,     // set by updateSquads — keeps the team focused/pincering
    flankSide: 0,             // -1 / 0 / +1 lateral approach offset (surround the target)
    flankVert: 0,             // -1 / 0 / +1 vertical approach offset (high/low pincer)
    react: 0,                 // reaction clock — AI re-decides when this hits 0
    reactTime: lerp(0.55, 0.12, skill),  // skilled pilots think faster
    aimJitter: lerp(0.10, 0.006, skill), // radians of aim error (worse = wider)
    burstT: 0,                // gun burst gating
    burstGap: lerp(0.8, 0.22, skill),   // pause between bursts — shorter so they keep up sustained fire
    evadeT: 0,
    evadeDir: 1,
    zoomT: 0,                 // boom-&-zoom extend/climb timer (energy doctrine)
    bombEgressT: 0,           // bomber: straight climb after a pass before turning back
    rollPhase: Math.random() * Math.PI * 2,
    panic: 0,                 // accumulates when under fire → triggers evade
    desired: new THREE.Vector3(0, 0, 1),
    altFloor: 60 + Math.random() * 40,   // each AI keeps its own minimum altitude
    weaponPref: 0,            // index it likes to use; recomputed on target
    fireGun: false,
    fireMissile: false,
    wantFlare: false,
  };
  return craft.ai;
}

// distance helper on raw vec3-likes
function dist(a, b){ return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }

// The battlefield is not flat: land can rise almost 50 m above groundY.  Look
// ahead along the current flight path as well as beneath the aircraft so an AI
// starts a recovery before a ridge (or a high-speed descent) becomes fatal.
function terrainRisk(craft, world, ai){
  const surface = (x, z) => (typeof world.surfaceHeight === 'function')
    ? world.surfaceHeight(x, z)
    : (world.groundY || 0);
  const speed = Math.max(0, craft.speed || craft.vel.length());
  const sink = Math.max(0, -craft.vel.y);
  const lookT = lerp(1.35, 2.25, ai.skill) + clamp(speed / 500, 0, 0.55);
  const here = surface(craft.pos.x, craft.pos.z);
  const ahead = surface(craft.pos.x + craft.vel.x * lookT, craft.pos.z + craft.vel.z * lookT);
  const clearance = craft.pos.y - here;
  const projectedClearance = craft.pos.y + craft.vel.y * lookT - ahead;
  const safe = Math.max(ai.altFloor, 85 + speed * 0.30 + sink * 2.2);
  const lowest = Math.min(clearance, projectedClearance);
  return {
    clearance,
    safe,
    needClimb: clamp((safe - lowest) / Math.max(1, safe), 0, 1),
  };
}

// ---------------------------------------------------------------------------
//  Target selection — nearest living hostile within sensor/engagement range.
//  Wingmen (team 0) hunt enemies; enemies (team 1) hunt the player & allies.
// ---------------------------------------------------------------------------
export function pickTarget(craft, world){
  let best = null, bestScore = Infinity;
  const sensorRange = 2200 + (craft.stats?.sensor ? 1400 : 0);
  for (const o of world.craft){
    if (!o.alive || o === craft || o.team === craft.team) continue;
    const d = dist(craft.pos, o.pos);
    if (d > sensorRange * 1.6) continue;
    // prefer closer + already-threatened-by-me targets; the player is juicier
    let score = d;
    if (o === world.player) score *= 0.8;
    if (craft.ai && craft.ai.target === o) score *= 0.6;   // sticky
    if (score < bestScore){ bestScore = score; best = o; }
  }
  return best;
}

// pick a carrier the AI (a bomber) should attack
function pickCarrierTarget(craft, world){
  let best = null, bestD = Infinity;
  for (const c of world.carriers){
    if (!c.alive || c.team === craft.team) continue;
    const d = dist(craft.pos, c.pos);
    if (d < bestD){ bestD = d; best = c; }
  }
  return best;
}

// Mirror battle.js's ballistic bomb step so an AI bomber releases far enough
// AHEAD of a surface target for its carried momentum to put the bomb on deck.
// The old "within 240 m of the carrier" gate waited until almost overhead, so
// a jet-speed bomber's ordnance sailed hundreds of metres beyond the target.
function bombImpactSolution(craft, world, carrier, weapon){
  let x = craft.pos.x, y = craft.pos.y, z = craft.pos.z;
  let vx = craft.vel.x, vy = craft.vel.y, vz = craft.vel.z;
  const step = 0.12;
  for (let t = step; t <= 14; t += step){
    vy -= 9.80665 * step;
    const drag = 1 - 0.02 * step;
    vx *= drag; vy *= drag; vz *= drag;
    x += vx * step; y += vy * step; z += vz * step;
    const surface = (typeof world.surfaceHeight === 'function')
      ? world.surfaceHeight(x, z)
      : (world.groundY || 0);
    if (y <= surface + 1){
      const tvx = carrier.vel?.x || 0, tvz = carrier.vel?.z || 0;
      const tx = carrier.pos.x + tvx * t, tz = carrier.pos.z + tvz * t;
      const miss = Math.hypot(x - tx, z - tz);
      // Let a direct hull strike or a useful splash hit trigger the release,
      // without treating the carrier's long broad-phase radius as unlimited aim tolerance.
      const hull = clamp(carrier.hitR || 70, 35, 180);
      const splash = Math.min(160, weapon.splash || 0) * 0.65;
      return { miss, tolerance: hull + splash, impactX: x, impactZ: z, targetX: tx, targetZ: tz, time: t };
    }
  }
  return null;
}

// forward axis of a craft (nose = +Z in local space) into _fwd
function craftForward(craft, out){
  out = out || _fwd;
  out.set(0, 0, 1).applyQuaternion(craft.group.quaternion);
  return out;
}

// pick the weapon index this craft should be using for a given range/target
function chooseWeapon(craft, range, target){
  const ws = craft.weapons;
  if (!ws || !ws.length) return -1;
  // far away → reach for a missile; otherwise GUNS (unlimited ammo). The threshold is
  // high so a craft with only a couple of missiles doesn't dribble them at medium range
  // and then sit there doing nothing — it closes and hoses with guns instead.
  const wantMissile = range > 1300;
  let gunIdx = -1, missIdx = -1;
  for (let i = 0; i < ws.length; i++){
    const w = ws[i];
    if (w.type === 'bomb') continue;            // bombers handle bombs separately
    if (w.ammo <= 0 && w.reserve <= 0) continue;
    if (w.type === 'gun'){ if (gunIdx < 0) gunIdx = i; }
    else { if (missIdx < 0) missIdx = i; }
  }
  if (wantMissile && missIdx >= 0) return missIdx;
  if (gunIdx >= 0) return gunIdx;
  return missIdx >= 0 ? missIdx : (gunIdx >= 0 ? gunIdx : -1);
}

// ---------------------------------------------------------------------------
//  MAIN FIGHTER / WINGMAN BRAIN
//  Sets on craft.ai: desired (unit heading), and the craft-level intents
//  craft.throttle, craft.boost, craft.wantGun, craft.wantMissile,
//  craft.wantFlare, craft.aiWeaponIdx. The integrator reads these.
// ---------------------------------------------------------------------------
export function updateAI(craft, world, dt){
  const ai = craft.ai;
  if (!ai) return;

  // clocks
  ai.react -= dt;
  ai.burstT -= dt;
  ai.evadeT -= dt;
  ai.zoomT -= dt;
  ai.panic = Math.max(0, ai.panic - dt * 0.6);
  craft.wantGun = false;
  craft.wantMissile = false;
  craft.wantFlare = false;

  // STANDING-START TAKEOFF: while still on the surface (a water/runway start), firewall
  // the throttle and hold near-level to build flying speed FAST. Hauling the nose up at
  // zero knots bleeds the forward acceleration and leaves wingmen wallowing on the water
  // behind the player. The integrator lifts the craft off once it has flying speed.
  if (craft.grounded){
    const f = craftForward(craft, _fwd);
    ai.desired.set(f.x, 0.06, f.z).normalize();   // wings level, a hair of up to rotate off
    craft.throttle = 1;
    craft.boost = craft.fuel > 0;                 // afterburner the takeoff roll
    craft.aiDesired = ai.desired;
    return;
  }

  // TARGET: a squad assignment (from updateSquads) wins so the team stays focused
  // and pincers as one; otherwise re-acquire the nearest hostile periodically.
  if (ai.assignedTarget && ai.assignedTarget.alive && ai.assignedTarget.team !== craft.team){
    ai.target = ai.assignedTarget;
  } else if (!ai.target || !ai.target.alive || ai.react <= 0){
    ai.target = pickTarget(craft, world) || ai.target;
    ai.react = ai.reactTime * (0.7 + Math.random() * 0.6);
  }
  const tgt = ai.target;

  // ---- threat sense: incoming missile, and is anyone sitting on my six? ----
  let incoming = null, incomingD = Infinity;
  for (const m of world.missiles){
    if (!m.alive || m.team === craft.team || m.target !== craft) continue;
    const d = dist(craft.pos, m.pos);
    if (d < incomingD){ incomingD = d; incoming = m; }
  }
  if (incoming){ ai.panic = Math.min(2.5, ai.panic + dt * 2.5); }

  const myFwd = craftForward(craft, _fwd);
  // nearest hostile that is BEHIND me with its nose on me — a gun threat to break off
  let tail = null, tailD = Infinity;
  for (const o of world.craft){
    if (!o.alive || o.team === craft.team) continue;
    _d.set(craft.pos.x - o.pos.x, craft.pos.y - o.pos.y, craft.pos.z - o.pos.z);
    const d = _d.length(); if (d < 1 || d > 650) continue;   // only a CLOSE threat is worth breaking off for
    _d.multiplyScalar(1 / d);
    const theirNoseOnMe = _d.dot(craftForward(o, _e));   // their nose points at me
    const itSitsBehindMe = -_d.dot(myFwd);               // it's clearly off my tail (not just abeam)
    if (theirNoseOnMe > 0.86 && itSitsBehindMe > 0.25 && d < tailD){ tailD = d; tail = o; }
  }

  // base desired heading: straight ahead
  ai.desired.copy(myFwd);

  // Terrain-aware altitude floor with speed/sink-rate lookahead.
  const terrain = terrainRisk(craft, world, ai);
  const alt = terrain.clearance;
  let needClimb = terrain.needClimb;

  // ---- state machine ----
  let throttle = 0.7, boost = false;

  if (!tgt){
    // SEEK: orbit toward map centre, hold a patrol altitude
    ai.state = 'seek';
    _to.set(-craft.pos.x, (ai.altFloor + 220) - craft.pos.y, -craft.pos.z);
    if (_to.lengthSq() > 1) _to.normalize();
    ai.desired.lerp(_to, 0.02);
    throttle = 0.62;
  } else {
    _to.set(tgt.pos.x - craft.pos.x, tgt.pos.y - craft.pos.y, tgt.pos.z - craft.pos.z);
    const range = _to.length() || 1;
    const fwd = myFwd;
    const losDot = (_to.x * fwd.x + _to.y * fwd.y + _to.z * fwd.z) / range; // -1..1 nose-on
    // are we behind the target (their tail toward us)?
    const tfwd = craftForward(tgt, _a);
    const behindDot = -((_to.x * tfwd.x + _to.y * tfwd.y + _to.z * tfwd.z) / range);

    // DEFENSIVE has priority: dodge a close missile, OR break off a gun attacker on
    // my six. Energy fighters unload & extend; everyone else breaks hard (scissors).
    const missileEvade = ai.panic > 1.0 || (incoming && incomingD < 600);
    const gunDefense = !!tail && ai.skill > 0.25;
    if (missileEvade || gunDefense){
      ai.state = missileEvade ? 'evade' : 'defend';
      if (ai.evadeT <= 0){ ai.evadeT = 0.7 + Math.random() * 0.7; ai.evadeDir = Math.random() < 0.5 ? -1 : 1; }
      const threat = incoming || tail || tgt;
      _b.set(threat.pos.x - craft.pos.x, threat.pos.y - craft.pos.y, threat.pos.z - craft.pos.z).normalize();
      if (ai.doctrine === 'energy' && !missileEvade){
        // ENERGY defence: don't turn-fight — unload and dive away to convert to speed,
        // then queue a zoom so it climbs back into a perch.
        ai.desired.set(-_b.x, -_b.y - 0.25, -_b.z).normalize();
        throttle = 1.0; boost = ai.skill > 0.3;
        ai.zoomT = Math.max(ai.zoomT, 1.2);
      } else {
        // hard break across the threat + a pitch jink (rolling scissors)
        _c.set(0, 1, 0).cross(_b).normalize().multiplyScalar(ai.evadeDir);
        ai.desired.copy(_c);
        ai.desired.y += 0.15 * Math.sin(world.time * 8 + ai.rollPhase);
        ai.desired.normalize();
        throttle = 1.0; boost = ai.skill > 0.3 && (incomingD < 900 || tailD < 480);
      }
      if (incoming && incoming.kind === 'ir' && craft.flares > 0 && Math.random() < 0.04 + ai.skill * 0.08)
        craft.wantFlare = true;

    } else if (ai.doctrine === 'energy' && ai.zoomT > 0 && range < 2000){
      // BOOM & ZOOM extend: after a slashing pass, climb away to rebuild an
      // altitude/speed advantage before diving back in. Refuse the turning fight.
      ai.state = 'zoom';
      ai.desired.set(fwd.x, fwd.y + 0.5, fwd.z).normalize();
      throttle = 1.0; boost = ai.skill > 0.3 && craft.speed < craft.stats.vMax * 0.72;

    } else if (range > 1600){
      // PURSUE: close the distance, leading for intercept — with a flank offset so
      // squadmates converge from different bearings (pincer) instead of single-file.
      ai.state = 'pursue';
      leadPoint(craft.pos, { position: tgt.pos, vel: tgt.vel, alive: true }, 900, _lead);
      applyFlank(ai, craft, tgt, range, _lead);
      ai.desired.set(_lead.x - craft.pos.x, _lead.y - craft.pos.y, _lead.z - craft.pos.z).normalize();
      throttle = 1.0; boost = ai.skill > 0.4 && range > 2400;

    } else if (range < 240 && losDot > 0.3){
      // OVERSHOOT guard: too close & nose-on → ease off to avoid collision/scissors
      ai.state = 'extend';
      ai.desired.set(fwd.x, fwd.y + 0.05, fwd.z).normalize();
      throttle = 0.5;
      if (ai.doctrine === 'energy') ai.zoomT = Math.max(ai.zoomT, 1.0);

    } else if (ai.doctrine === 'angles' && behindDot < 0.35 && losDot < 0.7 && range < 1400){
      // ANGLES fight: not yet on their six → curve toward the target's tail to gain
      // angles rather than flying straight at the lead and overshooting.
      ai.state = 'angle';
      const sixX = tgt.pos.x - tfwd.x * 260 + (tgt.vel.x || 0) * 0.3;
      const sixY = tgt.pos.y - tfwd.y * 260 + (tgt.vel.y || 0) * 0.3;
      const sixZ = tgt.pos.z - tfwd.z * 260 + (tgt.vel.z || 0) * 0.3;
      ai.desired.set(sixX - craft.pos.x, sixY - craft.pos.y, sixZ - craft.pos.z).normalize();
      throttle = craft.speed < craft.stats.vStall * 1.3 ? 1.0 : 0.95;

    } else {
      // ATTACK: aim at the lead point of the best weapon, manage energy
      ai.state = 'attack';
      const wi = chooseWeapon(craft, range, tgt);
      craft.aiWeaponIdx = wi;
      const w = wi >= 0 ? craft.weapons[wi] : null;
      const projSpd = w ? (w.speed || 1000) : 1000;
      leadPoint(craft.pos, { position: tgt.pos, vel: tgt.vel, alive: true }, projSpd, _lead);
      // skill-scaled aim jitter so weak pilots spray
      const jit = ai.aimJitter;
      ai.desired.set(
        _lead.x - craft.pos.x + (Math.random() - 0.5) * jit * range,
        _lead.y - craft.pos.y + (Math.random() - 0.5) * jit * range,
        _lead.z - craft.pos.z + (Math.random() - 0.5) * jit * range
      ).normalize();

      // energy: keep speed up, boost if target is escaping or we're slow
      const spd = craft.speed;
      throttle = 0.85;
      if (spd < craft.stats.vStall * 1.3) { throttle = 1; }
      if (range > 1200 && ai.skill > 0.5) boost = true;   // only boost to close from afar; boosting in close just overshoots the guns solution

      // FIRE GATING — only when the nose is genuinely on the lead solution
      const leadDir = _b.set(_lead.x - craft.pos.x, _lead.y - craft.pos.y, _lead.z - craft.pos.z).normalize();
      const aimDot = leadDir.dot(fwd);
      // When to pull the trigger. NOTE: skilled pilots fire on a SLIGHTLY tighter solution
      // but still take snap-shots — the old gate inverted this (skill 1 → within 10°), so
      // good pilots almost never fired against a manoeuvring target. Accuracy comes from the
      // skill-scaled aim JITTER above, not from refusing to shoot.
      const aimGate = lerp(0.90, 0.955, ai.skill);     // ~25° (rookie) … ~17° (ace)
      if (w && aimDot > aimGate){
        if (w.type === 'gun'){
          // burst discipline so they don't drain a clip instantly
          if (ai.burstT <= 0){
            craft.wantGun = true;
            if (Math.random() < dt * (3 + ai.skill * 6)) ai.burstT = ai.burstGap * (0.6 + Math.random() * 0.8);
          } else if (range < 1100 * Math.min(1, (w.speed || 1300) / 1300)){ craft.wantGun = true; }  // hold the trigger through a burst at gun-effective range (slow rockets only point-blank)
        } else {
          // missiles: respect lock time loosely — fire when reasonably nose-on & in range
          if (range < (w.type === 'lockmissile' ? 2400 : 2000) && Math.random() < dt * (0.4 + ai.skill)){
            craft.wantMissile = true;
            craft.aiWeaponIdx = wi;
          }
        }
        // ENERGY fighters zoom away only after a genuinely CLOSE slashing pass — not after
        // every medium-range burst, or they'd disengage constantly and never press an attack.
        if (ai.doctrine === 'energy' && craft.wantGun && range < 350) ai.zoomT = Math.max(ai.zoomT, 1.2);
      }
    }
  }

  // altitude correction always layered on top
  if (needClimb > 0){
    ai.desired.y = lerp(ai.desired.y, 1, Math.max(0.35, needClimb));
    ai.desired.normalize();
    throttle = Math.max(throttle, needClimb > 0.45 ? 1 : 0.85);
    if (needClimb > 0.45) boost = true;
  }

  // Stall recovery may lower the nose only when there is ample terrain clearance.
  if (craft.speed < craft.stats.vStall * 1.05 && needClimb < 0.2 && alt > terrain.safe * 1.4){
    ai.desired.y = Math.min(ai.desired.y, -0.1); ai.desired.normalize(); throttle = 1;
  }

  // commit intents
  craft.throttle = clamp(throttle, 0, 1);
  craft.boost = boost && craft.fuel > 0;
  craft.aiDesired = ai.desired;     // unit world heading the integrator steers toward
}

// Offset a pursue aim point sideways/vertically by the craft's assigned flank so a
// squad converges on a target from spread bearings (a pincer) rather than nose-to-tail.
function applyFlank(ai, craft, tgt, range, lead){
  if (!ai.flankSide && !ai.flankVert) return;
  _d.set(tgt.pos.x - craft.pos.x, 0, tgt.pos.z - craft.pos.z);   // horizontal line of sight
  if (_d.lengthSq() < 1) return;
  _d.normalize();
  _e.set(0, 1, 0).cross(_d).normalize();                          // left/right axis
  const lateral = clamp(range * 0.35, 120, 700);
  lead.x += _e.x * lateral * ai.flankSide;
  lead.z += _e.z * lateral * ai.flankSide;
  lead.y += clamp(range * 0.2, 60, 400) * ai.flankVert;
}

// ---------------------------------------------------------------------------
//  BOMBER BRAIN — heads for the nearest enemy carrier, lines up a run, and
//  pickles bombs/heavy ordnance on the way over; falls back to dogfight AI if
//  there's no carrier to hit.
// ---------------------------------------------------------------------------
export function updateBomber(craft, world, dt){
  const ai = craft.ai;
  if (!ai) return;
  craft.wantGun = false; craft.wantMissile = false; craft.wantBomb = false; craft.wantFlare = false;

  const carrier = pickCarrierTarget(craft, world);
  if (!carrier){ updateAI(craft, world, dt); return; }   // nothing to bomb → fight

  ai.react -= dt; ai.panic = Math.max(0, ai.panic - dt * 0.6);

  _to.set(carrier.pos.x - craft.pos.x, carrier.pos.y - craft.pos.y, carrier.pos.z - craft.pos.z);
  const range = _to.length() || 1;
  craftForward(craft, _fwd);
  const fwdHoriz = Math.hypot(_fwd.x, _fwd.z) || 1;
  const toHoriz = Math.hypot(_to.x, _to.z) || 1;
  const runDot = (_fwd.x * _to.x + _fwd.z * _to.z) / (fwdHoriz * toHoriz);

  // approach run: aim slightly above the carrier then dive the bombs in
  const terrain = terrainRisk(craft, world, ai);
  const alt = terrain.clearance;
  let throttle = 0.85, boost = false;
  const bombIdx = craft.weapons ? craft.weapons.findIndex(w => w.type === 'bomb' && (w.ammo > 0 || w.reserve > 0)) : -1;
  const bomb = bombIdx >= 0 ? craft.weapons[bombIdx] : null;
  const bombSolution = bomb ? bombImpactSolution(craft, world, carrier, bomb) : null;

  // missile threat → quick jink + flares, but keep pressing the attack
  let incoming = null, incomingD = Infinity;
  for (const m of world.missiles){ if (m.alive && m.team !== craft.team && m.target === craft){ const d = dist(craft.pos, m.pos); if (d < incomingD){ incomingD = d; incoming = m; } } }
  ai.bombEgressT = Math.max(0, (ai.bombEgressT || 0) - dt);
  // Once the ship passes behind the wing, do NOT reef into an immediate 180°
  // turn at bombing altitude. Extend straight and climb for several seconds;
  // only then is there enough height/separation for a heavy bomber to reverse
  // without losing lift and splashing down.
  if (ai.bombEgressT <= 0 && range < 1700 && runDot < -0.18) ai.bombEgressT = 8;
  if (ai.bombEgressT > 0){
    const egressAlt = (ai.bombAltitude || 280) + 210;
    ai.desired.set(_fwd.x, clamp((egressAlt - alt) / 260, 0.16, 0.48), _fwd.z).normalize();
    if (incoming && incoming.kind === 'ir' && craft.flares > 0 && Math.random() < 0.08) craft.wantFlare = true;
    craft.throttle = 1;
    craft.boost = craft.fuel > 0;
    craft.aiDesired = ai.desired;
    return;
  }
  if (incoming && incomingD < 500){
    // A heavy bomber must not make a fighter-style 90° flat break: the steep
    // bank sheds vertical lift and used to splash whole formations on their
    // first defended run. Keep most of the forward attack vector, add a
    // shallow lateral jink, and bias upward while the missile is close.
    _d.set(_to.x, 0, _to.z).normalize();
    _c.set(0, 1, 0).cross(_d).normalize();
    const evadeSide = (ai.evadeDir || 1) * (craft.team === 0 ? 1 : -1);
    const evadeAlt = ai.bombAltitude || 280;
    ai.desired.copy(_d).multiplyScalar(0.84).addScaledVector(_c, evadeSide * 0.38);
    ai.desired.y = clamp((evadeAlt + 80 - alt) / 260, 0.10, 0.38);
    ai.desired.normalize();
    if (incoming.kind === 'ir' && craft.flares > 0 && Math.random() < 0.08) craft.wantFlare = true;
    throttle = 1; boost = true;
  } else {
    // Hold a stable bombing altitude instead of aiming down at a point just
    // above the deck (which made the old run porpoise and spoiled its aim).
    // As the bomber closes, use the predicted impact error as lateral guidance
    // so it actively flies the bomb footprint onto the ship.
    let aimX = carrier.pos.x - craft.pos.x;
    let aimZ = carrier.pos.z - craft.pos.z;
    if (bombSolution && range < 3200){
      const correction = clamp((3200 - range) / 1800, 0.25, 1.35);
      const errX = bombSolution.targetX - bombSolution.impactX;
      const errZ = bombSolution.targetZ - bombSolution.impactZ;
      // Steer out only CROSS-TRACK error. Along-track error determines WHEN
      // to release; feeding it into steering could move the aim point behind
      // the bomber and command a fatal dive/reversal over the ship.
      const fx = _fwd.x / fwdHoriz, fz = _fwd.z / fwdHoriz;
      const along = errX * fx + errZ * fz;
      aimX += (errX - fx * along) * correction;
      aimZ += (errZ - fz * along) * correction;
    }
    // Keep a forward flight reference through the actual overflight. Without
    // this, the horizontal aim vector collapses near zero and even a modest
    // altitude correction becomes a near-vertical dive command.
    const aimHoriz = Math.hypot(aimX, aimZ);
    if (aimHoriz < 750){
      const ax = aimHoriz > 1 ? aimX / aimHoriz : _fwd.x / fwdHoriz;
      const az = aimHoriz > 1 ? aimZ / aimHoriz : _fwd.z / fwdHoriz;
      aimX = ax * 750; aimZ = az * 750;
    }
    const altitudeError = clamp((ai.bombAltitude || 280) - alt, -65, 110);
    ai.desired.set(aimX, altitudeError * 2.2, aimZ).normalize();
    throttle = range > 1400 ? 1 : 0.8;
    // also loose missiles at the carrier from range
    const missIdx = craft.weapons ? craft.weapons.findIndex(w => (w.type === 'missile' || w.type === 'lockmissile') && (w.ammo > 0 || w.reserve > 0)) : -1;
    if (missIdx >= 0 && range < 1800 && _fwd.dot(_to.clone().normalize()) > 0.9 && Math.random() < dt * (0.4 + ai.skill)){
      craft.wantMissile = true; craft.aiWeaponIdx = missIdx;
    }
  }

  // Bomb release has priority over evasive jinks and missile shots. A teammate
  // that reaches a valid solution must pickle NOW; previously the threat branch
  // skipped this code entirely, and a missile choice could overwrite aiWeaponIdx.
  if (bomb && bombSolution){
    if (bombSolution.miss <= bombSolution.tolerance && runDot > 0.25){
      craft.wantBomb = true;
      craft.wantMissile = false;
      craft.aiWeaponIdx = bombIdx;
    }
  }

  // Terrain recovery has priority over stall recovery; otherwise a slow bomber
  // could be ordered to lower its nose while already descending into a ridge.
  if (terrain.needClimb > 0){
    ai.desired.y = lerp(ai.desired.y, 1, Math.max(0.4, terrain.needClimb));
    ai.desired.normalize();
    throttle = 1;
    if (terrain.needClimb > 0.45) boost = true;
  }
  if (craft.speed < craft.stats.vStall * 1.1 && terrain.needClimb < 0.2 && alt > terrain.safe * 1.4){
    ai.desired.y = Math.min(ai.desired.y, -0.05); throttle = 1;
  }

  craft.throttle = clamp(throttle, 0, 1);
  craft.boost = boost && craft.fuel > 0;
  craft.aiDesired = ai.desired;
}

// ---------------------------------------------------------------------------
//  CARRIER POINT-DEFENCE — carriers don't fly, but they pick the nearest
//  hostile aircraft and return aim info so the sim can spit flak/CIWS tracers.
//  Returns { target, lead } or null.
// ---------------------------------------------------------------------------
export function updateCarrierPD(carrier, world, dt){
  if (!carrier.alive) return null;
  let best = null, bestD = Infinity;
  const range = carrier.pdRange || 1500;
  for (const o of world.craft){
    if (!o.alive || o.team === carrier.team) continue;
    const d = dist(carrier.pos, o.pos);
    if (d < range && d < bestD){ bestD = d; best = o; }
  }
  if (!best) return null;
  const lead = leadPoint(carrier.pos, { position: best.pos, vel: best.vel, alive: true }, carrier.pdSpeed || 1100, _lead.clone());
  return { target: best, lead, range: bestD };
}

// ---------------------------------------------------------------------------
//  ARMY ATTACK COORDINATION — the squad brain. Runs once per team a couple of
//  times a second and hands each AI fighter a target + an approach bearing, so a
//  formation fights as a unit: FOCUS-FIRE the priority foe (the player, then the
//  most wounded), but spread attackers across several targets and around each one
//  (a PINCER) instead of stacking single-file where they're easily out-circled.
//  updateAI honours ai.assignedTarget / ai.flankSide / ai.flankVert.
// ---------------------------------------------------------------------------
export function updateSquads(world, dt){
  world._squadT = (world._squadT || 0) - dt;
  if (world._squadT > 0) return;
  world._squadT = 0.5;                       // re-plan twice a second

  // group living AI fighters by team (bombers run their own brain — leave them be)
  const teams = new Map();
  for (const c of world.craft){
    if (!c.alive || c.isPlayer || c.isRemote || !c.ai || c.role === 'bomber') continue;
    let arr = teams.get(c.team);
    if (!arr){ arr = []; teams.set(c.team, arr); }
    arr.push(c);
  }

  for (const [team, members] of teams){
    const foes = world.craft.filter(o => o.alive && o.team !== team && !o.isCarrier);
    if (foes.length === 0){ for (const m of members) m.ai.assignedTarget = null; continue; }

    // priority order (lower = hit first): the player is juiciest, then the most
    // wounded foe (finish the kill), then everyone else.
    const prio = (o) => (o === world.player ? -1000 : 0) + (o.hp / Math.max(1, o.maxHp)) * 100;
    foes.sort((a, b) => prio(a) - prio(b));

    // cap attackers per foe so the squad concentrates on the top 1–3 targets without
    // every fighter dogpiling one bandit. Scales with squad size.
    const maxPer = Math.max(2, Math.ceil(members.length / Math.min(foes.length, 3)));
    const count = new Map();
    for (const m of members){
      // pick the highest-priority foe still under capacity, nearest among equals
      let pick = null, pickScore = Infinity;
      for (let fi = 0; fi < foes.length; fi++){
        const f = foes[fi];
        if ((count.get(f) || 0) >= maxPer) continue;
        const score = fi * 600 + dist(m.pos, f.pos);   // priority rank dominates, distance breaks ties
        if (score < pickScore){ pickScore = score; pick = f; }
      }
      if (!pick) pick = foes[0];
      const idx = count.get(pick) || 0;                // this craft's attacker index on that foe
      count.set(pick, idx + 1);
      m.ai.assignedTarget = pick;
      // surround: first attacker comes straight down the throat, the rest split
      // left/right, and beyond a pair stack high/low too.
      m.ai.flankSide = idx === 0 ? 0 : ((idx % 2) ? -1 : 1);
      m.ai.flankVert = idx < 2 ? 0 : ((idx % 2) ? 1 : -1);
    }
  }
}

// utility re-exported for battle.js convenience
export { interceptTime };
